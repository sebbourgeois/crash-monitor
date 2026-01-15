import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function initDb() {
    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        console.log('Running schema migration...');
        await pool.query(schemaSql);
        console.log('Schema migration completed successfully.');
    } catch (error) {
        console.error('Error initializing database:', error);
    } finally {
        await pool.end();
    }
}

initDb();
