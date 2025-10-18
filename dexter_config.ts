import * as fs from "fs";
import * as path from "path";
import Decimal from "decimal.js";
import dotenv from "dotenv";
import {
  mevActiveProviderKey,
  mevRequiresApiKey,
  mevTipLamportsFromSol,
  normalizeMevProvider,
  type MevProviderName,
} from "./dexter_mev";
import { getStrategyProfile } from "./dexter_strategy";

export type RuntimeMode = "read_only" | "paper" | "simulate" | "live";
export type Component = "collector" | "trader" | "doctor" | "database" | "analyze";
export type ExecutionMode = RuntimeMode;
export type NetworkName = "mainnet" | "devnet";

/** Project root when running compiled output from `dist/` (parent of `dist`). */
const CODE_ROOT = path.resolve(__dirname, "..");

function looksLikeWorkspace(p: string): boolean {
  return (
    fs.existsSync(p) &&
    fs.existsSync(path.join(p, ".env.example")) &&
    (fs.existsSync(path.join(p, "Dexter.ts")) ||
      fs.existsSync(path.join(p, "Dexter.py")) ||
      fs.existsSync(path.join(p, "package.json")) ||
      fs.existsSync(path.join(p, "pyproject.toml")))
  );
}

export function resolveProjectRoot(): string {
  const override = process.env.DEXTER_HOME ?? process.env.DEXTER_PROJECT_ROOT;
  if (override) return path.resolve(override);

  const cwd = process.cwd();
  if (looksLikeWorkspace(cwd)) return path.resolve(cwd);

  return CODE_ROOT;
}

export const PROJECT_ROOT = resolveProjectRoot();
export const ENV_PATH = path.join(PROJECT_ROOT, ".env");
export const DEFAULT_BACKUP_DIR = path.join(path.dirname(PROJECT_ROOT), "dexter_backups");

const VALID_RUNTIME_MODES = new Set<string>(["read_only", "paper", "simulate", "live"]);
const VALID_NETWORKS = new Set<string>(["mainnet", "devnet"]);

const DATASTORE_ENV_ALIASES: Record<string, readonly string[]> = {
  DEXTER_DATASTORE_ENABLED: ["DEXTER_PHASE2_ENABLED"],
  DEXTER_DATASTORE_RAW_EVENT_RETENTION_DAYS: ["DEXTER_PHASE2_RAW_EVENT_RETENTION_DAYS"],
  DEXTER_DATASTORE_EXPORT_DIR: ["DEXTER_PHASE2_EXPORT_DIR"],
};

const DEVNET_RPC_ENDPOINTS: readonly [string, string] = [
  "https://api.devnet.solana.com",
  "wss://api.devnet.solana.com",
];

const DEFAULT_MAINNET_RPC_ENDPOINTS: readonly [string, string] = [
  "https://api.mainnet-beta.solana.com",
  "wss://api.mainnet-beta.solana.com",
];

const ENV_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export interface RuntimeConfig {
  mode: RuntimeMode;
  network: NetworkName;
  allow_mainnet_live: boolean;
  mainnet_dry_run: boolean;
  emergency_stop_file: string;
  close_positions_on_shutdown: boolean;
  enable_wslogs: boolean;
}

export interface RpcConfig {
  http_url: string;
  ws_url: string;
  private_key: string;
}

export interface DatabaseConfig {
  dsn: string;
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  min_pool_size: number;
  max_pool_size: number;
  admin_dsn: string;
  admin_host: string;
  admin_port: number;
  admin_name: string;
  admin_user: string;
  admin_password: string;
}

export interface BackupConfig {
  enabled: boolean;
  directory: string;
  interval_seconds: number;
  retention_count: number;
  pg_dump_path: string;
}

export interface DataStoreConfig {
  enabled: boolean;
  raw_event_retention_days: number;
  export_dir: string;
  mint_snapshot_interval_seconds: number;
  mint_snapshot_retention_per_mint: number;
  maintenance_interval_seconds: number;
  max_database_size_bytes: number;
}

