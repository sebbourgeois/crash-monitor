require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const STAKE_CRASH_URL = 'https://stake.com/casino/games/crash';
const OUTPUT_FILE = 'crash_results.jsonl'; // JSON Lines format
const PORT = process.env.PORT || 3000;

// Telegram config from environment
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// WebSocket clients
const wsClients = new Set();

// Streak counters
let gamesSinceLast1x = 0;
let gamesSinceLast1000x = 0;

// Current game state for live updates
let currentGameState = {
  status: 'waiting',
  multiplier: 1.00,
  gameId: null
};

async function sendTelegram(message) {
  if (!TELEGRAM_ENABLED) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

// Read last N results from JSONL file
function readHistory(count = 100) {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return [];

    const content = fs.readFileSync(OUTPUT_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(line => line);
    const results = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Return last N results, newest first
    return results.slice(-count).reverse();
  } catch (err) {
    console.error('Error reading history:', err.message);
    return [];
  }
}

// Broadcast to all connected WebSocket clients
function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Setup Express and WebSocket server
function setupServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  // Serve static files from public/
  app.use(express.static(path.join(__dirname, 'public')));

  // WebSocket connection handling
  wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');
    wsClients.add(ws);

    // Send history to new client
    const history = readHistory(100);
    ws.send(JSON.stringify({ type: 'history', results: history }));

    // Send current game state
    ws.send(JSON.stringify({ type: 'live', state: currentGameState }));

    ws.on('close', () => {
      console.log('Client disconnected from WebSocket');
      wsClients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket client error:', err.message);
      wsClients.delete(ws);
    });
  });

  server.listen(PORT, () => {
    console.log(`Web server running at http://localhost:${PORT}`);
  });

  return server;
}

// Global reference for cleanup
let browser = null;

async function captureCrashData() {
  // Start web server first
  setupServer();

  console.log('Launching browser...');

  browser = await puppeteer.launch({
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

  const status = event.status;
  const gameId = event.id;
  const multiplier = event.multiplier || 1.00;

  // Broadcast live game state for relevant statuses
  // Stake statuses: pending, starting, start, in_progress, crash
  if (status === 'in_progress' || status === 'starting' || status === 'crash' || status === 'start') {
    currentGameState = {
      status: status,
      multiplier: multiplier,
      gameId: gameId
    };
    // Log in_progress updates (can remove later)
    if (status === 'in_progress') {
      process.stdout.write(`\r[LIVE] ${multiplier.toFixed(2)}x    `);
    }
    broadcast({ type: 'live', state: currentGameState });
  }

  // Only log to file when status is "crash" (round ended)
  if (status === 'crash') {
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

    // Update streak counters
    gamesSinceLast1x++;
    gamesSinceLast1000x++;

    // Check for x1.0 (instant crash - multiplier < 1.01)
    if (multiplier < 1.01) {
      sendTelegram(`🔴 <b>INSTANT CRASH!</b>\n${multiplier.toFixed(2)}x after ${gamesSinceLast1x} games`);
      gamesSinceLast1x = 0;
    }

    // Check for x1000 or more
    if (multiplier >= 1000) {
      sendTelegram(`🚀 <b>1000x+ MOON!</b>\n${multiplier.toFixed(2)}x after ${gamesSinceLast1000x} games`);
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

    // Broadcast to WebSocket clients
    broadcast({ type: 'result', result });
  }
}

async function cleanup() {
  console.log('\nShutting down...');
  if (browser) {
    try {
      await browser.close();
      console.log('Browser closed.');
    } catch (err) {
      console.error('Error closing browser:', err.message);
      // Force kill any remaining Chrome processes spawned by this instance
      if (browser.process()) {
        browser.process().kill('SIGKILL');
      }
    }
    browser = null;
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  await cleanup();
});
process.on('unhandledRejection', async (err) => {
  console.error('Unhandled rejection:', err);
  await cleanup();
});

captureCrashData().catch(async (err) => {
  console.error('Fatal error:', err);
  await cleanup();
});
