import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import type { AppConfig } from "./dexter_config";

const WINDOWS_FILE_ACCESS_RETRY_DELAYS = [50, 100, 200, 500] as const;
const WINDOWS_FILE_ACCESS_WINERRORS = new Set([5, 32]);
const pathWriteLocks = new Map<string, unknown>();
const runtimeSnapshotWarningTimes = new Map<string, number>();
const RUNTIME_SNAPSHOT_WARNING_INTERVAL_MS = 30_000;

function jsonSafe(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      o[String(k)] = jsonSafe(v);
    }
    return o;
  }
  if (Array.isArray(value)) return value.map((x) => jsonSafe(x));
  return value;
}

function readJsonFile<T>(p: string, defaultValue: T): T {
  if (!fs.existsSync(p)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return defaultValue;
  }
}

function pathLockKey(p: string): string {
  return path.normalize(path.resolve(p)).toLowerCase();
}

function isRetryableWindowsFileAccessError(exc: unknown): boolean {
  return (
    os.platform() === "win32" &&
    typeof exc === "object" &&
    exc !== null &&
    "code" in exc &&
    (exc as NodeJS.ErrnoException).code === "EPERM"
  );
}

function replaceWithRetry(tempPath: string, targetPath: string): void {
  for (const delay of WINDOWS_FILE_ACCESS_RETRY_DELAYS) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (exc) {
      if (!isRetryableWindowsFileAccessError(exc)) throw exc;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  fs.renameSync(tempPath, targetPath);
}

function shouldLogRuntimeSnapshotWarning(p: string): boolean {
  const key = pathLockKey(p);
  const now = Date.now();
  const last = runtimeSnapshotWarningTimes.get(key);
  if (last !== undefined && now - last < RUNTIME_SNAPSHOT_WARNING_INTERVAL_MS) return false;
  runtimeSnapshotWarningTimes.set(key, now);
  return true;
}

function atomicWriteJson(filePath: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const rendered = JSON.stringify(jsonSafe(payload), null, 2);
  fs.writeFileSync(tempPath, rendered, "utf-8");
  replaceWithRetry(tempPath, filePath);
}

export class RuntimeStateWriter {
  constructor(
    private readonly filePath: string,
    private readonly component: string
  ) {}

  write(payload: Record<string, unknown>): void {
    atomicWriteJson(this.filePath, { component: this.component, ...payload });
  }
}

export class OperatorCommandBus {
  private offset = 0;
  constructor(private readonly filePath: string) {}

  append(command: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, JSON.stringify(jsonSafe(command)) + "\n", "utf-8");
  }

  readPending(): Record<string, unknown>[] {
    if (!fs.existsSync(this.filePath)) return [];
    const buf = fs.readFileSync(this.filePath, "utf-8");
    const commands: Record<string, unknown>[] = [];
    const rest = buf.slice(this.offset);
    for (const line of rest.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        commands.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
    this.offset = buf.length;
    return commands;
  }
}

export function maybeDesktopNotify(title: string, message: string): boolean {
  try {
    const r = spawnSync("notify-send", [title, message], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function defaultControlState(): Record<string, unknown> {
  return {
    pause_new_entries: false,
    blacklist_creators: [],
    whitelist_creators: [],
    watchlist_mints: [],
    force_sell_mints: [],
  };
}

export function loadControlState(filePath: string): Record<string, unknown> {
  const payload = readJsonFile<unknown>(filePath, defaultControlState());
  const state = defaultControlState();
  if (typeof payload === "object" && payload !== null) {
    Object.assign(state, payload);
  }
  return state;
}

export function saveControlState(filePath: string, state: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...defaultControlState(), ...state };
  atomicWriteJson(filePath, merged);
  return merged;
}

export function publishRuntimeSnapshot(filePath: string, snapshot: Record<string, unknown>): void {
  try {
    atomicWriteJson(filePath, snapshot);
  } catch (exc) {
    if (isRetryableWindowsFileAccessError(exc) && shouldLogRuntimeSnapshotWarning(filePath)) {
      console.warn(`Skipping runtime snapshot update for ${filePath}: temporarily locked`);
      return;
    }
    throw exc;
  }
}

function lineSet(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  return new Set(
    fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  );
}

export function updateLineFile(filePath: string, value: string, present: boolean): string[] {
  const lines = lineSet(filePath);
  const normalized = value.trim();
  if (normalized) {
    if (present) lines.add(normalized);
    else lines.delete(normalized);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const rendered = [...lines].sort();
  fs.writeFileSync(filePath, rendered.length ? rendered.map((l) => `${l}\n`).join("") : "", "utf-8");
  return rendered;
}

export class OperatorAlertDispatcher {
  constructor(private readonly config: AppConfig) {}

  async send(title: string, lines: string[]): Promise<void> {
    const message = `${title}\n${lines.join("\n")}`;
    const tasks: Promise<void>[] = [];
    if (this.config.alerts.discord_webhook_url) {
      tasks.push(
        fetch(this.config.alerts.discord_webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message }),
        }).then(() => undefined)
      );
    }
    if (this.config.alerts.telegram_bot_token && this.config.alerts.telegram_chat_id) {
      const url = `https://api.telegram.org/bot${this.config.alerts.telegram_bot_token}/sendMessage`;
      tasks.push(
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.config.alerts.telegram_chat_id, text: message }),
        }).then(() => undefined)
      );
    }
    if (this.config.alerts.desktop_notifications) {
      maybeDesktopNotify(title, lines.join("\n"));
    }
    await Promise.allSettled(tasks);
  }
}

