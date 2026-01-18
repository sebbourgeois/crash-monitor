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

**Multiplier color coding**:
- Red (#ff4757): < 2x (instant crashes)
- Orange (#ffa502): 2x - 10x
- Green (#2ed573): 10x - 100x
- Gold (#ffd700): 100x - 1000x
- Pink (#ff6b9d): 1000x+ (moon shots)

**Output format** (JSONL - one JSON object per line):
```json
{"gameId":"...","multiplier":2.34,"timestamp":"...","gamesSinceLast1x":5,"gamesSinceLast1000x":42}
```

## Key Implementation Details

- Duplicate detection via Set of processed game IDs (auto-pruned at 1000 entries)
- Streak counters track games since last instant crash (< 1.01x) and last moon (>= 1000x)
- Runs headless with anti-detection flags (`--disable-blink-features=AutomationControlled`)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Web server port (default: 3000) |
| `TELEGRAM_ENABLED` | Enable Telegram notifications (true/false) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for notifications |
