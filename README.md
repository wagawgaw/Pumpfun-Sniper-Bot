# Dexter 3.0 (TypeScript) — `dexter-ts`

This directory is the **TypeScript port** of Dexter: a Solana tooling stack aimed at Pump.fun and PumpSwap workflows, Phase2 data, operator controls, and strategy research. The **canonical full runtime** (TUI, live trader, collector, analyzer, Pump.fun create flows, and Windows managed PostgreSQL setup) lives in the Python package under [`../Dexter`](../Dexter).

**Dexter-ts** focuses on **CLI tooling** that compiles with **Node.js 20+**, shares the same `.env` model as Python Dexter, and implements a **subset** of commands. There is **no curses TUI** in this port.

## Quick install (from GitHub)

Repository: <https://github.com/Nexorythm/Pumpfun-Sniper-Bot>

### 1) Clone and enter the project

```bash
git clone https://github.com/Nexorythm/Pumpfun-Sniper-Bot.git
cd Pumpfun-Sniper-Bot
```

### 2) Install Node.js dependencies

```bash
npm install
```

### 3) Create your local environment file

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### 4) Build and run a basic health check

```bash
npm run build
node dist/Dexter.js doctor --network devnet --mode read_only
```

If PostgreSQL is already installed and running, initialize schema once:

```bash
node dist/Dexter.js database-init
```

<div align="center">

<img width="512" height="512" alt="image" src="https://github.com/user-attachments/assets/d00e5aaa-fea4-40cb-bb33-10e3836a1fd5" />

</div>

## Relationship to Python Dexter

| Area | Python `../Dexter` | This package `dexter-ts` |
|------|--------------------|---------------------------|
| Interactive TUI (`dexter`, `dexter menu`) | Yes | **Not implemented** — use CLI only |
| Live trader / collector / analyzer loops | Yes | **Not ported** — commands exit with a pointer to Python |
| `database-setup` (managed Windows PostgreSQL) | Yes | **Not implemented** — use Python Dexter or install PostgreSQL yourself |
| `database-init`, doctor, export, replay, backtest, dashboard, control | Yes | **Implemented** (with minor doctor differences noted below) |
| `verify-migration` | Yes | **Implemented** (TS harness) |

## Install and build

From the `Dexter-ts` directory:

```bash
npm install
npm run build
```

Compiled output is written to `dist/`. Re-run `npm run build` after pulling changes.

### Environment

```bash
cp .env.example .env
```

Edit `.env` using the same variables as Python Dexter (see [.env.example](.env.example)). Minimum expectations for serious use:

- **Database**: PostgreSQL reachable via `DATABASE_URL` or the `DB_*` fields Dexter resolves
- **Wallet**: `PRIVATE_KEY` or `DEXTER_TRADING_PRIVATE_KEY` when modes require signing
- **RPC**: `HTTP_URL` and `WS_URL` for your chosen network
- **Safety**: keep `DEXTER_MAINNET_DRY_RUN=true` and `DEXTER_ALLOW_MAINNET_LIVE=false` until you intentionally enable live mainnet

### PostgreSQL bootstrap

Dexter-ts still expects **PostgreSQL-backed** operation for Phase2 features.

- **Schema only** (server already running):

  ```bash
  node dist/Dexter.js database-init
  ```

- **Managed Windows cluster / WinGet installer**: run `dexter database-setup` from the **Python** package, or use the scripts in this repo if you maintain them yourself:

  ```bash
  # Linux / macOS (if you use the bundled script)
  ./install_postgre.sh
  ```

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\install_postgres_windows.ps1
  ```

`dexter database-setup` invoked **from this TypeScript build** is intentionally unimplemented and will error; use Python Dexter or manual installation.

## How to run the CLI

Subcommands are registered on a Commander program named `dexter`. You can invoke them in either of these ways:

```bash
# Direct (recommended): arguments after the entry script
node dist/Dexter.js doctor --network mainnet --mode read_only

