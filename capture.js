require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const notifier = require('node-notifier');
const Database = require('better-sqlite3');

const STAKE_CRASH_URL = 'https://stake.com/casino/games/crash';
const DB_FILE = process.env.DB_PATH || 'crash_results.db';
const PORT = process.env.PORT || 3000;

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS crash_results (
    gameId TEXT PRIMARY KEY,
    multiplier REAL NOT NULL,
    timestamp TEXT NOT NULL,
    gamesSinceLast1x INTEGER,
    gamesSinceLast1000x INTEGER,
    gamesSinceDouble1x INTEGER
  );
`);

(function migrateTsMs() {
  const cols = db.prepare("PRAGMA table_info(crash_results)").all();
  const hasTsMs = cols.some(c => c.name === 'ts_ms');
  if (!hasTsMs) {
    console.log('Migrating: adding ts_ms column...');
    db.exec('ALTER TABLE crash_results ADD COLUMN ts_ms INTEGER');
  }
  const pending = db.prepare('SELECT rowid, timestamp FROM crash_results WHERE ts_ms IS NULL').all();
  if (pending.length > 0) {
    const update = db.prepare('UPDATE crash_results SET ts_ms = ? WHERE rowid = ?');
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        const ms = Date.parse(r.timestamp);
        if (!isNaN(ms)) update.run(ms, r.rowid);
      }
    });
    tx(pending);
    console.log(`Backfilled ts_ms for ${pending.length} rows.`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_ts_ms ON crash_results(ts_ms)');
})();

const insertResult = db.prepare(`
  INSERT OR IGNORE INTO crash_results
    (gameId, multiplier, timestamp, ts_ms, gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x)
  VALUES (@gameId, @multiplier, @timestamp, @ts_ms, @gamesSinceLast1x, @gamesSinceLast1000x, @gamesSinceDouble1x)
`);

const selectHistory = db.prepare(`
  SELECT gameId, multiplier, timestamp, gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x
  FROM crash_results
  ORDER BY rowid DESC
  LIMIT ?