export interface RiskConfig {
  per_trade_sol_cap: Decimal;
  session_sol_cap: Decimal;
  daily_sol_cap: Decimal;
  max_concurrent_sessions: number;
  per_creator_max_sessions: number;
  wallet_reserve_floor_sol: Decimal;
  daily_drawdown_stop_sol: Decimal;
}

export interface StrategyConfigShape {
  default_profile: string;
  min_entry_score_override: Decimal | null;
}

export interface ExecutionPolicyConfig {
  quote_retry_limit: number;
  send_retry_limit: number;
  confirmation_retry_limit: number;
  retry_delay_seconds: Decimal;
}

export interface WalletConfig {
  trading_private_key: string;
  hot_private_key: string;
  treasury_address: string;
}

export interface AlertConfig {
  telegram_bot_token: string;
  telegram_chat_id: string;
  discord_webhook_url: string;
  desktop_notifications: boolean;
}

export interface PathConfigShape {
  log_dir: string;
  results_file: string;
  leaderboard_file: string;
  state_dir: string;
  trader_snapshot_file: string;
  collector_snapshot_file: string;
  operator_control_file: string;
}

export interface AppMevConfig {
  enabled: boolean;
  provider: MevProviderName;
  tip_sol: Decimal;
  tip_lamports: number;
  jito_key: string;
  nextblock_key: string;
  zero_slot_key: string;
  temporal_key: string;
  bloxroute_key: string;
  requires_api_key(): boolean;
  active_provider_key(): string | null;
}

function makeMevConfig(
  base: Omit<AppMevConfig, "requires_api_key" | "active_provider_key">
): AppMevConfig {
  const o: AppMevConfig = {
    ...base,
    requires_api_key() {
      return mevRequiresApiKey(this);
    },
    active_provider_key() {
      return mevActiveProviderKey(this);
    },
  };
  return o;
}

export interface AppConfig {
  project_root: string;
  runtime: RuntimeConfig;
  rpc: RpcConfig;
  mev: AppMevConfig;
  database: DatabaseConfig;
  backup: BackupConfig;
  phase2: DataStoreConfig;
  risk: RiskConfig;
  strategy: StrategyConfigShape;
  execution: ExecutionPolicyConfig;
  wallets: WalletConfig;
  alerts: AlertConfig;
  paths: PathConfigShape;
  data_store: DataStoreConfig;
}

export function loadEnvFile(): void {
  dotenv.config({ path: ENV_PATH, override: false });
}

function decodeEnvValue(raw: string): string {
  let value = raw.replace(/\r$/, "").trimEnd();
  if (value && !/^["']/.test(value)) {
    const idx = value.search(/\s#/);
    if (idx >= 0 && (idx === 0 || /\s/.test(value[idx - 1]!))) {
      value = value.slice(0, idx).trimEnd();
    }
  }
  value = value.trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && `"'`.includes(value[0]!)) {
    const q = value[0]!;
    const inner = value.slice(1, -1);
    if (q === '"') {
      return inner
        .replace(/\\\\/g, "\0")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\0/g, "\\");
    }
    return inner;
  }
  return value;
}

function splitEnvComment(raw: string): [string, string] {
  const value = raw.replace(/\r$/, "").trimEnd();
  if (!value || /^["']/.test(value)) return [value, ""];
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "#") continue;
    if (i === 0 || /\s/.test(value[i - 1]!)) {
      return [value.slice(0, i).trimEnd(), value.slice(i)];
    }
  }
  return [value, ""];
}

