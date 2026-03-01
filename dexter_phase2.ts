import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import Decimal from "decimal.js";
import { Client, type Pool, type PoolClient } from "pg";

type PgConn = PoolClient | Client;
import type { AppConfig } from "./dexter_config";
import { PHASE2_SCHEMA_STATEMENTS } from "./phase2_schema";

export { PHASE2_SCHEMA_STATEMENTS };

function utcNow(): Date {
  return new Date();
}

function ensureUtc(value: Date | null | undefined): Date {
  if (value === null || value === undefined) return utcNow();
  return new Date(value.getTime());
}

export function jsonSafe(value: unknown): unknown {
  if (value instanceof Decimal) {
    if (!value.isFinite()) return null;
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return ensureUtc(value).toISOString();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      o[String(k)] = jsonSafe(v);
    }
    return o;
  }
  if (Array.isArray(value)) return value.map((x) => jsonSafe(x));
  return value;
}

export function jsonbParam(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

export function computeEventFingerprint(options: {
  source: string;
  signature: string;
  log_index: number;
  event_type: string;
  mint_id: string | null | undefined;
  payload: unknown;
}): string {
  const seed = [
    options.source,
    options.signature ?? "",
    String(options.log_index),
    options.event_type,
    options.mint_id ?? "",
    JSON.stringify(jsonSafe(options.payload)),
  ].join("|");
  return crypto.createHash("sha256").update(seed, "utf-8").digest("hex");
}

export function prepareLeaderboardEntries(
  leaderboard: Record<string, Record<string, unknown>>
): Record<string, unknown>[] {
  const ranked = Object.entries(leaderboard).sort((a, b) => {
    const sa = Number(a[1].performance_score ?? 0);
    const sb = Number(b[1].performance_score ?? 0);
    if (sb !== sa) return sb - sa;
    return String(b[0]).localeCompare(String(a[0]));
  });
  const entries: Record<string, unknown>[] = [];
  ranked.forEach(([creator, entry], idx) => {
    const normalized = { ...(jsonSafe(entry) as Record<string, unknown>) };
    normalized.creator = creator;
    normalized.rank = idx + 1;
    entries.push(normalized);
  });
  return entries;
}

export function computeLeaderboardVersion(leaderboard: Record<string, Record<string, unknown>>): string {
  const entries = prepareLeaderboardEntries(leaderboard);
  const payload = JSON.stringify(jsonSafe(entries));
  const digest = crypto.createHash("sha256").update(payload, "utf-8").digest("hex");
  return `lgd_${digest.slice(0, 20)}`;
}

function defaultExportDir(config: AppConfig | null | undefined): string {
  const p2 = config?.phase2;
  if (p2?.export_dir) return p2.export_dir;
  return path.join(config?.project_root ?? ".", "dev", "exports");
}

export interface ReplayInvariant {
  name: string;
  status: string;
  detail: string;
}

export interface SessionReplayRepository {
  fetch_session_bundle(options: {
    session_id?: string | null;
    mint_id?: string | null;
  }): Promise<Record<string, unknown>>;
}

export class Phase2Store implements SessionReplayRepository {
  readonly dbDsn: string;
  readonly config: AppConfig | null | undefined;
  pool: Pool | null = null;
  private lastMintSnapshotRecorded: Map<string, [string, Date]> = new Map();

  constructor(dbDsn: string, config?: AppConfig | null) {
    this.dbDsn = dbDsn;
    this.config = config;
  }

  bindPool(pool: Pool): void {
    this.pool = pool;
  }

  private async withConnection<T>(operation: (client: PgConn) => Promise<T>): Promise<T> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        return await operation(client);
      } finally {
        client.release();
      }
    }
    const client = new Client({ connectionString: this.dbDsn });
    await client.connect();
    try {
      return await operation(client);
    } finally {
      await client.end();
    }
  }

  async ensureSchema(): Promise<void> {
    await this.withConnection(async (c) => {
      for (const statement of PHASE2_SCHEMA_STATEMENTS) {
        await c.query(statement);
      }
    });
  }

  async recordRawEvent(options: {
    source: string;
    program: string;
    signature: string;
    slot: number;
    log_index: number;
    event_type: string;
    is_mint: boolean;
    payload: Record<string, unknown>;
    raw_logs?: string[] | null;
    observed_at?: Date | null;
  }): Promise<string> {
    const mint_id = String(options.payload.mint ?? "");
    const owner = String(options.payload.user ?? options.payload.owner ?? "");
    const fingerprint = computeEventFingerprint({
      source: options.source,
      signature: options.signature,
      log_index: options.log_index,
      event_type: options.event_type,
      mint_id: mint_id || null,
      payload: options.payload,
    });
    const observed_at = ensureUtc(options.observed_at ?? null);

    await this.withConnection(async (c) => {
      await c.query(
        `INSERT INTO phase2_raw_events (
          fingerprint, source, program, signature, slot, log_index, event_type, is_mint,
          mint_id, owner, observed_at, raw_logs, parsed_payload
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          NULLIF($9, ''), NULLIF($10, ''), $11, $12::jsonb, $13::jsonb
        ) ON CONFLICT (fingerprint) DO NOTHING`,
        [
          fingerprint,
          options.source,
          options.program,
          options.signature,
          Math.floor(options.slot || 0),
          Math.floor(options.log_index),
          options.event_type,
          Boolean(options.is_mint),
          mint_id,
          owner,
          observed_at,
          jsonbParam(options.raw_logs ?? []),
          jsonbParam(options.payload),
        ]
      );
    });
    return fingerprint;
  }

  async ensureStrategyProfile(options: {
    profile_key: string;
    profile_name: string;
    version: string;
    definition: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
    created_at?: Date | null;
  }): Promise<void> {
    const created_at = ensureUtc(options.created_at ?? null);
    await this.withConnection(async (c) => {
      await c.query(
        `INSERT INTO phase2_strategy_profiles (profile_key, profile_name, version, definition, metadata, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
         ON CONFLICT (profile_key) DO UPDATE SET
           profile_name = EXCLUDED.profile_name,
           version = EXCLUDED.version,
           definition = EXCLUDED.definition,
           metadata = EXCLUDED.metadata`,
        [
          options.profile_key,
          options.profile_name,
          options.version,
          jsonbParam(options.definition),
          jsonbParam(options.metadata ?? {}),
          created_at,
        ]
      );
    });
  }

  async recordBacktestRun(options: {
    profile_key: string;
    input_source: string;
    report: Record<string, unknown>;
    run_id?: string | null;
  }): Promise<string> {
    const run_id = options.run_id ?? `backtest_${crypto.randomBytes(16).toString("hex")}`;
    const trades = ((options.report.cases ?? options.report.trades) ?? []) as Record<string, unknown>[];

    await this.withConnection(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query(
          `INSERT INTO phase2_backtest_runs (run_id, profile_key, input_source, summary_payload, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [run_id, options.profile_key, options.input_source, jsonbParam(options.report), utcNow()]
        );
        for (const trade of trades) {
          await c.query(
            `INSERT INTO phase2_backtest_trades (run_id, mint_id, owner, entered, score, realized_return_pct, trade_payload)
             VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7::jsonb)`,
            [
              run_id,
              String(trade.mint_id ?? ""),
              String(trade.owner ?? ""),
              Boolean(trade.entered ?? false),
              Number(trade.score ?? 0),
              Number(trade.realized_return_pct ?? 0),
              jsonbParam(trade),
            ]
          );
        }
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
    return run_id;
  }

  async recordLeaderboardGeneration(
    leaderboard: Record<string, Record<string, unknown>>,
    options: { source: string; generated_at?: Date | null; metadata?: Record<string, unknown> | null }
  ): Promise<string> {
    const generated_at = ensureUtc(options.generated_at ?? null);
    const entries = prepareLeaderboardEntries(leaderboard);
    const version = computeLeaderboardVersion(leaderboard);
    const ranking_hash = crypto.createHash("sha256").update(JSON.stringify(jsonSafe(entries)), "utf-8").digest("hex");

    await this.withConnection(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query(
          `INSERT INTO phase2_leaderboard_generations (version, generated_at, source, creator_count, ranking_hash, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (version) DO NOTHING`,
          [version, generated_at, options.source, entries.length, ranking_hash, jsonbParam(options.metadata ?? {})]
        );
        await c.query("DELETE FROM phase2_creator_snapshots WHERE leaderboard_version = $1", [version]);
        for (const entry of entries) {
          await c.query(
            `INSERT INTO phase2_creator_snapshots (
              leaderboard_version, creator, rank, mint_count, total_swaps, success_count, unsuccess_count,
              median_peak_market_cap, median_market_cap, median_open_price, median_high_price,
              trust_factor, avg_success_ratio, median_success_ratio, performance_score, entry_payload
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
            [
              version,
              entry.creator,
              Math.floor(Number(entry.rank)),
              Math.floor(Number(entry.mint_count ?? 0)),
              Math.floor(Number(entry.total_swaps ?? 0)),
              Math.floor(Number(entry.success_count ?? 0)),
              Math.floor(Number(entry.unsuccess_count ?? 0)),
              Number(entry.median_peak_market_cap ?? 0),
              Number(entry.median_market_cap ?? 0),
              Number(entry.median_open_price ?? 0),
              Number(entry.median_high_price ?? 0),
              Number(entry.trust_factor ?? 0),
              Number(entry.avg_success_ratio ?? 0),
              Number(entry.median_success_ratio ?? 0),
              Number(entry.performance_score ?? 0),
              jsonbParam(entry),
            ]
          );
        }
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
    return version;
  }

  async fetchOperatorSnapshot(options: { limit?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.floor(options.limit ?? 5));
    return this.withConnection(async (c) => {
      const v = await c.query(
        `SELECT version FROM phase2_leaderboard_generations ORDER BY generated_at DESC LIMIT 1`
      );
      const latest_version = v.rows[0]?.version ?? null;
      let top_creators: Record<string, unknown>[] = [];
      if (latest_version) {
        const r = await c.query(
          `SELECT creator, rank, performance_score, trust_factor, median_success_ratio
           FROM phase2_creator_snapshots WHERE leaderboard_version = $1 ORDER BY rank ASC LIMIT $2`,
          [latest_version, limit]
        );
        top_creators = r.rows;
      }
      const active_sessions = (
        await c.query(
          `SELECT session_id, mint_id, owner, status, opened_at, close_reason
           FROM phase2_trade_sessions WHERE status = 'open' ORDER BY opened_at DESC LIMIT $1`,
          [limit]
        )
      ).rows;
      const recent_positions = (
        await c.query(`SELECT * FROM phase2_position_journal ORDER BY updated_at DESC LIMIT $1`, [limit])
      ).rows;
      const recent_risk_events = (
        await c.query(`SELECT * FROM phase2_risk_events ORDER BY created_at DESC LIMIT $1`, [limit])
      ).rows;
      const recent_fills = (
        await c.query(
          `SELECT session_id, mint_id, side, tx_id, wallet_delta_lamports, filled_at
           FROM phase2_fills ORDER BY filled_at DESC LIMIT $1`,
          [limit]
        )
      ).rows;
      return {
        leaderboard_version: latest_version,
        top_creators,
        active_sessions,
        recent_positions,
        recent_risk_events,
        recent_fills,
      };
    });
  }

  async fetch_session_bundle(options: {
    session_id?: string | null;
    mint_id?: string | null;
  }): Promise<Record<string, unknown>> {
    const session_id = options.session_id ?? null;
    const mint_id = options.mint_id ?? null;
    if (!session_id && !mint_id) {
      throw new Error("session_id or mint_id is required for replay/export lookup.");
    }

    return this.withConnection(async (c) => {
      let session_row: Record<string, unknown> | undefined;
      if (session_id) {
        const r = await c.query(`SELECT * FROM phase2_trade_sessions WHERE session_id = $1`, [session_id]);
        session_row = r.rows[0];
      } else {
        const r = await c.query(
          `SELECT * FROM phase2_trade_sessions WHERE mint_id = $1 ORDER BY opened_at DESC LIMIT 1`,
          [mint_id]
        );
        session_row = r.rows[0];
      }

      if (!session_row) {
        return {
          session: null,
          orders: [],
          fills: [],
          holdings: [],
          decisions: [],
          position_journal: null,
          risk_events: [],
          strategy_profile: null,
          raw_events: [],
          leaderboard_generation: null,
          leaderboard_entries: [],
        };
      }

      const session = session_row;
      const sid = String(session.session_id);

      const position_journal = (
        await c.query(`SELECT * FROM phase2_position_journal WHERE session_id = $1`, [sid])
      ).rows[0];

      const risk_events = (
        await c.query(
          `SELECT * FROM phase2_risk_events WHERE session_id = $1 ORDER BY created_at ASC, event_id ASC`,
          [sid]
        )
      ).rows;

      let strategy_profile: Record<string, unknown> | null = null;
      if (position_journal?.strategy_profile) {
        const sp = await c.query(`SELECT * FROM phase2_strategy_profiles WHERE profile_key = $1`, [
          position_journal.strategy_profile,
        ]);
        strategy_profile = sp.rows[0] ?? null;
      }

      let leaderboard_generation: Record<string, unknown> | null = null;
      let leaderboard_entries: Record<string, unknown>[] = [];
      if (session.leaderboard_version) {
        const lg = await c.query(`SELECT * FROM phase2_leaderboard_generations WHERE version = $1`, [
          session.leaderboard_version,
        ]);
        leaderboard_generation = lg.rows[0] ?? null;
        const le = await c.query(
          `SELECT * FROM phase2_creator_snapshots WHERE leaderboard_version = $1 ORDER BY rank ASC`,
          [session.leaderboard_version]
        );
        leaderboard_entries = le.rows;
      }

      const decisions = (
        await c.query(
          `SELECT * FROM phase2_strategy_decisions WHERE session_id = $1 ORDER BY decided_at ASC, decision_id ASC`,
          [sid]
        )
      ).rows;

      const orders = (
        await c.query(
          `SELECT * FROM phase2_orders WHERE session_id = $1 ORDER BY created_at ASC, order_id ASC`,
          [sid]
        )
      ).rows;

      const fills = (
        await c.query(
          `SELECT * FROM phase2_fills WHERE session_id = $1 ORDER BY filled_at ASC, fill_id ASC`,
          [sid]
        )
      ).rows;

      const holdings = (
        await c.query(
          `SELECT * FROM phase2_holding_snapshots WHERE session_id = $1 ORDER BY recorded_at ASC, snapshot_id ASC`,
          [sid]
        )
      ).rows;

      const sessionOpened = (session.opened_at as Date) ?? utcNow();
      const sessionClosed = (session.closed_at as Date) ?? utcNow();
      const winStart = new Date(sessionOpened.getTime() - 60_000);
      const winEnd = new Date(sessionClosed.getTime() + 60_000);

      const raw_events = (
        await c.query(
          `SELECT * FROM phase2_raw_events WHERE mint_id = $1 AND observed_at >= $2 AND observed_at <= $3
           ORDER BY observed_at ASC, log_index ASC`,
          [session.mint_id, winStart, winEnd]
        )
      ).rows;

      return {
        session,
        orders,
        fills,
        holdings,
        decisions,
        position_journal: position_journal ?? null,
        risk_events,
        strategy_profile,
        raw_events,
        leaderboard_generation,
        leaderboard_entries,
      };
    });
  }

  async exportDataset(options: {
    kind: string;
    output_path: string;
    session_id?: string | null;
    mint_id?: string | null;
    leaderboard_version?: string | null;
    limit?: number | null;
  }): Promise<number> {
    const output_path = options.output_path;
    fs.mkdirSync(path.dirname(output_path), { recursive: true });
    const limit = options.limit === null || options.limit === undefined || options.limit <= 0 ? null : Math.floor(options.limit);

    const rows = await this.withConnection(async (c) => {
      if (options.kind === "sessions") {
        let q = "SELECT * FROM phase2_trade_sessions";
        const params: unknown[] = [];
        if (options.session_id) {
          q += " WHERE session_id = $1";
          params.push(options.session_id);
        } else if (options.mint_id) {
          q += " WHERE mint_id = $1";
          params.push(options.mint_id);
        }
        q += " ORDER BY opened_at DESC";
        if (limit) q += ` LIMIT ${limit}`;
        return (await c.query(q, params)).rows;
      }
      if (options.kind === "raw_events") {
        let q = "SELECT * FROM phase2_raw_events";
        const params: unknown[] = [];
        if (options.mint_id) {
          q += " WHERE mint_id = $1";
          params.push(options.mint_id);
        }
        q += " ORDER BY observed_at DESC";
        if (limit) q += ` LIMIT ${limit}`;
        return (await c.query(q, params)).rows;
      }
      if (options.kind === "leaderboard") {
        if (options.leaderboard_version) {
          return (
            await c.query(
              `SELECT * FROM phase2_creator_snapshots WHERE leaderboard_version = $1 ORDER BY rank ASC`,
              [options.leaderboard_version]
            )
          ).rows;
        }
        return (
          await c.query(`SELECT * FROM phase2_leaderboard_generations ORDER BY generated_at DESC LIMIT $1`, [
            limit ?? 50,
          ])
        ).rows;
      }
      if (options.kind === "positions") {
        let q = "SELECT * FROM phase2_position_journal ORDER BY updated_at DESC";
        if (limit) q += ` LIMIT ${limit}`;
        return (await c.query(q)).rows;
      }
      if (options.kind === "risk_events") {
        let q = "SELECT * FROM phase2_risk_events ORDER BY created_at DESC";
        if (limit) q += ` LIMIT ${limit}`;
        return (await c.query(q)).rows;
      }
      if (options.kind === "strategy_profiles") {
        let q = "SELECT * FROM phase2_strategy_profiles ORDER BY created_at DESC";
        if (limit) q += ` LIMIT ${limit}`;
        return (await c.query(q)).rows;
      }
      throw new Error(`Unsupported export kind: ${options.kind}`);
    });

    const handle = fs.createWriteStream(output_path, { encoding: "utf-8" });
    for (const row of rows) {
      handle.write(JSON.stringify(jsonSafe(row)) + "\n");
    }
    handle.end();
    await new Promise<void>((resolve, reject) => {
      handle.on("finish", () => resolve());
      handle.on("error", reject);
    });
    return rows.length;
  }
}