`);

// Feature Toggles
const DASHBOARD_ENABLED = process.env.DASHBOARD_ENABLED !== 'false';
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';
const DESKTOP_NOTIFICATIONS_ENABLED = process.env.DESKTOP_NOTIFICATIONS_ENABLED === 'true';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Watchdog. The capture stalls silently: the process stays alive and the event
// loop keeps ticking, but Stake stops delivering websocket frames, so nothing
// ever throws and neither captureWithRetry nor systemd notices. Observed twice
// in the DB — a 7.8h gap on 2026-07-20 and a 54h gap starting 2026-08-13, both
// inside a single long-lived PID. "No row written for STALE_MS" is the only
// reliable liveness signal, so the watchdog escalates on it: first relaunch the
// browser in-process, then exit non-zero so the supervisor (systemd
// Restart=always / docker restart policy) rebuilds the whole process.
const WATCHDOG_ENABLED = process.env.WATCHDOG_ENABLED !== 'false';
const WATCHDOG_STALE_MS = Number(process.env.WATCHDOG_STALE_MS) || 3 * 60 * 1000;
const WATCHDOG_CHECK_MS = Number(process.env.WATCHDOG_CHECK_MS) || 30 * 1000;

const wsClients = new Set();
let gamesSinceLast1x = 0;
let gamesSinceLast1000x = 0;
let gamesSinceDouble1x = 0;
let lastWas1x = false;
let currentGameState = { status: 'waiting', multiplier: 1.00, gameId: null };

// Watchdog state. lastResultMs starts at boot rather than at the DB's newest
// row so a cold start (or a restart mid-outage) gets a full window of grace
// before the watchdog can fire. staleStrikes is only ever cleared by a real
// result, which is what makes the escalation ladder work.
let lastResultMs = Date.now();
let staleStrikes = 0;
const noteResult = () => { lastResultMs = Date.now(); staleStrikes = 0; };
const noteCaptureStart = () => { lastResultMs = Date.now(); };

function seedStreaksFromDb() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM crash_results').get().n;
  if (total === 0) return;

  const rowsAfter = (rowid) =>
    rowid == null ? total : db.prepare('SELECT COUNT(*) AS n FROM crash_results WHERE rowid > ?').get(rowid).n;

  const last1x = db.prepare('SELECT MAX(rowid) AS r FROM crash_results WHERE multiplier < 1.01').get().r;
  const last1000x = db.prepare('SELECT MAX(rowid) AS r FROM crash_results WHERE multiplier >= 1000').get().r;
  const lastDouble = db.prepare(`
    SELECT MAX(c1.rowid) AS r
    FROM crash_results c1
    JOIN crash_results c0 ON c0.rowid = c1.rowid - 1
    WHERE c1.multiplier < 1.01 AND c0.multiplier < 1.01
  `).get().r;

  gamesSinceLast1x = rowsAfter(last1x);
  gamesSinceLast1000x = rowsAfter(last1000x);
  gamesSinceDouble1x = rowsAfter(lastDouble);

  const latest = db.prepare('SELECT multiplier FROM crash_results ORDER BY rowid DESC LIMIT 1').get();
  lastWas1x = latest ? latest.multiplier < 1.01 : false;

  console.log(`Seeded streaks from DB (${total} rows): since<1.01=${gamesSinceLast1x}, since>=1000=${gamesSinceLast1000x}, sinceDouble<1.01=${gamesSinceDouble1x}`);
}

seedStreaksFromDb();

// Multi-channel notification helper
async function notify(title, message, isCritical = false) {
  const plainText = message.replace(/<[^>]*>?/gm, ''); // Strip HTML for desktop/logs
  
  // 1. Console
  console.log(`\n[NOTIFY] ${title}: ${plainText}`);

  // 2. Telegram
  if (TELEGRAM_ENABLED && isCritical) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `<b>${title}</b>\n${message}`,
          parse_mode: 'HTML'
        })
      });
    } catch (err) {
      console.error('Telegram error:', err.message);
    }
  }

  // 3. Desktop
  if (DESKTOP_NOTIFICATIONS_ENABLED) {
    notifier.notify({
      title: title,
      message: plainText,
      sound: true,
      wait: false
    });
  }
}

function readHistory(count = 100) {
  try {
    return selectHistory.all(count);
  } catch (err) {
    console.error('Error reading history:', err.message);
    return [];
  }
}

const PERIOD_MS = {
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '3m': 90 * 24 * 60 * 60 * 1000,
  '6m': 180 * 24 * 60 * 60 * 1000,
  'all': null
};

function buildAnalytics(period = 'all') {
  const offset = PERIOD_MS[period] !== undefined ? PERIOD_MS[period] : null;
  const fromMs = offset === null ? null : Date.now() - offset;

  const rows = fromMs === null
    ? db.prepare('SELECT multiplier, ts_ms FROM crash_results ORDER BY rowid ASC').all()
    : db.prepare('SELECT multiplier, ts_ms FROM crash_results WHERE ts_ms >= ? ORDER BY rowid ASC').all(fromMs);

  if (rows.length === 0) return { total: 0, period };

  const total = rows.length;
  const spanMs = (rows[rows.length - 1].ts_ms ?? 0) - (rows[0].ts_ms ?? 0);
  const bucketByHour = (offset !== null && offset <= 24 * 60 * 60 * 1000) || spanMs <= 24 * 60 * 60 * 1000;
  const bucketUnit = bucketByHour ? 'hour' : 'day';

  const bucketKey = (ts) => {
    if (!ts) return 'unknown';
    const d = new Date(ts);
    return bucketByHour
      ? d.toISOString().slice(0, 13) + ':00'
      : d.toISOString().slice(0, 10);
  };

  let sum = 0, max = -Infinity, min = Infinity;
  let count1000x = 0, countLt = 0, countDouble = 0;
  const gaps1000x = [], gapsLt = [];
  let gapSince1000x = 0, gapSinceLt = 0;
  let lastWasLt = false;
  const perBucket = new Map();
  const dist = { red: 0, orange: 0, green: 0, purple: 0, turquoise: 0 };
  const multipliers = new Array(total);

  for (let i = 0; i < total; i++) {
    const m = rows[i].multiplier;
    const key = bucketKey(rows[i].ts_ms);

    sum += m;
    if (m > max) max = m;
    if (m < min) min = m;
    multipliers[i] = m;

    if (m < 1.01) dist.red++;
    else if (m < 2) dist.orange++;
    else if (m < 100) dist.green++;
    else if (m < 1000) dist.purple++;
    else dist.turquoise++;

    gapSince1000x++;
    gapSinceLt++;
    if (m >= 1000) {
      count1000x++;
      gaps1000x.push(gapSince1000x);
      gapSince1000x = 0;
    }
    if (m < 1.01) {
      countLt++;
      gapsLt.push(gapSinceLt);
      gapSinceLt = 0;
      if (lastWasLt) countDouble++;
      lastWasLt = true;
    } else {
      lastWasLt = false;
    }

    let bucket = perBucket.get(key);
    if (!bucket) {
      bucket = { key, total: 0, count1000x: 0, countLt: 0, sumMultiplier: 0 };
      perBucket.set(key, bucket);
    }
    bucket.total++;
    bucket.sumMultiplier += m;
    if (m >= 1000) bucket.count1000x++;
    if (m < 1.01) bucket.countLt++;
  }

  const sorted = multipliers.slice().sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const maxOf = (arr) => arr.length ? arr.reduce((a, b) => a > b ? a : b, 0) : 0;

  const topMultipliers = fromMs === null
    ? db.prepare('SELECT gameId, multiplier, timestamp FROM crash_results ORDER BY multiplier DESC LIMIT 10').all()
    : db.prepare('SELECT gameId, multiplier, timestamp FROM crash_results WHERE ts_ms >= ? ORDER BY multiplier DESC LIMIT 10').all(fromMs);

  const buckets = [...perBucket.values()].sort((a, b) => a.key.localeCompare(b.key));
  const effectiveSpanMs = Math.max(spanMs, 1);
  const spanDays = effectiveSpanMs / (24 * 60 * 60 * 1000);
  const spanHours = effectiveSpanMs / (60 * 60 * 1000);

  return {
    period,
    total,
    firstMs: rows[0].ts_ms,
    lastMs: rows[rows.length - 1].ts_ms,
    bucketUnit,
    bucketCount: perBucket.size,
    spanDays,
    spanHours,
    gamesPerDay: total / Math.max(spanDays, 1 / 24),
    gamesPerHour: total / Math.max(spanHours, 1 / 60),
    mean: sum / total,
    median: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    max,
    min,
    distribution: dist,
    count1000x,
    countLt1_01: countLt,
    countDouble1x: countDouble,
    avgGap1000x: avg(gaps1000x),
    avgGapLt1_01: avg(gapsLt),
    maxGap1000x: maxOf(gaps1000x),
    maxGapLt1_01: maxOf(gapsLt),
    currentGap1000x: gapSince1000x,
    currentGapLt1_01: gapSinceLt,
    topMultipliers,
    buckets: buckets.map(b => ({
      key: b.key,
      total: b.total,
      count1000x: b.count1000x,
      countLt: b.countLt,
      meanMultiplier: b.sumMultiplier / b.total
    }))
  };
}

function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

function setupServer() {
  if (!DASHBOARD_ENABLED) return null;

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  app.use(express.static(path.join(__dirname, 'public')));

  // Liveness for external monitoring — same staleness signal the watchdog uses.
  app.get('/api/health', (req, res) => {
    const staleMs = Date.now() - lastResultMs;
    const stale = staleMs >= WATCHDOG_STALE_MS;
    res.status(stale ? 503 : 200).json({
      ok: !stale,
      staleSeconds: Math.round(staleMs / 1000),
      thresholdSeconds: Math.round(WATCHDOG_STALE_MS / 1000),
      lastResultMs,
      staleStrikes,
      watchdogEnabled: WATCHDOG_ENABLED,
      uptimeSeconds: Math.round(process.uptime())
    });
  });

  app.get('/api/analytics', (req, res) => {
    try {
      const period = typeof req.query.period === 'string' ? req.query.period : 'all';
      res.json(buildAnalytics(period));
    } catch (err) {
      console.error('Analytics error:', err);
      res.status(500).json({ error: 'analytics failed' });
    }
  });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.send(JSON.stringify({
      type: 'history',
      results: readHistory(1000),
      streaks: { gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x }
    }));
    ws.send(JSON.stringify({ type: 'live', state: currentGameState }));
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  server.listen(PORT, () => console.log(`Web dashboard: http://localhost:${PORT}`));
  return server;
}

