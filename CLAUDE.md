# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Node.js monitor for the Stake.com, Shuffle.com, Roobet.com and Goated.com Crash games. For each site, headless Puppeteer attaches a CDP session to intercept `Network.webSocketFrameReceived`, normalizes the site's frames to a common event shape, persists final results to that site's own SQLite file, and broadcasts live state to a bundled web dashboard with one tab per site. Read-only — never places bets or interacts with the pages.

## Commands

```bash
npm install
cp .env.example .env       # all flags optional; defaults work
npm start                  # = node capture.js
```

Then open `http://localhost:3000` (live dashboard) or `http://localhost:3000/analytics.html` (period-windowed analytics). Both have Stake.com / Shuffle.com / Roobet.com / Goated.com tabs; `?site=roobet` deep-links a tab.

There is no test suite, linter, or build step — `capture.js` runs directly under Node 22.12+ (the floor Puppeteer 25 sets; declared in `engines`).

`package.json` carries an `overrides` block pinning `uuid` to `^11.1.1`. `node-notifier@10.0.1` is the latest release and still depends on `uuid@^8`, which has an open advisory, so the override is the only fix that is not a downgrade. Drop it if node-notifier ever ships a version that bumps uuid itself.

## Layout

| File | Responsibility |
|---|---|
| `capture.js` | Wiring only. Builds one monitor per site, serves HTTP + WS, owns the watchdog ladder, notifications and shutdown. |
| `lib/sites.js` | The **only** place site differences live: page URL, env var names, and `parseFrame()` per site — including the wire format, since Roobet is binary and the others are JSON. |
| `lib/store.js` | One SQLite file: schema, migration, history, `buildAnalytics()`. |
| `lib/monitor.js` | One site's capture loop: browser, retry, streaks, dedupe, staleness clock. |
| `public/` | Dashboards; `site-tabs.js` is shared by both pages. |

**Adding a site** means adding an entry to `SITES` in `lib/sites.js` (with a `parseFrame` that returns the normalized event) plus a row in `dump-monthly.sh`'s `SITE_DB` / `SITE_OUT` tables. Nothing else — `capture.js` iterates `SITES`, and the frontends build their tabs from `GET /api/sites`.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Web server / WS port |
| `DB_PATH` | `crash_results.db` | Stake's SQLite file |
| `SHUFFLE_DB_PATH` | `shuffle_crash_results.db` | Shuffle's SQLite file — never point two sites at one file |
| `ROOBET_DB_PATH` | `roobet_crash_results.db` | Roobet's SQLite file |
| `GOATED_DB_PATH` | `goated_crash_results.db` | Goated's SQLite file |
| `STAKE_ENABLED` / `SHUFFLE_ENABLED` / `ROOBET_ENABLED` / `GOATED_ENABLED` | `true` | `false` skips that site's browser; its archive is still served |
| `DASHBOARD_ENABLED` | `true` | Set to `false` for capture-only daemon (skips Express + WS server) |
| `TELEGRAM_ENABLED` | `false` | Only critical events (instant crash, 1000x+) are sent |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Required when Telegram is on |
| `TELEGRAM_SITES` | `all` | Which sites push to Telegram: `all`, `none`, or `stake,shuffle` — console/desktop are unaffected |
| `DESKTOP_NOTIFICATIONS_ENABLED` | `false` | Uses `node-notifier` |
| `WATCHDOG_ENABLED` | `true` | Stall watchdog; `false` disables both tiers |
| `WATCHDOG_STALE_MS` | `180000` | No new row for this long = that site is stalled |
| `WATCHDOG_CHECK_MS` | `30000` | Staleness poll interval |
| `BROWSER_RECYCLE_MS` | `21600000` | Per-site scheduled browser relaunch (6h); `0` disables |
| `TEMPERATURE_WINDOW` | `300` | Rounds in the live dashboard's cold/regular/hot window; clamped to ≥ 50 |
| `STREAK_UNDER_X` | `2.2` | Cold streak watch: a run is consecutive rounds under this multiplier |
| `STREAK_MIN_LEN` | `16` | Cold streak watch: run length that counts as an event; clamped to ≥ 2 |

