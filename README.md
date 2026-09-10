<div align="center">

# Crash Monitor

**Real-time capture, storage and analysis of the Stake.com, Shuffle.com and Roobet.com Crash feeds.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/storage-SQLite%20WAL-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)](./DOCKER.md)
[![Read only](https://img.shields.io/badge/mode-read--only-blue?style=flat-square)](#)
[![Archive](https://img.shields.io/badge/dataset-639k%20rounds-8b5cf6?style=flat-square)](#public-dataset)

[Quick start](#quick-start) &nbsp;•&nbsp; [Dashboards](#dashboards) &nbsp;•&nbsp; [Public dataset](#public-dataset) &nbsp;•&nbsp; [API](#http--websocket-api) &nbsp;•&nbsp; [Deployment](#deployment)

</div>

A headless browser attaches to each site's Crash page over the Chrome DevTools Protocol, intercepts the live WebSocket stream, writes every round to SQLite, and serves a live dashboard plus a period-windowed analytics dashboard — one tab per site.

| Tab | Page | Database | Archive |
|---|---|---|---|
| **Stake.com** | `stake.com/casino/games/crash` | `crash_results.db` | [`db-archives/`](./db-archives) |
| **Shuffle.com** | `shuffle.com/games/originals/crash` | `shuffle_crash_results.db` | [`db-archives-shuffle/`](./db-archives-shuffle) |
| **Roobet.com** | `roobet.com/casino/game/crash` | `roobet_crash_results.db` | `db-archives-roobet/` |

Each site is fully independent — its own browser, its own database, its own streak counters, its own stall watchdog — so one site going down never disturbs the others' archives.

> [!NOTE]
> This tool is **read-only**. It observes the public crash feeds without placing bets, clicking, or otherwise interacting with the pages. It is intended for statistical analysis, research and learning.

## Features

- **Multi-site capture** — three sites monitored side by side, each in its own browser and database. Adding a fourth is one entry in `lib/sites.js`.
- **Real-time interception** — Puppeteer + CDP (`Network.webSocketFrameReceived`) taps each live crash stream. Stake and Shuffle send GraphQL JSON; Roobet sends packed binary Socket.IO frames. All three are normalized to one event shape.
- **SQLite persistence** — every round written via `better-sqlite3` in WAL mode, with an indexed millisecond timestamp for fast time-window queries.
- **Live dashboard** — WebSocket-pushed multiplier ticker, streak counters, result pills, a live distribution histogram and a **cold / regular / hot** temperature gauge for the current stretch.
- **Analytics dashboard** — period selector from `1h` to `all` over volume, mean, p90/p99, distribution, rare-event gaps and Top 10 multipliers.
- **Monthly archives** — `dump-monthly.sh` exports per-month CSV + JSON stats for every site, ready to schedule with cron. The output is committed, so this repo doubles as a [public dataset](#public-dataset) of 639k+ rounds.
- **Notifications** — console, Telegram and desktop alerts for instant crashes (`< 1.01x`) and 1000x+ moon shots, labelled by site.
- **Resilient** — per-site browser relaunch on disconnect, a per-site [stall watchdog](#stall-watchdog) for silent feed outages, and `/api/health` for external probes.
- **Deployable** — ships with a `systemd` unit template and a production `Dockerfile` / Compose setup with a persistent volume.

## Requirements

- **Node.js 22.12+** (required by Puppeteer 25, enforced via `engines`)
- A working Chromium — Puppeteer downloads its own; on Linux a few shared libraries may be missing (see [Troubleshooting](#troubleshooting))
- …or just **Docker**, if you'd rather install nothing else

## Quick start

```bash
git clone https://github.com/sebbourgeois/stake-crash-archives.git
cd stake-crash-archives
npm install
cp .env.example .env       # every variable is optional; defaults are sane
npm start
```

Then open:

- **<http://localhost:3000>** — live dashboard
- **<http://localhost:3000/analytics.html>** — period-windowed analytics

> [!TIP]
> There is no test suite, linter or build step. `node capture.js` is the entire runtime.

### With Docker

The image uses Debian's `chromium` package (no ~300 MB Chrome download), runs as a non-root user, and keeps the databases on a named volume so they survive rebuilds.

```bash
cp .env.example .env       # optional
docker compose up -d --build
docker compose logs -f crash-monitor
```

Full setup, volume migration and container troubleshooting live in [`DOCKER.md`](./DOCKER.md).

## Configuration

All configuration is via environment variables; a `.env` file in the project root is loaded automatically. Every flag is optional.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server / WebSocket port |
| `DB_PATH` | `crash_results.db` | Stake SQLite file (Compose sets `/data/crash_results.db`) |
| `SHUFFLE_DB_PATH` | `shuffle_crash_results.db` | Shuffle SQLite file — never the same file as another site |
| `ROOBET_DB_PATH` | `roobet_crash_results.db` | Roobet SQLite file — again, its own file |
| `STAKE_ENABLED` | `true` | `false` stops capturing Stake; its archive stays browsable |
| `SHUFFLE_ENABLED` | `true` | Same for Shuffle |
| `ROOBET_ENABLED` | `true` | Same for Roobet |
| `DASHBOARD_ENABLED` | `true` | `false` runs a capture-only daemon (skips Express + WS) |
| `TELEGRAM_ENABLED` | `false` | Send extreme-event alerts via Telegram |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | — | Target chat ID for alerts |
| `TELEGRAM_SITES` | `all` | Which sites push to Telegram: `all`, `none`, or a comma-separated list of site keys (`stake,shuffle`). Console and desktop notifications ignore it |
| `DESKTOP_NOTIFICATIONS_ENABLED` | `false` | Native desktop alerts via `node-notifier` |
| `WATCHDOG_ENABLED` | `true` | Stall watchdog (see [below](#stall-watchdog)) |
| `WATCHDOG_STALE_MS` | `180000` | How long without a new result counts as stalled |
| `WATCHDOG_CHECK_MS` | `30000` | How often staleness is checked |
| `BROWSER_RECYCLE_MS` | `21600000` | Relaunch each site's browser this often (6h) to shed page leaks; `0` disables |
| `TEMPERATURE_WINDOW` | `300` | Rounds compared against the all-time baseline for the live dashboard's cold / regular / hot gauge (min 50) |
| `STREAK_UNDER_X` | `2.2` | Cold streak watch: a run is consecutive rounds that all ended under this multiplier |
| `STREAK_MIN_LEN` | `16` | Cold streak watch: run length that counts as an event (min 2) |

> [!TIP]
> To find your `TELEGRAM_CHAT_ID`, message your bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat.id` field.

> [!NOTE]
> Each enabled site runs its own headless Chromium, so three sites need roughly three times the memory of one. Disable one with `ROOBET_ENABLED=false` if that is tight — its dashboard tab keeps serving whatever is already archived.

## Dashboards

Both pages open with a **Stake.com / Shuffle.com / Roobet.com** tab bar. The selected site is mirrored into `?site=` and remembered locally, so a tab survives a reload, follows you across the Live ↔ Analytics link, and can be shared as a direct link (`/?site=shuffle`). A site with capture disabled is marked with a red square and still serves its archive.

Every site streams over the same WebSocket, so switching tabs is instant and background sites keep updating — nothing is missed while you look at another one.

### Live (`/`)

- Big-font live multiplier with `WAITING` / `STARTING` / `IN PROGRESS` / `CRASHED` states
- Headline stats: average, median and max across the last 1000 rounds
- Streak counters: games since the last `<1.01x`, `1000x+`, and back-to-back `<1.01x`
- Live distribution histogram and animated result pills with optional audio cues
- Temperature gauge: is the current stretch **COLD**, **REGULAR** or **HOT**? It takes the last `TEMPERATURE_WINDOW` rounds (300 by default, about two hours), measures the share that ended under 2x, and scores it as a z-score against that site's own all-time share. Beyond ±2 standard deviations the label flips to COLD (more early crashes than usual) or HOT (fewer). Under an unchanged game that happens about 5% of the time, so the label is a sanity check for the "it's been crashing early all evening" feeling rather than a signal. The instant-crash count for the window is shown next to its expected value for the same reason.
- Cold streak watch: how many rounds in a row have ended under `STREAK_UNDER_X` (2.2x) right now, the site's record, how many runs of `STREAK_MIN_LEN`+ (16) the archive holds and when the last one was, plus the odds of one starting in the next hour / 24h / 7 days. The odds treat every round as an independent draw at the site's own all-time under-threshold share, scaled by its observed rounds per day, so they read the same on any day regardless of when the last run happened. On Stake a 16+ run under 2.2x is a roughly-fortnightly event (about 9% on any given day). It is a probability, not a prediction — the widget is there to put a number on the "it's been under 2x forever" feeling, not to time anything.

### Analytics (`/analytics.html`)

- Period selector: `1h`, `3h`, `12h`, `1d`, `1w`, `1m`, `3m`, `6m`, `all`
- Overview cards: total, mean, median, p90, p99, span
- Rare-event panel: count and average gap for `<1.01x`, `1000x+`, double-`<1.01x`
- Time-series charts auto-bucketed hourly or daily depending on the window
- Top 10 multipliers with timestamps and game IDs

### Multiplier tiers

| Color | Range | Meaning |
|---|---|---|
| Red | `< 1.01x` | Instant crash |
| Orange | `1.01x – 1.99x` | Low |
| Green | `2x – 99.99x` | Standard |
| Purple | `100x – 999.99x` | High |
| Turquoise | `≥ 1000x` | Moon shot |

Multipliers are **truncated** to 2 decimals for display (matching Stake's UI), so a captured `1.0089275` renders as `1.00x`, not `1.01x`. The database keeps full precision.

> [!NOTE]
> The feeds differ in precision at the source: Stake publishes a full float (`1.0089275`), Shuffle an already-rounded 2-decimal string (`"1.13"`), and Roobet an integer number of hundredths (`187` → `1.87`). All are stored as `REAL`, so only Stake rows carry digits past the second decimal.

## Public dataset

The `.db` files are gitignored, but the generated monthly archives **are committed** — so this repository doubles as an open dataset of the Crash feeds. Clone or fork it and you get every round captured so far, without running the capture yourself.

**Stake** — [`db-archives/`](https://github.com/sebbourgeois/stake-crash-archives/tree/master/db-archives), coverage starts `2026-01-16T13:09:37Z`:

| Month | Rounds | Days with data | Mean | Median | Max | Instant crash % |
|---|---:|---:|---:|---:|---:|---:|
| `2026-01` | 43,597 | 16 | 12.50x | 1.97x | 40,015x | 1.94 % |
| `2026-02` | 84,786 | 28 | 11.96x | 1.99x | 61,866x | 1.82 % |
| `2026-03` | 78,677 | 28 | 12.51x | 1.99x | 48,465x | 1.90 % |
| `2026-04` | 53,208 | 20 | 11.00x | 1.97x | 47,670x | 2.00 % |
| `2026-05` | 54,312 | 18 | 11.69x | 1.99x | 38,891x | 1.96 % |
| `2026-06` | 91,544 | 30 | 17.06x | 1.99x | 399,026x | 1.97 % |
| `2026-07` | 93,854 | 31 | 13.74x | 1.99x | 116,772x | 2.07 % |
| `2026-08` | 88,325 | 30 | 14.37x | 1.97x | 396,866x | 1.94 % |
| **Total** | **588,303** | — | **13.40x** | — | **399,026x** | **1.95 %** |

**Shuffle** — [`db-archives-shuffle/`](https://github.com/sebbourgeois/stake-crash-archives/tree/master/db-archives-shuffle), capture started `2026-08-15`:

| Month | Rounds | Days with data | Mean | Median | Max | Instant crash % |
|---|---:|---:|---:|---:|---:|---:|
| `2026-08` | 50,789 | 17 | 11.43x | 1.97x | 25,956x | 2.06 % |

**Roobet** — capture started `2026-09-01`; `db-archives-roobet/` appears with the first monthly dump.

About 77 MB of CSV in total. Gaps within a month are capture downtime, not missing rounds in the game itself — each summary's `coverage.largestGapSeconds` tells you where.

### Getting the data

```bash
# whole archive, no history
git clone --depth 1 https://github.com/sebbourgeois/stake-crash-archives.git

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

> [!NOTE]
> The archive is provided as-is for research and learning. Past rounds say nothing about future ones — this dataset is not a betting strategy.

## Monthly archives

`dump-monthly.sh` exports each site's database into one CSV plus one stats file per calendar month (UTC), each site into its own directory. It opens the databases **read-only**, so it is safe to run while capture is live.

```bash
./dump-monthly.sh                   # every site that has a DB, every month
./dump-monthly.sh -s shuffle        # one site
./dump-monthly.sh -m 2026-07 -z     # one month for every site, gzip the CSVs
./dump-monthly.sh -s stake -d other.db -o /mnt/backup
```

| Option | Default | Description |
|---|---|---|
| `-s SITE` | every site with a DB on disk | `stake`, `shuffle` or `roobet`; repeatable |
| `-d DB` | the site's own DB | Path to the SQLite file |
| `-o OUTDIR` | the site's own archive dir | Output directory |
| `-m YYYY-MM` | every month | Only this month; repeatable |
| `-z` | off | Gzip the generated CSVs (`-9`) |
| `-h` | — | Show help |

Because `-d` and `-o` describe a single archive, they may only be combined with one `-s`. A site whose dump fails does not stop the others — the run finishes the rest, then exits non-zero naming what failed.

Re-running overwrites: previously generated files are wiped first, so stale months never linger. With `-m` the wipe is scoped to the selected months, and the roll-ups are rebuilt from every summary present in the output directory.

> [!IMPORTANT]
> The script needs a Node that can load the compiled `better-sqlite3` binding. It probes `$NODE_BIN`, then `PATH`, then any nvm-installed versions, and uses the first that works — so a mismatched `node` on `PATH` is not a problem. If none work, run `npm rebuild better-sqlite3` or set `NODE_BIN=/path/to/node`.

### Scheduling with cron

`dump-last-month.sh` is the cron entry point: it resolves the previous calendar month and hands it to `dump-monthly.sh`, leaving all other months untouched. It covers every site that has a database, so this single line did not change when Shuffle and Roobet were added.

```cron
5 0 1 * * /path/to/stake-crash-archives/dump-last-month.sh >> /path/to/stake-crash-archives/dump-monthly.log 2>&1
```

Run on the 1st, it archives the month that just ended; run on any other day it still targets the previous calendar month, so a missed run retried by hand does the same thing. Override with `MONTH=2026-03 ./dump-last-month.sh` to backfill, and pass extra flags straight through (`./dump-last-month.sh -z`).

> [!NOTE]
> Months are bucketed in UTC. The script forces `TZ=UTC` so hosts on a local timezone still line up with the stored timestamps.

Refreshing a fork's archives is then two commands — re-running overwrites in place, so `git diff` shows exactly which months changed:

```bash
./dump-last-month.sh
git add db-archives && git commit -m "Archive $(date -u -d 'last month' +%Y-%m)"
```

## Stall watchdog

A capture can stall silently: the process stays alive and the event loop keeps running, but a site stops delivering WebSocket frames. Nothing throws, so neither the retry loop nor the supervisor notices — this repo's own Stake database has a 7.8 h gap and a 54 h gap that both happened inside a single long-lived PID.

"No row written for `WATCHDOG_STALE_MS`" is therefore the liveness signal, and each site is watched separately:

1. **Relaunch that site's browser** in-process, then give it one more full window.
2. If that window also passes with no result:
   - **every enabled site is stale** → the process is wedged, so it **exits with status 1** and the supervisor (`Restart=always` under systemd, `restart: unless-stopped` under Compose) rebuilds it from scratch;
   - **another site is still delivering results** → only the stalled site keeps relaunching. Restarting the process here would punch a hole in the healthy site's archive to fix a problem it does not have.

Tier 1 is routine self-healing and only logs; tier 2 sends a Telegram alert, re-sent roughly hourly while the outage lasts rather than once per window.

> [!NOTE]
> Threshold trade-off, measured over 90 days of this database: gaps longer than 3 min happen ~57 times, longer than 5 min 12 times, longer than 6 min 7 times — and every gap past 6 min was a real outage. So the default fires a cheap browser relaunch every other day or so and only restarts the service when it matters. Raise `WATCHDOG_STALE_MS` to `300000` if you would rather it stay quieter.

## HTTP & WebSocket API

The monitor exposes a small surface, used by the bundled dashboards. Everything is scoped by a `site` key (`stake`, `shuffle`, `roobet`).

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
// 1. On connect: one per site — last 1000 results, current streaks, the temperature gauge and the cold streak watch
{ "type": "history", "site": "shuffle", "results": [ ... ], "streaks": { ... }, "temperature": { ... }, "streakOdds": { ... } }

// 2. Live state on every frame (in_progress / starting / crash / start)
{ "type": "live", "site": "stake", "state": { "status": "in_progress", "multiplier": 1.42, "gameId": "..." } }

// 3. Persisted round, with the temperature and streak watch recomputed to include it
{ "type": "result", "site": "stake", "result": { "gameId": "...", "multiplier": 7.31, "ts_ms": 1716123456789, ... }, "temperature": { ... }, "streakOdds": { ... } }
```

`temperature` is `null` until the site has at least twice `TEMPERATURE_WINDOW` rounds archived, otherwise:

```jsonc
{
  "window": 300, "label": "cold",          // "cold" | "regular" | "hot"
  "z": 2.04, "threshold": 2,               // z-score of the under-2x share; |z| >= threshold flips the label
  "pctLt2": 56.3, "instants": 7, "expectedInstants": 5.9,
  "baseline": { "total": 612563, "pctLt2": 50.4, "pctInstant": 1.95 }
}
```

`streakOdds` is `null` until the site has 1000 rounds archived, otherwise:

```jsonc
{
  "threshold": 2.2, "minLen": 16,
  "current": 3,                             // consecutive rounds under threshold the archive currently ends on
  "longest": 19, "count": 13,               // record run, and runs that reached minLen
  "last": { "len": 19, "startMs": 1788..., "endMs": 1788... },   // latest run that reached minLen, or null
  "total": 617565, "pUnder": 0.5496,        // rounds archived; all-time share under threshold
  "perRound": 3.12e-5,                      // chance a given round starts a minLen+ run: (1-p)·p^minLen
  "reach": 0.0003,                          // chance the current run goes on to reach minLen
  "roundsPerDay": 3053, "coveredDays": 202.3, "observedPerDay": 0.064,
  "odds": { "hour": 0.004, "day": 0.091, "week": 0.487 }        // P(at least one run starts in the window)
}
```

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

Every site uses this identical schema in its **own file** — tables are never shared, so `gameId` only has to be unique within one site (Stake's are UUIDs, Shuffle's increasing integers, Roobet's Mongo ObjectIds). `gameId` is the primary key, so reconnects and restarts never produce duplicate rows. The schema is created on first launch; the `ts_ms` column is added and backfilled idempotently for older databases.

## Architecture

```
┌──────────────┐  CDP   ┌────────────────┐
│  stake.com   │ ─────► │ monitor:stake  │ ──► crash_results.db ────────► db-archives/
└──────────────┘        └───────┬────────┘                                (monthly dumps)
                                │
┌──────────────┐  CDP   ┌───────┴────────┐
│ shuffle.com  │ ─────► │monitor:shuffle │ ──► shuffle_crash_results.db ► db-archives-shuffle/
└──────────────┘        └───────┬────────┘
                                │                                         ┌──────────────┐
┌──────────────┐  CDP   ┌───────┴────────┐                                │  Dashboards  │
│  roobet.com  │ ─────► │ monitor:roobet │ ──► roobet_crash_results.db ──► │ live / stats │
└──────────────┘        └───────┬────────┘      └──► db-archives-roobet/   └──────▲───────┘
                                │  tagged {site} broadcasts + /api/analytics      │
                                └─────────────────────────────────────────────────┘
```

| File | Role |
|---|---|
| `capture.js` | Wiring only: builds one monitor per site, serves the API and WebSocket, owns the watchdog ladder and shutdown |
| `lib/sites.js` | Everything site-specific — the page URL and the parser that normalizes one raw frame |
| `lib/store.js` | One SQLite file: schema, migration, queries, analytics |
| `lib/monitor.js` | One site's capture loop: browser, retry, streaks, dedupe, staleness clock |
| `public/` | Both dashboards; `site-tabs.js` is shared by them |

How a round travels through it:

1. For each site, Puppeteer launches headless Chromium with anti-detection flags and loads that site's crash page.
2. A CDP session subscribes to `Network.webSocketFrameReceived` — **after** navigation, because enabling `Network` on `about:blank` and then navigating makes Chrome stop delivering frames to that session.
3. The site's `parseFrame()` normalizes each raw frame to `{ status, gameId, multiplier, timestamp }`. Stake's `MultiplayerCrash` GraphQL events, Shuffle's `CrashEventPayload` events and Roobet's packed binary Socket.IO payloads differ in wire format as well as in shape, and this is the only place those differences live.
4. Live state is broadcast for `starting` / `start` / `in_progress` / `crash`; **only `crash` is persisted**, deduped by `gameId`.
5. Express serves `public/` and exposes `/api/sites`, `/api/analytics` and `/api/health`; the `ws` server pushes site-tagged updates over the same HTTP server.
6. Streak counters are seeded from each database at startup, so they survive restarts.

### Adding a site

Add an entry to `SITES` in `lib/sites.js` — page URL, env var names and a `parseFrame()` returning the normalized event — plus a row in `dump-monthly.sh`'s site table. Nothing else: `capture.js` iterates `SITES`, and both frontends build their tabs from `GET /api/sites`.

## Deployment

### systemd

`stake-crash.service.example` is a template unit for keeping the monitor alive across reboots. Run this from the repo checkout, as the user the service should run as, with the same Node on `PATH` you ran `npm install` with:

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
> `ExecStart` must point at an absolute `node` path on the **same Node major that built `node_modules`**. `better-sqlite3` is a native addon, so installing dependencies under a different major makes the unit die at startup with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. After a Node upgrade, run `npm rebuild better-sqlite3` and update the path.

> [!NOTE]
> nvm is a shell function and does not exist under systemd, so a bare `node` will not resolve — the `command -v node` above expands to the versioned binary, which is what you want. A later `nvm install` of a new default silently breaks that pin.

The rendered `stake-crash.service` is gitignored, so machine-specific paths stay out of the repo — edit the installed copy under `/etc/systemd/system/`, or keep a local one alongside the `.example`.

### Docker

See [`DOCKER.md`](./DOCKER.md) for the image layout, migrating an existing database into the named volume, and container-specific troubleshooting. The short version is `docker compose up -d --build`.

## Troubleshooting

**Puppeteer fails to launch on Linux** — install the shared libraries Chromium needs:

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
```

**Dashboard shows "Disconnected"** — the WebSocket client reconnects automatically. If it stays disconnected, check the server logs: Puppeteer may be inside its 10-second restart backoff after a page crash.

**`dump-monthly.sh` cannot load `better-sqlite3`** — the native module is built against one Node ABI and the `node` on your `PATH` may be another. Run `npm rebuild better-sqlite3`, or point the script at a known-good binary with `NODE_BIN=/path/to/node ./dump-monthly.sh`.

**One site's tab is empty or stuck** — check `/api/health`, which reports each site separately: `sites.shuffle.staleSeconds` climbing past `thresholdSeconds` while Stake stays low means only that capture is down. Logs are prefixed per site (`[SHUFFLE] Capture error: ...`).

> [!WARNING]
> WAL mode allows concurrent readers (the archive script, the `sqlite3` CLI), but **never run two `capture.js` instances against the same database** — `gameId` primary-key collisions will silently drop one writer's rows and streak counters will desync. The same applies to pointing two sites at one file: give each its own path.

> [!CAUTION]
> These sites aggressively rate-limit scrapers. Running multiple instances from the same IP, or stripping the anti-detection flags, is likely to get the session blocked.
