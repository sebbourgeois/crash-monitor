const WebSocket = require('ws');

// Constants found during research
const APP_KEY = '1b169515002956903f7e'; // Trying a different common Stake key if the other fails, but let's stick to the one found first:
// const APP_KEY = 'af05fb6f133f95e86574'; 
// Actually, I'll try the one I found in the search results first. 
// "1b169515002956903f7e" is also very common for Stake. 
// Let's try the one form the previous search: "af05fb6f133f95e86574""

const KEYS_TO_TRY = [
    'af05fb6f133f95e86574', // Found in search
    '1b169515002956903f7e', // Another common one
];

const CLUSTERS = ['mt1', 'eu', 'ap1'];

async function testConnection(key, cluster) {
    return new Promise((resolve, reject) => {
        const url = `wss://ws-${cluster}.pusher.com/app/${key}?protocol=7&client=js&version=7.0.0&flash=false`;
        console.log(`Testing ${url} ...`);

        const ws = new WebSocket(url);

        ws.on('open', () => {
            console.log(`[${key}|${cluster}] Connected!`);

            const channels = [
                'available_multiplayer_crash_1', // Specific guess
                'market:crash',
                'crash',
                'events'
            ];

            channels.forEach(channel => {
                console.log(`[${key}|${cluster}] Subscribing to ${channel}...`);
                ws.send(JSON.stringify({
                    event: 'pusher:subscribe',
                    data: { channel: channel }
                }));
            });
        });

        ws.on('message', (data) => {
            const msg = data.toString();
            console.log(`[${key}|${cluster}] Received:`, msg.substring(0, 200)); // Log first 200 chars
            if (msg.includes('pusher:subscription_succeeded')) {
                console.log(`[${key}|${cluster}] SUCCESS: Subscription confirmed!`);
            }
        });

        ws.on('error', (err) => {
            console.log(`[${key}|${cluster}] Error:`, err.message);
            ws.close();
            resolve(false);
        });

        setTimeout(() => {
            console.log(`[${key}|${cluster}] Timeout`);
            ws.close();
            resolve(true);
        }, 10000); // 10s wait for events
    });
}

(async () => {
    console.log("Starting Pusher Key Discovery (Round 3)...");
    const key = '1dd368f51522a30b2da3';
    await testConnection(key, 'ap1');
    await testConnection(key, 'eu');
    await testConnection(key, 'mt1');
})();