## Architecture

`capture.js` maps over `SITES`, and for each one creates a store (`lib/store.js`) and a monitor (`lib/monitor.js`). **Nothing is shared between sites** — separate browsers, DB files, streak counters, dedupe sets and staleness clocks — so one site's outage cannot disturb the other's archive. The only shared things are the HTTP/WS server, the notifier and the process itself.

Startup order in `capture.js`, and it matters:

1. **Monitors are constructed** (which opens each DB, runs its migration and seeds its streaks).
2. **Express + WS server (`setupServer`)**, only when `DASHBOARD_ENABLED`.
3. **`monitor.start()` per site** — starts that site's watchdog and its capture loop.

### Per-site store (`lib/store.js`)

`createStore(dbFile, label)` opens the file in WAL mode, creates `crash_results` if missing, then runs `migrateTsMs()` — adds `ts_ms INTEGER` if absent, backfills it from `timestamp` for any rows where it's NULL, and creates `idx_ts_ms`. This makes period queries in `buildAnalytics()` cheap. Any schema change should follow the same idempotent ADD-COLUMN-then-backfill pattern, in this one function, not a separate migration file — it then applies to every site automatically.

`seedStreaks()` recomputes `gamesSinceLast1x`, `gamesSinceLast1000x`, `gamesSinceDouble1x` from the DB so counters survive restarts. Without this, streaks would reset to 0 on every process start.

`buildTemperature()` labels the current stretch `cold | regular | hot` for the live dashboard. It reads the last `TEMPERATURE_WINDOW` rows (300 by default, ~2h on any of the sites at ~130 rounds/h), takes the share that ended `< 2x`, and scores it as a z-score against the site's all-time share with the window excluded; `|z| >= TEMPERATURE_Z` (2) flips the label, positive meaning colder. Design points, all deliberate:

- The under-2x share is the statistic, not the instant-crash rate. It sits near 50% so 300 rounds have real power (σ ≈ 2.9 pp); instants are ~2% on Stake and ~5% on Roobet, so a window holds only 6–14 of them and the label would flip on ordinary noise. Instant count vs. expected is returned for display only.
- The baseline is **per site** — Roobet's instant rate is more than double Stake's — and is per-site by construction since each store owns one file.
- The all-time counts are read with one full scan at store creation (~0.1s on 600k rows) and then kept exact in memory by `insert()`, which only increments them when `INSERT OR IGNORE` actually wrote a row. The hot path therefore does one indexed `LIMIT 300` read per crash, nothing else.
- It returns `null` until the archive holds at least `2 × TEMPERATURE_WINDOW` rows, so a fresh site shows `--` instead of comparing a window with itself.

`buildStreakOdds()` feeds the live dashboard's "cold streak watch": the run of consecutive rounds under `STREAK_UNDER_X` the archive currently ends on, the longest ever, how many runs reached `STREAK_MIN_LEN`, the latest such run, and the probability of one starting in the next hour / day / week. The run-length state machine (`feedStreak`) is seeded by one chronological scan at store creation (~0.4s on 600k rows, ordered by `rowid` like everything else) and then advanced by `insert()` for each row actually written, so it is exact without rescanning. Odds are `(1-p)·p^minLen` per round with `p` the all-time under-threshold share, treated as a Poisson rate at the observed rounds/day, where "observed" excludes inter-row gaps over 10 min so capture outages do not deflate it. It is deliberately model-based rather than counting past events: 13 events is too few for an empirical rate, and independence is the game's own claim. Returns `null` under 1000 rows.

### Per-site monitor (`lib/monitor.js`)

