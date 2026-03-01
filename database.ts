import { Client } from "pg";
import {
  ENV_PATH,
  ensureDirectories,
  loadConfig,
  loadEnvFile,
  logStartupSummary,
  updateEnvFile,
  validateConfig,
} from "./dexter_config";
import { PHASE2_SCHEMA_STATEMENTS } from "./phase2_schema";
import {
  applyManagedPostgresStateToEnvironment,
  ensureLocalPostgresRunning,
  loadManagedPostgresState,
  managedStateToEnvUpdates,
  persistManagedPostgresStateFromConfig,
} from "./dexter_local_postgres";

function quoteIdent(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function connectionHelp(config: ReturnType<typeof loadConfig>, exc: unknown, admin: boolean): string {
  const host = admin ? config.database.admin_host : config.database.host;
  const port = admin ? config.database.admin_port : config.database.port;
  const role = admin ? config.database.admin_user : config.database.user;
  const target = admin ? "PostgreSQL admin connection" : "Dexter app database";
  let message = `Unable to reach the ${target} at ${host}:${port} as ${role}: ${exc}. `;
  message +=
    "Make sure PostgreSQL is installed, the local PostgreSQL server is running, and the configured password is correct.";
  if (process.platform === "win32") {
    message +=
      " On Windows, the easiest fix is `dexter database-setup`, which repairs Dexter's local postgres admin password, app role, database, and tables for you.";
  } else {
    message += " On Linux, run `./install_postgre.sh` if PostgreSQL is not installed yet.";
  }
  return message;
}

const BASE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS mints (
    mint_id TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    owner TEXT,
    market_cap DOUBLE PRECISION,
    price_history TEXT,
    price_usd DOUBLE PRECISION,
    liquidity DOUBLE PRECISION,
    open_price DOUBLE PRECISION,
    high_price DOUBLE PRECISION,
    low_price DOUBLE PRECISION,
    current_price DOUBLE PRECISION,
    age DOUBLE PRECISION DEFAULT 0,
    tx_counts TEXT,
    volume TEXT,
    holders TEXT,
    mint_sig TEXT,
    bonding_curve TEXT,
    created INT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS stagnant_mints (
    mint_id TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    owner TEXT,
    holders TEXT,
    price_history TEXT,
    tx_counts TEXT,
    volume TEXT,
    peak_price_change DOUBLE PRECISION,
    peak_market_cap DOUBLE PRECISION,
    final_market_cap DOUBLE PRECISION,
    final_ohlc TEXT,
    mint_sig TEXT,
    bonding_curve TEXT,
    slot_delay TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE INDEX IF NOT EXISTS idx_mints_mint_id ON mints(mint_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stagnant_mints_mint_id ON stagnant_mints(mint_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mints_timestamp ON mints(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_stagnant_mints_timestamp ON stagnant_mints(timestamp)`,
];

export async function initializeDb(
  modeOverride?: string | null,
  networkOverride?: string | null
): Promise<void> {
  loadEnvFile();
  if (applyManagedPostgresStateToEnvironment()) {
    const managed = loadManagedPostgresState();
    if (managed) updateEnvFile(managedStateToEnvUpdates(managed), ENV_PATH);
  }
  const config = loadConfig(modeOverride, networkOverride);
  ensureLocalPostgresRunning(config);
  const [errors, warnings] = validateConfig(config, "database");
  if (errors.length) throw new Error(errors.join("; "));
  for (const w of warnings) console.warn(`WARN: ${w}`);

  ensureDirectories(config);
  logStartupSummary({ info: (m: string) => console.info(m) }, config, "database");

  let client: Client | null = null;
  try {
    client = new Client({ connectionString: config.database.dsn });
    await client.connect();
    console.log(`Database '${config.database.name}' is already reachable; continuing with schema bootstrap.`);
  } catch {
    await client?.end().catch(() => undefined);
    client = null;
  }

  let adminClient: Client | null = null;
  let adminError: unknown = null;
  if (config.database.admin_dsn) {
    try {
      adminClient = new Client({ connectionString: config.database.admin_dsn });
      await adminClient.connect();
    } catch (exc) {
      adminError = exc;
      if (client === null) throw new Error(connectionHelp(config, exc, true));
    }
  }

  if (adminClient) {
    try {
      const userExists = await adminClient.query("SELECT 1 FROM pg_roles WHERE rolname = $1;", [
        config.database.user,
      ]);
      if (!userExists.rowCount) {
        await adminClient.query(
          `CREATE USER ${quoteIdent(config.database.user)} WITH PASSWORD ${quoteLiteral(config.database.password)};`
        );
        console.log(`User '${config.database.user}' created.`);
      } else {
        await adminClient.query(
          `ALTER USER ${quoteIdent(config.database.user)} WITH PASSWORD ${quoteLiteral(config.database.password)};`
        );
        console.log(`User '${config.database.user}' password refreshed.`);
      }

      const dbExists = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1;", [
        config.database.name,
      ]);
      if (!dbExists.rowCount) {
        await adminClient.query(
          `CREATE DATABASE ${quoteIdent(config.database.name)} OWNER ${quoteIdent(config.database.user)};`
        );
        console.log(`Database '${config.database.name}' created.`);
      }
    } finally {
      await adminClient.end();
    }
  } else if (adminError && client === null) {
    throw new Error(connectionHelp(config, adminError, true));
  }

  if (client === null) {
    try {
      client = new Client({ connectionString: config.database.dsn });
      await client.connect();
    } catch (exc) {
      throw new Error(connectionHelp(config, exc, false));
    }
  }

  try {
    for (const statement of BASE_STATEMENTS) {
      await client.query(statement);
    }
    if (config.phase2.enabled) {
      for (const statement of PHASE2_SCHEMA_STATEMENTS) {
        await client.query(statement);
      }
    }
  } finally {
    await client.end();
  }

  const persisted = persistManagedPostgresStateFromConfig(config);
  if (persisted) {
    const managed = loadManagedPostgresState();
    if (managed) updateEnvFile(managedStateToEnvUpdates(managed), ENV_PATH);
  }
  console.log("PostgreSQL database, tables, and indexes initialized successfully.");
}

export async function run(
  modeOverride?: string | null,
  networkOverride?: string | null
): Promise<number> {
  try {
    await initializeDb(modeOverride, networkOverride);
    return 0;
  } catch (exc) {
    console.error(exc);
    return 1;
  }
}
