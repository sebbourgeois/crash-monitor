require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const notifier = require('node-notifier');

const { SITES } = require('./lib/sites');
const { createStore } = require('./lib/store');
const { createMonitor, floorMult } = require('./lib/monitor');

const PORT = process.env.PORT || 3000;

// Feature Toggles
const DASHBOARD_ENABLED = process.env.DASHBOARD_ENABLED !== 'false';
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';
const DESKTOP_NOTIFICATIONS_ENABLED = process.env.DESKTOP_NOTIFICATIONS_ENABLED === 'true';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// A site list from the environment: "all" (default), "none", or a
// comma-separated list of site keys ("stake,shuffle").
function parseSiteFilter(raw, varName) {
  const value = String(raw ?? 'all').trim().toLowerCase();
  if (value === '' || value === 'all') return new Set(Object.keys(SITES));
  if (value === 'none') return new Set();
  const keys = value.split(',').map(s => s.trim()).filter(Boolean);
  const unknown = keys.filter(k => !SITES[k]);
  if (unknown.length) {
    console.warn(`[CONFIG] ${varName} lists unknown site(s): ${unknown.join(', ')} — known keys are ${Object.keys(SITES).join(', ')}`);
  }
  return new Set(keys.filter(k => SITES[k]));
}

// Which sites are captured. A site left out behaves exactly like one with its
// own *_ENABLED flag set to false: no browser, archive still served.
const CAPTURE_SITES = parseSiteFilter(process.env.SITES, 'SITES');

// Which sites may reach Telegram. Console and desktop notifications are
// unaffected — this only narrows the one channel that pushes to a phone.
const TELEGRAM_SITES = parseSiteFilter(process.env.TELEGRAM_SITES, 'TELEGRAM_SITES');

// Watchdog. A capture stalls silently: the process stays alive and the event
// loop keeps ticking, but the site stops delivering websocket frames, so
// nothing ever throws and neither the retry loop nor systemd notices. Observed
// twice in the Stake DB — a 7.8h gap on 2026-07-20 and a 54h gap starting
// 2026-08-13, both inside a single long-lived PID. "No row written for
// STALE_MS" is the only reliable liveness signal, so the watchdog escalates on
// it; the ladder itself lives in onStale() below.
const WATCHDOG = {
  enabled: process.env.WATCHDOG_ENABLED !== 'false',
  staleMs: Number(process.env.WATCHDOG_STALE_MS) || 3 * 60 * 1000,
  checkMs: Number(process.env.WATCHDOG_CHECK_MS) || 30 * 1000
};

// Scheduled browser recycle, per site. The sites' single-page apps leak while
// left open (multi-GB renderers after a few days), and the watchdog only ever
// relaunches on a stall. 0 disables. See lib/monitor.js for the round-boundary
// handling.
const BROWSER_RECYCLE_MS = process.env.BROWSER_RECYCLE_MS === undefined
  ? 6 * 60 * 60 * 1000
  : Number(process.env.BROWSER_RECYCLE_MS) || 0;

const wsClients = new Set();

function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// Multi-channel notification helper. isCritical gates Telegram specifically;
// console always prints. siteKey scopes the alert to one site so TELEGRAM_SITES
// can filter it; a null siteKey is a process-level alert, which still needs at
// least one site opted in before it is worth pushing.
async function notify(title, message, isCritical = false, siteKey = null) {
  const plainText = message.replace(/<[^>]*>?/gm, ''); // Strip HTML for desktop/logs

  // 1. Console
  console.log(`\n[NOTIFY] ${title}: ${plainText}`);

  // 2. Telegram
  const telegramAllowed = siteKey ? TELEGRAM_SITES.has(siteKey) : TELEGRAM_SITES.size > 0;
  if (TELEGRAM_ENABLED && isCritical && telegramAllowed) {
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
    notifier.notify({ title, message: plainText, sound: true, wait: false });
  }
}

// One shared stdout line for every site. Each monitor overwriting its own \r
// line would garble the terminal once a second site is live, so the in-progress
// multipliers are rendered together into a single line instead. Skipped when
// stdout is not a TTY: under systemd the never-ending \r line makes journald
// log it as "blob data" and bury every real line.
function renderLiveLine() {
  if (!process.stdout.isTTY) return;
  const parts = monitors
    .filter(m => m.enabled && m.liveState.status === 'in_progress')
    .map(m => `${m.site.label} ${floorMult(m.liveState.multiplier)}x`);
  if (parts.length) process.stdout.write(`\r\x1b[K[LIVE] ${parts.join('  |  ')}  `);
}

// Watchdog escalation ladder, shared by every site.
//
// Strike 1 is routine self-healing: over 90 days of Stake history 57 gaps
// exceeded 3 min but only 7 exceeded 6 min, so a browser relaunch must not spam
// Telegram. Strike 2+ means the relaunch did not help.
//
// Exiting the process is only correct when *every* enabled site is stale — that
// is the signature of a wedged process, which a supervisor restart fixes. If one
// site is still delivering results, killing the process would punch holes in its
// archive to fix a problem it does not have, so that site keeps running and only
// the stalled one is relaunched.
async function onStale({ monitor, staleMs, strikes }) {
  const label = monitor.site.label;
  const mins = (staleMs / 60000).toFixed(1);

  if (strikes === 1) {
    console.error(`\n[WATCHDOG] [${label}] No crash result for ${mins} min — relaunching browser.`);
    notify(`⚠️ ${label} capture stalled`, `No result for ${mins} min — relaunching browser`, false, monitor.site.key);
    monitor.graceWindow(); // hold off escalation for one more full window
    monitor.restart();
    return;
  }

  const live = monitors.filter(m => m.enabled);
  if (live.every(m => m.isStale())) {
    // Stop every watchdog first — cleanup() awaits the Telegram round-trip, and
    // another tick inside that window would re-send the alert.
    monitors.forEach(m => m.stopWatchdog());
    console.error(`\n[WATCHDOG] Still no crash result after a browser relaunch (${label}, ${mins} min) — exiting for a service restart.`);
    await notify('⚠️ Capture stalled', 'Still no result after a browser relaunch — exiting so the service restarts', true);
    await cleanup(1);
    return;
  }

  // Re-alert on the first escalation, then hourly-ish, so a multi-day outage
  // stays visible without one message per window.
  if (strikes === 2 || strikes % 20 === 0) {
    await notify(`⚠️ ${label} capture stalled`, `No result for ${mins} min and a browser relaunch did not help. Other sites are healthy, so the process stays up.`, true, monitor.site.key);
  } else {
    console.error(`\n[WATCHDOG] [${label}] Still stalled (${mins} min) — relaunching again; other sites are healthy.`);
  }
  monitor.graceWindow();
  monitor.restart();
}