`captureWithRetry` is a single serialized `for(;;)` loop **per site**, so exactly one browser is ever alive per site. `captureOnce` ends its run by awaiting a promise that `page.error` / `browser.disconnected` reject and `restart()` resolves — routing those through the promise keeps them inside the loop's `catch` instead of escaping to `uncaughtException`. Errors back off 10s; a watchdog abort relaunches after 1s.

**Scheduled recycle.** The three crash pages are single-page apps that leak while left open: measured on 2026-09-08, a Stake renderer was at 2.1 GB after 4 days and a Roobet one at 9.2 GB after 24h, with the process holding ~17 GB in total. The watchdog only relaunches on a stall, so `captureOnce` arms a `BROWSER_RECYCLE_MS` timer at each launch. When it fires the run is *not* aborted immediately: `recycleDue` is set and `handleFrame` calls `restart()` right after the next persisted crash, so a live round is never cut off; `RECYCLE_GRACE_MS` (2 min) forces it if no crash frame arrives. `clearRecycle()` runs on every exit from `captureOnce`, so a watchdog relaunch resets the schedule. Launch args add `--js-flags=--max-old-space-size=1024` as a backstop (a leaking renderer is killed by V8, `page.error` fires, and the retry loop relaunches it) and `--disable-features=IsolateOrigins,site-per-process` so third-party iframes share the page renderer instead of spawning ~5 extra processes per browser. Puppeteer merges a user-supplied `--disable-features` with its own list, so that flag does not clobber the defaults.

