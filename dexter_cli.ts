import { Command } from "commander";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
  currentUtcTimestamp,
  ensureDirectories,
  loadConfig,
  validateConfig,
} from "./dexter_config";
import { run as runDatabaseInit } from "./database";
import { runWindowsSetup } from "./database_setup";
import { runMigrationHarness } from "./dexter_migration_harness";
import { Phase2Store, runExport, runReplay } from "./dexter_phase2";
import {
  addWatchlistMint,
  blacklistOwner,
  pauseEntries,
  queueForceSell,
  removeWatchlistMint,
  resumeEntries,
  runDashboard,
  whitelistOwner,
} from "./dexter_operator";
import {
  backtestRecords,
  getStrategyProfile,
  loadRecordsFromJson,
  renderBacktestReport,
  serializeStrategyProfile,
} from "./dexter_strategy";
import { ensureLocalPostgresRunning } from "./dexter_local_postgres";
import { cc } from "./DexLab/colors";
import { PRICE_STEP_UNITS } from "./settings";

const PROCESS_ENV_DEXTER_NETWORK = process.env.DEXTER_NETWORK;

function resolveCliNetwork(cmd: Command): [string, string | null] {
  const opts = cmd.opts() as { network?: string };
  const requested = opts.network;
  if (requested) return [requested, null];
  const envNetwork = (PROCESS_ENV_DEXTER_NETWORK ?? "").trim().toLowerCase();
  if (envNetwork === "mainnet" || envNetwork === "devnet") return [envNetwork, null];
  return [
    "devnet",
    "DEXTER_NETWORK is unset; defaulting this command to devnet. Pass --network mainnet to inspect mainnet under the existing safety gates.",
  ];
}

function loadCliConfig(cmd: Command): { config: ReturnType<typeof loadConfig>; warning: string | null } {
  const opts = cmd.opts() as { mode?: string; network?: string };
  const [network, warning] = resolveCliNetwork(cmd);
  return { config: loadConfig(opts.mode ?? null, network), warning };
}

function statusSymbol(status: string): string {
  return (
    { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" }[status] ?? status.toUpperCase()
  );
}

async function checkDatabase(config: ReturnType<typeof loadConfig>): Promise<{
  title: string;
  status: string;
  detail: string;
}> {
  if (!config.database.dsn) {
    return { title: "Database", status: "fail", detail: "DATABASE_URL or DB_* variables are not configured." };
  }
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: config.database.dsn, connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return {
      title: "Database",
      status: "pass",
      detail: `Connected to ${config.database.host}:${config.database.port}/${config.database.name}.`,
    };
  } catch (exc) {
    return { title: "Database", status: "fail", detail: `Connection failed: ${exc}` };
  }
}

async function checkHttpRpc(config: ReturnType<typeof loadConfig>): Promise<{
  title: string;
  status: string;
  detail: string;
}> {
  if (!config.rpc.http_url) return { title: "HTTP RPC", status: "fail", detail: "Resolved HTTP RPC URL is missing." };
  try {
    const response = await fetch(config.rpc.http_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
    });
    if (!response.ok) {
      return { title: "HTTP RPC", status: "fail", detail: `HTTP ${response.status}` };
    }
    return { title: "HTTP RPC", status: "pass", detail: "Endpoint responded." };
  } catch (exc) {
    return { title: "HTTP RPC", status: "fail", detail: String(exc) };
  }
}

async function checkWsRpc(config: ReturnType<typeof loadConfig>): Promise<{
  title: string;
  status: string;
  detail: string;
}> {
  if (!config.rpc.ws_url) return { title: "WebSocket RPC", status: "fail", detail: "Resolved WebSocket RPC URL is missing." };
  return { title: "WebSocket RPC", status: "pass", detail: "URL configured (live WS probe not implemented in TS doctor)." };
}

function checkWallet(config: ReturnType<typeof loadConfig>, component: string): {
  title: string;
  status: string;
  detail: string;
} {
  if (!config.rpc.private_key) {
    if (
      (component === "trader" || component === "all") &&
      (config.runtime.mode === "simulate" || config.runtime.mode === "live")
    ) {
      return {
        title: "Wallet",
        status: "fail",
        detail: "PRIVATE_KEY is required for simulate/live trader mode.",
      };
    }
    return { title: "Wallet", status: "warn", detail: "PRIVATE_KEY is not configured." };
  }
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(config.rpc.private_key));
    return { title: "Wallet", status: "pass", detail: `Decoded wallet ${kp.publicKey.toBase58()}.` };
  } catch (exc) {
    return { title: "Wallet", status: "fail", detail: `PRIVATE_KEY could not be decoded: ${exc}` };
  }
}