const RETRY_DELAY_MS = 10000;
const RELAUNCH_DELAY_MS = 1000;

let browser = null;
let abortCapture = null; // set while a capture run is live; ends the run without an error

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function closeBrowser(b) {
  if (!b) return;
  // Drop 'disconnected' first: closing the browser fires it, and the handler
  // would otherwise reject the (already settled) run promise on the way out.
  b.removeAllListeners('disconnected');
  await b.close().catch(() => {});
}

// One serialized supervisor loop. captureCrashData only returns when
// restartCapture() aborts it; anything else lands in the catch. Either way the
// browser is torn down and relaunched, so there is exactly one browser alive.
async function captureWithRetry() {
  for (;;) {
    let failed = false;
    try {
      await captureCrashData();
    } catch (err) {
      failed = true;
      console.error('Capture error:', err.message);
    }
    abortCapture = null;
    await closeBrowser(browser);
    browser = null;

    const delay = failed ? RETRY_DELAY_MS : RELAUNCH_DELAY_MS;
    console.log(`Restarting browser in ${delay / 1000}s...`);
    await sleep(delay);
    noteCaptureStart(); // the fresh run gets a full stale window before escalation
  }
}

// Ends the current capture run; the loop above relaunches the browser.
function restartCapture() {
  const abort = abortCapture;
  abortCapture = null;
  if (abort) abort();
  else closeBrowser(browser); // still starting up — kill it so page.goto rejects
}