**Parking tab.** After the CDP listener is attached, `captureOnce` opens a blank tab and brings it to front so the crash page is `document.hidden`. That pauses the page's `requestAnimationFrame` loop and with it the 60fps canvas animation, which was costing roughly a core per site (measured 2026-09-08 over 100s: Stake 117% → 8%, Roobet ~200% → 20%, Shuffle 123% → 43%). Frame delivery is unaffected because CDP reads websocket frames at the network layer and Puppeteer's default flags disable renderer backgrounding and timer throttling. Alternatives that were measured and rejected: request interception blocking images/media/fonts (halved Stake's CPU but Roobet received zero events), `--blink-settings=imagesEnabled=false` (Roobet zero events) and `--disable-gpu` (Roobet went to 260%). Do not close the blank tab or navigate it.

The CDP Network listener is attached **after** navigation. Enabling Network on a freshly-created CDP session while still on `about:blank` and then navigating makes Chrome stop delivering `Network.webSocketFrameReceived` to that session, so the crash subscription frames never arrive (dashboard stays stuck at 1.00x).

`handleFrame()` is the hot path:

1. `site.parseFrame(response)` — given the raw CDP frame — returns a normalized event or `null`.
2. For statuses in `{in_progress, starting, crash, start}`: update `currentGameState`, call `onLive` and broadcast `{type:'live', site, state}`.
3. **Only `status === 'crash'` is persisted.** Duplicates are filtered via a `processedGames` Set, pruned to 500 entries when it exceeds 1000 — this is per-process, not DB-backed, so the DB's `INSERT OR IGNORE` on `gameId` PK is the real duplicate guard.
4. Streaks are incremented for every crash, then `gamesSinceLast1x` / `gamesSinceLast1000x` reset to 0 after their threshold fires. `gamesSinceDouble1x` resets only on back-to-back `<1.01x` (tracked by `lastWas1x`).
5. `notify()` fires Telegram + desktop for `<1.01x` or `>=1000x` (the `isCritical` arg gates Telegram specifically). Console logs always print, prefixed with the site label.

### Frame parsing (`lib/sites.js`)

This is the most error-prone area, and the only file that knows how the sites differ. Every parser returns `{ status, gameId, multiplier, timestamp? }` or `null`, with `status` in `starting | start | in_progress | crash`.

`parseFrame()` receives the **raw CDP frame** (`{ opcode, payloadData }`), not a decoded object, because the wire format is itself a site difference: Stake, Shuffle and Goated send JSON text (opcode 1) while Roobet sends packed binary (opcode 2, base64-encoded by CDP). `monitor.js` therefore does no decoding at all. `jsonFrame(parse)` wraps the JSON sites so `parseStakeFrame` / `parseShuffleFrame` / `parseGoatedFrame` stay pure functions of the decoded object; it drops binary frames and swallows JSON syntax errors. Do not move `JSON.parse` back into `monitor.js` — it would silently discard every Roobet frame.

**Stake** — GraphQL subscription frames with `data.type` of `'data'` or `'next'`; the event is at `payload.data.crash?.event || payload.data.event` (both shapes are in use) and must have `__typename === 'MultiplayerCrash'`. Its status strings are already the normalized vocabulary. Multipliers are full floats.

**Shuffle** — `payload.data.crashEventUpdate` with `__typename === 'CrashEventPayload'`. Differences that matter:

- statuses are `ACCEPTING_BETS | BLOCK | IN_PROGRESS | CRASHED`, mapped via `SHUFFLE_STATUS`;
- multipliers are decimal **strings**, live in `currentPoint` and final in `crashPoint` (null until the round ends), already rounded to 2 decimals at the source;
- the id is the numeric `crashGameId` (increasing integers, vs Stake's UUIDs) — stringified for the PK;
- there is no timestamp field; `startedAt` (epoch ms) + `elapsed` (ms) is the actual crash moment, which beats the receive time;
- a `CRASHED` frame without a usable `crashPoint` is dropped rather than archived as a bogus `1.00x`.

**Roobet** — Socket.IO on a `/crash` namespace. Every update is the single event `stateUpdate`, which Socket.IO splits into a text announcement (`451-/crash,["stateUpdate",{"_placeholder":true,"num":0}]`) plus one binary attachment. The parser ignores the announcement and reads the attachment directly; that is only safe because `stateUpdate` is the sole event on the namespace and each payload's first byte is a self-describing tag. Strings are length-prefixed with one byte, integers are big-endian int32:

- **tag `0x04`** (5 bytes) — a round tick every 150ms, carrying *elapsed milliseconds*, nothing else.
- **tag `0x03`** (35 or 104 bytes) — round lifecycle: id length, 24-char Mongo ObjectId, phase byte, two int32 clock offsets, and for phase 4 a 64-char provably-fair hash plus the crash point **in hundredths** (`187` → `1.87x`). Phases map `1 → starting`, `2 → start`, `3 → in_progress`, `4 → crash`.
- **tag `0x05`** — other players' bets. Ignored.

Two consequences unique to this site:

- **ticks carry no game id**, so the id from the last lifecycle frame is held in the module-level `roobetGameId`. Until one arrives (a fresh browser joining mid-round) ticks are dropped rather than attributed to a null game — that costs at most the live display for one partial round, and nothing in the archive, since the crash frame carries the id itself.
- **ticks carry no multiplier either** — the real client derives it from elapsed time. `ROOBET_GROWTH_PER_MS` (`6.014e-5`) and `ROOBET_LAUNCH_MS` (`233`) are a least-squares fit over 21 observed rounds, accurate to 0.5% from 1.01x to 28.23x, clamped at 1.00x. **Only the live display uses them.** The archived crash point is always the exact integer from phase 4, never a value computed from this curve, so a drift in Roobet's growth constant would cosmetically skew the ticker and leave the data correct.

Also worth knowing: the last ~70 ticks of a Roobet round arrive as a burst with 1ms elapsed steps rather than 150ms, so live broadcasts clump at the end of each round. That is Roobet's behaviour, not a bug.

**Goated** — a dedicated socket, `wss://casino-crash-websocket.goated.com/`, carrying only `{ type: 'crash_updates', data: [item] }` envelopes. Each item names the round in `r` (increasing integers, stringified for the PK) and has a `typ` of `update` (lifecycle), `tick` (~100ms, `v` = current multiplier, `t` = elapsed ms) or `participants` (other players' bets, ignored). Details that matter:

- lifecycle statuses are `waiting → betting → in_progress → crashed`, mapped via `GOATED_STATUS`. `waiting` lasts ~20ms and `betting` is the 7s window; there is no bets-locked phase, so **both map to `starting`** — nothing on this site ever produces `start`;
- every number is a decimal **string** at full float precision (`"24.72606013264511"`), including `crash_multiplier`, which is archived as-is — the site's UI rounds for display, the archive does not;
- `at` is the server's epoch ms for that item, so the `crashed` update's `at` is the crash timestamp (~40ms ahead of receive time);
- a `crashed` update without a usable `crash_multiplier` is dropped, same as Shuffle;
- `data` has only ever held one item (1.6k frames observed on 2026-09-30), but it is an array, so `parseGoatedFrame` folds a batch to one event and a `crash` wins over any tick in the same batch.

Goated's tick growth constant is the same `6.01e-5`/ms as Roobet's, but unlike Roobet the multiplier is sent on every tick, so nothing is derived client-side.

### Stall watchdog

The failure mode this exists for: the process stays alive and the event loop keeps ticking, but a site stops delivering websocket frames. Nothing throws, so neither `captureWithRetry` nor systemd notices — the Stake DB holds a 7.8h gap (2026-07-20) and a 54h gap (2026-08-13) that both happened inside one long-lived PID.

- Liveness is per-site `lastResultMs`, bumped by `noteResult()` on every persisted crash and by `noteCaptureStart()` at boot and on each (re)launch, so a cold start or a relaunch always gets a full window of grace.
- `staleStrikes` is cleared **only** by `noteResult()`. If the interval also cleared it, tier 1's `noteCaptureStart()` would reset the count on the next tick and it could never escalate.
- The ladder lives in `onStale()` in `capture.js`. Strike 1 → that site's `restart()` (browser relaunch, console/desktop only). Strike 2+ → **exit only if every enabled site is stale**; the non-zero code is what marks it a fault for the supervisor, so don't "tidy" it to 0. If another site is still producing results, the process stays up and only the stalled site keeps relaunching — killing the process there would punch a hole in the healthy site's archive to fix a problem it does not have. The critical Telegram alert is sent on strike 2 and then every 20th strike, so a multi-day outage does not send one message per window.
- `cleanup(code)` is idempotent via `isShuttingDown`, and `uncaughtException`/`unhandledRejection` log the error and exit 1 instead of being passed straight in as the exit code.
- Threshold rationale, measured over 90 days of Stake data: 57 gaps > 3min, 12 > 5min, 7 > 6min, and nothing between 6 and 10min. Tier 2 needs two windows (~6min), which in that history only ever means a real outage.

### Server-side analytics (`buildAnalytics` in `lib/store.js`)

`GET /api/analytics?site=<key>&period=<1h|3h|12h|1d|1w|1m|3m|6m|all>` returns a single aggregate object for one site (`site` defaults to `stake`; unknown → 400). Implementation notes that matter when extending it:

- `PERIOD_MS['all']` is `null` — the `null`/non-null branch chooses between `SELECT … WHERE ts_ms >= ?` and a full-table scan. Don't collapse the branches.
- Bucket granularity is auto-picked: hourly if the period is ≤ 24h *or* the data span is ≤ 24h; daily otherwise. The frontend reads `bucketUnit` to relabel charts.
- Percentiles are computed in-process from a sorted copy of all multipliers in the window — fine at current volume (~millions of rows max), but watch this if a table grows much larger.
- `topMultipliers` is a separate `ORDER BY multiplier DESC LIMIT 10` query rather than something derived from the in-memory pass.

### HTTP + WebSocket protocol (server → client)

`GET /api/sites` returns `[{ key, label, tab, url, enabled }]` and is what the tab bars are built from.

`GET /api/health` is aggregate: `503` once **any** enabled site is stale, with a `sites` map of per-site health. Top-level `staleSeconds` is the worst enabled site's, which keeps pre-multi-site probes meaningful.

Three WS message shapes, all JSON strings, **all tagged with `site`**:

```js
{ type: 'history', site, results: [...up to 1000 rows...], streaks: {...}, temperature, streakOdds }  // one per site, on connect
{ type: 'live',    site, state:   { status, multiplier, gameId } }          // every CDP frame for {in_progress, starting, crash, start}
{ type: 'result',  site, result:  { gameId, multiplier, timestamp, ts_ms, ...streaks }, temperature, streakOdds } // only on status === 'crash'
```

`temperature` and `streakOdds` are the `buildTemperature()` / `buildStreakOdds()` objects (or `null`), recomputed after the row is inserted so they already include it.

Every client gets every site's stream; the frontend keeps a state bag per site and renders only the active tab. Adding a new message type means handling it in `public/app.js` (`ws.onmessage` switch).

### Frontend (`public/`)

- `site-tabs.js` — shared tab bar. Builds tabs from `/api/sites`, mirrors the selection into `?site=` and `localStorage`, and rewrites `a.nav-link[data-keep-site]` hrefs so the site follows you across pages. URL wins over the remembered tab so shared links open their site.
- `index.html` + `app.js` — live dashboard. State is `{ site, sites: { <key>: { results, streaks, temperature, liveGame } }, chart }`; the temperature strip and the cold streak watch under the live display are rendered by `updateTemperature()` / `updateStreakOdds()` from the server's objects only — the page never recomputes them, so the two sides cannot disagree. The gauge spans −3…+3 σ with the ±2 σ "regular" band marked; background sites keep accumulating data but touch no DOM. Notable: `animateMultiplier()` runs in `requestAnimationFrame` and *predicts* the live multiplier by drifting it upward ~6%/sec when status is `in_progress`, then snaps toward the server's last value with a 0.2 lerp factor and a `+0.1x` ceiling. Without this, the displayed number stutters between WS frames. If you change crash-rate constants on the server, mirror them here.
- `analytics.html` + `analytics.js` — period-windowed dashboard, fetches `/api/analytics?site=&period=` and renders five Chart.js charts + two card grids + Top 10 table. State is `{ site, period, charts, reqId }`; `destroyCharts()` must be called before re-rendering or Chart.js will leak canvases, and `reqId` drops responses for a tab you already left.
- Both pages share `style.css` (dark theme, brutalist cards).

### Multiplier tier colors (kept in sync across server + both frontends)

| Tier | Range | Color |
|---|---|---|
| red | `< 1.01x` | `#f6465d` |
| orange | `1.01x – 1.99x` | `#ff9f43` |
| green | `2x – 99.99x` | `#0ecb81` |
| purple | `100x – 999.99x` | `#a855f7` |
| turquoise | `≥ 1000x` | `#00d2d3` |

The server uses these labels in `buildAnalytics().distribution`; the frontends mirror them in `getColorClass()` / `colors`; `dump-monthly.sh` mirrors them again in its `TIERS` table. Add a tier in one place → add it in all four.

## Data model

Identical schema per site, in **separate files** (`crash_results.db`, `shuffle_crash_results.db`, `roobet_crash_results.db`):

```sql
CREATE TABLE crash_results (
  gameId               TEXT    PRIMARY KEY,   -- dedupe boundary, unique within one site only
  multiplier           REAL    NOT NULL,
  timestamp            TEXT    NOT NULL,      -- ISO 8601 (Stake's own, derived from Shuffle's startedAt+elapsed, or receive time for Roobet)
  ts_ms                INTEGER,               -- epoch ms, indexed via idx_ts_ms
  gamesSinceLast1x     INTEGER,
  gamesSinceLast1000x  INTEGER,
  gamesSinceDouble1x   INTEGER
);
```

`better-sqlite3` runs in WAL mode (`-wal`, `-shm` sidecar files). Concurrent readers (e.g. `sqlite3` CLI) are fine; never run two `capture.js` instances against the same DB, and never point two sites at one file.

## Archiving

`dump-monthly.sh` dumps **every site that has a DB on disk** by default, each into its own directory (`db-archives/` for stake, `db-archives-shuffle/` for shuffle, `db-archives-roobet/` for roobet), with identical `crash_YYYY-MM.csv` / `.summary.json` naming inside. `-s SITE` scopes it; `-d`/`-o` override paths and therefore only work with a single site. One site's failure does not abort the others — failures are collected and reported with a non-zero exit at the end. `dump-last-month.sh` (the cron entry point) passes everything through, so the existing single cron line covers new sites automatically.

## Deployment

`stake-crash.service.example` is the tracked systemd unit template, with `__USER__` / `__WORKDIR__` / `__NODE__` placeholders and a `sed` recipe in the README to fill them. The rendered `stake-crash.service` is gitignored, so machine-specific paths never land in the repo — edit the `.example` for anything that should reach forkers, not a local copy. The unit name keeps the `stake-crash` prefix for continuity with existing installs even though it now supervises every site.

`ExecStart` must use an absolute `node` path on the same Node major that built `node_modules`: `better-sqlite3` is a native addon, so an `npm install` under a different major kills the unit at startup with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch (fix: `npm rebuild better-sqlite3`, then repoint `ExecStart`). nvm is a shell function and does not exist under systemd, so a bare `node` will not resolve. The unit relies on `Restart=always` for process-level resilience; in-process resilience comes from each site's `captureWithRetry`.

The Docker image must `COPY lib ./lib` alongside `capture.js` and `public`. Compose sets `shm_size: 768m` because the per-site Chromium instances exhaust Docker's default 64 MB `/dev/shm`.

## Things that look weird but aren't

- One stalled site does **not** restart the process while another site is healthy. That asymmetry is deliberate; see the watchdog section.
- `cleanup()` is still wired to `uncaughtException` and `unhandledRejection` — the process exits on *any* unhandled error rather than trying to recover. That is a last-resort backstop: `page.error` and `browser.disconnected` are recovered in-process per site by `captureWithRetry`, and a silent stall is handled by the watchdog. `Restart=always` covers what's left.
- `closeBrowser()` calls `removeAllListeners('disconnected')` before `close()`. Without it, an intentional teardown fires the handler and rejects a promise that has already settled — harmless today, but it makes the shutdown path depend on settle-order.
- The live stdout line is rendered centrally by `renderLiveLine()` in `capture.js` from every monitor's `liveState`, not by each monitor. Two sites each overwriting their own `\r` line garbles the terminal. It is skipped entirely, and the `\r\x1b[K` prefix on result lines dropped, when stdout is not a TTY: under systemd the never-terminated line made journald store the output as `[NNK blob data]` and bury every real log line.
- `migrate_to_sqlite.js` used to exist for one-time JSONL→SQLite import; it has been removed. Don't add it back — `migrateTsMs` in `lib/store.js` is the only ongoing migration path.
- The `processedGames` Set is *also* used as a dedupe even though the DB has `INSERT OR IGNORE` on `gameId`. The Set short-circuits before `store.insert()` and before incrementing streak counters — removing it would cause duplicate streak increments on the same `gameId` within a single process.
- Roobet's `parseFrame` keeps module-level state (`roobetGameId`) even though every other parser is pure. Ticks genuinely do not carry an id, so there is nothing to be pure over; it is safe because exactly one monitor exists per site.
- A disabled site still opens (and therefore creates) its DB file. That keeps its dashboard tab and `/api/analytics` working uniformly instead of special-casing every read path.
