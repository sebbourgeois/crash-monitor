# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Node.js monitor for the Stake.com Crash game. Headless Puppeteer attaches a CDP session to intercept `Network.webSocketFrameReceived`, filters frames for `__typename === 'MultiplayerCrash'`, persists final results to SQLite, and broadcasts live state to a bundled web dashboard. Read-only — never places bets or interacts with the page.

## Commands

```bash
npm install
cp .env.example .env       # all flags optional; defaults work
npm start                  # = node capture.js
```

Then open `http://localhost:3000` (live dashboard) or `http://localhost:3000/analytics.html` (period-windowed analytics).

There is no test suite, linter, or build step — `capture.js` runs directly under Node 22.12+ (the floor Puppeteer 25 sets; declared in `engines`).

`package.json` carries an `overrides` block pinning `uuid` to `^11.1.1`. `node-notifier@10.0.1` is the latest release and still depends on `uuid@^8`, which has an open advisory, so the override is the only fix that is not a downgrade. Drop it if node-notifier ever ships a version that bumps uuid itself.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Web server / WS port |
| `DASHBOARD_ENABLED` | `true` | Set to `false` for capture-only daemon (skips Express + WS server) |
| `TELEGRAM_ENABLED` | `false` | Only critical events (instant crash, 1000x+) are sent |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Required when Telegram is on |
| `DESKTOP_NOTIFICATIONS_ENABLED` | `false` | Uses `node-notifier` |
| `WATCHDOG_ENABLED` | `true` | Stall watchdog; `false` disables both tiers |
| `WATCHDOG_STALE_MS` | `180000` | No new row for this long = stalled |
| `WATCHDOG_CHECK_MS` | `30000` | Staleness poll interval |

## Architecture

Single entry point: `capture.js`. The file does five things in this order, and the ordering matters:

1. **Schema + on-startup migration.** Opens `crash_results.db` in WAL mode, creates `crash_results` if missing, then runs `migrateTsMs()` — adds `ts_ms INTEGER` if absent, backfills it from `timestamp` for any rows where it's NULL, and creates `idx_ts_ms`. This makes period queries in `buildAnalytics()` cheap. Any schema change should follow the same idempotent ADD-COLUMN-then-backfill pattern, not a separate migration file.
2. **Streak seeding (`seedStreaksFromDb`).** Recomputes `gamesSinceLast1x`, `gamesSinceLast1000x`, `gamesSinceDouble1x` from the DB so counters survive restarts. Without this, streaks would reset to 0 on every process start.
3. **Express + WS server (`setupServer`).** Only when `DASHBOARD_ENABLED`. Serves `public/`, exposes `GET /api/analytics?period=…` and `GET /api/health` (watchdog staleness; `503` once stale), and runs a `ws` server on the same HTTP server.
4. **Stall watchdog (`startWatchdog`).** Only liveness signal that catches a silent stall — see below.
5. **Puppeteer + CDP loop (`captureWithRetry` → `captureCrashData`).** Headless Chromium with `--disable-blink-features=AutomationControlled` and a spoofed UA. `captureWithRetry` is a single serialized `for(;;)` loop, so exactly one browser is ever alive. `captureCrashData` ends its run by awaiting a promise that `page.error` / `browser.disconnected` reject and `restartCapture()` resolves — routing those through the promise keeps them inside the loop's `catch` instead of escaping to `uncaughtException`. Errors back off 10s; a watchdog abort relaunches after 1s.
6. **Per-frame handler (`processCrashMessage`).** The hot path — see below.

### Stall watchdog (`startWatchdog`)

The failure mode this exists for: the process stays alive and the event loop keeps ticking, but Stake stops delivering websocket frames. Nothing throws, so neither `captureWithRetry` nor systemd notices — the DB holds a 7.8h gap (2026-07-20) and a 54h gap (2026-08-13) that both happened inside one long-lived PID.

- Liveness is `lastResultMs`, bumped by `noteResult()` on every persisted crash and by `noteCaptureStart()` at boot and on each (re)launch, so a cold start or a relaunch always gets a full window of grace.
- `staleStrikes` is cleared **only** by `noteResult()`. If the interval also cleared it, tier 1's `noteCaptureStart()` would reset the count on the next tick and it could never escalate.
- Strike 1 → `restartCapture()` (browser relaunch, console/desktop only). Strike 2 → `cleanup(1)`; the non-zero code is what marks it a fault for the supervisor, so don't "tidy" it to 0.
- `cleanup(code)` is idempotent via `isShuttingDown`, and `uncaughtException`/`unhandledRejection` now log the error and exit 1 instead of being passed straight in as the exit code.
- Threshold rationale, measured over 90 days: 57 gaps > 3min, 12 > 5min, 7 > 6min, and nothing between 6 and 10min. Tier 2 needs two windows (~6min), which in that history only ever means a real outage.

### CDP frame handling (`processCrashMessage`)

This is the most error-prone area. The chain is:

1. Reject frames where `data.type` is not `'data'` or `'next'`.
2. Pull the event from `payload.data.crash?.event || payload.data.event` — Stake uses both shapes.
3. Require `event.__typename === 'MultiplayerCrash'`.
4. For statuses in `{in_progress, starting, crash, start}`: update `currentGameState` and broadcast `{type:'live', state}`. The `in_progress` branch also writes a `\r[LIVE] …` line to stdout.
5. **Only `status === 'crash'` is persisted.** Duplicates are filtered via a `processedGames` Set, pruned to 500 entries when it exceeds 1000 — this is per-process, not DB-backed, so the DB's `INSERT OR IGNORE` on `gameId` PK is the real duplicate guard.
6. Streaks are incremented for every crash, then `gamesSinceLast1x` / `gamesSinceLast1000x` reset to 0 after their threshold fires. `gamesSinceDouble1x` resets only on back-to-back `<1.01x` (tracked by `lastWas1x`).
7. `notify()` fires Telegram + desktop for `<1.01x` or `>=1000x` (the `isCritical` arg gates Telegram specifically). Console logs always print.

### Server-side analytics (`buildAnalytics`)

`GET /api/analytics?period=<1h|3h|12h|1d|1w|1m|3m|6m|all>` returns a single aggregate object. Implementation notes that matter when extending it:

- `PERIOD_MS['all']` is `null` — the `null`/non-null branch chooses between `SELECT … WHERE ts_ms >= ?` and a full-table scan. Don't collapse the branches.
- Bucket granularity is auto-picked: hourly if the period is ≤ 24h *or* the data span is ≤ 24h; daily otherwise. The frontend reads `bucketUnit` to relabel charts.
- Percentiles are computed in-process from a sorted copy of all multipliers in the window — fine at current volume (~millions of rows max), but watch this if the table grows much larger.
- `topMultipliers` is a separate `ORDER BY multiplier DESC LIMIT 10` query rather than something derived from the in-memory pass.

### WebSocket protocol (server → client)

Three message shapes, all sent as JSON strings:

```js
{ type: 'history', results: [...up to 1000 rows...], streaks: { gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x } }  // on connect
{ type: 'live',    state:   { status, multiplier, gameId } }                                                                    // every CDP frame for {in_progress, starting, crash, start}
{ type: 'result',  result:  { gameId, multiplier, timestamp, ts_ms, gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x } } // only on status === 'crash'
```

Adding a new message type means handling it in `public/app.js` (`ws.onmessage` switch).

### Frontend (`public/`)

- `index.html` + `app.js` — live dashboard. Notable: `animateMultiplier()` runs in `requestAnimationFrame` and *predicts* the live multiplier by drifting it upward ~6%/sec when status is `in_progress`, then snaps toward the server's last value with a 0.2 lerp factor and a `+0.1x` ceiling. Without this, the displayed number stutters between WS frames. If you change crash-rate constants on the server, mirror them here.
- `analytics.html` + `analytics.js` — period-windowed dashboard, fetches `/api/analytics` and renders five Chart.js charts + two card grids + Top 10 table. State is `{ period, charts }`; `destroyCharts()` must be called before re-rendering or Chart.js will leak canvases.
- Both pages share `style.css` (dark theme, glassmorphic cards).

### Multiplier tier colors (kept in sync across server + both frontends)

| Tier | Range | Color |
|---|---|---|
| red | `< 1.01x` | `#f6465d` |
| orange | `1.01x – 1.99x` | `#ff9f43` |
| green | `2x – 99.99x` | `#0ecb81` |
| purple | `100x – 999.99x` | `#a855f7` |
| turquoise | `≥ 1000x` | `#00d2d3` |

The server uses these labels in `buildAnalytics().distribution`; the frontends mirror them in `getColorClass()` / `colors`. Add a tier in one place → add it in all three.

## Data model

```sql
CREATE TABLE crash_results (
  gameId               TEXT    PRIMARY KEY,   -- dedupe boundary
  multiplier           REAL    NOT NULL,
  timestamp            TEXT    NOT NULL,      -- ISO 8601 from Stake (or new Date() fallback)
  ts_ms                INTEGER,               -- epoch ms, indexed via idx_ts_ms
  gamesSinceLast1x     INTEGER,
  gamesSinceLast1000x  INTEGER,
  gamesSinceDouble1x   INTEGER
);
```

`better-sqlite3` runs in WAL mode (`crash_results.db-wal`, `-shm` sidecar files). Concurrent readers (e.g. `sqlite3` CLI) are fine; never run two `capture.js` instances against the same DB.

## Deployment

`stake-crash.service` is a systemd unit with hardcoded paths for the original author's environment (`/home/sb/...`, nvm-installed Node). Adjust `User`, `WorkingDirectory`, and `ExecStart` before enabling. The unit relies on `Restart=always` for process-level resilience; in-process resilience comes from `captureWithRetry`.

## Things that look weird but aren't

- `cleanup()` is still wired to `uncaughtException` and `unhandledRejection` — the process exits on *any* unhandled error rather than trying to recover. That is now a last-resort backstop: `page.error` and `browser.disconnected` are recovered in-process by `captureWithRetry`, and a silent stall is handled by the watchdog. `Restart=always` covers what's left.
- `closeBrowser()` calls `removeAllListeners('disconnected')` before `close()`. Without it, an intentional teardown fires the handler and rejects a promise that has already settled — harmless today, but it makes the shutdown path depend on settle-order.
- `migrate_to_sqlite.js` used to exist for one-time JSONL→SQLite import; it has been removed. Don't add it back — the schema migration in `capture.js` (`migrateTsMs`) is the only ongoing migration path.
- The `processedGames` Set is *also* used as a dedupe even though the DB has `INSERT OR IGNORE` on `gameId`. The Set short-circuits before `insertResult.run()` and before incrementing streak counters — removing it would cause duplicate streak increments on the same `gameId` within a single process.