function encodeEnvValue(value: string): string {
  const text = String(value);
  if (!text) return "";
  if (/\s/.test(text) || /[#"'\\]/.test(text)) {
    const escaped = text
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return text;
}

export function readEnvValues(envPath: string = ENV_PATH): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const values: Record<string, string> = {};
  const text = fs.readFileSync(envPath, "utf-8");
  for (const line of text.split("\n")) {
    const m = ENV_KEY_PATTERN.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    values[key] = decodeEnvValue(m[2]!);
  }
  return values;
}

export function updateEnvFile(updates: Record<string, string | null>, envPath: string = ENV_PATH): string {
  const existingLines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8").split("\n")
    : [];
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(updates)) {
    normalized[k] = v === null ? "" : String(v);
  }
  const remaining = { ...normalized };
  const output: string[] = [];

  for (const line of existingLines) {
    const m = ENV_KEY_PATTERN.exec(line.trim());
    if (!m) {
      output.push(line);
      continue;
    }
    const key = m[1]!;
    const rawValue = m[2]!;
    if (key in remaining) {
      const [, inlineComment] = splitEnvComment(rawValue);
      const rendered = encodeEnvValue(remaining[key]!);
      delete remaining[key];
      output.push(`${key}=${rendered}${inlineComment}`);
      continue;
    }
    output.push(line);
  }

  if (Object.keys(remaining).length) {
    if (output.length && output[output.length - 1]?.trim()) output.push("");
    for (const [key, value] of Object.entries(remaining)) {
      output.push(`${key}=${encodeEnvValue(value)}`);
    }
  }

  const rendered = output.join("\n").replace(/\s+$/, "");
  fs.writeFileSync(envPath, rendered ? `${rendered}\n` : "", "utf-8");
  for (const [key, value] of Object.entries(normalized)) {
    process.env[key] = value;
  }
  loadConfigCache.clear();
  return envPath;
}

function env(name: string, defaultValue = ""): string {
  for (const candidate of [name, ...(DATASTORE_ENV_ALIASES[name] ?? [])]) {
    const raw = process.env[candidate];
    if (raw !== undefined && raw.trim()) return raw.trim();
  }
  return defaultValue.trim();
}

function envInt(name: string, defaultValue: number): number {
  const raw = env(name);
  if (!raw) return defaultValue;
  return parseInt(raw, 10);
}

function envDecimal(name: string, defaultValue: string): Decimal {
  const raw = env(name, defaultValue);
  try {
    return new Decimal(raw);
  } catch {
    throw new Error(`Invalid decimal value for ${name}: ${raw}`);
  }
}

