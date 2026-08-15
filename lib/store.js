// Per-site SQLite store. One store == one .db file, so Stake and Shuffle
// results never share a table. The schema, the on-startup migration and every
// query below are identical across sites; only the file path differs.
const Database = require('better-sqlite3');

const PERIOD_MS = {
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '3m': 90 * 24 * 60 * 60 * 1000,
  '6m': 180 * 24 * 60 * 60 * 1000,
  'all': null
};

function createStore(dbFile, label = dbFile) {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS crash_results (
      gameId TEXT PRIMARY KEY,
      multiplier REAL NOT NULL,
      timestamp TEXT NOT NULL,
      gamesSinceLast1x INTEGER,
      gamesSinceLast1000x INTEGER,
      gamesSinceDouble1x INTEGER
    );
  `);

  // Idempotent ADD-COLUMN-then-backfill. Any future schema change follows the
  // same shape rather than a separate migration file.
  (function migrateTsMs() {
    const cols = db.prepare('PRAGMA table_info(crash_results)').all();
    if (!cols.some(c => c.name === 'ts_ms')) {
      console.log(`[${label}] Migrating: adding ts_ms column...`);
      db.exec('ALTER TABLE crash_results ADD COLUMN ts_ms INTEGER');
    }
    const pending = db.prepare('SELECT rowid, timestamp FROM crash_results WHERE ts_ms IS NULL').all();
    if (pending.length > 0) {
      const update = db.prepare('UPDATE crash_results SET ts_ms = ? WHERE rowid = ?');
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          const ms = Date.parse(r.timestamp);
          if (!isNaN(ms)) update.run(ms, r.rowid);
        }
      });
      tx(pending);
      console.log(`[${label}] Backfilled ts_ms for ${pending.length} rows.`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_ts_ms ON crash_results(ts_ms)');
  })();

  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO crash_results
      (gameId, multiplier, timestamp, ts_ms, gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x)
    VALUES (@gameId, @multiplier, @timestamp, @ts_ms, @gamesSinceLast1x, @gamesSinceLast1000x, @gamesSinceDouble1x)
  `);

  const selectHistory = db.prepare(`
    SELECT gameId, multiplier, timestamp, gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x
    FROM crash_results
    ORDER BY rowid DESC
    LIMIT ?
  `);

  function readHistory(count = 100) {
    try {
      return selectHistory.all(count);
    } catch (err) {
      console.error(`[${label}] Error reading history:`, err.message);
      return [];
    }
  }

  // Recomputes the streak counters from the DB so they survive a restart.
  function seedStreaks() {
    const total = db.prepare('SELECT COUNT(*) AS n FROM crash_results').get().n;
    if (total === 0) {
      return { gamesSinceLast1x: 0, gamesSinceLast1000x: 0, gamesSinceDouble1x: 0, lastWas1x: false, total: 0 };
    }

    const rowsAfter = (rowid) =>
      rowid == null ? total : db.prepare('SELECT COUNT(*) AS n FROM crash_results WHERE rowid > ?').get(rowid).n;

    const last1x = db.prepare('SELECT MAX(rowid) AS r FROM crash_results WHERE multiplier < 1.01').get().r;
    const last1000x = db.prepare('SELECT MAX(rowid) AS r FROM crash_results WHERE multiplier >= 1000').get().r;
    const lastDouble = db.prepare(`
      SELECT MAX(c1.rowid) AS r
      FROM crash_results c1
      JOIN crash_results c0 ON c0.rowid = c1.rowid - 1
      WHERE c1.multiplier < 1.01 AND c0.multiplier < 1.01
    `).get().r;

    const latest = db.prepare('SELECT multiplier FROM crash_results ORDER BY rowid DESC LIMIT 1').get();

    return {
      gamesSinceLast1x: rowsAfter(last1x),
      gamesSinceLast1000x: rowsAfter(last1000x),
      gamesSinceDouble1x: rowsAfter(lastDouble),
      lastWas1x: latest ? latest.multiplier < 1.01 : false,
      total
    };
  }

  function buildAnalytics(period = 'all') {
    const offset = PERIOD_MS[period] !== undefined ? PERIOD_MS[period] : null;
    const fromMs = offset === null ? null : Date.now() - offset;

    const rows = fromMs === null
      ? db.prepare('SELECT multiplier, ts_ms FROM crash_results ORDER BY rowid ASC').all()
      : db.prepare('SELECT multiplier, ts_ms FROM crash_results WHERE ts_ms >= ? ORDER BY rowid ASC').all(fromMs);

    if (rows.length === 0) return { total: 0, period };

    const total = rows.length;
    const spanMs = (rows[rows.length - 1].ts_ms ?? 0) - (rows[0].ts_ms ?? 0);
    const bucketByHour = (offset !== null && offset <= 24 * 60 * 60 * 1000) || spanMs <= 24 * 60 * 60 * 1000;
    const bucketUnit = bucketByHour ? 'hour' : 'day';

    const bucketKey = (ts) => {
      if (!ts) return 'unknown';
      const d = new Date(ts);
      return bucketByHour
        ? d.toISOString().slice(0, 13) + ':00'
        : d.toISOString().slice(0, 10);
    };

    let sum = 0, max = -Infinity, min = Infinity;
    let count1000x = 0, countLt = 0, countDouble = 0;
    const gaps1000x = [], gapsLt = [];
    let gapSince1000x = 0, gapSinceLt = 0;
    let lastWasLt = false;
    const perBucket = new Map();
    const dist = { red: 0, orange: 0, green: 0, purple: 0, turquoise: 0 };
    const multipliers = new Array(total);

    for (let i = 0; i < total; i++) {
      const m = rows[i].multiplier;
      const key = bucketKey(rows[i].ts_ms);

      sum += m;
      if (m > max) max = m;
      if (m < min) min = m;
      multipliers[i] = m;

      if (m < 1.01) dist.red++;
      else if (m < 2) dist.orange++;
      else if (m < 100) dist.green++;
      else if (m < 1000) dist.purple++;
      else dist.turquoise++;

      gapSince1000x++;
      gapSinceLt++;
      if (m >= 1000) {
        count1000x++;
        gaps1000x.push(gapSince1000x);
        gapSince1000x = 0;
      }
      if (m < 1.01) {
        countLt++;
        gapsLt.push(gapSinceLt);
        gapSinceLt = 0;
        if (lastWasLt) countDouble++;
        lastWasLt = true;
      } else {
        lastWasLt = false;
      }

      let bucket = perBucket.get(key);
      if (!bucket) {
        bucket = { key, total: 0, count1000x: 0, countLt: 0, sumMultiplier: 0 };
        perBucket.set(key, bucket);
      }
      bucket.total++;
      bucket.sumMultiplier += m;
      if (m >= 1000) bucket.count1000x++;
      if (m < 1.01) bucket.countLt++;
    }

    const sorted = multipliers.slice().sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const maxOf = (arr) => arr.length ? arr.reduce((a, b) => a > b ? a : b, 0) : 0;

    const topMultipliers = fromMs === null
      ? db.prepare('SELECT gameId, multiplier, timestamp FROM crash_results ORDER BY multiplier DESC LIMIT 10').all()
      : db.prepare('SELECT gameId, multiplier, timestamp FROM crash_results WHERE ts_ms >= ? ORDER BY multiplier DESC LIMIT 10').all(fromMs);

    const buckets = [...perBucket.values()].sort((a, b) => a.key.localeCompare(b.key));
    const effectiveSpanMs = Math.max(spanMs, 1);
    const spanDays = effectiveSpanMs / (24 * 60 * 60 * 1000);
    const spanHours = effectiveSpanMs / (60 * 60 * 1000);

    return {
      period,
      total,
      firstMs: rows[0].ts_ms,
      lastMs: rows[rows.length - 1].ts_ms,
      bucketUnit,
      bucketCount: perBucket.size,
      spanDays,
      spanHours,
      gamesPerDay: total / Math.max(spanDays, 1 / 24),
      gamesPerHour: total / Math.max(spanHours, 1 / 60),
      mean: sum / total,
      median: pct(0.5),
      p90: pct(0.9),
      p99: pct(0.99),
      max,
      min,
      distribution: dist,
      count1000x,
      countLt1_01: countLt,
      countDouble1x: countDouble,
      avgGap1000x: avg(gaps1000x),
      avgGapLt1_01: avg(gapsLt),
      maxGap1000x: maxOf(gaps1000x),
      maxGapLt1_01: maxOf(gapsLt),
      currentGap1000x: gapSince1000x,
      currentGapLt1_01: gapSinceLt,
      topMultipliers,
      buckets: buckets.map(b => ({
        key: b.key,
        total: b.total,
        count1000x: b.count1000x,
        countLt: b.countLt,
        meanMultiplier: b.sumMultiplier / b.total
      }))
    };
  }

  return {
    dbFile,
    insert: (result) => insertResult.run(result),
    readHistory,
    seedStreaks,
    buildAnalytics,
    close: () => { try { db.close(); } catch {} }
  };
}

module.exports = { createStore, PERIOD_MS };
