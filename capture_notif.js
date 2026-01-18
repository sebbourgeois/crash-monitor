const puppeteer = require('puppeteer');
const fs = require('fs');
const notifier = require('node-notifier');

const STAKE_CRASH_URL = 'https://stake.com/casino/games/crash';
const OUTPUT_FILE = 'crash_results.jsonl'; // JSON Lines format

// Streak counters
let gamesSinceLast1x = 0;
let gamesSinceLast1000x = 0;

function sendNotification(title, message) {
  notifier.notify({
    title: title,
    message: message,
    sound: true,
    wait: false
  });
}

async function captureCrashData() {
  console.log('Launching browser...');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const client = await page.createCDPSession();
  await client.send('Network.enable');

  // Track seen game IDs to avoid duplicate logs
  const processedGames = new Set();

  client.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
    try {
      const data = JSON.parse(response.payloadData);
      processCrashMessage(data, processedGames);
    } catch (e) {
      // Not JSON - ignore
    }
  });

  console.log(`Navigating to ${STAKE_CRASH_URL}...`);
  await page.goto(STAKE_CRASH_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('Monitoring crash game results...');
  console.log(`Results saved to: ${OUTPUT_FILE}`);
  console.log('Press Ctrl+C to stop.\n');

  await new Promise(() => {});
}

function processCrashMessage(data, processedGames) {
  if (data.type !== 'data' && data.type !== 'next') return;

  const payload = data.payload?.data;
  if (!payload) return;

  // Extract crash event from various possible paths
  const event = payload.crash?.event || payload.event;
  if (!event || event.__typename !== 'MultiplayerCrash') return;

  // Only log when status is "crash" (round ended)
  if (event.status === 'crash') {
    const gameId = event.id;

    // Avoid duplicate logs for same game
    if (processedGames.has(gameId)) return;
    processedGames.add(gameId);

    // Keep set size manageable
    if (processedGames.size > 1000) {
      const iterator = processedGames.values();
      for (let i = 0; i < 500; i++) {
        processedGames.delete(iterator.next().value);
      }
    }

    const multiplier = event.multiplier;

    // Update streak counters
    gamesSinceLast1x++;
    gamesSinceLast1000x++;

    // Check for x1.0 (instant crash - multiplier < 1.01)
    if (multiplier < 1.01) {
      sendNotification('🔴 INSTANT CRASH!', `${multiplier.toFixed(2)}x after ${gamesSinceLast1x} games`);
      gamesSinceLast1x = 0;
    }

    // Check for x1000 or more
    if (multiplier >= 1000) {
      sendNotification('🚀 1000x+ MOON!', `${multiplier.toFixed(2)}x after ${gamesSinceLast1000x} games`);
      gamesSinceLast1000x = 0;
    }

    const result = {
      gameId: gameId,
      multiplier: multiplier,
      timestamp: event.timestamp || new Date().toISOString(),
      gamesSinceLast1x: gamesSinceLast1x,
      gamesSinceLast1000x: gamesSinceLast1000x
    };

    // Log to console (aligned output)
    const multStr = (multiplier.toFixed(2) + 'x').padStart(10);
    const since1x = String(gamesSinceLast1x).padStart(5);
    const since1000x = String(gamesSinceLast1000x).padStart(5);
    console.log(`[CRASH] ${multStr} | Game: ${gameId} | Since 1x: ${since1x} | Since 1000x: ${since1000x}`);

    // Save to file (JSON Lines format - one JSON object per line)
    fs.appendFileSync(OUTPUT_FILE, JSON.stringify(result) + '\n');
  }
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

captureCrashData().catch(console.error);
