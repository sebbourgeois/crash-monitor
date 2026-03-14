# Stake Crash Monitor

A professional-grade Node.js application that monitors Stake.com crash game results in real-time. It intercepts WebSocket traffic via the Chrome DevTools Protocol (CDP), processes results, persists data, and provides a modernized, glassmorphic live dashboard for deep statistical analysis.

## Features

- **Real-time Monitoring** - Intercepts WebSocket frames directly from Stake.com using a resilient, CDP-based scraper.
- **Modern "Trading" Dashboard** - Glassmorphic UI with real-time multiplier display, interactive statistics, and distribution histograms.
- **Multi-Channel Notifications** - Integrated alerts for extreme events (instant crashes, 1000x+ moons) via:
  - **Telegram Bot API**
  - **Desktop Notifications** (with `node-notifier`)
  - **Live Web Dashboard** (with audio cues)
- **High-Performance Persistence** - Logs all crash results to JSONL format with optimized historical reading for massive logs.
- **Resilient Architecture** - Automatic browser recovery and session restart on disconnections or page crashes.
- **Detailed Statistics** - Real-time tracking of averages, medians, min/max, and streak counters.

## Prerequisites

- Node.js 18+
- Chrome/Chromium (managed by Puppeteer)

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/stake-crash-archives.git
cd stake-crash-archives

# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env with your specific configuration
```

## Configuration

Create a `.env` file in the project root to toggle features:

```bash
# Web server port (default: 3000)
PORT=3000
DASHBOARD_ENABLED=true

# Telegram notifications (optional)
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Desktop notifications (optional)
DESKTOP_NOTIFICATIONS_ENABLED=false
```

## Usage

```bash
# Start the unified monitor
npm start
```

The system will:
1. Launch a headless Chrome instance with anti-detection flags.
2. Attach a CDP session to intercept WebSocket traffic.
3. Serve the web dashboard at `http://localhost:3000`.
4. Persist and broadcast results to all configured channels.

## Web Dashboard

The modernized dashboard includes:

- **Live Multiplier View** - High-fidelity display with real-time status (PREPARING, STARTING, CRASHING).
- **Statistical Panel** - Comprehensive breakdown of average, median, min, max, and total games.
- **Streak Tracking** - Games since last instant crash (<1.01x), moon (1000x+), and double-instant crash.
- **Distribution Chart** - Real-time histogram of crash ranges.
- **Result Grid** - Animated, color-coded pills with hover tooltips for game metadata.
- **Audio Alerts** - Toggleable sound cues for high-tier multipliers and crashes.

### Multiplier Tiers

| Color  | Range        | Description     |
|--------|--------------|-----------------|
| Red    | < 1.01x      | Instant crash   |
| Orange | 1.01x - 1.99x| Low multiplier  |
| Green  | 2x - 99x     | Normal range    |
| Purple | 100x - 999x  | High multiplier |
| Turquoise| 1000x+     | Moon shot       |

## Data Format

Results are stored in `crash_results.jsonl` (JSON Lines format):

```json
{"gameId":"abc123","multiplier":2.34,"timestamp":"2025-01-18T12:00:00.000Z","gamesSinceLast1x":5,"gamesSinceLast1000x":42,"gamesSinceDouble1x":120}
```

## Project Structure

```
stake-crash-archives/
├── capture.js           # Unified monitor (Scraper + Server + Notifications)
├── public/              # Modernized Web Frontend
│   ├── index.html       # Structure & Dashboard
│   ├── app.js           # Real-time state management & Logic
│   └── style.css        # Glassmorphic "Trading" styles
├── crash_results.jsonl  # Persistent data store (generated)
├── GEMINI.md            # Instructional context for AI agents
├── package.json         # Dependencies & Scripts
└── .env                 # Environment configuration
```

## Troubleshooting

### Browser fails to launch on Linux

Ensure necessary dependencies are installed:
```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
```

### High Performance Handling

The `capture.js` backend uses an optimized partial-file-read strategy (`readHistory`) to ensure that even as `crash_results.jsonl` grows into the megabytes/gigabytes, client connections remain near-instantaneous.

## License

MIT