function checkDirectories(config: ReturnType<typeof loadConfig>): {
  title: string;
  status: string;
  detail: string;
} {
  try {
    const probe = path.join(config.paths.log_dir, ".dexter_write_probe");
    fs.mkdirSync(config.paths.log_dir, { recursive: true });
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.unlinkSync(probe);
    return { title: "Writable Paths", status: "pass", detail: "log_dir is writable." };
  } catch (exc) {
    return { title: "Writable Paths", status: "fail", detail: String(exc) };
  }
}

function checkPgDump(config: ReturnType<typeof loadConfig>): {
  title: string;
  status: string;
  detail: string;
} {
  const which = config.backup.pg_dump_path || "pg_dump";
  return {
    title: "Backup Tooling",
    status: "warn",
    detail: `pg_dump path=${which} (executable probe not implemented in TS doctor).`,
  };
}

async function runDoctorOpts(options: {
  mode?: string | null;
  network?: string | null;
  component?: string | null;
}): Promise<number> {
  let config: ReturnType<typeof loadConfig>;
  try {
    const net = (options.network ?? "").trim();
    const network =
      net ||
      (() => {
        const envNetwork = (PROCESS_ENV_DEXTER_NETWORK ?? "").trim().toLowerCase();
        if (envNetwork === "mainnet" || envNetwork === "devnet") return envNetwork;
        return "devnet";
      })();
    config = loadConfig(options.mode ?? null, network);
  } catch (exc) {
    console.log(`[${currentUtcTimestamp()}] FAIL  Config: ${exc}`);
    return 1;
  }

  const component = options.component ?? "all";
  const envCheck =
    component === "all"
      ? (() => {
          const [e1, w1] = validateConfig(config, "collector");
          const [e2, w2] = validateConfig(config, "trader");
          const errors = [...new Set([...e1, ...e2])].sort();
          const warnings = [...new Set([...w1, ...w2])].sort();
          if (errors.length) {
            return { title: "Environment", status: "fail", detail: errors.join("; ") };
          }
          if (warnings.length) {
            return { title: "Environment", status: "warn", detail: warnings.join("; ") };
          }
          return {
            title: "Environment",
            status: "pass",
            detail: "Required variables and safety gates look valid.",
          };
        })()
      : (() => {
          const [errors, warnings] = validateConfig(config, component as "collector" | "trader");
          if (errors.length) return { title: "Environment", status: "fail", detail: errors.join("; ") };
          if (warnings.length) return { title: "Environment", status: "warn", detail: warnings.join("; ") };
          return {
            title: "Environment",
            status: "pass",
            detail: "Required variables and safety gates look valid.",
          };
        })();

  const checks = [
    envCheck,
    await checkDatabase(config),
    await checkHttpRpc(config),
    await checkWsRpc(config),
    checkWallet(config, component),
    checkDirectories(config),
    checkPgDump(config),
  ];

  let exitCode = 0;
  for (const check of checks) {
    if (check.status === "fail") exitCode = 1;
    console.log(
      `[${currentUtcTimestamp()}] ${statusSymbol(check.status).padEnd(5)} ${check.title}: ${check.detail}`
    );
  }
  return exitCode;
}

async function runDoctor(cmd: Command): Promise<number> {
  const opts = cmd.opts() as { mode?: string; network?: string; component?: string };
  const [network] = resolveCliNetwork(cmd);
  return runDoctorOpts({ mode: opts.mode ?? null, network, component: opts.component ?? "all" });
}

function notPorted(name: string): never {
  console.error(
    `${name} is not implemented in Dexter-ts yet. Use the Python Dexter package in ../Dexter for the full trading runtime.`
  );
  process.exit(1);
  throw new Error("unreachable");
}