export class ReplayEngine {
  constructor(private readonly repository: SessionReplayRepository) {}

  async replay_session(options: { session_id?: string | null; mint_id?: string | null }): Promise<Record<string, unknown>> {
    const bundle = await this.repository.fetch_session_bundle(options);
    const session = bundle.session as Record<string, unknown> | null | undefined;
    if (!session) {
      throw new Error("No Phase 2 session was found for the requested identifier.");
    }

    const fills = (bundle.fills as Record<string, unknown>[]) ?? [];
    const decisions = (bundle.decisions as Record<string, unknown>[]) ?? [];
    const holdings = (bundle.holdings as Record<string, unknown>[]) ?? [];
    const position_journal = bundle.position_journal as Record<string, unknown> | null | undefined;
    const risk_events = (bundle.risk_events as Record<string, unknown>[]) ?? [];
    const strategy_profile = bundle.strategy_profile as Record<string, unknown> | null | undefined;
    const raw_events = (bundle.raw_events as Record<string, unknown>[]) ?? [];
    const orders = (bundle.orders as Record<string, unknown>[]) ?? [];

    const buy_fill = fills.find((f) => f.side === "buy");
    const sell_fill = [...fills].reverse().find((f) => f.side === "sell");

    const invariants: ReplayInvariant[] = [];
    if (buy_fill && sell_fill) {
      const expected_profit = Math.floor(
        Number(sell_fill.wallet_delta_lamports ?? sell_fill.proceeds_lamports ?? 0) -
          Number(buy_fill.cost_lamports ?? 0)
      );
      const recorded_profit = session.realized_profit_lamports;
      if (recorded_profit === null || recorded_profit === undefined) {
        invariants.push({
          name: "realized_profit_recorded",
          status: "warn",
          detail: "Replay derived realized profit, but the session summary did not store it.",
        });
      } else if (Number(recorded_profit) === expected_profit) {
        invariants.push({
          name: "realized_profit_matches_fills",
          status: "pass",
          detail: `sell wallet delta - buy cost = ${expected_profit} lamports.`,
        });
      } else {
        invariants.push({
          name: "realized_profit_matches_fills",
          status: "fail",
          detail: `Session stored ${recorded_profit} lamports but replay derived ${expected_profit} lamports.`,
        });
      }
    } else {
      invariants.push({
        name: "fills_present",
        status: "warn",
        detail: "Replay did not find both a buy fill and a sell fill for this session.",
      });
    }

    if (session.leaderboard_version) {
      invariants.push({
        name: "leaderboard_version_pinned",
        status: "pass",
        detail: `Session is pinned to leaderboard version ${session.leaderboard_version}.`,
      });
    } else {
      invariants.push({
        name: "leaderboard_version_pinned",
        status: "warn",
        detail: "Session is missing a leaderboard version reference.",
      });
    }

    const decision_types = new Set(decisions.map((d) => d.decision_type));
    if (decision_types.has("buy") || decision_types.has("sell")) {
      invariants.push({
        name: "decision_journal_present",
        status: "pass",
        detail: `Recorded decisions: ${[...decision_types].filter(Boolean).sort().join(", ")}.`,
      });
    } else {
      invariants.push({
        name: "decision_journal_present",
        status: "warn",
        detail: "Replay found no buy/sell decision rows for the session.",
      });
    }

    if (position_journal) {
      invariants.push({
        name: "position_journal_present",
        status: "pass",
        detail: `Position journal status=${position_journal.status}.`,
      });
    } else {
      invariants.push({
        name: "position_journal_present",
        status: "warn",
        detail: "Replay found no position journal row for the session.",
      });
    }

    if (strategy_profile) {
      invariants.push({
        name: "strategy_profile_pinned",
        status: "pass",
        detail: `Session uses strategy profile ${strategy_profile.profile_name} (${strategy_profile.version}).`,
      });
    } else {
      invariants.push({
        name: "strategy_profile_pinned",
        status: "warn",
        detail: "Replay found no pinned strategy profile for the session.",
      });
    }

    const timeline: Record<string, unknown>[] = [];
    for (const event of raw_events) {
      timeline.push({
        timestamp: event.observed_at,
        kind: "raw_event",
        event_type: event.event_type,
        fingerprint: event.fingerprint,
      });
    }
    for (const decision of decisions) {
      timeline.push({
        timestamp: decision.decided_at,
        kind: "decision",
        decision_type: decision.decision_type,
        reason: decision.reason,
      });
    }
    for (const order of orders) {
      timeline.push({
        timestamp: order.created_at,
        kind: "order",
        side: order.side,
        status: order.status,
        tx_id: order.tx_id,
      });
    }
    for (const fill of fills) {
      timeline.push({
        timestamp: fill.filled_at,
        kind: "fill",
        side: fill.side,
        tx_id: fill.tx_id,
      });
    }
    for (const holding of holdings) {
      timeline.push({
        timestamp: holding.recorded_at,
        kind: "holding",
        status: holding.status,
        token_balance: holding.token_balance,
      });
    }
    for (const event of risk_events) {
      timeline.push({
        timestamp: event.created_at,
        kind: "risk_event",
        event_type: event.event_type,
        severity: event.severity,
        detail: event.detail,
      });
    }
    timeline.sort(
      (a, b) =>
        String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")) ||
        String(a.kind).localeCompare(String(b.kind))
    );

    return {
      session: jsonSafe(session),
      strategy_profile: jsonSafe(strategy_profile),
      position_journal: jsonSafe(position_journal),
      leaderboard_generation: jsonSafe(bundle.leaderboard_generation),
      leaderboard_entries: jsonSafe(bundle.leaderboard_entries ?? []),
      counts: {
        raw_events: raw_events.length,
        decisions: decisions.length,
        orders: orders.length,
        fills: fills.length,
        holdings: holdings.length,
        risk_events: risk_events.length,
      },
      invariants: invariants.map((i) => jsonSafe(i) as Record<string, unknown>),
      timeline: jsonSafe(timeline),
    };
  }
}

