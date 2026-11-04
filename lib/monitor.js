// One monitor per site: its own browser, its own streak counters, its own
// dedupe set, its own staleness clock. Nothing here is shared between sites,
// so a Shuffle outage cannot disturb the Stake capture (and vice versa).
const puppeteer = require('puppeteer');

const RETRY_DELAY_MS = 10000;
const RELAUNCH_DELAY_MS = 1000;
// Once a recycle is due, wait this long for a natural round boundary (a crash
// frame) before relaunching anyway — a stalled site must not block its recycle.
const RECYCLE_GRACE_MS = 2 * 60 * 1000;
// A scheduled recycle launches its replacement browser first and only closes
// the current one once the replacement has delivered a crash frame. This is
// how long the replacement gets to do so (Stake's first result after a healthy
// launch: median 17s, p90 85s over Oct 2026) before it is given up on and the
// current browser kept; the recycle is then retried after RECYCLE_RETRY_MS.
const RECYCLE_WARMUP_MS = 3 * 60 * 1000;
const RECYCLE_RETRY_MS = 30 * 60 * 1000;
// How many failed websocket handshakes / HTTP >= 400 responses to log per launch.
const MAX_LAUNCH_DIAG_LINES = 3;
// Under systemd stdout is a pipe: a \r line never ends, so journald buffers it
// as "blob data" and hides the real log lines. Only clear the line on a TTY.
const CLEAR_LINE = process.stdout.isTTY ? '\r\x1b[K' : '';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Runs inside the page, before its own scripts. Shuffle's client will not
// reopen its subscription socket while document.hidden, so behind the parking
// tab the first dropped socket ended the stream until the watchdog relaunched
// the browser (7-25 stalls a day from 2026-09-08). The page is told it is
// visible; the tab is still really hidden, so its animation loop stays paused.
function maskHidden() {
  Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
  Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
  for (const target of [document, window]) {
    target.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  }
}

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

  // The replacement browser while a recycle is warming up: a promise of the
  // session to adopt, or of null if it never delivered a crash frame.
  let warmup = null;
  let warmingBrowser = null;
  let pendingSession = null; // warmed-up session the capture loop should adopt next

  function recycleNow(reason) {
    if (!abortCapture) return; // run already ending
    warmRecycle(reason);
  }

  function scheduleRecycle(ms = recycleMs) {
    if (!recycleMs) return;
    clearRecycle();
    recycleTimer = setTimeout(() => {
      recycleDue = true;
      recycleGraceTimer = setTimeout(() => recycleNow('no round boundary within grace'), RECYCLE_GRACE_MS);
    }, ms);
  }

  function clearRecycle() {
    recycleDue = false;
    clearTimeout(recycleTimer);
    clearTimeout(recycleGraceTimer);
    recycleTimer = recycleGraceTimer = null;
  }

  // Warm handoff. A freshly launched browser does not always get the crash
  // stream — measured on Stake over Oct 2026, 78 of 187 recycle launches never
  // produced a result, and once one failed the next relaunches tended to fail
  // too, for 8–70 minutes. The old browser was healthy right up to the recycle,
  // so it is kept alive until the replacement proves itself with a crash frame.
  // Both browsers feed handleFrame meanwhile; processedGames dedupes the overlap.
  async function warmRecycle(reason) {
    if (warmup) return;
    clearRecycle();
    console.log(`${CLEAR_LINE}[${site.label}] Recycling browser (${reason}) — launching the replacement first.`);
    const started = Date.now();
    warmup = (async () => {
      let next = null;
      try {
        next = await launchSession();
        warmingBrowser = next.browser;
        await next.waitForCrash(RECYCLE_WARMUP_MS);
        return next;
      } catch (err) {
        console.error(`[${site.label}] Replacement browser did not deliver (${err.message}); keeping the current browser.`);
        if (next) next.logDiagnostics();
        await closeBrowser(next ? next.browser : null);
        return null;
      } finally {
        warmingBrowser = null;
      }
    })();
    const next = await warmup;
    warmup = null;
    if (!abortCapture) {
      // The current run ended during the warm-up (watchdog restart). The
      // capture loop is waiting on `warmup` and will adopt `next` itself.
      pendingSession = next;
      return;
    }
    if (!next) {
      console.log(`[${site.label}] Recycle postponed; retrying in ${Math.round(RECYCLE_RETRY_MS / 60000)} min.`);
      scheduleRecycle(RECYCLE_RETRY_MS);
      return;
    }
    console.log(`[${site.label}] Replacement browser is live after ${Math.round((Date.now() - started) / 1000)}s; closing the old one.`);
    pendingSession = next;
    restart();
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
    if (!event) return null;

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
    if (status !== 'crash' || processedGames.has(gameId)) return event;
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
    broadcast({ type: 'result', result, temperature: store.buildTemperature(), streakOdds: store.buildStreakOdds() });

    // A crash frame is the round boundary: the cheapest moment to relaunch.
    if (recycleDue) recycleNow(`scheduled every ${Math.round(recycleMs / 60000)} min`);
    return event;
  }

  // Launches a browser, loads the crash page and attaches the frame listener.
  // Returns a session; frames flow into handleFrame as soon as this resolves.
  // `trackAsCurrent` exposes the browser to restart() while it is still
  // starting up, so a watchdog restart during page.goto kills it.
  async function launchSession(trackAsCurrent = false) {
    const b = await puppeteer.launch({
      headless: true,
      // capture.js owns shutdown. Puppeteer's own signal handlers delete the
      // temp profile *before* killing Chrome, which then rewrites files into
      // it — every service restart left /tmp/puppeteer_dev_chrome_profile-*
      // directories behind. Without them, cleanup() closes the browser first
      // and the profile is removed once it has exited.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
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
    if (trackAsCurrent) browser = b;

    // Diagnostics for a launch that delivers nothing: what the page's own
    // requests and websocket handshakes came back with.
    const diag = { httpErrors: [], wsCreated: 0, wsClosed: 0, wsErrors: [], frames: 0 };
    const session = {
      browser: b,
      diag,
      logDiagnostics() {
        console.error(`[${site.label}]   launch diagnostics: ${diag.frames} frames, ${diag.wsCreated} websockets opened / ${diag.wsClosed} closed`
          + (diag.wsErrors.length ? `, handshake errors: ${diag.wsErrors.join(' | ')}` : '')
          + (diag.httpErrors.length ? `, HTTP errors: ${diag.httpErrors.join(' | ')}` : ''));
      }
    };

    try {
      // Chrome always starts with one about:blank tab. Keep a handle on it: it
      // becomes the parking tab below, so no third tab (and renderer) is needed.
      const parkingTab = (await b.pages())[0] || await b.newPage();

      const page = await b.newPage();
      await page.setUserAgent(USER_AGENT);
      if (site.maskHidden) await page.evaluateOnNewDocument(maskHidden);
      page.on('response', (r) => {
        if (r.status() >= 400 && diag.httpErrors.length < MAX_LAUNCH_DIAG_LINES) {
          diag.httpErrors.push(`${r.status()} ${r.url().slice(0, 80)}`);
        }
      });

      // Roobet needs 40-45s to reach networkidle2 on a loaded box; 60s was marginal.
      await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 120000 });

      // Rejects when the page or browser dies; never resolves. Settled before it
      // is awaited is fine — the noop catch below keeps it off unhandledRejection.
      session.died = new Promise((_, reject) => {
        page.on('error', reject);
        b.on('disconnected', () => reject(new Error('Browser disconnected')));
      });
      session.died.catch(() => {});

      let sawCrash;
      const firstCrash = new Promise(res => { sawCrash = res; });
      session.waitForCrash = (ms) => Promise.race([
        firstCrash,
        session.died,
        sleep(ms).then(() => { throw new Error(`no crash frame within ${Math.round(ms / 1000)}s`); })
      ]);

      // Attach the CDP Network listener AFTER navigation. Enabling Network on a
      // freshly-created CDP session while still on about:blank and then navigating
      // makes Chrome stop delivering Network.webSocketFrameReceived to that session,
      // so the crash subscription frames never arrive (dashboard stays stuck at 1.00x).
      // Enabling it once the page is loaded — it holds a persistent GraphQL crash
      // subscription — restores frame delivery.
      const client = await page.createCDPSession();
      client.on('Network.webSocketCreated', () => { diag.wsCreated++; });
      client.on('Network.webSocketClosed', () => { diag.wsClosed++; });
      client.on('Network.webSocketFrameError', ({ errorMessage }) => {
        if (diag.wsErrors.length < MAX_LAUNCH_DIAG_LINES) diag.wsErrors.push(errorMessage);
      });
      client.on('Network.webSocketFrameReceived', ({ response }) => {
        diag.frames++;
        let event = null;
        try {
          event = handleFrame(response);
        } catch (e) {}
        if (event && event.status === 'crash') sawCrash();
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
      await parkingTab.bringToFront();
      return session;
    } catch (err) {
      await closeBrowser(b);
      if (trackAsCurrent && browser === b) browser = null;
      throw err;
    }
  }

  // One capture run: a fresh launch, or a session warmed up by warmRecycle.
  async function captureOnce(session) {
    if (!session) session = await launchSession(true);
    browser = session.browser;

    console.log(`[${site.label}] Monitoring crash game results at ${site.url}`);
    noteCaptureStart();
    scheduleRecycle();

    // Keep the run alive until it is aborted (resolve) or the browser/page dies
    // (reject). Routing browser and page failures through this promise keeps them
    // inside captureWithRetry's catch — thrown from the listener they would land
    // in uncaughtException and take the whole process down instead.
    await Promise.race([
      new Promise((resolve) => { abortCapture = resolve; }),
      session.died
    ]);
  }

  // One serialized supervisor loop per site. captureOnce only returns when
  // restart() aborts it; anything else lands in the catch. Either way the
  // browser is torn down and relaunched, so this site has exactly one browser.
  async function captureWithRetry() {
    for (;;) {
      let failed = false;
      try {
        const adopt = pendingSession;
        pendingSession = null;
        await captureOnce(adopt);
      } catch (err) {
        failed = true;
        console.error(`[${site.label}] Capture error:`, err.message);
      }
      abortCapture = null;
      clearRecycle();
      await closeBrowser(browser);
      browser = null;

      // A recycle may still be warming its replacement up (the run ended on a
      // watchdog restart meanwhile). Wait for its verdict rather than launching
      // a third browser; warmRecycle parks the result in pendingSession.
      if (warmup) await warmup;
      if (pendingSession) {
        console.log(`[${site.label}] Switching to the replacement browser.`);
        continue;
      }

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
        console.log(`[${site.label}] Capture disabled (not in SITES, or ${site.enabledEnv}=false) — serving archived data only.`);
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
      clearRecycle();
      await Promise.all([closeBrowser(browser), closeBrowser(warmingBrowser)]);
      store.close();
    }
  };

  return api;
}

module.exports = { createMonitor, floorMult };