# Explicit "cli" prefix (same parser)
node dist/Dexter.js cli doctor --network mainnet --mode read_only
```

npm scripts:

```bash
npm run cli -- help
npm run cli -- doctor --network devnet --mode read_only
```

**Do not** run `node dist/Dexter.js` with no arguments, or `menu` / `interactive`, expecting a TUI — the port prints a short message and exits; use the CLI forms above.

### Windows PowerShell quick start

```powershell
cd Dexter-ts
npm install
npm run build
Copy-Item .env.example .env
# Configure .env, then:
node dist/Dexter.js database-init
node dist/Dexter.js doctor --network mainnet --mode read_only
```

## Mainnet safety model

Same conceptual model as Python Dexter:

- `read_only`: observe-oriented configuration loading
- `paper`: paper-style runtime (full loop still Python-only here)
- `simulate` / `live`: signing and submission modes where implemented upstream; **live trading loops are not in Dexter-ts**

Mainnet rules:

- `DEXTER_MAINNET_DRY_RUN=true` keeps mainnet `live` in safer behavior where applicable
- real mainnet sends require both `DEXTER_MAINNET_DRY_RUN=false` and `DEXTER_ALLOW_MAINNET_LIVE=true`
- `USE_MEV` applies to live mainnet buy/sell in the Python trader, not in this TS subset

## Useful examples (Dexter-ts)

```bash
npm run build

# Health check
node dist/Dexter.js doctor --network mainnet --mode read_only

# Operator dashboard
node dist/Dexter.js dashboard --network mainnet --watch

# Export Phase2 data
node dist/Dexter.js export --kind leaderboard --network mainnet --output ./out.jsonl

# Backtest (optional --input JSON/JSONL; otherwise uses internal/offline paths as implemented)
node dist/Dexter.js backtest --network devnet --strategy balanced

# Replay session
node dist/Dexter.js replay --network mainnet --session-id <id>

# Migration harness
node dist/Dexter.js verify-migration --network devnet
```

Commands that **exit and ask you to use Python Dexter** include: `run` (after optional `doctor-first`), `trade`, `collector`, `analyze`, `create`, `manage`. Use [`../Dexter`](../Dexter) for those flows.

## Command reference (TypeScript)

Global help:

```bash
node dist/Dexter.js help
node dist/Dexter.js help doctor
```

### Implemented in Dexter-ts

- **`doctor`** — env validation, database connectivity, HTTP RPC probe, wallet decode, writable paths. WebSocket RPC is reported as configured only (**live WS probe not implemented** in TS). Backup tooling (`pg_dump`) is a **warning** without executable verification.
- **`database-init`** — bootstrap or repair schema when PostgreSQL is already available.
- **`export`** — Phase2 exports (`--kind` required): `sessions`, `raw_events`, `leaderboard`, `positions`, `risk_events`, `strategy_profiles`.
- **`replay`** — normalized Phase2 replay; requires `--session-id` or `--mint-id`.
- **`backtest`** — offline strategy evaluation; optional `--input`, `--strategy`, `--limit`, `--json`.
- **`dashboard`** — operator dashboard; `--watch`, `--interval`, `--limit`, `--json`.
- **`control`** — `pause`, `resume`, `force-sell`, `blacklist`, `whitelist`, `watchlist-add`, `watchlist-remove` (with required `--owner` / `--mint` where applicable).
- **`verify-migration`** — migration harness (`--json` supported).

### Stubs / Python-only (Dexter-ts)

- **`run` / `start`** — may run `doctor` when `--doctor-first` is set; then exits toward Python for `trade` / `collector` / `analyze` targets.
- **`trade`**, **`collector`**, **`analyze`**, **`create`**, **`manage`** — not implemented in TS.
- **`database-setup`** — not implemented; use Python Dexter or external install paths.

## Configuration surface (no TUI)

There are no interactive settings pages in this port. Configure everything through **`.env`** (see `.env.example`), grouped similarly to Python Dexter:

- **Quick essentials**: `DEXTER_NETWORK`, `DEXTER_RUNTIME_MODE`, `PRIVATE_KEY`, `DATABASE_URL`, `HTTP_URL`, `WS_URL`
- **Runtime & safety**: `DEXTER_ENABLE_WSLOGS`, `DEXTER_DATASTORE_ENABLED`, `DEXTER_CLOSE_POSITIONS_ON_SHUTDOWN`, `DEXTER_MAINNET_DRY_RUN`, `DEXTER_ALLOW_MAINNET_LIVE`
- **Risk & strategy**: `DEXTER_STRATEGY_PROFILE`, caps, reserve floor, drawdown stops, retry knobs
- **Alerts & paths**: Telegram, Discord, desktop notifications, log/state/export/backup directories

For a single-command flag reference, use `node dist/Dexter.js help <command>`.

## Operator notes

- `PRIVATE_KEY` is the default signer where the stack expects a key; `DEXTER_TRADING_PRIVATE_KEY` can override the trading signer in the full Python runtime.
- `DATABASE_URL` is the preferred single DSN; Dexter also composes a DSN from `DB_*` when set.
- For the **full** Pump.fun creator leaderboard, automated buying, and TUI experience, run **[`../Dexter`](../Dexter)** (Python).
