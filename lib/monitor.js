// One monitor per site: its own browser, its own streak counters, its own
// dedupe set, its own staleness clock. Nothing here is shared between sites,
// so a Shuffle outage cannot disturb the Stake capture (and vice versa).
const puppeteer = require('puppeteer');

const RETRY_DELAY_MS = 10000;
const RELAUNCH_DELAY_MS = 1000;
// Once a recycle is due, wait this long for a natural round boundary (a crash
// frame) before relaunching anyway — a stalled site must not block its recycle.
const RECYCLE_GRACE_MS = 2 * 60 * 1000;
// Under systemd stdout is a pipe: a \r line never ends, so journald buffers it
// as "blob data" and hides the real log lines. Only clear the line on a TTY.
const CLEAR_LINE = process.stdout.isTTY ? '\r\x1b[K' : '';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Stake's UI truncates to 2 decimals (e.g. 1.0089 → "1.00x", not "1.01x"). Match that.
const floorMult = (m) => (Math.floor(m * 100) / 100).toFixed(2);

function createMonitor({ site, store, enabled, watchdog, recycleMs = 0, broadcast, notify, onLive, onStale }) {
  const seeded = store.seedStreaks();
  let gamesSinceLast1x = seeded.gamesSinceLast1x;
  let gamesSinceLast1000x = seeded.gamesSinceLast1000x;
  let gamesSinceDouble1x = seeded.gamesSinceDouble1x;
  let lastWas1x = seeded.lastWas1x;

  console.log(`[${site.label}] Seeded streaks from DB (${seeded.total} rows): since<1.01=${gamesSinceLast1x}, since>=1000=${gamesSinceLast1000x}, sinceDouble<1.01=${gamesSinceDouble1x}`);

  let currentGameState = { status: 'waiting', multiplier: 1.00, gameId: null };
  const processedGames = new Set();

  // Watchdog clock. lastResultMs starts at boot rather than at the DB's newest
  // row so a cold start (or a restart mid-outage) gets a full window of grace
  // before the watchdog can fire. staleStrikes is only ever cleared by a real
  // result, which is what makes the escalation ladder work — if the interval
  // cleared it too, the relaunch in tier 1 would reset the count every tick and
  // it could never escalate.
  let lastResultMs = Date.now();
  let staleStrikes = 0;
  const noteResult = () => { lastResultMs = Date.now(); staleStrikes = 0; };
  const noteCaptureStart = () => { lastResultMs = Date.now(); };

  let browser = null;
  let abortCapture = null; // set while a capture run is live; ends the run without an error
  let watchdogTimer = null;

  // Scheduled browser recycle. The sites are single-page apps that leak while
  // left open: after four days a Stake renderer sat at 2 GB and a Roobet one at
  // 9 GB. The watchdog only relaunches on a stall, so without this a healthy
  // browser is never replaced. The recycle waits for the next crash frame so a
  // live round is not cut off mid-flight; RECYCLE_GRACE_MS caps that wait.
  let recycleDue = false;
  let recycleTimer = null;
  let recycleGraceTimer = null;

  function recycleNow(reason) {
    if (!abortCapture) return; // run already ending
    console.log(`${CLEAR_LINE}[${site.label}] Recycling browser (${reason}).`);
    restart();
  }

  function scheduleRecycle() {
    if (!recycleMs) return;
    recycleTimer = setTimeout(() => {
      recycleDue = true;
      recycleGraceTimer = setTimeout(() => recycleNow('no round boundary within grace'), RECYCLE_GRACE_MS);
    }, recycleMs);
  }

  function clearRecycle() {
    recycleDue = false;
    clearTimeout(recycleTimer);
    clearTimeout(recycleGraceTimer);
    recycleTimer = recycleGraceTimer = null;
  }

  async function closeBrowser(b) {
    if (!b) return;
    // Drop 'disconnected' first: closing the browser fires it, and the handler
    // would otherwise reject the (already settled) run promise on the way out.
    b.removeAllListeners('disconnected');
    await b.close().catch(() => {});
  }

  // `response` is the raw CDP frame: parsers own their own decoding because the
  // wire format (JSON text vs. packed binary) is itself a site difference.
  function handleFrame(response) {
    const event = site.parseFrame(response);
    if (!event) return;

    const { status, gameId, multiplier } = event;

    if (['in_progress', 'starting', 'crash', 'start'].includes(status)) {
      currentGameState = { status, multiplier, gameId };
      if (onLive) onLive(site, currentGameState);
      broadcast({ type: 'live', state: currentGameState });
    }

    // Only a finished round is archived. processedGames short-circuits before
    // the streak counters are touched, so a repeated frame for the same gameId
    // cannot double-increment them — the DB's INSERT OR IGNORE alone would not
    // prevent that.
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
      notify(`🔴 ${site.label} INSTANT CRASH!`, `${floorMult(multiplier)}x after ${gamesSinceLast1x} games`, true, site.key);
      gamesSinceLast1x = 0;
    } else if (multiplier >= 1000) {
      notify(`🚀 ${site.label} 1000x+ MOON!`, `${floorMult(multiplier)}x after ${gamesSinceLast1000x} games`, true, site.key);
      gamesSinceLast1000x = 0;
    }

    const multStr = (floorMult(multiplier) + 'x').padStart(10);
    console.log(`${CLEAR_LINE}[${site.label}] ${multStr} | Game: ${gameId} | Since 1x: ${result.gamesSinceLast1x} | Since 1000x: ${result.gamesSinceLast1000x}`);

    store.insert(result);
    noteResult();
    broadcast({ type: 'result', result });

    // A crash frame is the round boundary: the cheapest moment to relaunch.
    if (recycleDue) recycleNow(`scheduled every ${Math.round(recycleMs / 60000)} min`);
  }

  async function captureOnce() {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        // Fold the page's third-party iframes (ads, chat widgets, captchas) into
        // the page renderer instead of ~5 extra processes per browser. Puppeteer
        // merges this list with its own --disable-features.
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        // Backstop for the leak the scheduled recycle exists for: past this V8
        // heap the renderer is killed, page 'error' fires, and captureWithRetry
        // relaunches it 10s later instead of the box swapping.
        '--js-flags=--max-old-space-size=1024'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    // Roobet needs 40-45s to reach networkidle2 on a loaded box; 60s was marginal.
    await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 120000 });

    // Attach the CDP Network listener AFTER navigation. Enabling Network on a
    // freshly-created CDP session while still on about:blank and then navigating
    // makes Chrome stop delivering Network.webSocketFrameReceived to that session,
    // so the crash subscription frames never arrive (dashboard stays stuck at 1.00x).
    // Enabling it once the page is loaded — it holds a persistent GraphQL crash
    // subscription — restores frame delivery.
    const client = await page.createCDPSession();
    client.on('Network.webSocketFrameReceived', ({ response }) => {
      try {
        handleFrame(response);
      } catch (e) {}
    });
    await client.send('Network.enable');

    // Park the crash page behind a blank tab. document.hidden pauses its
    // requestAnimationFrame loop, so the 60fps canvas animation stops burning
    // a core per site (measured 2026-09-08: Stake 117% -> 8%, Roobet ~200% ->
    // 20%, Shuffle 123% -> 43%). The websocket is unaffected: CDP reads frames
    // at the network layer, and Puppeteer's default --disable-renderer-
    // backgrounding / --disable-background-timer-throttling keep the page's
    // own timers running. Blocking images/fonts or --disable-gpu were measured
    // too and both broke Roobet.
    const parkingTab = await browser.newPage();
    await parkingTab.bringToFront();

    console.log(`[${site.label}] Monitoring crash game results at ${site.url}`);
    noteCaptureStart();
    scheduleRecycle();

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

  // One serialized supervisor loop per site. captureOnce only returns when
  // restart() aborts it; anything else lands in the catch. Either way the
  // browser is torn down and relaunched, so this site has exactly one browser.
  async function captureWithRetry() {
    for (;;) {
      let failed = false;
      try {
        await captureOnce();
      } catch (err) {
        failed = true;
        console.error(`[${site.label}] Capture error:`, err.message);
      }
      abortCapture = null;
      clearRecycle();
      await closeBrowser(browser);
      browser = null;

      const delay = failed ? RETRY_DELAY_MS : RELAUNCH_DELAY_MS;
      console.log(`[${site.label}] Restarting browser in ${delay / 1000}s...`);
      await sleep(delay);
      noteCaptureStart(); // the fresh run gets a full stale window before escalation
    }
  }

  // Ends the current capture run; the loop above relaunches the browser.
  function restart() {
    const abort = abortCapture;
    abortCapture = null;
    if (abort) abort();
    else closeBrowser(browser); // still starting up — kill it so page.goto rejects
  }

  function startWatchdog() {
    if (!watchdog.enabled) return;
    watchdogTimer = setInterval(() => {
      const staleMs = Date.now() - lastResultMs;
      if (staleMs < watchdog.staleMs) return;
      staleStrikes++;
      Promise.resolve(onStale({ monitor: api, staleMs, strikes: staleStrikes }))
        .catch(err => console.error(`[${site.label}] Watchdog error:`, err.message));
    }, watchdog.checkMs);
  }

  const api = {
    site,
    store,
    enabled,
    start() {
      if (!enabled) {
        console.log(`[${site.label}] Capture disabled (${site.enabledEnv}=false) — serving archived data only.`);
        return;
      }
      startWatchdog();
      captureWithRetry();
    },
    restart,
    stopWatchdog() {
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = null;
    },
    // Called by the watchdog ladder to hold off escalation for one more window.
    graceWindow: noteCaptureStart,
    isStale: () => Date.now() - lastResultMs >= watchdog.staleMs,
    get staleMs() { return Date.now() - lastResultMs; },
    get strikes() { return staleStrikes; },
    get liveState() { return currentGameState; },
    get streaks() {
      return { gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x };
    },
    health() {
      const staleMs = Date.now() - lastResultMs;
      return {
        ok: !enabled || staleMs < watchdog.staleMs,
        enabled,
        staleSeconds: Math.round(staleMs / 1000),
        lastResultMs,
        staleStrikes
      };
    },
    async close() {
      api.stopWatchdog();
      await closeBrowser(browser);
      store.close();
    }
  };

  return api;
}

module.exports = { createMonitor, floorMult };
