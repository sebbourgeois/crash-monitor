require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const notifier = require('node-notifier');

const STAKE_CRASH_URL = 'https://stake.com/casino/games/crash';
const OUTPUT_FILE = 'crash_results.jsonl';
const PORT = process.env.PORT || 3000;

// Feature Toggles
const DASHBOARD_ENABLED = process.env.DASHBOARD_ENABLED !== 'false';
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';
const DESKTOP_NOTIFICATIONS_ENABLED = process.env.DESKTOP_NOTIFICATIONS_ENABLED === 'true';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const wsClients = new Set();
let gamesSinceLast1x = 0;
let gamesSinceLast1000x = 0;
let gamesSinceDouble1x = 0;
let lastWas1x = false;
let currentGameState = { status: 'waiting', multiplier: 1.00, gameId: null };

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

// Efficiently read last N results from JSONL file
function readHistory(count = 100) {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return [];

    const stats = fs.statSync(OUTPUT_FILE);
    const bufferSize = Math.min(stats.size, 1024 * 256); // Read last 256KB max
    const buffer = Buffer.alloc(bufferSize);
    
    const fd = fs.openSync(OUTPUT_FILE, 'r');
    fs.readSync(fd, buffer, 0, bufferSize, stats.size - bufferSize);
    fs.closeSync(fd);

    const content = buffer.toString('utf8');
    const lines = content.trim().split('\n').filter(line => line);
    
    // If the first line might be partial (because we cut off at 100KB), discard it
    if (stats.size > bufferSize) lines.shift();

    const results = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    return results.slice(-count).reverse();
  } catch (err) {
    console.error('Error reading history:', err.message);
    return [];
  }
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

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: 'history', results: readHistory(1000) }));
    ws.send(JSON.stringify({ type: 'live', state: currentGameState }));
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  server.listen(PORT, () => console.log(`Web dashboard: http://localhost:${PORT}`));
  return server;
}

let browser = null;
let isRestarting = false;

async function captureWithRetry() {
  try {
    await captureCrashData();
  } catch (err) {
    console.error('Capture error:', err.message);
    if (!isRestarting) {
      isRestarting = true;
      console.log('Attempting to restart browser in 10s...');
      if (browser) await browser.close().catch(() => {});
      setTimeout(() => {
        isRestarting = false;
        captureWithRetry();
      }, 10000);
    }
  }
}

async function captureCrashData() {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const client = await page.createCDPSession();
  await client.send('Network.enable');

  const processedGames = new Set();

  client.on('Network.webSocketFrameReceived', ({ response }) => {
    try {
      const data = JSON.parse(response.payloadData);
      processCrashMessage(data, processedGames);
    } catch (e) {}
  });

  // Handle browser/page crashes
  page.on('error', err => { throw err; });
  browser.on('disconnected', () => { if (!isRestarting) throw new Error('Browser disconnected'); });

  await page.goto(STAKE_CRASH_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('Monitoring crash game results...');
  
  await new Promise(() => {}); // Keep alive
}

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
      process.stdout.write(`\r[LIVE] ${multiplier.toFixed(2)}x    `);
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

  const result = {
    gameId, multiplier,
    timestamp: event.timestamp || new Date().toISOString(),
    gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x
  };

  if (multiplier < 1.01) {
    notify('🔴 INSTANT CRASH!', `${multiplier.toFixed(2)}x after ${gamesSinceLast1x} games`, true);
    gamesSinceLast1x = 0;
  } else if (multiplier >= 1000) {
    notify('🚀 1000x+ MOON!', `${multiplier.toFixed(2)}x after ${gamesSinceLast1000x} games`, true);
    gamesSinceLast1000x = 0;
  }

  const multStr = (multiplier.toFixed(2) + 'x').padStart(10);
  console.log(`\r\x1b[K[CRASH] ${multStr} | Game: ${gameId} | Since 1x: ${result.gamesSinceLast1x} | Since 1000x: ${result.gamesSinceLast1000x}`);

  fs.appendFileSync(OUTPUT_FILE, JSON.stringify(result) + '\n');
  broadcast({ type: 'result', result });
}

async function cleanup() {
  console.log('\nShutting down...');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', cleanup);
process.on('unhandledRejection', cleanup);

setupServer();
captureWithRetry();
