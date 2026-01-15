import EventSource from 'eventsource';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const SSE_URL = 'https://edgegpt-g8u9.onrender.com/events/ethercrash';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("DATABASE_URL is not defined in .env");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
});

interface GameData {
    id: number; // The game_id from source
    hash: string;
    multiplier: number;
    time?: number; // Sometimes provided
}

function startIngestion() {
    console.log(`Connecting to SSE stream: ${SSE_URL}`);

    const es = new EventSource(SSE_URL);

    es.onopen = () => {
        console.log('Connection to SSE stream opened.');
    };

    es.onmessage = (event) => {
        // The event.data might be a JSON string or just a heartbeat
        if (!event.data) return;

        try {
            const data = JSON.parse(event.data);
            console.log('Received event:', data);

            // Adjust parsing logic based on actual payload structure
            // Assuming payload is like: { id: 7759159, multiplier: 1.42, hash: "..." }
            // We will need to verify this structure from the subagent logs if it differs.
            if (data && data.id && data.multiplier && data.hash) {
                saveGame(data);
            }

        } catch (err) {
            console.error('Error parsing event data:', err);
        }
    };

    es.onerror = (err) => {
        console.error('EventSource error:', err);
        // EventSource usually auto-reconnects, but we log strictly.
    };
}

async function saveGame(game: GameData) {
    const client = await pool.connect();
    try {
        const query = `
      INSERT INTO games (game_id, multiplier, hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (game_id) DO UPDATE 
      SET multiplier = EXCLUDED.multiplier, hash = EXCLUDED.hash
      RETURNING *;
    `;
        const values = [game.id, game.multiplier, game.hash];

        const res = await client.query(query, values);
        console.log(`Saved game ${game.id} with multiplier ${game.multiplier}x`);
    } catch (err) {
        console.error('Error saving game to DB:', err);
    } finally {
        client.release();
    }
}

// Start the process
startIngestion();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await pool.end();
    process.exit(0);
});