function startWatchdog() {
  if (!WATCHDOG_ENABLED) return;
  console.log(`Watchdog: restart if no crash result for ${Math.round(WATCHDOG_STALE_MS / 1000)}s`);
  const timer = setInterval(async () => {
    const staleMs = Date.now() - lastResultMs;
    if (staleMs < WATCHDOG_STALE_MS) return;

    staleStrikes++;
    const mins = (staleMs / 60000).toFixed(1);
    if (staleStrikes === 1) {
      // Not critical: over 90 days of history, 57 gaps exceeded 3 min but only
      // 7 exceeded 6 min, so tier 1 is mostly routine self-healing and must not
      // spam Telegram. Only the escalation below is worth waking someone for.
      console.error(`\n[WATCHDOG] No crash result for ${mins} min — relaunching browser.`);
      notify('⚠️ Capture stalled', `No result for ${mins} min — relaunching browser`, false);
      noteCaptureStart(); // hold off escalation for one more full window
      restartCapture();
    } else {
      // Stop ticking first — cleanup() awaits the Telegram round-trip, and a
      // second tick in that window would re-send the alert.
      clearInterval(timer);
      console.error(`\n[WATCHDOG] Still no crash result after a browser relaunch (${mins} min) — exiting for a service restart.`);
      await notify('⚠️ Capture stalled', 'Still no result after a browser relaunch — exiting so the service restarts', true);
      await cleanup(1);
    }
  }, WATCHDOG_CHECK_MS);
}

