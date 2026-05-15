# Stake Crash Monitor

Real-time monitor for the Stake.com Crash game. Intercepts WebSocket frames via the Chrome DevTools Protocol, persists every result to SQLite, and serves a live dashboard with deep multi-period analytics.

> [!NOTE]
> This tool is read-only: it observes the publicly available crash feed without placing bets or interacting with the page. It is intended for statistical analysis, research, and learning.

## Features

- **Real-time capture** — Headless Puppeteer + CDP (`Network.webSocketFrameReceived`) intercepts the live `MultiplayerCrash` stream.
- **SQLite persistence** — Every crash result is stored in `crash_results.db` via `better-sqlite3` with WAL mode and an indexed millisecond timestamp.
- **Live dashboard** — WebSocket-pushed multiplier display, streak counters, distribution histogram, and color-coded result pills (`/`).
- **Analytics dashboard** — Period selector (1h → 6m → all) with overview, rare-event stats, volume/mean/1000x/instant time-series, and Top 10 multipliers (`/analytics.html`).
- **Multi-channel notifications** — Console, Telegram, and desktop alerts for instant crashes (< 1.01x) and 1000x+ moon shots.
- **Resilient** — Auto-restarts the browser on disconnect; graceful shutdown on `SIGINT` / `SIGTERM`.
- **Deployable** — Ships with a `systemd` unit file for hands-off operation.

## Requirements

- Node.js 18+
- Chromium dependencies (managed by Puppeteer; see [Troubleshooting](#troubleshooting) for Linux)

## Quick start

```bash
git clone https://github.com/<your-fork>/stake-crash-archives.git
cd stake-crash-archives
npm install
cp .env.example .env
npm start
```

Then open [http://localhost:3000](http://localhost:3000) for the live dashboard, or [http://localhost:3000/analytics.html](http://localhost:3000/analytics.html) for the analytics view.

## Configuration

All configuration lives in `.env`. Every flag is optional — the monitor runs with sensible defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web server port |
| `DASHBOARD_ENABLED` | `true` | Set to `false` to run as a headless capture-only daemon |
| `TELEGRAM_ENABLED` | `false` | Send extreme-event alerts via Telegram |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | — | Target chat ID for alerts |
| `DESKTOP_NOTIFICATIONS_ENABLED` | `false` | Native desktop notifications via `node-notifier` |

> [!TIP]
> To get your `TELEGRAM_CHAT_ID`, message your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `chat.id` value.

## Dashboards

### Live (`/`)

- Headline live multiplier with `WAITING` / `STARTING` / `IN PROGRESS` / `CRASHED` states.
- Stats panel: average, median, max across the last 1000 games.
- Streak tracking: games since the last `<1.01x`, `1000x+`, and back-to-back `<1.01x`.
- Real-time distribution histogram (Chart.js).
- Animated result pills with hover tooltips and optional audio cues.

### Analytics (`/analytics.html`)

- Period selector: `1h`, `3h`, `12h`, `1d`, `1w`, `1m`, `3m`, `6m`, `all`.
- Overview cards: total games, mean, median, p90, p99, span.
- Rare-event panel: count and average gap for `<1.01x`, `1000x+`, and double-`<1.01x` events.
- Time-series charts auto-bucketed by hour or day depending on span.
- Top 10 multipliers table with absolute timestamps and game IDs.

### Multiplier tiers

| Color     | Range            | Meaning         |
|-----------|------------------|-----------------|
| Red       | `< 1.01x`        | Instant crash   |
| Orange    | `1.01x – 1.99x`  | Low             |
| Green     | `2x – 99.99x`    | Standard        |
| Purple    | `100x – 999.99x` | High            |
| Turquoise | `≥ 1000x`        | Moon shot       |

## Data model

Results are stored in SQLite (`crash_results.db`):

```sql
CREATE TABLE crash_results (
  gameId               TEXT    PRIMARY KEY,
  multiplier           REAL    NOT NULL,
  timestamp            TEXT    NOT NULL,    -- ISO 8601
  ts_ms                INTEGER,             -- indexed epoch ms
  gamesSinceLast1x     INTEGER,
  gamesSinceLast1000x  INTEGER,
  gamesSinceDouble1x   INTEGER
);
```

`gameId` is the primary key, so re-runs and reconnects never produce duplicate rows.

### Migrating from JSONL

Earlier versions persisted results to `crash_results.jsonl`. To import legacy data into the SQLite store:

```bash
node migrate_to_sqlite.js
```

The script streams the JSONL file, deduplicates on `gameId`, and reports inserted / skipped / malformed counts.

## HTTP & WebSocket API

The monitor exposes a tiny API surface used by the bundled dashboards.

**`GET /api/analytics?period=<period>`** — returns aggregate stats for one of `1h`, `3h`, `12h`, `1d`, `1w`, `1m`, `3m`, `6m`, `all`.

**WebSocket (`ws://<host>:<port>/`)** — clients receive three message shapes:

```jsonc
// 1. On connect: last 1000 results + current streaks
{ "type": "history", "results": [...], "streaks": { ... } }

// 2. Live state on every frame (in_progress / starting / crash / start)
{ "type": "live", "state": { "status": "in_progress", "multiplier": 1.42, "gameId": "..." } }

// 3. Persisted crash result
{ "type": "result", "result": { "gameId": "...", "multiplier": 7.31, ... } }
```

## Running as a service (Linux)

A `systemd` unit is included for keeping the monitor running across reboots:

```bash
sudo cp stake-crash.service /etc/systemd/system/stake-crash.service
# Edit User, WorkingDirectory and ExecStart paths to match your setup
sudo systemctl daemon-reload
sudo systemctl enable --now stake-crash
journalctl -u stake-crash -f
```

> [!IMPORTANT]
> The unit file ships with paths hardcoded for the original author's environment (`/home/sb/...`, nvm-installed Node). Adjust `User`, `WorkingDirectory`, and `ExecStart` before enabling.

## Architecture

```
┌──────────────┐   CDP    ┌──────────────┐   ws    ┌──────────────┐
│  Stake.com   │ ───────► │  capture.js  │ ──────► │  Dashboards  │
│  (WebSocket) │          │  (Puppeteer) │         │ live / stats │
└──────────────┘          └──────┬───────┘         └──────────────┘
                                 │
                                 │ better-sqlite3
                                 ▼
                          crash_results.db
                                 │
                                 │ /api/analytics
                                 ▼
                          Aggregated stats
```

1. Puppeteer launches headless Chromium with anti-detection flags and loads `stake.com/casino/games/crash`.
2. A CDP session subscribes to `Network.webSocketFrameReceived`.
3. `processCrashMessage()` filters frames for `__typename === 'MultiplayerCrash'`, broadcasts live state, and persists only `status === 'crash'` events.
4. The Express server serves `public/` and exposes `/api/analytics`; the `ws` server pushes live updates.
5. Streak counters are seeded from the database at startup so they survive restarts.

## Troubleshooting

### Puppeteer fails to launch on Linux

Install the system libraries Chromium needs:

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
```

### Dashboard shows "Disconnected"

The WebSocket client reconnects automatically. If it stays disconnected, check the server logs — Puppeteer may be in its 10-second restart backoff after a page crash.

### Database is locked

`better-sqlite3` runs in WAL mode, so concurrent readers (e.g. `sqlite3` CLI) are fine. Don't run two `capture.js` instances against the same `crash_results.db`.

> [!CAUTION]
> Stake aggressively rate-limits scrapers. Running multiple instances from the same IP, or removing the anti-detection flags, is likely to get the session blocked.
