const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store game history (last 50 crash points)
let gameHistory = [];
const HISTORY_LIMIT = 50;

// Current game state
let currentState = {
    status: 'unknown',
    multiplier: 1.00,
    startTime: null,
    nextRoundTime: null,
    crashPoint: null
};

// --- Mock Data Logic ---
let mockInterval = null;
let lastRealEventTime = 0;

function startMockData() {
    if (mockInterval) return;
    console.log('--- STARTING MOCK DATA STREAM (Fallback) ---');

    let multiplier = 1.00;
    let isCrashed = false;
    let crashPoint = 2.00;

    mockInterval = setInterval(() => {
        // If we received real data recently, stop mocking behavior (but keep interval alive to check)
        if (Date.now() - lastRealEventTime < 5000 && lastRealEventTime !== 0) {
            return;
        }

        if (currentState.status === 'CRASHED') {
            // Wait for new round
            if (Date.now() % 5000 < 200) { // Simple restart logic
                currentState.status = 'STARTING';
                currentState.multiplier = 1.00;
                console.log('Mock: Game Starting');
                io.emit('game_starting', currentState);
                isCrashed = false;
                multiplier = 1.00;
                crashPoint = (Math.random() * 10 + 1).toFixed(2); // Random crash 1x - 11x

                // Occasionally crash high
                if (Math.random() > 0.9) crashPoint = (Math.random() * 100).toFixed(2);
            }
        } else if (currentState.status === 'STARTING') {
            if (Date.now() % 1000 < 200) {
                currentState.status = 'IN_PROGRESS';
            }
        } else {
            // In Progress
            multiplier *= 1.05; // Exp growth
            if (multiplier >= crashPoint) {
                currentState.status = 'CRASHED';
                currentState.crashPoint = crashPoint;
                currentState.multiplier = crashPoint;
                console.log(`Mock: Crashed @ ${crashPoint}x`);

                gameHistory.unshift({ crashPoint: crashPoint, timestamp: Date.now() });
                if (gameHistory.length > 50) gameHistory.pop();

                io.emit('game_crash', currentState);
                io.emit('history_update', gameHistory);
            } else {
                currentState.multiplier = multiplier;
                // console.log(`Mock Tick: ${multiplier.toFixed(2)}x`);
                io.emit('game_tick', { ...currentState, multiplier: multiplier.toFixed(2) });
            }
        }
    }, 200); // 5 ticks per second
}

// --- SSE Client Logic (via Puppeteer) ---

async function connectToSSE() {
    console.log('Launching Headless Browser (Stealth Mode)...');

    // Fallback timer: if no events in 15 seconds, start mock
    setTimeout(() => {
        if (lastRealEventTime === 0) {
            console.log("No real data received yet. Enabling Mock Data.");
            startMockData();
        }
    }, 15000); // 15s timeout

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080'
            ]
        });
        const page = await browser.newPage();

        // Set User-Agent to standard Chrome
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        await page.exposeFunction('onGameEvent', (data) => {
            console.log("GAME EVENT RECEIVED:", JSON.stringify(data).substring(0, 250));
            lastRealEventTime = Date.now();
            handleGameEvent(data);
        });

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.evaluateOnNewDocument(() => {
            const OriginalEventSource = window.EventSource;
            window.EventSource = function (url, config) {
                console.log('Intercepted EventSource:', url);
                const es = new OriginalEventSource(url, config);
                es.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        window.onGameEvent(data);
                    } catch (e) { }
                };
                return es;
            };
            window.EventSource.prototype = OriginalEventSource.prototype;
        });

        // Sanity check
        console.log('Sanity check: Navigating to google.com...');
        try {
            await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
            console.log('Google loaded successfully.');
        } catch (e) { }

        console.log('Navigating to edgegpt.bot...');
        await page.goto('https://edgegpt.bot/crash?crash=stake', {
            waitUntil: 'domcontentloaded',
            timeout: 15000
        });
        console.log('Page loaded.');

        try { await page.screenshot({ path: 'debug_1_loaded.png' }); } catch (e) { }

        page.on('console', msg => console.log('BROWSER:', msg.text()));

        // --- Interaction Logic ---
        console.log("Attempting interaction...");
        try {
            await page.waitForSelector('button', { timeout: 5000 }).catch(() => console.log("No buttons found yet."));

            // Try to find Crash button
            const crashButton = await page.$x("//button[contains(., 'Crash')]");
            if (crashButton.length > 0) {
                console.log("Found Crash button, clicking...");
                await crashButton[0].click();
                await new Promise(r => setTimeout(r, 1000));
            }

            // Stake button
            const stakeElements = await page.$x("//*[contains(text(), 'Stake')]");
            for (const el of stakeElements) {
                try {
                    if (await el.evaluate(node => node.offsetParent !== null)) {
                        console.log("Found visible 'Stake' element, clicking...");
                        await el.click();
                        await new Promise(r => setTimeout(r, 1000));
                        break;
                    }
                } catch (e) { }
            }
            try { await page.screenshot({ path: 'debug_2_interacted.png' }); } catch (e) { }

        } catch (e) {
            console.log('Interaction error:', e.message);
        }

    } catch (error) {
        console.error("Puppeteer/Browser Error:", error);
    }
}

function handleGameEvent(data) {
    if (!data) return;
    const type = data.type || (data.payload && data.payload.type);

    if (type === 'GAME_TICK' || type === 'tick' || (data.payload && data.payload.multiplier)) {
        const payload = data.payload || data;
        currentState.status = 'IN_PROGRESS';
        currentState.multiplier = payload.multiplier || payload.value;
        io.emit('game_tick', currentState);
    }
    else if (type === 'GAME_STARTING' || type === 'start') {
        currentState.status = 'STARTING';
        currentState.multiplier = 1.00;
        currentState.nextRoundTime = data.timeInMs;
        console.log("Game Starting (Real)");
        io.emit('game_starting', currentState);
    }
    else if (type === 'GAME_CRASH' || type === 'crash') {
        currentState.status = 'CRASHED';
        currentState.crashPoint = data.crashPoint || data.value || (data.payload && data.payload.value);
        currentState.multiplier = currentState.crashPoint;
        console.log(`Crashed at ${currentState.crashPoint}x (Real)`);

        gameHistory.unshift({
            crashPoint: currentState.crashPoint,
            timestamp: Date.now()
        });
        if (gameHistory.length > HISTORY_LIMIT) gameHistory.pop();

        io.emit('game_crash', currentState);
        io.emit('history_update', gameHistory);
    }
    else {
        console.log("Unknown Event:", JSON.stringify(data));
        io.emit('debug_event', data);
    }
}

// --- Socket.IO ---

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.emit('initial_state', {
        gameState: currentState,
        history: gameHistory
    });
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Start Server
const PORT = 3005;
server.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
    connectToSSE();
});

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