async function captureCrashData() {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const processedGames = new Set();

  await page.goto(STAKE_CRASH_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Attach the CDP Network listener AFTER navigation. Enabling Network on a
  // freshly-created CDP session while still on about:blank and then navigating
  // makes Chrome stop delivering Network.webSocketFrameReceived to that session,
  // so the crash subscription frames never arrive (dashboard stays stuck at 1.00x).
  // Enabling it once the page is loaded — it holds a persistent GraphQL crash
  // subscription — restores frame delivery.
  const client = await page.createCDPSession();
  client.on('Network.webSocketFrameReceived', ({ response }) => {
    try {
      const data = JSON.parse(response.payloadData);
      processCrashMessage(data, processedGames);
    } catch (e) {}
  });
  await client.send('Network.enable');

  console.log('Monitoring crash game results...');
  noteCaptureStart();

  // Keep the run alive until it is aborted (resolve) or the browser/page dies
  // (reject). Routing browser and page failures through this promise keeps them
  // inside captureWithRetry's catch — thrown from the listener they would land
  // in uncaughtException and take the whole process down instead.
  await new Promise((resolve, reject) => {
    abortCapture = resolve;
    page.on('error', reject);
    browser.on('disconnected', () => reject(new Error('Browser disconnected')));
  });
}

// Stake's UI truncates to 2 decimals (e.g. 1.0089 → "1.00x", not "1.01x"). Match that.
const floorMult = (m) => (Math.floor(m * 100) / 100).toFixed(2);

function processCrashMessage(data, processedGames) {
  if (data.type !== 'data' && data.type !== 'next') return;
  const payload = data.payload?.data;
  if (!payload) return;

  const event = payload.crash?.event || payload.event;
  if (!event || event.__typename !== 'MultiplayerCrash') return;

  const { status, id: gameId, multiplier = 1.00 } = event;

  if (['in_progress', 'starting', 'crash', 'start'].includes(status)) {
    currentGameState = { status, multiplier, gameId };
    if (status === 'in_progress') {
      process.stdout.write(`\r[LIVE] ${floorMult(multiplier)}x    `);
    }
    broadcast({ type: 'live', state: currentGameState });
  }

  if (status !== 'crash' || processedGames.has(gameId)) return;
  processedGames.add(gameId);

  if (processedGames.size > 1000) {
    [...processedGames].slice(0, 500).forEach(id => processedGames.delete(id));
  }

  gamesSinceLast1x++;
  gamesSinceLast1000x++;
  gamesSinceDouble1x++;
  if (multiplier < 1.01 && lastWas1x) gamesSinceDouble1x = 0;
  lastWas1x = (multiplier < 1.01);

  const timestamp = event.timestamp || new Date().toISOString();
  const ts_ms = Date.parse(timestamp) || Date.now();
  const result = {
    gameId, multiplier, timestamp, ts_ms,
    gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x
  };

  if (multiplier < 1.01) {
    notify('🔴 INSTANT CRASH!', `${floorMult(multiplier)}x after ${gamesSinceLast1x} games`, true);
    gamesSinceLast1x = 0;
  } else if (multiplier >= 1000) {
    notify('🚀 1000x+ MOON!', `${floorMult(multiplier)}x after ${gamesSinceLast1000x} games`, true);
    gamesSinceLast1000x = 0;
  }

  const multStr = (floorMult(multiplier) + 'x').padStart(10);
  console.log(`\r\x1b[K[CRASH] ${multStr} | Game: ${gameId} | Since 1x: ${result.gamesSinceLast1x} | Since 1000x: ${result.gamesSinceLast1000x}`);

  insertResult.run(result);
  noteResult();
  broadcast({ type: 'result', result });
}

let isShuttingDown = false;

// Exit code matters: 1 tells the supervisor this was a fault, not a clean stop.
async function cleanup(code = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\nShutting down...');
  await closeBrowser(browser);
  try { db.close(); } catch {}
  process.exit(code);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  cleanup(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  cleanup(1);
});

setupServer();
startWatchdog();
captureWithRetry();