async function dbHealth(config: AppConfig): Promise<Record<string, unknown>> {
  if (!config.database.dsn) return { status: "fail", detail: "DATABASE_URL is not configured." };
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: config.database.dsn, connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return {
      status: "pass",
      detail: `Connected to ${config.database.host}:${config.database.port}/${config.database.name}.`,
    };
  } catch (exc) {
    return { status: "fail", detail: String(exc) };
  }
}

export async function buildDashboardSnapshot(
  config: AppConfig,
  options: { limit?: number } = {}
): Promise<Record<string, unknown>> {
  const { Phase2Store } = await import("./dexter_phase2");
  const limit = options.limit ?? 5;
  const trader_state = readJsonFile(config.paths.trader_snapshot_file, {});
  const collector_state = readJsonFile(config.paths.collector_snapshot_file, {});
  const database = await dbHealth(config);
  let phase2: Record<string, unknown> = {
    leaderboard_version: null,
    top_creators: [],
    active_sessions: [],
    recent_positions: [],
    recent_risk_events: [],
    recent_fills: [],
  };
  if (config.database.dsn) {
    try {
      const store = new Phase2Store(config.database.dsn, config);
      await store.ensureSchema();
      phase2 = await store.fetchOperatorSnapshot({ limit });
    } catch (exc) {
      phase2 = { status: "fail", detail: String(exc) };
    }
  }
  const watchlist_file = path.join(config.project_root, "watchlist.txt");
  const blacklist_file = path.join(config.project_root, "blacklist.txt");
  return {
    runtime: {
      network: config.runtime.network,
      mode: config.runtime.mode,
      strategy_profile: config.strategy.default_profile,
    },
    collector: collector_state,
    trader: trader_state,
    database,
    phase2,
    watchlist: [...lineSet(watchlist_file)].sort(),
    blacklist: [...lineSet(blacklist_file)].sort(),
    paths: {
      trader_snapshot: config.paths.trader_snapshot_file,
      collector_snapshot: config.paths.collector_snapshot_file,
      operator_control: config.paths.operator_control_file,
    },
  };
}

export function renderDashboard(snapshot: Record<string, unknown>): string {
  const runtime = (snapshot.runtime ?? {}) as Record<string, unknown>;
  const collector = (snapshot.collector ?? {}) as Record<string, unknown>;
  const trader = (snapshot.trader ?? {}) as Record<string, unknown>;
  const database = (snapshot.database ?? {}) as Record<string, unknown>;
  const phase2 = (snapshot.phase2 ?? {}) as Record<string, unknown>;

  const section = (title: string, lines: string[]) => {
    const border = "=".repeat(Math.max(24, title.length + 6));
    return [border, title, ...lines].join("\n");
  };

  const top_creators = (phase2.top_creators as unknown[]) ?? [];
  const recent_positions = (phase2.recent_positions as unknown[]) ?? [];
  const recent_risk_events = (phase2.recent_risk_events as unknown[]) ?? [];
  const active_holdings = (trader.holdings_preview as unknown[]) ?? [];
  const recent_fills = (phase2.recent_fills as unknown[]) ?? [];

  const preview = (items: unknown[], fmt: (item: Record<string, unknown>) => string): string[] => {
    if (!items.length) return ["none"];
    return items.slice(0, 5).map((i) => fmt(i as Record<string, unknown>));
  };

  const sections = [
    section("Dexter Dashboard", [
      `network=${runtime.network} mode=${runtime.mode} strategy=${runtime.strategy_profile}`,
      `db_status=${database.status} db_detail=${database.detail}`,
    ]),
    section("Collector Health", [
      `status=${collector.status ?? "unknown"} subscribed=${collector.subscribed ?? false}`,
      `processed_logs=${collector.processed_logs ?? 0} last_event_at=${collector.last_event_at}`,
    ]),
    section("Trader Health", [
      `status=${trader.status ?? "unknown"} wallet=${trader.wallet}`,
      `active_sessions=${trader.active_session_count ?? 0} holdings=${active_holdings.length} pending=${trader.pending_positions ?? 0}`,
      `daily_pnl_lamports=${trader.daily_realized_pnl_lamports ?? 0} reserved=${trader.reserved_lamports ?? 0}`,
    ]),
    section(
      "Holdings",
      preview(active_holdings, (item) =>
        `${item.mint_id} owner=${item.owner} balance=${item.token_balance} market=${item.market}`.trim()
      )
    ),
    section(
      "Recent Positions",
      preview(recent_positions, (item) =>
        `${item.mint_id} status=${item.status} pnl=${item.realized_profit_lamports} exit=${item.exit_reason}`.trim()
      )
    ),
    section(
      "Top Creators",
      preview(top_creators, (item) =>
        `#${item.rank} ${item.creator} perf=${item.performance_score} trust=${item.trust_factor}`.trim()
      )
    ),
    section(
      "Recent Fills",
      preview(recent_fills, (item) =>
        `${item.side} ${item.mint_id} tx=${item.tx_id} at=${item.filled_at}`.trim()
      )
    ),
    section(
      "Risk Events",
      preview(recent_risk_events, (item) =>
        `${item.severity} ${item.event_type} mint=${item.mint_id} detail=${item.detail}`.trim()
      )
    ),
    section("Lists", [
      `watchlist=${((snapshot.watchlist as string[]) ?? []).slice(0, 8).join(", ") || "none"}`,
      `blacklist=${((snapshot.blacklist as string[]) ?? []).slice(0, 8).join(", ") || "none"}`,
    ]),
  ];
  return sections.join("\n\n");
}