export function buildProgram(): Command {
  const program = new Command("dexter")
    .description("Dexter runtime tooling (TypeScript port)")
    .configureHelp({ helpWidth: 100 });

  program
    .command("run")
    .alias("start")
    .description("Guided runtime entrypoint")
    .option("--mode <mode>", "DEXTER_RUNTIME_MODE override")
    .option("--network <net>", "devnet or mainnet")
    .option("--target <t>", "trade|collector|analyze", "trade")
    .option("--doctor-first", "Run doctor first")
    .action(async (options, cmd) => {
      const { config, warning } = loadCliConfig(cmd);
      if (warning) console.log(`[${currentUtcTimestamp()}] WARN  Start: ${warning}`);
      console.log(
        `${cc.LIGHT_CYAN}Dexter Start${cc.RESET} intent=start:${options.target} mode=${config.runtime.mode} network=${config.runtime.network}`
      );
      if (options.doctorFirst) {
        const [network] = resolveCliNetwork(cmd);
        const comp = options.target === "trade" ? "all" : options.target;
        const code = await runDoctorOpts({
          mode: options.mode ?? null,
          network,
          component: comp,
        });
        if (code !== 0) process.exit(code);
      }
      if (options.target === "trade") notPorted("dexter run --target trade");
      if (options.target === "collector") notPorted("dexter run --target collector");
      notPorted("dexter run --target analyze");
    });

  program
    .command("create")
    .description("Create / seeded session (Python only for now)")
    .option("--mode <mode>")
    .option("--network <net>")
    .option("--mint <mint>")
    .option("--owner <owner>")
    .option("--profit-target-pct <n>", "Seeded target percentage", String(PRICE_STEP_UNITS))
    .action(() => notPorted("dexter create"));

  program
    .command("manage")
    .description("Manage positions (Python only for now)")
    .option("--mode <mode>")
    .option("--network <net>")
    .action(() => notPorted("dexter manage"));

  program
    .command("doctor")
    .description("Validate environment and connectivity")
    .option("--mode <mode>")
    .option("--network <net>")
    .option("--component <c>", "all|collector|trader", "all")
    .action(async (_opts, cmd) => {
      process.exitCode = await runDoctor(cmd);
    });

  program
    .command("collector")
    .description("Log collector (Python only)")
    .option("--mode <mode>")
    .option("--network <net>")
    .action(() => notPorted("dexter collector"));

  program
    .command("trade")
    .description("Trader (Python only)")
    .option("--mode <mode>")
    .option("--network <net>")
    .action(() => notPorted("dexter trade"));

  program
    .command("analyze")
    .description("Creator analyzer (Python only)")
    .option("--mode <mode>")
    .option("--network <net>")
    .action(() => notPorted("dexter analyze"));

  program
    .command("replay")
    .description("Replay normalized Phase2 session")
    .option("--mode <mode>")
    .option("--network <net>")
    .option("--session-id <id>")
    .option("--mint-id <id>")
    .option("--json", "JSON report")
    .action(async (_opts, cmd) => {
      const opts = cmd.opts() as { sessionId?: string; mintId?: string; json?: boolean; mode?: string };
      if (!opts.sessionId && !opts.mintId) {
        console.log(`[${currentUtcTimestamp()}] FAIL  Replay: provide --session-id or --mint-id.`);
        process.exitCode = 1;
        return;
      }
      const { config } = loadCliConfig(cmd);
      const [errors, warnings] = validateConfig(config, "analyze");
      if (errors.length) {
        for (const e of errors) console.log(`[${currentUtcTimestamp()}] FAIL  Replay: ${e}`);
        process.exitCode = 1;
        return;
      }
      for (const w of warnings) console.log(`[${currentUtcTimestamp()}] WARN  Replay: ${w}`);
      ensureLocalPostgresRunning(config);
      const out = await runReplay(config.database.dsn, {
        session_id: opts.sessionId,
        mint_id: opts.mintId,
        as_json: opts.json,
      });
      console.log(out);
    });

  program
    .command("backtest")
    .description("Offline strategy evaluation")
    .option("--mode <mode>")
    .option("--network <net>")
    .option("--strategy <s>")
    .option("--input <path>")
    .option("--limit <n>", undefined, "250")
    .option("--json")
    .action(async (_opts, cmd) => {
      const opts = cmd.opts() as { strategy?: string; input?: string; limit?: string; json?: boolean };
      const { config } = loadCliConfig(cmd);
      ensureLocalPostgresRunning(config);
      ensureDirectories(config);
      const profile = getStrategyProfile(opts.strategy ?? config.strategy.default_profile);
      let records: Record<string, unknown>[] = [];
      if (opts.input) {
        records = loadRecordsFromJson(opts.input);
      }
      const report = backtestRecords(records, { profile });
      if (config.phase2.enabled && config.database.dsn) {
        const store = new Phase2Store(config.database.dsn, config);
        await store.ensureSchema();
        await store.ensureStrategyProfile({
          profile_key: profile.name,
          profile_name: profile.name,
          version: profile.version,
          definition: serializeStrategyProfile(profile) as Record<string, unknown>,
          metadata: { source: "dexter.backtest" },
        });
        await store.recordBacktestRun({
          profile_key: profile.name,
          input_source: opts.input ?? "database:stagnant_mints",
          report: report as Record<string, unknown>,
        });
      }
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else console.log(renderBacktestReport(report));
    });

  program
    .command("verify-migration")
    .description("Migration harness (Python only)")
    .option("--mode <mode>")
    .option("--network <net>")
    .option("--json")
    .action(async (_opts, cmd) => {
      const { config } = loadCliConfig(cmd);
      try {
        process.exitCode = await runMigrationHarness({
          config,
          as_json: (cmd.opts() as { json?: boolean }).json,
        });
      } catch (exc) {
        console.error(exc);
        process.exitCode = 1;
      }
    });

  program
    .command("export")
    .description("Export Phase2 datasets")
    .requiredOption("--kind <kind>", "sessions|raw_events|leaderboard|positions|risk_events|strategy_profiles")
    .option("--mode <mode>")
    .option("--network <net>")
    .option("--output <path>")
    .option("--session-id <id>")
    .option("--mint-id <id>")
    .option("--leaderboard-version <v>")
    .option("--limit <n>")
    .action(async (_opts, cmd) => {
      const opts = cmd.opts() as {
        kind: string;
        output?: string;
        sessionId?: string;
        mintId?: string;
        leaderboardVersion?: string;
        limit?: string;
      };
      const { config } = loadCliConfig(cmd);
      const [errors, warnings] = validateConfig(config, "analyze");
      if (errors.length) {
        for (const e of errors) console.log(`[${currentUtcTimestamp()}] FAIL  Export: ${e}`);
        process.exitCode = 1;
        return;
      }
      for (const w of warnings) console.log(`[${currentUtcTimestamp()}] WARN  Export: ${w}`);
      ensureLocalPostgresRunning(config);
      const [outPath, count] = await runExport(config.database.dsn, {
        config,
        kind: opts.kind,
        output_path: opts.output ?? null,
        session_id: opts.sessionId ?? null,
        mint_id: opts.mintId ?? null,
        leaderboard_version: opts.leaderboardVersion ?? null,
        limit: opts.limit ? parseInt(opts.limit, 10) : null,
      });
      console.log(`[${currentUtcTimestamp()}] PASS  Export: wrote ${count} row(s) to ${outPath}`);
    });

  program
    .command("dashboard")
    .description("Operator dashboard")
    .option("--mode <mode>")
    .option("--network <net>")
    .option("--watch")
    .option("--interval <s>", undefined, "2")
    .option("--limit <n>", undefined, "5")
    .option("--json")
    .action(async (_opts, cmd) => {
      const opts = cmd.opts() as { watch?: boolean; interval?: string; limit?: string; json?: boolean };
      const { config } = loadCliConfig(cmd);
      ensureLocalPostgresRunning(config);
      ensureDirectories(config);
      process.exitCode = await runDashboard(config, {
        watch: opts.watch,
        interval: parseFloat(opts.interval ?? "2"),
        as_json: opts.json,
        limit: parseInt(opts.limit ?? "5", 10),
      });
    });

  program
    .command("control")
    .description("Operator controls")
    .argument("<action>", "pause|resume|force-sell|blacklist|whitelist|watchlist-add|watchlist-remove")
    .option("--mode <mode>")
    .option("--network <net>")
    .option("--owner <o>")
    .option("--mint <m>")
    .option("--reason <r>", undefined, "operator_force_sell")
    .action((action, _extra, cmd) => {
      const opts = cmd.opts() as { owner?: string; mint?: string; reason?: string };
      const { config } = loadCliConfig(cmd);
      ensureDirectories(config);
      const ts = currentUtcTimestamp();
      if (action === "pause") {
        pauseEntries(config);
        console.log(`[${ts}] PASS  Control: new entries paused via ${config.runtime.emergency_stop_file}`);
        return;
      }
      if (action === "resume") {
        resumeEntries(config);
        console.log(`[${ts}] PASS  Control: new entries resumed.`);
        return;
      }
      if (action === "force-sell") {
        if (!opts.mint) {
          console.log(`[${ts}] FAIL  Control: --mint is required for force-sell.`);
          process.exitCode = 1;
          return;
        }
        queueForceSell(config, opts.mint, opts.reason ?? "operator_force_sell");
        console.log(`[${ts}] PASS  Control: queued force-sell for ${opts.mint}.`);
        return;
      }
      if (action === "blacklist") {
        if (!opts.owner) {
          console.log(`[${ts}] FAIL  Control: --owner is required for blacklist.`);
          process.exitCode = 1;
          return;
        }
        const entries = blacklistOwner(config, opts.owner);
        console.log(`[${ts}] PASS  Control: blacklisted ${opts.owner}. entries=${entries.length}`);
        return;
      }
      if (action === "whitelist") {
        if (!opts.owner) {
          console.log(`[${ts}] FAIL  Control: --owner is required for whitelist.`);
          process.exitCode = 1;
          return;
        }
        const entries = whitelistOwner(config, opts.owner);
        console.log(`[${ts}] PASS  Control: removed ${opts.owner} from blacklist. entries=${entries.length}`);
        return;
      }
      if (action === "watchlist-add") {
        if (!opts.mint) {
          console.log(`[${ts}] FAIL  Control: --mint is required for watchlist-add.`);
          process.exitCode = 1;
          return;
        }
        const entries = addWatchlistMint(config, opts.mint);
        console.log(`[${ts}] PASS  Control: added ${opts.mint} to watchlist. entries=${entries.length}`);
        return;
      }
      if (action === "watchlist-remove") {
        if (!opts.mint) {
          console.log(`[${ts}] FAIL  Control: --mint is required for watchlist-remove.`);
          process.exitCode = 1;
          return;
        }
        const entries = removeWatchlistMint(config, opts.mint);
        console.log(`[${ts}] PASS  Control: removed ${opts.mint} from watchlist. entries=${entries.length}`);
        return;
      }
      console.log(`[${ts}] FAIL  Control: unsupported action ${action}.`);
      process.exitCode = 1;
    });

  program
    .command("database-setup")
    .description("Windows PostgreSQL setup (Python implementation)")
    .allowUnknownOption(true)
    .action(() => {
      try {
        process.exitCode = runWindowsSetup(program.opts());
      } catch (exc) {
        console.log(`[${currentUtcTimestamp()}] FAIL  Database setup: ${exc}`);
        process.exitCode = 1;
      }
    });

  program
    .command("database-init")
    .description("Bootstrap DB schema")
    .option("--network <net>")
    .action(async (_opts, cmd) => {
      const opts = cmd.opts() as { network?: string };
      try {
        process.exitCode = await runDatabaseInit(null, opts.network ?? null);
      } catch (exc) {
        console.log(`[${currentUtcTimestamp()}] FAIL  Database init: ${exc}`);
        process.exitCode = 1;
      }
    });

  return program;
}

export async function legacyMainAsync(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    const program = buildProgram();
    if (args.length === 1) {
      program.help();
      return 0;
    }
    const sub = args[1]!;
    program.showHelpAfterError(false);
    try {
      await program.parseAsync([sub, "--help"], { from: "user" });
    } catch {
      console.log(`[${currentUtcTimestamp()}] FAIL  Help: unknown command '${sub}'.`);
      program.help();
      return 1;
    }
    return 0;
  }

  const program = buildProgram();
  try {
    await program.parseAsync(args, { from: "user" });
    const code = process.exitCode;
    return typeof code === "number" && code !== 0 ? code : 0;
  } catch (exc) {
    console.error(exc);
    return 1;
  }
}

