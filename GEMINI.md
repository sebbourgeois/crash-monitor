# GEMINI.md

This file provides high-level instructions and project context for Gemini CLI when working in this repository.

## Project Overview

**Stake Crash Monitor** is a Node.js-based real-time monitoring tool for the Stake.com "Crash" game. It uses Puppeteer to intercept WebSocket traffic via the Chrome DevTools Protocol (CDP), processes game results, persists them to a JSONL file, and serves a live web dashboard.

### Core Technologies
- **Backend:** Node.js, Express, `ws` (WebSockets), `puppeteer` (Headless Chrome)
- **Frontend:** Vanilla JS, CSS, Chart.js (Statistics & Histogram)
- **Data:** JSONL (`crash_results.jsonl`) for persistent storage
- **Notifications:** Telegram Bot API for extreme multiplier alerts

## Building and Running

### Prerequisites
- Node.js 18+
- Chrome/Chromium

### Commands
```bash
# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
# Edit .env: 
# DASHBOARD_ENABLED, TELEGRAM_ENABLED, DESKTOP_NOTIFICATIONS_ENABLED

# Start the monitor (all-in-one)
npm start
```

### Features
- **Consolidated Backend:** Single `capture.js` entry point for all notification channels.
- **Efficient History:** `readHistory` uses partial file reads for high performance on large logs.
- **Modern Dashboard:** Glassmorphic UI with real-time stats, distribution charts, and audio alerts.
- **Resilient Scraper:** Automatic browser restart on crashes or disconnections.

## Architecture & Data Flow

1.  **Ingestion:** `capture.js` launches a headless browser, navigates to Stake, and attaches a CDP session to listen for `Network.webSocketFrameReceived`.
2.  **Processing:** `processCrashMessage()` filters frames for `MultiplayerCrash` events.
3.  **Persistence:** Results are appended to `crash_results.jsonl`.
4.  **Broadcast:** The internal WebSocket server (`wsClients`) sends real-time updates and historical data to connected dashboard clients.
5.  **Visualization:** The dashboard (`public/app.js`) calculates statistics (average, median, distribution) and updates the UI and Chart.js histogram.

### Multiplier Tiers & Color Coding
- **Red (< 1.01x):** Instant crash
- **Orange (1.01x - 1.99x):** Low multiplier
- **Green (2.00x - 99.99x):** Standard range
- **Purple (100.00x - 999.99x):** High multiplier
- **Turquoise/Gold (≥ 1000.00x):** Moon shot

## Development Conventions

### Code Structure
- `capture.js`: Main entry point containing the scraper, server, and notification logic.
- `public/`: Contains the frontend assets.
- `crash_results.jsonl`: The primary data store (JSON Lines format).

### Key Logic
- **Duplicate Detection:** Uses a `Set` of `gameId`s (pruned at 1000 entries) to avoid double-processing results.
- **Streak Tracking:** Variables like `gamesSinceLast1x` and `gamesSinceLast1000x` track the frequency of extreme events.
- **Headless Mode:** Puppeteer runs with `--disable-blink-features=AutomationControlled` to minimize detection.

### Best Practices
- **Graceful Shutdown:** `SIGINT` and `SIGTERM` handlers ensure the Puppeteer browser is closed correctly.
- **Frontend Performance:** Limits the number of DOM elements (pills) to 200 and memory history to 500 records.
- **Environment Variables:** All sensitive or configurable values (Telegram tokens, Ports) must reside in `.env`.