export async function runDashboard(
  config: AppConfig,
  options: { watch?: boolean; interval?: number; as_json?: boolean; limit?: number } = {}
): Promise<number> {
  const watch = options.watch ?? false;
  const interval = Math.max(0.5, options.interval ?? 2.0);
  const limit = options.limit ?? 5;
  for (;;) {
    const snapshot = await buildDashboardSnapshot(config, { limit });
    const output = options.as_json
      ? JSON.stringify(jsonSafe(snapshot), null, 2)
      : renderDashboard(snapshot);
    if (watch) {
      if (os.platform() === "win32") {
        spawnSync("cmd", ["/c", "cls"], { stdio: "inherit" });
      } else {
        process.stdout.write("\x1b[2J\x1b[H");
      }
    }
    console.log(output);
    if (!watch) return 0;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

export function pauseEntries(config: AppConfig): void {
  const state = loadControlState(config.paths.operator_control_file);
  state.pause_new_entries = true;
  saveControlState(config.paths.operator_control_file, state);
  fs.mkdirSync(path.dirname(config.runtime.emergency_stop_file), { recursive: true });
  fs.writeFileSync(config.runtime.emergency_stop_file, "", "utf-8");
}

export function resumeEntries(config: AppConfig): void {
  const state = loadControlState(config.paths.operator_control_file);
  state.pause_new_entries = false;
  saveControlState(config.paths.operator_control_file, state);
  if (fs.existsSync(config.runtime.emergency_stop_file)) {
    fs.unlinkSync(config.runtime.emergency_stop_file);
  }
}

export function blacklistOwner(config: AppConfig, owner: string): string[] {
  const entries = updateLineFile(path.join(config.project_root, "blacklist.txt"), owner, true);
  const state = loadControlState(config.paths.operator_control_file);
  const bl = new Set((state.blacklist_creators as string[]) ?? []);
  bl.add(owner);
  state.blacklist_creators = [...bl].sort();
  saveControlState(config.paths.operator_control_file, state);
  return entries;
}

export function whitelistOwner(config: AppConfig, owner: string): string[] {
  const entries = updateLineFile(path.join(config.project_root, "blacklist.txt"), owner, false);
  const state = loadControlState(config.paths.operator_control_file);
  const bl = new Set((state.blacklist_creators as string[]) ?? []);
  bl.delete(owner);
  state.blacklist_creators = [...bl].sort();
  const wl = new Set((state.whitelist_creators as string[]) ?? []);
  wl.add(owner);
  state.whitelist_creators = [...wl].sort();
  saveControlState(config.paths.operator_control_file, state);
  return entries;
}

export function addWatchlistMint(config: AppConfig, mint: string): string[] {
  const entries = updateLineFile(path.join(config.project_root, "watchlist.txt"), mint, true);
  const state = loadControlState(config.paths.operator_control_file);
  const wl = new Set((state.watchlist_mints as string[]) ?? []);
  wl.add(mint);
  state.watchlist_mints = [...wl].sort();
  saveControlState(config.paths.operator_control_file, state);
  return entries;
}

export function removeWatchlistMint(config: AppConfig, mint: string): string[] {
  const entries = updateLineFile(path.join(config.project_root, "watchlist.txt"), mint, false);
  const state = loadControlState(config.paths.operator_control_file);
  const wl = new Set((state.watchlist_mints as string[]) ?? []);
  wl.delete(mint);
  state.watchlist_mints = [...wl].sort();
  saveControlState(config.paths.operator_control_file, state);
  return entries;
}

export function queueForceSell(config: AppConfig, mint: string, reason: string): void {
  const state = loadControlState(config.paths.operator_control_file);
  const fs_ = new Set((state.force_sell_mints as string[]) ?? []);
  fs_.add(mint);
  state.force_sell_mints = [...fs_].sort();
  state.last_force_sell_reason = reason;
  saveControlState(config.paths.operator_control_file, state);
}
