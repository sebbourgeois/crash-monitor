# Stake Crash Monitor

Real-time monitor for the Stake.com Crash game. A headless browser attaches to the page over the Chrome DevTools Protocol, intercepts the live `MultiplayerCrash` WebSocket stream, persists every round to SQLite, and serves a live + analytics dashboard.

> [!NOTE]
> This tool is **read-only**. It observes the public crash feed without placing bets, clicking, or otherwise interacting with the page. It is intended for statistical analysis, research, and learning.

## Features

- **Real-time capture** — Puppeteer + CDP (`Network.webSocketFrameReceived`) taps the live `MultiplayerCrash` stream with anti-detection flags.
- **SQLite persistence** — Every round is written to `crash_results.db` via `better-sqlite3` in WAL mode, with an indexed millisecond timestamp for fast time-window queries.
- **Live dashboard** (`/`) — WebSocket-pushed multiplier ticker, streak counters, recent-game pills, and a live distribution histogram.
- **Analytics dashboard** (`/analytics.html`) — Period selector (`1h` → `6m` → `all`) over volume, mean, p90/p99, distribution, rare-event gaps, and Top 10 multipliers.
- **Multi-channel notifications** — Console, Telegram, and desktop alerts for instant crashes (`< 1.01x`) and 1000x+ moon shots.
- **Resilient** — Auto-restarts the browser on disconnect; graceful shutdown on `SIGINT` / `SIGTERM`.
- **Deployable** — Ships with a `systemd` unit and a production-ready `Dockerfile` / `docker compose` setup with a persistent volume.

## Requirements

- Node.js 18+ (20 LTS recommended)
- A working Chromium — Puppeteer downloads its own by default; on Linux you may need a few shared libraries (see [Troubleshooting](#troubleshooting))
- Or just Docker, if you'd rather not install anything else

## Quick start

```bash
git clone <your-fork-url> stake-crash-archives
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
| `DB_PATH` | `crash_results.db` | SQLite file path (Compose sets this to `/data/crash_results.db`) |
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

## Stall watchdog

The capture can stall silently: the process stays alive and the event loop keeps
running, but Stake stops delivering websocket frames. Nothing throws, so neither
the retry loop nor the supervisor notices — this repo's own DB has a 7.8 h gap
and a 54 h gap that happened inside a single long-lived PID.

"No row written for `WATCHDOG_STALE_MS`" is therefore the liveness signal, and
the watchdog escalates on it:

1. **Relaunch the browser** in-process, and give it one more full window.
2. **Exit with status 1** if that window also passes with no result, so the
   supervisor (`Restart=always` under systemd, `restart: unless-stopped` under
   Compose) rebuilds the process from scratch.

Tier 1 is routine self-healing and only logs; tier 2 sends a Telegram alert.
`GET /api/health` exposes the same signal for external monitoring — it returns
`200` with `{ ok: true, staleSeconds, … }`, or `503` once the window is passed.

> [!NOTE]
> Threshold trade-off, measured over 90 days of this DB: gaps longer than 3 min
> happen ~57 times, longer than 5 min 12 times, longer than 6 min 7 times — and
> every gap past 6 min was a real outage. So the default fires a cheap browser
> relaunch every other day or so and only restarts the service when it matters.
> Raise `WATCHDOG_STALE_MS` to `300000` if you would rather it stay quieter.

## Dashboards

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

`gameId` is the primary key, so reconnects and restarts never produce duplicate rows. The schema is created on first launch; the `ts_ms` column is added and backfilled idempotently for older databases.

## HTTP & WebSocket API

The monitor exposes a tiny surface used by the bundled dashboards.

**`GET /api/analytics?period=<period>`** — returns aggregate stats for one of `1h`, `3h`, `12h`, `1d`, `1w`, `1m`, `3m`, `6m`, `all`.

**WebSocket** (`ws://<host>:<port>/`) — clients receive three message shapes:

```jsonc
// 1. On connect: last 1000 results + current streaks
{ "type": "history", "results": [ ... ], "streaks": { ... } }

// 2. Live state on every frame (in_progress / starting / crash / start)
{ "type": "live", "state": { "status": "in_progress", "multiplier": 1.42, "gameId": "..." } }

// 3. Persisted round
{ "type": "result", "result": { "gameId": "...", "multiplier": 7.31, "ts_ms": 1716123456789, ... } }
```

## Running as a systemd service

A `stake-crash.service` unit is included for keeping the monitor alive across reboots:

```bash
sudo cp stake-crash.service /etc/systemd/system/stake-crash.service
sudo systemctl daemon-reload
sudo systemctl enable --now stake-crash
journalctl -u stake-crash -f
```

> [!IMPORTANT]
> The unit ships with paths hardcoded for the original author's environment (`/home/sb/...`, nvm-installed Node). Edit `User`, `WorkingDirectory`, and `ExecStart` before enabling.

## Architecture

```
┌──────────────┐   CDP    ┌──────────────┐   ws    ┌──────────────┐
│  stake.com   │ ───────► │  capture.js  │ ──────► │  Dashboards  │
│  (WebSocket) │          │  (Puppeteer) │         │ live / stats │
└──────────────┘          └──────┬───────┘         └──────────────┘
                                 │ better-sqlite3
                                 ▼
                          crash_results.db
                                 │ /api/analytics
                                 ▼
                          Aggregated stats
```

1. Puppeteer launches headless Chromium with anti-detection flags and loads `stake.com/casino/games/crash`.
2. A CDP session subscribes to `Network.webSocketFrameReceived`.
3. `processCrashMessage()` filters frames for `__typename === 'MultiplayerCrash'`, broadcasts live state, and persists only `status === 'crash'` events.
4. Express serves `public/` and exposes `/api/analytics`; the `ws` server pushes live updates over the same HTTP server.
5. Streak counters are seeded from the database at startup so they survive restarts.

## Troubleshooting

### Puppeteer fails to launch on Linux

Install the shared libraries Chromium needs:

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
```

### Dashboard shows "Disconnected"

The WebSocket client reconnects automatically. If it stays disconnected, check the server logs — Puppeteer may be inside its 10-second restart backoff after a page crash.

### Database is locked

WAL mode allows concurrent readers (e.g. the `sqlite3` CLI), but **never run two `capture.js` instances against the same DB** — `gameId` PK collisions will silently drop one writer's rows and streak counters will desync.

> [!CAUTION]
> Stake aggressively rate-limits scrapers. Running multiple instances from the same IP, or stripping the anti-detection flags, is likely to get the session blocked.
