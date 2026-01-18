# Stake Crash Monitor

A Node.js application that monitors Stake.com crash game results in real-time. Captures WebSocket data via Puppeteer and Chrome DevTools Protocol, logs results to a JSONL file, and serves a live web dashboard for visualization and statistics.

## Features

- **Real-time monitoring** - Intercepts WebSocket frames from Stake.com crash game
- **Live web dashboard** - Dark-themed UI with live multiplier display, statistics, and result history
- **Data persistence** - Logs all crash results to JSONL format for analysis
- **Telegram notifications** - Get alerts for extreme events (instant crashes, 1000x+ moons)
- **Statistics tracking** - Average, median, min/max, and distribution histogram
- **Streak counters** - Track games since last instant crash (<1.01x) and moon (1000x+)

## Prerequisites

- Node.js 18+
- Chrome/Chromium (installed automatically by Puppeteer)

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/stake-crash-archives.git
cd stake-crash-archives

# Install dependencies
npm install

# Create environment file (optional, for Telegram notifications)
cp .env.example .env
# Edit .env with your Telegram credentials
```

## Configuration

Create a `.env` file in the project root:

```bash
# Web server port (default: 3000)
PORT=3000

# Telegram notifications (optional)
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

### Setting up Telegram Notifications

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token to `TELEGRAM_BOT_TOKEN`
3. Start a chat with your bot
4. Get your chat ID from [@userinfobot](https://t.me/userinfobot) or similar
5. Set `TELEGRAM_ENABLED=true`

## Usage

```bash
# Start the monitor
npm start
# or
node capture.js

# Open the dashboard
# Navigate to http://localhost:3000
```

The monitor will:
1. Launch a headless Chrome browser
2. Navigate to Stake.com crash game
3. Intercept WebSocket messages for game results
4. Log results to `crash_results.jsonl`
5. Broadcast updates to connected dashboard clients

Press `Ctrl+C` to stop.

## Web Dashboard

The dashboard displays:

- **Live multiplier** - Current game status and multiplier with color-coded states
- **Statistics** - Average, median, min, max, and total games tracked
- **Streak counters** - Games since last instant crash and moon shot
- **Distribution chart** - Histogram of result ranges
- **Result history** - Color-coded pills showing recent results

### Multiplier Color Coding

| Color  | Range        | Description     |
|--------|--------------|-----------------|
| Red    | < 1.01x      | Instant crash   |
| Orange | 1.01x - 1.99x| Low multiplier  |
| Green  | 2x - 99x     | Normal range    |
| Purple | 100x - 999x  | High multiplier |
| Gold   | 1000x+       | Moon shot       |

## Data Format

Results are stored in `crash_results.jsonl` (JSON Lines format):

```json
{"gameId":"abc123","multiplier":2.34,"timestamp":"2025-01-18T12:00:00.000Z","gamesSinceLast1x":5,"gamesSinceLast1000x":42}
{"gameId":"def456","multiplier":1.00,"timestamp":"2025-01-18T12:01:00.000Z","gamesSinceLast1x":0,"gamesSinceLast1000x":43}
```

Each line contains:
- `gameId` - Unique game identifier
- `multiplier` - Final crash multiplier
- `timestamp` - When the game ended
- `gamesSinceLast1x` - Games since last instant crash
- `gamesSinceLast1000x` - Games since last 1000x+ moon

## Project Structure

```
stake-crash-archives/
├── capture.js           # Main script with dashboard and notifications
├── capture_v1.js        # Basic version (no notifications/server)
├── capture_v2.js        # Alternative version
├── capture_notif.js     # Desktop notifications version
├── public/
│   ├── index.html       # Dashboard HTML
│   ├── app.js           # Dashboard JavaScript
│   └── style.css        # Dashboard styles
├── crash_results.jsonl  # Output file (generated)
├── package.json
└── .env                 # Configuration (create from .env.example)
```

## Script Variants

| Script            | Features                                        |
|-------------------|-------------------------------------------------|
| `capture.js`      | Full: web dashboard, Telegram, file logging     |
| `capture_v1.js`   | Basic: file logging only                        |
| `capture_notif.js`| Desktop notifications (requires `node-notifier`)|

## Troubleshooting

### Browser fails to launch

On Linux servers, you may need additional dependencies:

```bash
# Debian/Ubuntu
sudo apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2

# Or install Chromium directly
sudo apt-get install chromium-browser
```

### Connection issues

- Ensure you have a stable internet connection
- The script uses anti-detection flags but Stake.com may still block automated access
- Try running with `headless: false` in `capture.js` to debug

### High memory usage

The script maintains a Set of processed game IDs (max 1000) and the dashboard keeps 500 results in memory. This should be minimal but can be adjusted in the code if needed.

## License

MIT