function envBool(name: string, defaultValue = false): boolean {
  const raw = env(name);
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function buildPostgresDsn(user: string, password: string, host: string, port: number, database: string): string {
  if (!user || !host || !database) return "";
  const enc = (s: string) => encodeURIComponent(s);
  const auth = password ? `${enc(user)}:${enc(password)}` : enc(user);
  return `postgres://${auth}@${host}:${port}/${database}`;
}

function parseDsn(dsn: string): { host: string; port: number; name: string; user: string; password: string } {
  if (!dsn) return { host: "", port: 5432, name: "", user: "", password: "" };
  try {
    const u = new URL(dsn);
    const host = u.hostname || "";
    const port = u.port ? parseInt(u.port, 10) : 5432;
    const name = u.pathname.replace(/^\//, "");
    const user = decodeURIComponent(u.username || "");
    const password = decodeURIComponent(u.password || "");
    return { host, port, name, user, password };
  } catch {
    return { host: "", port: 5432, name: "", user: "", password: "" };
  }
}

function pathIsWithin(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function resolveNetwork(networkOverride?: string | null): NetworkName {
  const raw = (networkOverride ?? env("DEXTER_NETWORK", "mainnet")).toLowerCase();
  if (!VALID_NETWORKS.has(raw)) throw new Error("DEXTER_NETWORK must be one of: devnet, mainnet");
  return raw as NetworkName;
}

function rpcUrlsForNetwork(network: NetworkName): [string, string] {
  if (network === "devnet") return [...DEVNET_RPC_ENDPOINTS] as [string, string];
  return [env("HTTP_URL", DEFAULT_MAINNET_RPC_ENDPOINTS[0]!), env("WS_URL", DEFAULT_MAINNET_RPC_ENDPOINTS[1]!)];
}

const loadConfigCache = new Map<string, AppConfig>();

export function loadConfigClearCache(): void {
  loadConfigCache.clear();
}

export function loadConfig(modeOverride?: string | null, networkOverride?: string | null): AppConfig {
  const key = `${modeOverride ?? ""}\0${networkOverride ?? ""}`;
  const hit = loadConfigCache.get(key);
  if (hit) return hit;

  loadEnvFile();

  let runtimeMode = (modeOverride ?? env("DEXTER_RUNTIME_MODE", "read_only")).toLowerCase();
  if (!VALID_RUNTIME_MODES.has(runtimeMode)) {
    throw new Error("DEXTER_RUNTIME_MODE must be one of: read_only, paper, simulate, live");
  }

  const network = resolveNetwork(networkOverride);
  const [http_url, ws_url] = rpcUrlsForNetwork(network);
  const private_key = env("PRIVATE_KEY");
  const trading_private_key = env("DEXTER_TRADING_PRIVATE_KEY", private_key);
  const hot_private_key = env("DEXTER_HOT_PRIVATE_KEY", trading_private_key);
  const { tip_sol, tip_lamports } = mevTipLamportsFromSol(env("MEV_TIP", "0.00001"));

  let database_url = env("DATABASE_URL");
  if (!database_url) {
    database_url = buildPostgresDsn(
      env("DB_USER", "dexter_user"),
      env("DB_PASSWORD"),
      env("DB_HOST", "127.0.0.1"),
      envInt("DB_PORT", 5432),
      env("DB_NAME", "dexter_db")
    );
  }

  let admin_dsn = env("POSTGRES_ADMIN_DSN");
  if (!admin_dsn) {
    admin_dsn = buildPostgresDsn(
      env("POSTGRES_ADMIN_USER", "postgres"),
      env("POSTGRES_ADMIN_PASSWORD"),
      env("POSTGRES_ADMIN_HOST", env("DB_HOST", "127.0.0.1")),
      envInt("POSTGRES_ADMIN_PORT", envInt("DB_PORT", 5432)),
      env("POSTGRES_ADMIN_DB", "postgres")
    );
  }

  const db = parseDsn(database_url);
  const adm = parseDsn(admin_dsn);

  const log_dir = path.resolve(env("DEXTER_LOG_DIR", path.join(PROJECT_ROOT, "dev", "logs")));
  const results_file = path.resolve(env("DEXTER_RESULTS_FILE", path.join(PROJECT_ROOT, "dev", "results.txt")));
  const leaderboard_file = path.resolve(
    env("DEXTER_LEADERBOARD_FILE", path.join(PROJECT_ROOT, "dev", "leaderboard.txt"))
  );
  const state_dir = path.resolve(env("DEXTER_STATE_DIR", path.join(PROJECT_ROOT, "dev", "state")));
  const trader_snapshot_file = path.resolve(
    env("DEXTER_TRADER_SNAPSHOT_FILE", path.join(state_dir, "trader-runtime.json"))
  );
  const collector_snapshot_file = path.resolve(
    env("DEXTER_COLLECTOR_SNAPSHOT_FILE", path.join(state_dir, "collector-runtime.json"))
  );
  const operator_control_file = path.resolve(
    env("DEXTER_OPERATOR_CONTROL_FILE", path.join(state_dir, "operator-control.json"))
  );

  const phase2: DataStoreConfig = {
    enabled: envBool("DEXTER_DATASTORE_ENABLED", true),
    raw_event_retention_days: envInt("DEXTER_DATASTORE_RAW_EVENT_RETENTION_DAYS", 30),
    export_dir: path.resolve(env("DEXTER_DATASTORE_EXPORT_DIR", path.join(PROJECT_ROOT, "dev", "exports"))),
    mint_snapshot_interval_seconds: envInt("DEXTER_DATASTORE_MINT_SNAPSHOT_INTERVAL_SECONDS", 15),
    mint_snapshot_retention_per_mint: envInt("DEXTER_DATASTORE_MINT_SNAPSHOT_RETENTION_PER_MINT", 4),
    maintenance_interval_seconds: envInt("DEXTER_DATASTORE_MAINTENANCE_INTERVAL_SECONDS", 60),
    max_database_size_bytes: envInt("DEXTER_DATASTORE_MAX_DATABASE_SIZE_BYTES", 2147483648),
  };

  const strategy: StrategyConfigShape = {
    default_profile: env("DEXTER_STRATEGY_PROFILE", "balanced").toLowerCase(),
    min_entry_score_override: env("DEXTER_MIN_ENTRY_SCORE_OVERRIDE")
      ? envDecimal("DEXTER_MIN_ENTRY_SCORE_OVERRIDE", "0")
      : null,
  };

  const config: AppConfig = {
    project_root: PROJECT_ROOT,
    runtime: {
      mode: runtimeMode as RuntimeMode,
      network,
      allow_mainnet_live: envBool("DEXTER_ALLOW_MAINNET_LIVE", false),
      mainnet_dry_run: envBool("DEXTER_MAINNET_DRY_RUN", true),
      emergency_stop_file: path.resolve(env("DEXTER_EMERGENCY_STOP_FILE", path.join(PROJECT_ROOT, "dev", "EMERGENCY_STOP"))),
      close_positions_on_shutdown: envBool("DEXTER_CLOSE_POSITIONS_ON_SHUTDOWN", false),
      enable_wslogs: envBool("DEXTER_ENABLE_WSLOGS", true),
    },
    rpc: {
      http_url,
      ws_url,
      private_key: trading_private_key,
    },
    mev: makeMevConfig({
      enabled: envBool("USE_MEV", false),
      provider: normalizeMevProvider(env("MEV_PROVIDER", "jito")),
      tip_sol,
      tip_lamports,
      jito_key: env("MEV_JITO_KEY"),
      nextblock_key: env("MEV_NEXTBLOCK_KEY"),
      zero_slot_key: env("MEV_ZERO_SLOT_KEY"),
      temporal_key: env("MEV_TEMPORAL_KEY"),
      bloxroute_key: env("MEV_BLOXROUTE_KEY"),
    }),
    database: {
      dsn: database_url,
      host: db.host,
      port: db.port,
      name: db.name,
      user: db.user,
      password: db.password,
      min_pool_size: envInt("DEXTER_DB_MIN_POOL_SIZE", 1),
      max_pool_size: envInt("DEXTER_DB_MAX_POOL_SIZE", 20),
      admin_dsn,
      admin_host: adm.host,
      admin_port: adm.port,
      admin_name: adm.name,
      admin_user: adm.user,
      admin_password: adm.password,
    },
    backup: {
      enabled: envBool("DEXTER_BACKUP_ENABLED", true),
      directory: path.resolve(env("DEXTER_BACKUP_DIR", DEFAULT_BACKUP_DIR)),
      interval_seconds: envInt("DEXTER_BACKUP_INTERVAL_SECONDS", 3600),
      retention_count: envInt("DEXTER_BACKUP_RETENTION_COUNT", 24),
      pg_dump_path: env("DEXTER_PG_DUMP_PATH", "pg_dump"),
    },
    phase2,
    data_store: phase2,
    risk: {
      per_trade_sol_cap: envDecimal("DEXTER_PER_TRADE_SOL_CAP", "100.00"),
      session_sol_cap: envDecimal("DEXTER_SESSION_SOL_CAP", "1000.00"),
      daily_sol_cap: envDecimal("DEXTER_DAILY_SOL_CAP", "10000.00"),
      max_concurrent_sessions: envInt("DEXTER_MAX_CONCURRENT_SESSIONS", 100),
      per_creator_max_sessions: envInt("DEXTER_PER_CREATOR_MAX_SESSIONS", 100),
      wallet_reserve_floor_sol: envDecimal("DEXTER_WALLET_RESERVE_FLOOR_SOL", "0.00020398"),
      daily_drawdown_stop_sol: envDecimal("DEXTER_DAILY_DRAWDOWN_STOP_SOL", "10000.00"),
    },
    strategy,
    execution: {
      quote_retry_limit: envInt("DEXTER_QUOTE_RETRY_LIMIT", 3),
      send_retry_limit: envInt("DEXTER_SEND_RETRY_LIMIT", 2),
      confirmation_retry_limit: envInt("DEXTER_CONFIRMATION_RETRY_LIMIT", 6),
      retry_delay_seconds: envDecimal("DEXTER_RETRY_DELAY_SECONDS", "0.25"),
    },
    wallets: {
      trading_private_key,
      hot_private_key,
      treasury_address: env("DEXTER_TREASURY_ADDRESS"),
    },
    alerts: {
      telegram_bot_token: env("DEXTER_TELEGRAM_BOT_TOKEN"),
      telegram_chat_id: env("DEXTER_TELEGRAM_CHAT_ID"),
      discord_webhook_url: env("DEXTER_DISCORD_WEBHOOK_URL"),
      desktop_notifications: envBool("DEXTER_DESKTOP_NOTIFICATIONS", false),
    },
    paths: {
      log_dir,
      results_file,
      leaderboard_file,
      state_dir,
      trader_snapshot_file,
      collector_snapshot_file,
      operator_control_file,
    },
  };

  loadConfigCache.set(key, config);
  return config;
}

export function resolveTradeExecutionMode(config: AppConfig): ExecutionMode {
  if (config.runtime.mode !== "live") return config.runtime.mode;
  if (config.runtime.network === "mainnet" && config.runtime.mainnet_dry_run) return "simulate";
  return "live";
}

export function validateConfig(config: AppConfig, component: Component): [string[], string[]] {
  const errors: string[] = [];
  const warnings: string[] = [];
  const execution_mode = resolveTradeExecutionMode(config);

  if (config.database.min_pool_size < 1) errors.push("DEXTER_DB_MIN_POOL_SIZE must be >= 1.");
  if (config.database.max_pool_size < config.database.min_pool_size) {
    errors.push("DEXTER_DB_MAX_POOL_SIZE must be >= DEXTER_DB_MIN_POOL_SIZE.");
  }

  if (["collector", "trader", "doctor"].includes(component)) {
    if (!config.rpc.http_url) errors.push("Resolved HTTP RPC URL is missing.");
    if (!config.rpc.ws_url) errors.push("Resolved WebSocket RPC URL is missing.");
  }

  if (["collector", "trader", "analyze", "doctor"].includes(component) && !config.database.dsn) {
    errors.push("DATABASE_URL or DB_* variables are required.");
  }

  if (component === "database") {
    if (!config.database.dsn) {
      errors.push("DATABASE_URL or DB_* variables are required for the Dexter app database.");
    }
    if (!config.database.admin_dsn) {
      warnings.push(
        "POSTGRES_ADMIN_DSN or POSTGRES_ADMIN_* variables are only required when Dexter must create the database or user."
      );
    }
  }

  if (component === "trader") {
    if ((execution_mode === "simulate" || execution_mode === "live") && !config.rpc.private_key) {
      errors.push("PRIVATE_KEY is required for simulate and live trader modes.");
    }
  }

  if (component === "doctor" && !config.rpc.private_key) {
    warnings.push("PRIVATE_KEY is not set; wallet decoding will be skipped.");
  }

  if (config.mev.enabled) {
    if (config.mev.tip_lamports <= 0) {
      errors.push("MEV_TIP must resolve to a positive lamport value when USE_MEV=true.");
    }
    if (config.runtime.network !== "mainnet") {
      warnings.push("USE_MEV is enabled, but MEV routing is mainnet-only; Dexter will ignore it on devnet.");
    } else if (
      execution_mode === "live" &&
      config.mev.requires_api_key() &&
      !config.mev.active_provider_key()
    ) {
      errors.push(`${config.mev.provider} requires its MEV API key when USE_MEV=true.`);
    }
  }

  if (config.runtime.mode === "live" && config.runtime.network === "mainnet") {
    if (config.runtime.mainnet_dry_run) {
      warnings.push("Mainnet live runtime is in dry-run mode; transactions will be simulated and not submitted.");
    } else if (!config.runtime.allow_mainnet_live) {
      errors.push(
        "Live mainnet transaction sends are locked. Set DEXTER_MAINNET_DRY_RUN=false and DEXTER_ALLOW_MAINNET_LIVE=true to unlock them explicitly."
      );
    }
  }

  if (config.runtime.mode === "live" && !config.runtime.close_positions_on_shutdown) {
    warnings.push(
      "DEXTER_CLOSE_POSITIONS_ON_SHUTDOWN=false; open live positions will require manual handling on shutdown."
    );
  }

  if (fs.existsSync(config.runtime.emergency_stop_file)) {
    warnings.push(
      `Emergency stop is active at ${config.runtime.emergency_stop_file}; new trader buys will be blocked.`
    );
  }

  if (config.backup.enabled) {
    if (config.backup.interval_seconds < 60) errors.push("DEXTER_BACKUP_INTERVAL_SECONDS must be at least 60.");
    if (config.backup.retention_count < 1) errors.push("DEXTER_BACKUP_RETENTION_COUNT must be at least 1.");
    if (pathIsWithin(config.backup.directory, config.project_root)) {
      errors.push("DEXTER_BACKUP_DIR must be outside the repository root.");
    }
  }

  if (config.phase2.enabled && config.phase2.raw_event_retention_days < 1) {
    errors.push("DEXTER_DATASTORE_RAW_EVENT_RETENTION_DAYS must be at least 1.");
  }
  if (config.phase2.enabled && config.phase2.mint_snapshot_interval_seconds < 1) {
    errors.push("DEXTER_DATASTORE_MINT_SNAPSHOT_INTERVAL_SECONDS must be at least 1.");
  }
  if (config.phase2.enabled && config.phase2.mint_snapshot_retention_per_mint < 1) {
    errors.push("DEXTER_DATASTORE_MINT_SNAPSHOT_RETENTION_PER_MINT must be at least 1.");
  }
  if (config.phase2.enabled && config.phase2.maintenance_interval_seconds < 10) {
    errors.push("DEXTER_DATASTORE_MAINTENANCE_INTERVAL_SECONDS must be at least 10.");
  }
  if (config.phase2.enabled && config.phase2.max_database_size_bytes < 0) {
    errors.push("DEXTER_DATASTORE_MAX_DATABASE_SIZE_BYTES must be >= 0.");
  }

  if (config.risk.per_trade_sol_cap.lte(0)) errors.push("DEXTER_PER_TRADE_SOL_CAP must be > 0.");
  if (config.risk.session_sol_cap.lt(config.risk.per_trade_sol_cap)) {
    errors.push("DEXTER_SESSION_SOL_CAP must be >= DEXTER_PER_TRADE_SOL_CAP.");
  }
  if (config.risk.daily_sol_cap.lt(config.risk.session_sol_cap)) {
    errors.push("DEXTER_DAILY_SOL_CAP must be >= DEXTER_SESSION_SOL_CAP.");
  }
  if (config.risk.max_concurrent_sessions < 1) errors.push("DEXTER_MAX_CONCURRENT_SESSIONS must be >= 1.");
  if (config.risk.per_creator_max_sessions < 1) errors.push("DEXTER_PER_CREATOR_MAX_SESSIONS must be >= 1.");
  if (config.risk.wallet_reserve_floor_sol.lt(0)) errors.push("DEXTER_WALLET_RESERVE_FLOOR_SOL must be >= 0.");
  if (config.risk.daily_drawdown_stop_sol.lt(0)) errors.push("DEXTER_DAILY_DRAWDOWN_STOP_SOL must be >= 0.");
  if (config.execution.quote_retry_limit < 1) errors.push("DEXTER_QUOTE_RETRY_LIMIT must be >= 1.");
  if (config.execution.send_retry_limit < 1) errors.push("DEXTER_SEND_RETRY_LIMIT must be >= 1.");
  if (config.execution.confirmation_retry_limit < 1) errors.push("DEXTER_CONFIRMATION_RETRY_LIMIT must be >= 1.");
  if (config.execution.retry_delay_seconds.lt(0)) errors.push("DEXTER_RETRY_DELAY_SECONDS must be >= 0.");
  if (
    (config.runtime.mode === "simulate" || config.runtime.mode === "live") &&
    !config.wallets.trading_private_key
  ) {
    errors.push("DEXTER_TRADING_PRIVATE_KEY or PRIVATE_KEY is required for simulate/live trader mode.");
  }
  if (config.wallets.hot_private_key && !config.wallets.trading_private_key) {
    errors.push("DEXTER_HOT_PRIVATE_KEY requires DEXTER_TRADING_PRIVATE_KEY or PRIVATE_KEY.");
  }
  if (config.wallets.treasury_address && !config.wallets.trading_private_key) {
    warnings.push(
      "DEXTER_TREASURY_ADDRESS is set without a trading wallet; treasury reporting will be informational only."
    );
  }

  try {
    getStrategyProfile(config.strategy.default_profile);
  } catch (exc) {
    errors.push(`DEXTER_STRATEGY_PROFILE is invalid: ${exc}`);
  }

  if (config.alerts.telegram_chat_id && !config.alerts.telegram_bot_token) {
    warnings.push("DEXTER_TELEGRAM_CHAT_ID is set, but DEXTER_TELEGRAM_BOT_TOKEN is still missing.");
  } else if (config.alerts.telegram_bot_token && !config.alerts.telegram_chat_id) {
    warnings.push(
      "Telegram bot token is set. DEXTER_TELEGRAM_CHAT_ID can be auto-captured after you message the bot /id while Dexter is running."
    );
  }

  return [errors, warnings];
}

export function ensureDirectories(config: AppConfig): void {
  fs.mkdirSync(config.paths.log_dir, { recursive: true });
  fs.mkdirSync(path.dirname(config.paths.results_file), { recursive: true });
  fs.mkdirSync(path.dirname(config.paths.leaderboard_file), { recursive: true });
  fs.mkdirSync(config.paths.state_dir, { recursive: true });
  fs.mkdirSync(path.dirname(config.paths.trader_snapshot_file), { recursive: true });
  fs.mkdirSync(path.dirname(config.paths.collector_snapshot_file), { recursive: true });
  fs.mkdirSync(path.dirname(config.paths.operator_control_file), { recursive: true });
  if (config.phase2.enabled) fs.mkdirSync(config.phase2.export_dir, { recursive: true });
  if (config.backup.enabled) fs.mkdirSync(config.backup.directory, { recursive: true });
}

export function redactUrl(value: string): string {
  if (!value) return "<unset>";
  try {
    const u = new URL(value);
    const host = u.hostname || value;
    return `${u.protocol || "unknown:"}//${host}`;
  } catch {
    return "<unset>";
  }
}

export function redactDsn(value: string): string {
  if (!value) return "<unset>";
  const { host, port, name, user } = parseDsn(value);
  if (!host) return "<invalid>";
  return `postgres://${user || "<unset>"}:***@${host}:${port}/${name || "<unset>"}`;
}

export function currentUtcTimestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export function logStartupSummary(
  logger: { info: (msg: string) => void },
  config: AppConfig,
  component: string
): void {
  const execution_mode = resolveTradeExecutionMode(config);
  logger.info(
    [
      "startup",
      `component=${component}`,
      `mode=${config.runtime.mode}`,
      `execution_mode=${execution_mode}`,
      `network=${config.runtime.network}`,
      `mainnet_live_unlock=${config.runtime.allow_mainnet_live}`,
      `mainnet_dry_run=${config.runtime.mainnet_dry_run}`,
      `mev_enabled=${config.mev.enabled}`,
      `mev_provider=${config.mev.provider}`,
      `mev_tip_lamports=${config.mev.tip_lamports}`,
      `http=${redactUrl(config.rpc.http_url)}`,
      `ws=${redactUrl(config.rpc.ws_url)}`,
      `db=${redactDsn(config.database.dsn)}`,
      `log_dir=${config.paths.log_dir}`,
      `backup_dir=${config.backup.directory}`,
      `data_store_enabled=${config.phase2.enabled}`,
      `data_store_export_dir=${config.phase2.export_dir}`,
      `strategy_profile=${config.strategy.default_profile}`,
      `max_sessions=${config.risk.max_concurrent_sessions}`,
      `per_creator_limit=${config.risk.per_creator_max_sessions}`,
      `reserve_floor=${config.risk.wallet_reserve_floor_sol.toString()}`,
    ].join(" ")
  );
}
