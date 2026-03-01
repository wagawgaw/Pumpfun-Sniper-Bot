import * as fs from "fs";
import * as path from "path";
import type { AppConfig } from "./dexter_config";
import { PROJECT_ROOT } from "./dexter_config";

export const LOCAL_POSTGRES_DEFAULT_MAJOR = "17";
export const LOCAL_POSTGRES_DEFAULT_PORT = 55432;
export const MANAGED_FLAG_ENV = "DEXTER_LOCAL_POSTGRES_MANAGED";
export const BIN_DIR_ENV = "DEXTER_LOCAL_POSTGRES_BIN_DIR";
export const DATA_DIR_ENV = "DEXTER_LOCAL_POSTGRES_DATA_DIR";
export const LOG_FILE_ENV = "DEXTER_LOCAL_POSTGRES_LOG_FILE";
export const PORT_ENV = "DEXTER_LOCAL_POSTGRES_PORT";
const STATE_FILE_NAME = "dexter-managed.json";

function envFlag(name: string, defaultValue = false): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function isManagedLocalPostgres(): boolean {
  return envFlag(MANAGED_FLAG_ENV, false);
}

export function defaultLocalPostgresRoot(projectRoot: string = PROJECT_ROOT): string {
  return path.join(projectRoot, ".dexter", "postgres");
}

export function configuredLocalPostgresPort(): number {
  const raw = (process.env[PORT_ENV] ?? "").trim();
  if (!raw) return LOCAL_POSTGRES_DEFAULT_PORT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : LOCAL_POSTGRES_DEFAULT_PORT;
}

export function configuredLocalPostgresBinDir(): string | null {
  const raw = (process.env[BIN_DIR_ENV] ?? "").trim();
  return raw ? raw : null;
}

export function configuredLocalPostgresDataDir(): string | null {
  const raw = (process.env[DATA_DIR_ENV] ?? "").trim();
  return raw ? raw : null;
}

export function configuredLocalPostgresLogFile(): string | null {
  const raw = (process.env[LOG_FILE_ENV] ?? "").trim();
  return raw ? raw : null;
}

export function managedStateFile(dataDir: string): string {
  return path.join(path.dirname(dataDir), STATE_FILE_NAME);
}

export function loadManagedPostgresState(dataDir?: string | null): Record<string, string> | null {
  let statePath: string | null = null;
  if (dataDir) {
    const candidate = managedStateFile(dataDir);
    if (fs.existsSync(candidate)) statePath = candidate;
  } else {
    const configured = configuredLocalPostgresDataDir();
    if (configured) {
      const candidate = managedStateFile(configured);
      if (fs.existsSync(candidate)) statePath = candidate;
    }
  }
  if (!statePath || !fs.existsSync(statePath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(statePath, "utf-8")) as unknown;
    if (typeof payload !== "object" || payload === null) return null;
    const state: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (v !== null && v !== undefined) state[String(k)] = String(v);
    }
    return Object.keys(state).length ? state : null;
  } catch {
    return null;
  }
}

export function managedStateToEnvUpdates(state: Record<string, string>): Record<string, string> {
  const db_host = state.db_host ?? "127.0.0.1";
  const db_port = state.db_port ?? state.port ?? String(LOCAL_POSTGRES_DEFAULT_PORT);
  const db_name = state.db_name ?? "dexter_db";
  const db_user = state.db_user ?? "dexter_user";
  const db_password = state.db_password ?? "";
  const admin_db = state.admin_db ?? "postgres";
  const admin_user = state.admin_user ?? "postgres";
  const admin_password = state.admin_password ?? "";
  const enc = (s: string) => encodeURIComponent(s);
  const auth = (u: string, p: string) => (p ? `${enc(u)}:${enc(p)}` : enc(u));
  return {
    DATABASE_URL: `postgres://${auth(db_user, db_password)}@${db_host}:${db_port}/${db_name}`,
    DB_HOST: db_host,
    DB_PORT: String(db_port),
    DB_NAME: db_name,
    DB_USER: db_user,
    DB_PASSWORD: db_password,
    POSTGRES_ADMIN_DSN: `postgres://${auth(admin_user, admin_password)}@${db_host}:${db_port}/${admin_db}`,
    POSTGRES_ADMIN_USER: admin_user,
    POSTGRES_ADMIN_PASSWORD: admin_password,
    POSTGRES_ADMIN_HOST: db_host,
    POSTGRES_ADMIN_PORT: String(db_port),
    POSTGRES_ADMIN_DB: admin_db,
  };
}

export function applyManagedPostgresStateToEnvironment(): boolean {
  if (!isManagedLocalPostgres()) return false;
  const state = loadManagedPostgresState();
  if (!state) return false;
  for (const [key, value] of Object.entries(managedStateToEnvUpdates(state))) {
    process.env[key] = value;
  }
  return true;
}

export function writeManagedPostgresState(options: {
  bin_dir: string;
  data_dir: string;
  log_file: string;
  port: number;
  db_host: string;
  db_port: number;
  db_name: string;
  db_user: string;
  db_password: string;
  admin_db: string;
  admin_user: string;
  admin_password: string;
  pg_dump_path: string;
}): string {
  const statePath = managedStateFile(options.data_dir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const payload = {
    schema_version: 1,
    managed: true,
    bin_dir: options.bin_dir,
    data_dir: options.data_dir,
    log_file: options.log_file,
    port: options.port,
    db_host: options.db_host,
    db_port: options.db_port,
    db_name: options.db_name,
    db_user: options.db_user,
    db_password: options.db_password,
    admin_db: options.admin_db,
    admin_user: options.admin_user,
    admin_password: options.admin_password,
    pg_dump_path: options.pg_dump_path,
  };
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  return statePath;
}

export function persistManagedPostgresStateFromConfig(config: AppConfig): string | null {
  if (!isManagedLocalPostgres()) return null;
  const bin_dir = configuredLocalPostgresBinDir();
  const data_dir = configuredLocalPostgresDataDir();
  const log_file = configuredLocalPostgresLogFile();
  if (!bin_dir || !data_dir || !log_file) return null;
  return writeManagedPostgresState({
    bin_dir,
    data_dir,
    log_file,
    port: configuredLocalPostgresPort(),
    db_host: config.database.host || "127.0.0.1",
    db_port: config.database.port || configuredLocalPostgresPort(),
    db_name: config.database.name || "dexter_db",
    db_user: config.database.user || "dexter_user",
    db_password: config.database.password,
    admin_db: config.database.admin_name || "postgres",
    admin_user: config.database.admin_user || "postgres",
    admin_password: config.database.admin_password,
    pg_dump_path: config.backup.pg_dump_path,
  });
}

/**
 * Python Dexter can start a managed local cluster; Dexter-ts does not replicate that yet.
 * When the flag is set we only warn—ensure the server is already up before `database-init`.
 */
export function ensureLocalPostgresRunning(_config?: AppConfig | null, _timeoutSeconds = 60): boolean {
  if (!isManagedLocalPostgres()) return false;
  console.warn(
    "[dexter] DEXTER_LOCAL_POSTGRES_MANAGED=true: auto-start is not implemented in Dexter-ts; ensure PostgreSQL is running."
  );
  return false;
}

export function discoverPostgresBin(_preferredMajor?: string | null): string | null {
  return null;
}

export async function initializeLocalCluster(_options: unknown): Promise<void> {
  throw new Error("initializeLocalCluster is not implemented in Dexter-ts; use Python database-setup.");
}

export async function startLocalPostgres(_options: unknown): Promise<boolean> {
  throw new Error("startLocalPostgres is not implemented in Dexter-ts; use Python database-setup.");
}