// One monitor per site, each with its own DB file, browser, streak counters and
// staleness clock. Nothing is shared, so a Shuffle outage cannot disturb the
// Stake capture (and vice versa).
const monitors = Object.values(SITES).map((site) => {
  const dbFile = process.env[site.dbEnv] || site.defaultDb;
  const store = createStore(dbFile, site.label);
  return createMonitor({
    site,
    store,
    enabled: CAPTURE_SITES.has(site.key) && process.env[site.enabledEnv] !== 'false',
    watchdog: WATCHDOG,
    recycleMs: BROWSER_RECYCLE_MS,
    broadcast: (msg) => broadcast({ ...msg, site: site.key }),
    notify,
    onLive: renderLiveLine,
    onStale
  });
});

const monitorFor = (key) => monitors.find(m => m.site.key === key);

function setupServer() {
  if (!DASHBOARD_ENABLED) return null;

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  app.use(express.static(path.join(__dirname, 'public')));

  // Tab bar source of truth: the frontends build their site tabs from this.
  app.get('/api/sites', (req, res) => {
    res.json(monitors.map(m => ({
      key: m.site.key,
      label: m.site.label,
      tab: m.site.tab,
      url: m.site.url,
      enabled: m.enabled
    })));
  });

  // Liveness for external monitoring — same staleness signal the watchdog uses.
  // 503 once any enabled site is stale; staleSeconds is the worst site's, so a
  // probe written against the single-site version keeps working.
  app.get('/api/health', (req, res) => {
    const sites = {};
    let ok = true;
    let worstStale = 0;
    for (const m of monitors) {
      const health = m.health();
      sites[m.site.key] = health;
      if (!health.ok) ok = false;
      if (m.enabled) worstStale = Math.max(worstStale, health.staleSeconds);
    }
    res.status(ok ? 200 : 503).json({
      ok,
      staleSeconds: worstStale,
      thresholdSeconds: Math.round(WATCHDOG.staleMs / 1000),
      watchdogEnabled: WATCHDOG.enabled,
      uptimeSeconds: Math.round(process.uptime()),
      sites
    });
  });

  // ?site= defaults to stake so the pre-multi-site URL still resolves.
  app.get('/api/analytics', (req, res) => {
    const key = typeof req.query.site === 'string' ? req.query.site : 'stake';
    const monitor = monitorFor(key);
    if (!monitor) return res.status(400).json({ error: `unknown site: ${key}` });
    try {
      const period = typeof req.query.period === 'string' ? req.query.period : 'all';
      res.json({ site: key, ...monitor.store.buildAnalytics(period) });
    } catch (err) {
      console.error('Analytics error:', err);
      res.status(500).json({ error: 'analytics failed' });
    }
  });

  // Every client gets every site's state on connect and every site's updates
  // afterwards, so switching tabs in the dashboard needs no reconnect.
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    for (const m of monitors) {
      ws.send(JSON.stringify({
        type: 'history',
        site: m.site.key,
        results: m.store.readHistory(1000),
        streaks: m.streaks,
        temperature: m.store.buildTemperature(),
        streakOdds: m.store.buildStreakOdds()
      }));
      ws.send(JSON.stringify({ type: 'live', site: m.site.key, state: m.liveState }));
    }
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  server.listen(PORT, () => console.log(`Web dashboard: http://localhost:${PORT}`));
  return server;
}

let isShuttingDown = false;

// Exit code matters: 1 tells the supervisor this was a fault, not a clean stop.
async function cleanup(code = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\nShutting down...');
  await Promise.all(monitors.map(m => m.close().catch(() => {})));
  process.exit(code);
}

// SIGHUP too: Puppeteer's signal handlers are disabled (see lib/monitor.js), so
// a closed terminal would otherwise kill node and orphan every browser.
process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('SIGHUP', () => cleanup(0));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  cleanup(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  cleanup(1);
});

setupServer();
console.log(`Capturing: ${monitors.filter(m => m.enabled).map(m => m.site.key).join(', ') || 'no sites'}`);
if (TELEGRAM_ENABLED) {
  const listed = [...TELEGRAM_SITES].join(', ');
  console.log(`Telegram alerts: ${TELEGRAM_SITES.size ? listed : 'no sites (TELEGRAM_SITES=none)'}`);
}
if (WATCHDOG.enabled) {
  console.log(`Watchdog: restart a site with no crash result for ${Math.round(WATCHDOG.staleMs / 1000)}s`);
  console.log(`Browser recycle: ${BROWSER_RECYCLE_MS ? `every ${Math.round(BROWSER_RECYCLE_MS / 60000)} min per site` : 'disabled'}`);
}
monitors.forEach(m => m.start());
