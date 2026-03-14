# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js application that monitors Stake.com crash game results using Puppeteer. Captures WebSocket data via Chrome DevTools Protocol, logs crash multipliers to a JSONL file, and serves a real-time web dashboard for visualization.

## Commands

```bash
npm install   # Install dependencies
cp .env.example .env  # Create config file, then edit with your values
npm start     # Run the monitor (or: node capture.js)
# Open http://localhost:3000 for the web dashboard
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
TELEGRAM_ENABLED=true           # Enable/disable Telegram notifications
TELEGRAM_BOT_TOKEN=your_token   # Bot token from @BotFather
TELEGRAM_CHAT_ID=your_chat_id   # Your Telegram chat ID
```

## Architecture

**Core mechanism**: Uses Puppeteer to open the crash game page, then intercepts WebSocket frames via CDP (`Network.webSocketFrameReceived`) to extract game results without directly interacting with the page.

**Script variants**:
- `capture.js` - Main script with web dashboard, Telegram notifications for extreme results (instant crashes < 1.01x, moon shots >= 1000x)
- `capture_v1.js` - Basic version without notifications or web server
- `capture_v2.js` - Alternative version with Telegram support but no web server
- `capture_notif.js` - Desktop notifications version (requires `npm install node-notifier`)

**Data flow**:
1. Express server starts on port 3000, serves static frontend from `public/`
2. WebSocket server broadcasts crash results to connected clients
3. Puppeteer opens stake.com/casino/games/crash
4. CDP session listens for WebSocket frames
5. `processCrashMessage()` filters for `MultiplayerCrash` events with status "crash"
6. Results appended to `crash_results.jsonl` and broadcast to frontend clients

**Web frontend** (`public/`):
- `index.html` - Main page structure with stats, chart, and results grid
- `style.css` - Dark theme (#1a1a2e background) with neon color-coded multiplier pills
- `app.js` - WebSocket client, Chart.js distribution histogram, real-time updates

**Multiplier color coding** (defined in `public/app.js:getColorClass()`):
- Red (#ff4757): < 1.01x (instant crash)
- Orange (#ffa502): 1.01x - 1.99x
- Green (#2ed573): 2x - 99.99x
- Purple (#a855f7): 100x - 999.99x
- Gold (#ffd700): 1000x+ (moon shots)

**Output format** (JSONL - one JSON object per line):
```json
{"gameId":"...","multiplier":2.34,"timestamp":"...","gamesSinceLast1x":5,"gamesSinceLast1000x":42}
```

**WebSocket message types** (server → dashboard client):
- `{ type: 'history', results: [...] }` - Initial batch of last 100 results sent on connect
- `{ type: 'result', result: {...} }` - New crash result
- `{ type: 'live', state: { status, multiplier, gameId } }` - Live game state updates

**CDP event parsing chain** (in `processCrashMessage()`):
1. Filter `data.type` for `'data'` or `'next'`
2. Extract `payload.data.crash?.event || payload.data.event`
3. Require `event.__typename === 'MultiplayerCrash'`
4. Broadcast live state for statuses: `in_progress`, `starting`, `crash`, `start`
5. Only persist and log results when `status === 'crash'`

## Key Implementation Details

- Duplicate detection via Set of processed game IDs (auto-pruned at 1000 entries)
- Streak counters track games since last instant crash (< 1.01x) and last moon (>= 1000x)
- Runs headless with anti-detection flags (`--disable-blink-features=AutomationControlled`)
- Dashboard keeps max 500 results in memory and 200 DOM pill elements for performance
- Graceful shutdown on SIGINT/SIGTERM with browser cleanup

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Web server port (default: 3000) |
| `TELEGRAM_ENABLED` | Enable Telegram notifications (true/false) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for notifications |
