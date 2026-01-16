const WebSocket = require('ws');

const KEYS = [
    'af05fb6f133f95e86574',
    '1dd368f51522a30b2da3',
    '1b169515002956903f7e',
    'b36208be3390cba7041a',
    'c830595cbd07b2561ac7', // Found in stake source
    '6a365c2f01869dec9a8f'  // Found in stake source
];

const CLUSTERS = ['mt1', 'us2', 'us3', 'eu', 'ap1', 'ap2', 'ap3', 'sa1'];

async function test(key, cluster) {
    return new Promise(resolve => {
        const url = `wss://ws-${cluster}.pusher.com/app/${key}?protocol=7&client=js&version=7.0.0&flash=false`;
        const ws = new WebSocket(url);
        let resolved = false;

        ws.on('open', () => {
            // If it opens and stays open without immediate error, it's a candidate
            // But we might get an error frame.
        });

        ws.on('message', (data) => {
            const msg = data.toString();
            if (msg.includes('pusher:error')) {
                // Determine if it's cluster error or other
                if (!resolved) {
                    resolved = true;
                    ws.close();
                    if (msg.includes('cluster')) {
                        resolve({ success: false, reason: 'wrong_cluster' });
                    } else {
                        resolve({ success: false, reason: 'other_error: ' + msg });
                    }
                }
            } else if (msg.includes('pusher:connection_established')) {
                if (!resolved) {
                    resolved = true;
                    ws.close();
                    resolve({ success: true });
                }
            }
        });

        ws.on('error', (err) => {
            if (!resolved) {
                resolved = true;
                // Connection failed (e.g. DNS)
                // console.log(`[${key}|${cluster}] Conn Error`); 
                resolve({ success: false, reason: 'conn_error' });
            }
        });

        ws.on('close', (code, reason) => {
            if (!resolved) {
                resolved = true;
                resolve({ success: false, reason: 'closed ' + code });
            }
        });

        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                ws.terminate();
                resolve({ success: false, reason: 'timeout' });
            }
        }, 3000);
    });
}

(async () => {
    console.log(`Testing ${KEYS.length} keys on ${CLUSTERS.length} clusters...`);

    for (const key of KEYS) {
        // Parallel cluster test for this key
        const promises = CLUSTERS.map(async cluster => {
            const res = await test(key, cluster);
            if (res.success) {
                console.log(`>>> MATCH FOUND: Key=${key} Cluster=${cluster}`);
            } else {
                // Optional verbose logging
                // console.log(`Failed: ${key} on ${cluster} (${res.reason})`);
            }
        });
        await Promise.all(promises);
    }
    console.log("Done.");
})();