export function renderReplayReport(report: Record<string, unknown>): string {
  const session = report.session as Record<string, unknown>;
  const counts = report.counts as Record<string, number>;
  const lines = [
    `session_id=${session.session_id} mint_id=${session.mint_id} owner=${session.owner}`,
    `status=${session.status} opened_at=${session.opened_at} closed_at=${session.closed_at}`,
    `counts raw_events=${counts.raw_events} decisions=${counts.decisions} orders=${counts.orders} fills=${counts.fills} holdings=${counts.holdings} risk_events=${counts.risk_events ?? 0}`,
  ];
  for (const inv of (report.invariants as Record<string, unknown>[]) ?? []) {
    lines.push(`${String(inv.status).toUpperCase().padEnd(4)} ${inv.name}: ${inv.detail}`);
  }
  return lines.join("\n");
}

export async function runReplay(
  db_dsn: string,
  options: { session_id?: string | null; mint_id?: string | null; as_json?: boolean }
): Promise<string> {
  const store = new Phase2Store(db_dsn);
  const engine = new ReplayEngine(store);
  const report = await engine.replay_session({
    session_id: options.session_id,
    mint_id: options.mint_id,
  });
  if (options.as_json) {
    return JSON.stringify(jsonSafe(report), null, 2);
  }
  return renderReplayReport(report);
}

export async function runExport(
  db_dsn: string,
  options: {
    config: AppConfig;
    kind: string;
    output_path?: string | null;
    session_id?: string | null;
    mint_id?: string | null;
    leaderboard_version?: string | null;
    limit?: number | null;
  }
): Promise<[string, number]> {
  const store = new Phase2Store(db_dsn, options.config);
  const export_dir = defaultExportDir(options.config);
  fs.mkdirSync(export_dir, { recursive: true });
  const stamp = utcNow().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const out =
    options.output_path ??
    path.join(export_dir, `${options.kind}-${stamp}.jsonl`);
  const count = await store.exportDataset({
    kind: options.kind,
    output_path: out,
    session_id: options.session_id,
    mint_id: options.mint_id,
    leaderboard_version: options.leaderboard_version,
    limit: options.limit,
  });
  return [out, count];
}
