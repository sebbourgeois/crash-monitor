<div align="center">

# Crash Monitor

**Real-time capture, storage and analysis of the Stake.com and Shuffle.com Crash game feeds.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/storage-SQLite%20WAL-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)](./DOCKER.md)
[![Read only](https://img.shields.io/badge/mode-read--only-blue?style=flat-square)](#)
[![Archive](https://img.shields.io/badge/archive-538k%20rounds-8b5cf6?style=flat-square)](#published-archive)

</div>

A headless browser attaches to each site's Crash page over the Chrome DevTools Protocol, intercepts the live WebSocket stream, persists every round to SQLite, and serves a live dashboard plus a period-windowed analytics dashboard. Both dashboards have a tab per site.

| Tab | Page | Database |
|---|---|---|
| **Stake.com** | `stake.com/casino/games/crash` | `crash_results.db` |
| **Shuffle.com** | `shuffle.com/games/originals/crash` | `shuffle_crash_results.db` |

Each site is fully independent — its own browser, its own database, its own streak counters and its own stall watchdog — so one site going down never disturbs the other's archive.

> [!NOTE]
> This tool is **read-only**. It observes the public crash feeds without placing bets, clicking, or otherwise interacting with the pages. It is intended for statistical analysis, research, and learning.

## Features

- **Multi-site capture** — Stake.com and Shuffle.com are monitored side by side, each in its own browser and its own database. Adding a third site means one entry in `lib/sites.js`.
- **Real-time capture** — Puppeteer + CDP (`Network.webSocketFrameReceived`) taps each site's live crash stream with anti-detection flags.
- **SQLite persistence** — Every round is written to that site's database via `better-sqlite3` in WAL mode, with an indexed millisecond timestamp for fast time-window queries.
- **Live dashboard** (`/`) — Site tabs, WebSocket-pushed multiplier ticker, streak counters, recent-game pills, and a live distribution histogram.
- **Analytics dashboard** (`/analytics.html`) — Site tabs plus a period selector (`1h` → `6m` → `all`) over volume, mean, p90/p99, distribution, rare-event gaps, and Top 10 multipliers.
- **Monthly archives** — `dump-monthly.sh` exports per-month CSV + JSON stats for every site, ready to schedule with cron. The generated archives are committed to this repo, so it also ships as a [public dataset](#published-archive) of 538k+ rounds.
- **Multi-channel notifications** — Console, Telegram, and desktop alerts for instant crashes (`< 1.01x`) and 1000x+ moon shots, labelled by site.
- **Resilient** — Per-site browser relaunch on disconnect, a per-site stall watchdog for silent feed outages, and a `/api/health` endpoint for external monitoring.
- **Deployable** — Ships with a `systemd` unit and a production-ready `Dockerfile` / `docker compose` setup with a persistent volume.

## Requirements

- Node.js 22.12+ (required by Puppeteer 25; enforced via `engines` in `package.json`)
- A working Chromium — Puppeteer downloads its own by default; on Linux you may need a few shared libraries (see [Troubleshooting](#troubleshooting))
- Or just Docker, if you'd rather not install anything else

## Quick start

```bash
git clone git@github.com:sebbourgeois/stake-crash-archives.git
cd stake-crash-archives
npm install
cp .env.example .env       # all variables are optional; defaults are sane
npm start
```

Then open:

- [http://localhost:3000](http://localhost:3000) — live dashboard
- [http://localhost:3000/analytics.html](http://localhost:3000/analytics.html) — period-windowed analytics

> [!TIP]
> There is no test suite, linter, or build step. `node capture.js` is the whole runtime.

## Docker

A production image and Compose file are provided. The container uses the Debian `chromium` package (no ~300 MB Chrome download), runs as a non-root user, and persists the DB to a named volume so it survives rebuilds.

```bash
cp .env.example .env       # optional
docker compose up -d --build
docker compose logs -f crash-monitor
```

Full setup, volume migration, and troubleshooting notes live in [`DOCKER.md`](./DOCKER.md).

## Configuration

All configuration is via environment variables (a `.env` file is loaded automatically). Every flag is optional.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server / WebSocket port |
| `DB_PATH` | `crash_results.db` | Stake SQLite file (Compose sets this to `/data/crash_results.db`) |
| `SHUFFLE_DB_PATH` | `shuffle_crash_results.db` | Shuffle SQLite file — must never be the same file as `DB_PATH` |
| `STAKE_ENABLED` | `true` | Set to `false` to stop capturing Stake; its archive stays browsable |
| `SHUFFLE_ENABLED` | `true` | Same for Shuffle |
| `DASHBOARD_ENABLED` | `true` | Set to `false` to run as a capture-only daemon (skips Express + WS) |
| `TELEGRAM_ENABLED` | `false` | Send extreme-event alerts via Telegram |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | — | Target chat ID for alerts |
| `DESKTOP_NOTIFICATIONS_ENABLED` | `false` | Native desktop alerts via `node-notifier` |
| `WATCHDOG_ENABLED` | `true` | Stall watchdog (see below) |
| `WATCHDOG_STALE_MS` | `180000` | How long without a new result counts as stalled |
| `WATCHDOG_CHECK_MS` | `30000` | How often staleness is checked |

> [!TIP]
> To find your `TELEGRAM_CHAT_ID`, message your bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat.id` field.

> [!NOTE]
> Each enabled site runs its own headless Chromium, so two sites need roughly twice the memory of one. Disable a site with `SHUFFLE_ENABLED=false` / `STAKE_ENABLED=false` if that is tight — its dashboard tab keeps serving whatever is already archived.

## Stall watchdog

A capture can stall silently: the process stays alive and the event loop keeps running, but the site stops delivering websocket frames. Nothing throws, so neither the retry loop nor the supervisor notices — this repo's own Stake DB has a 7.8 h gap and a 54 h gap that happened inside a single long-lived PID.

"No row written for `WATCHDOG_STALE_MS`" is therefore the liveness signal, and each site is watched separately:

1. **Relaunch that site's browser** in-process, and give it one more full window.
2. If that window also passes with no result:
   - **every enabled site is stale** → the process is wedged, so it **exits with status 1** and the supervisor (`Restart=always` under systemd, `restart: unless-stopped` under Compose) rebuilds it from scratch;
   - **another site is still delivering results** → only the stalled site keeps relaunching. Restarting the process here would punch a hole in the healthy site's archive to fix a problem it does not have.

Tier 1 is routine self-healing and only logs; tier 2 sends a Telegram alert (re-sent about hourly while the outage lasts, not once per window).

> [!NOTE]
> Threshold trade-off, measured over 90 days of this DB: gaps longer than 3 min happen ~57 times, longer than 5 min 12 times, longer than 6 min 7 times — and every gap past 6 min was a real outage. So the default fires a cheap browser relaunch every other day or so and only restarts the service when it matters. Raise `WATCHDOG_STALE_MS` to `300000` if you would rather it stay quieter.

## Monthly archives

`dump-monthly.sh` exports each site's database into one CSV + one stats file per calendar month (UTC). Every site gets its own output directory, so the two archives never mix:

| Site | Database | Archive directory |
|---|---|---|
| `stake` | `crash_results.db` | `db-archives/` |
| `shuffle` | `shuffle_crash_results.db` | `db-archives-shuffle/` |

It opens the DBs **read-only**, so it is safe to run while the capture is live.

```bash
./dump-monthly.sh                   # every site that has a DB, every month
./dump-monthly.sh -s shuffle        # one site
./dump-monthly.sh -m 2026-07 -z     # one month for every site, gzip the CSVs
./dump-monthly.sh -s stake -d other.db -o /mnt/backup
```

| Option | Default | Description |
|---|---|---|
| `-s SITE` | every site with a DB on disk | `stake` or `shuffle`; repeatable |
| `-d DB` | the site's own DB | Path to the SQLite file |
| `-o OUTDIR` | the site's own archive dir | Output directory |
| `-m YYYY-MM` | every month | Only this month; repeatable |
| `-z` | off | Gzip the generated CSVs (`-9`) |
| `-h` | — | Show help |

Because `-d` and `-o` describe a single archive, they may only be combined with one `-s`. A site whose dump fails does not stop the others — the run finishes the rest and then exits non-zero, naming what failed.

Each run writes:

| File | Contents |
|---|---|
| `crash_YYYY-MM.csv` | Every row for that month, plus an `iso_utc` column next to the raw `timestamp` / `ts_ms` |
| `crash_YYYY-MM.summary.json` | Row count, first/last result, min/mean/median/p25–p99/max, tier distribution, cumulative counts at ≥1.01/2/5/10/50/100/1000x, per-day counts, top 10 multipliers, and coverage (days with data, largest gap between rounds) |
| `index.csv` | One line per archived month |
| `summary.json` | Every month summary in a single file |

Re-running overwrites: previously generated files are wiped first, so stale months never linger. With `-m` the wipe is scoped to the selected months, and the roll-ups are rebuilt from every summary present in the output directory.

> [!IMPORTANT]
> The script needs a Node that can load the compiled `better-sqlite3` binding. It probes `$NODE_BIN`, then `PATH`, then any nvm-installed versions, and uses the first that works — so a mismatched `node` on `PATH` is not a problem. If none work, run `npm rebuild better-sqlite3` or set `NODE_BIN=/path/to/node`.

### Scheduling with cron

`dump-last-month.sh` is the cron entry point: it resolves the previous calendar month and hands it to `dump-monthly.sh`, leaving all other months untouched. It covers every site that has a database, so the single cron line below did not change when Shuffle was added.

```cron
5 0 1 * * /path/to/stake-crash-archives/dump-last-month.sh >> /path/to/stake-crash-archives/dump-monthly.log 2>&1
```

Run on the 1st, it archives the month that just ended. Run on any other day, it still targets the previous calendar month, so a missed run retried by hand does the same thing. Override the target with `MONTH=2026-03 ./dump-last-month.sh` to backfill, and pass extra flags straight through (`./dump-last-month.sh -z`, `./dump-last-month.sh -s shuffle`).

> [!NOTE]
> Months are bucketed in UTC. The script forces `TZ=UTC` so hosts on a local timezone still line up with the stored timestamps.

## Published archive

The `.db` files themselves are gitignored, but the generated monthly archives **are committed** — so this repository doubles as a public dataset of the Crash feeds. Clone or fork it and you get every round captured so far, without running the capture yourself.

The table below covers the Stake archive in `db-archives/`, which is where the history is. Shuffle capture started on 2026-08-15, so `db-archives-shuffle/` begins there and grows from the same monthly job.

**Repository:** [`github.com/sebbourgeois/stake-crash-archives`](https://github.com/sebbourgeois/stake-crash-archives)
**Archive path:** [`db-archives/`](https://github.com/sebbourgeois/stake-crash-archives/tree/master/db-archives)

| Month | Rounds | Days with data | Mean | Median | Max | Instant crash % |
|---|---:|---:|---:|---:|---:|---:|
| `2026-01` | 43,597 | 16 | 12.50x | 1.97x | 40,015x | 1.94 % |
| `2026-02` | 84,786 | 28 | 11.96x | 1.99x | 61,866x | 1.82 % |
| `2026-03` | 78,677 | 28 | 12.51x | 1.99x | 48,465x | 1.90 % |
| `2026-04` | 53,208 | 20 | 11.00x | 1.97x | 47,670x | 2.00 % |
| `2026-05` | 54,312 | 18 | 11.69x | 1.99x | 38,891x | 1.96 % |
| `2026-06` | 91,544 | 30 | 17.06x | 1.99x | 399,026x | 1.97 % |
| `2026-07` | 93,854 | 31 | 13.74x | 1.99x | 116,772x | 2.07 % |
| `2026-08` | 38,124 | 14 | 20.18x | 1.97x | 396,866x | 2.02 % |
| **Total** | **538,102** | — | **13.72x** | — | **399,026x** | **1.96 %** |

Coverage starts `2026-01-16T13:09:37Z`; gaps within a month are capture downtime, not missing rounds in the game itself — each summary's `coverage.largestGapSeconds` tells you where. About 67 MB of CSV in total.

### Getting the data

```bash
# whole archive, no history
git clone --depth 1 git@github.com:sebbourgeois/stake-crash-archives.git

# archives only, without the app or the git history
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/sebbourgeois/stake-crash-archives.git
cd stake-crash-archives && git sparse-checkout set db-archives

# or a single month, straight over HTTP
curl -O https://raw.githubusercontent.com/sebbourgeois/stake-crash-archives/master/db-archives/crash_2026-07.csv
```

### What's in it

| File | Contents |
|---|---|
| `crash_YYYY-MM.csv` | One row per round: `gameId,multiplier,timestamp,ts_ms,iso_utc,gamesSinceLast1x,gamesSinceLast1000x,gamesSinceDouble1x` |
| `crash_YYYY-MM.summary.json` | Per-month stats — count, min/mean/median/p25–p99/max, tier distribution, cumulative counts at ≥1.01/2/5/10/50/100/1000x, per-day counts, top 10, coverage |
| `index.csv` | One line per month, for a quick overview |
| `summary.json` | Every month summary plus `totalRows` in one file |

Load a month in three lines:

```python
import pandas as pd
df = pd.read_csv("db-archives/crash_2026-07.csv", parse_dates=["iso_utc"])
print(df.multiplier.describe(), (df.multiplier < 1.01).mean())
```

### Refreshing your fork

The archives are regenerated from the DB by [`dump-monthly.sh`](#monthly-archives), so a fork that runs its own capture keeps the same layout:

```bash
./dump-last-month.sh          # rebuild the month that just ended
git add db-archives && git commit -m "Archive $(date -u -d 'last month' +%Y-%m)"
```

Re-running overwrites in place, so `git diff` on `db-archives/` shows exactly which months changed.

> [!NOTE]
> The archive is provided as-is for research and learning. Multipliers are stored at full float precision (a round shown as `1.00x` on Stake may be `1.0089275` here) — truncate to 2 decimals if you want to match what the site displayed. Past rounds say nothing about future ones; this dataset is not a betting strategy.

## Dashboards

Both pages open with a **Stake.com / Shuffle.com** tab bar. The selected site is mirrored into `?site=` and remembered locally, so a tab survives a reload, follows you across the Live ↔ Analytics link, and can be shared as a direct link (`/?site=shuffle`). A site with capture disabled is marked with a red square and still serves its archive.

Every site streams over the same WebSocket, so switching tabs is instant and the background site keeps updating — nothing is missed while you look at the other one.

### Live (`/`)

- Big-font live multiplier with `WAITING` / `STARTING` / `IN PROGRESS` / `CRASHED` states.
- Headline stats: average, median, and max across the last 1000 rounds.
- Streak counters: games since the last `<1.01x`, `1000x+`, and back-to-back `<1.01x`.
- Live distribution histogram and animated result pills with optional audio cues.

### Analytics (`/analytics.html`)

- Period selector: `1h`, `3h`, `12h`, `1d`, `1w`, `1m`, `3m`, `6m`, `all`.
- Overview cards: total, mean, median, p90, p99, span.
- Rare-event panel: count + average gap for `<1.01x`, `1000x+`, and double-`<1.01x`.
- Time-series charts auto-bucketed hourly or daily depending on the window.
- Top 10 multipliers with timestamps and game IDs.

### Multiplier tiers

| Color     | Range            | Meaning       |
|-----------|------------------|---------------|
| Red       | `< 1.01x`        | Instant crash |
| Orange    | `1.01x – 1.99x`  | Low           |
| Green     | `2x – 99.99x`    | Standard      |
| Purple    | `100x – 999.99x` | High          |
| Turquoise | `≥ 1000x`        | Moon shot     |

Multipliers are displayed using **truncation** to 2 decimals (matching Stake's UI), so a captured value of `1.0089275` renders as `1.00x`, not `1.01x`. The DB stores full float precision.

> [!NOTE]
> The two feeds differ in precision at the source: Stake publishes a full float (`1.0089275`), while Shuffle publishes an already-rounded 2-decimal string (`"1.13"`). Both are stored as `REAL`, so a Shuffle row simply carries no digits past the second decimal.

## Data model

```sql
CREATE TABLE crash_results (
  gameId               TEXT    PRIMARY KEY,    -- dedupe boundary
  multiplier           REAL    NOT NULL,
  timestamp            TEXT    NOT NULL,       -- ISO 8601
  ts_ms                INTEGER,                -- indexed epoch ms (idx_ts_ms)
  gamesSinceLast1x     INTEGER,
  gamesSinceLast1000x  INTEGER,
  gamesSinceDouble1x   INTEGER
);
```

Every site uses this identical schema in its **own file** — the tables are never shared, so `gameId` only has to be unique within one site (Stake's are UUIDs, Shuffle's are increasing integers). `gameId` is the primary key, so reconnects and restarts never produce duplicate rows. The schema is created on first launch; the `ts_ms` column is added and backfilled idempotently for older databases.

## HTTP & WebSocket API

The monitor exposes a tiny surface used by the bundled dashboards. Everything is scoped by a `site` key (`stake`, `shuffle`).

**`GET /api/sites`** — the tab bar's source of truth: `[{ key, label, tab, url, enabled }, ...]`.

**`GET /api/analytics?site=<site>&period=<period>`** — aggregate stats for one of `1h`, `3h`, `12h`, `1d`, `1w`, `1m`, `3m`, `6m`, `all`. `site` defaults to `stake`; an unknown one returns `400`.

**`GET /api/health`** — watchdog liveness. Returns `200`, or `503` once any enabled site has passed its staleness window. Top-level `staleSeconds` is the worst enabled site's, so a probe written against the single-site version keeps working:

```jsonc
{
  "ok": true, "staleSeconds": 26, "thresholdSeconds": 180,
  "watchdogEnabled": true, "uptimeSeconds": 35,
  "sites": {
    "stake":   { "ok": true, "enabled": true, "staleSeconds": 26, "lastResultMs": 1786814197468, "staleStrikes": 0 },
    "shuffle": { "ok": true, "enabled": true, "staleSeconds":  8, "lastResultMs": 1786814214855, "staleStrikes": 0 }
  }
}
```

**WebSocket** (`ws://<host>:<port>/`) — every client receives every site's stream, and each message carries the `site` it belongs to. There are three shapes:

```jsonc
// 1. On connect: one per site — last 1000 results + current streaks
{ "type": "history", "site": "shuffle", "results": [ ... ], "streaks": { ... } }

// 2. Live state on every frame (in_progress / starting / crash / start)
{ "type": "live", "site": "stake", "state": { "status": "in_progress", "multiplier": 1.42, "gameId": "..." } }

// 3. Persisted round
{ "type": "result", "site": "stake", "result": { "gameId": "...", "multiplier": 7.31, "ts_ms": 1716123456789, ... } }
```

## Running as a systemd service

`stake-crash.service.example` is a template unit for keeping the monitor alive across reboots. Run this from the repo checkout, as the user the service should run as, with the same Node on `PATH` that you ran `npm install` with:

```bash
sed -e "s|__USER__|$USER|g" \
    -e "s|__WORKDIR__|$PWD|g" \
    -e "s|__NODE__|$(command -v node)|g" \
    stake-crash.service.example | sudo tee /etc/systemd/system/stake-crash.service
sudo systemctl daemon-reload
sudo systemctl enable --now stake-crash
journalctl -u stake-crash -f
```

Then check `curl -s localhost:3000/api/health` — a `200` with a low `staleSeconds` means frames are actually landing, which `systemctl status` alone does not tell you.

> [!IMPORTANT]
> `ExecStart` must point at an absolute `node` path on the **same Node major that built `node_modules`**. `better-sqlite3` is a native addon, so installing deps under a different major makes the unit die at startup with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. After a Node upgrade, run `npm rebuild better-sqlite3` and update the path.

> [!NOTE]
> nvm is a shell function and does not exist under systemd, so a bare `node` will not resolve — the `command -v node` above expands to the versioned binary (`~/.nvm/versions/node/vXX/bin/node`), which is what you want. Be aware that a later `nvm install` of a new default silently breaks that pin.

The rendered `stake-crash.service` is gitignored, so your machine-specific paths stay out of the repo — edit the installed copy under `/etc/systemd/system/`, or keep a local one alongside the `.example`.

## Architecture

```
┌──────────────┐  CDP   ┌───────────────┐
│  stake.com   │ ─────► │ monitor:stake │ ──► crash_results.db ─────────► db-archives/
└──────────────┘        └───────┬───────┘                                 (monthly dumps)
                                │
┌──────────────┐  CDP   ┌───────┴────────┐                                ┌──────────────┐
│ shuffle.com  │ ─────► │monitor:shuffle │ ──► shuffle_crash_results.db   │  Dashboards  │
└──────────────┘        └───────┬────────┘         │                      │ live / stats │
                                │                  └──► db-archives-shuffle/     ▲
                                │  tagged {site} broadcasts + /api/analytics     │
                                └────────────────────────────────────────────────┘
```

| File | Role |
|---|---|
| `capture.js` | Wiring only: builds one monitor per site, serves the API/WebSocket, owns the watchdog ladder and shutdown |
| `lib/sites.js` | Everything site-specific — the URL and the parser that normalizes one raw frame |
| `lib/store.js` | One SQLite file: schema, migration, queries, analytics |
| `lib/monitor.js` | One site's capture loop: browser, streaks, dedupe, staleness clock |

1. For each site, Puppeteer launches headless Chromium with anti-detection flags and loads that site's crash page.
2. A CDP session subscribes to `Network.webSocketFrameReceived`.
3. The site's `parseFrame()` normalizes each frame to `{ status, gameId, multiplier, timestamp }` — Stake's `MultiplayerCrash` events and Shuffle's `CrashEventPayload` events differ in shape, and this is the only place that difference lives. Live state is broadcast; only `status === 'crash'` is persisted.
4. Express serves `public/` and exposes `/api/sites`, `/api/analytics` and `/api/health`; the `ws` server pushes site-tagged live updates over the same HTTP server.
5. Streak counters are seeded from each database at startup so they survive restarts.

## Troubleshooting

### Puppeteer fails to launch on Linux

Install the shared libraries Chromium needs:

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
```

### Dashboard shows "Disconnected"

The WebSocket client reconnects automatically. If it stays disconnected, check the server logs — Puppeteer may be inside its 10-second restart backoff after a page crash.

### `dump-monthly.sh` cannot load `better-sqlite3`

The native module is built against one Node ABI, and the `node` on your `PATH` may be another. Rebuild it for the Node you intend to use (`npm rebuild better-sqlite3`), or point the script at a known-good binary with `NODE_BIN=/path/to/node ./dump-monthly.sh`.

### Database is locked

WAL mode allows concurrent readers (the archive script, the `sqlite3` CLI), but **never run two `capture.js` instances against the same DB** — `gameId` PK collisions will silently drop one writer's rows and streak counters will desync. The same applies to pointing two sites at one file: give each its own path.

### One site's tab is empty or stuck

Check `/api/health` — it reports each site separately, so `sites.shuffle.staleSeconds` climbing past `thresholdSeconds` while Stake stays low means only that capture is down. The logs are prefixed per site (`[SHUFFLE] Capture error: ...`).

> [!CAUTION]
> These sites aggressively rate-limit scrapers. Running multiple instances from the same IP, or stripping the anti-detection flags, is likely to get the session blocked.
