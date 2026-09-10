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

// Temperature indicator: how the most recent TEMPERATURE_WINDOW rounds compare
// with this site's own all-time distribution. The statistic is the share of
// rounds that ended below 2x — it sits near 50%, so a window of a few hundred
// rounds already has real power, and it is what "crashing early all the time"
// actually means. It is expressed as a z-score against the all-time share
// (positive = more early crashes than usual = cold). Instant crashes are
// reported alongside, but they are too rare (~2% on Stake, ~5% on Roobet) to
// drive the label on their own: 300 rounds hold about six of them, so a
// perfectly ordinary spread of 3 to 9 would flip the label constantly.
//
// The threshold is two standard deviations: under a genuinely unchanged game
// that is exceeded about 5% of the time, so a COLD or HOT label is rare enough
// to mean something, yet a sliding window still shows it a few times a day.
const TEMPERATURE_WINDOW = Math.max(50, Number(process.env.TEMPERATURE_WINDOW) || 300);
const TEMPERATURE_Z = 2;

// Cold-streak watch: runs of consecutive rounds that all ended under
// STREAK_UNDER_X, and how often a run reaches STREAK_MIN_LEN. The defaults
// come from the question that motivated it — "how often are there 16+ rounds
// in a row under 2.2x?" — and the answer on Stake is about once a fortnight.
// Every round is an independent draw, so the odds shown are the same on any
// day regardless of when the last run happened; the widget exists to say so.
const STREAK_UNDER_X = Number(process.env.STREAK_UNDER_X) > 1 ? Number(process.env.STREAK_UNDER_X) : 2.2;
const STREAK_MIN_LEN = Math.max(2, Math.floor(Number(process.env.STREAK_MIN_LEN)) || 16);
// Consecutive rows further apart than this are a capture gap, not play time,
// so they are left out of the rounds-per-day estimate the odds are scaled by.
const STREAK_GAP_MS = 10 * 60 * 1000;

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

  // All-time counts for the temperature baseline. Read once with a full scan
  // (~0.1s on 600k rows), then kept exact in memory by insert(), so the hot
  // path never rescans the table.
  const baseline = db.prepare('SELECT COUNT(*) AS total, SUM(multiplier < 2) AS lt2, SUM(multiplier < 1.01) AS instant FROM crash_results').get();
  baseline.lt2 = baseline.lt2 || 0;
  baseline.instant = baseline.instant || 0;

  // Run-length state for buildStreakOdds(). Seeded by one chronological scan
  // (~0.4s on 600k rows) and then advanced by insert() one round at a time —
  // exactly the same state machine either way, so the two can never disagree.
  const streak = {
    lt: 0,            // rounds under STREAK_UNDER_X (for the per-round probability)
    current: 0,       // length of the run the archive currently ends on
    longest: 0,
    count: 0,         // runs that reached STREAK_MIN_LEN (counted the moment they do)
    last: null,       // { len, startMs, endMs } of the latest such run, extended while it lasts
    runStartMs: null,
    prevMs: null,
    coveredMs: 0      // play time with capture gaps removed
  };

  function feedStreak(multiplier, ts_ms) {
    if (ts_ms != null) {
      if (streak.prevMs != null) {
        const d = ts_ms - streak.prevMs;
        if (d > 0 && d < STREAK_GAP_MS) streak.coveredMs += d;
      }
      streak.prevMs = ts_ms;
    }
    if (multiplier < STREAK_UNDER_X) {
      streak.lt++;
      if (streak.current === 0) streak.runStartMs = ts_ms;
      streak.current++;
      if (streak.current > streak.longest) streak.longest = streak.current;
      if (streak.current === STREAK_MIN_LEN) {
        streak.count++;
        streak.last = { len: streak.current, startMs: streak.runStartMs, endMs: ts_ms };
      } else if (streak.current > STREAK_MIN_LEN) {
        streak.last.len = streak.current;
        streak.last.endMs = ts_ms;
      }
    } else {
      streak.current = 0;
    }
  }

  for (const r of db.prepare('SELECT multiplier, ts_ms FROM crash_results ORDER BY rowid ASC').iterate()) {
    feedStreak(r.multiplier, r.ts_ms);
  }

  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO crash_results
      (gameId, multiplier, timestamp, ts_ms, gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x)
    VALUES (@gameId, @multiplier, @timestamp, @ts_ms, @gamesSinceLast1x, @gamesSinceLast1000x, @gamesSinceDouble1x)
  `);

  function insert(result) {
    const info = insertResult.run(result);
    if (info.changes === 1) {
      baseline.total++;
      if (result.multiplier < 2) baseline.lt2++;
      if (result.multiplier < 1.01) baseline.instant++;
      feedStreak(result.multiplier, result.ts_ms);
    }
    return info;
  }

  const selectWindow = db.prepare('SELECT multiplier FROM crash_results ORDER BY rowid DESC LIMIT ?');

  // See TEMPERATURE_WINDOW above. Returns null until the site has enough
  // history for the baseline to mean anything: the window itself plus at least
  // as many rounds again outside it.
  function buildTemperature() {
    const rows = selectWindow.all(TEMPERATURE_WINDOW);
    const n = rows.length;
    const outside = baseline.total - n;
    if (n < TEMPERATURE_WINDOW || outside < TEMPERATURE_WINDOW) return null;

    let lt2 = 0, instant = 0;
    for (const r of rows) {
      if (r.multiplier < 2) lt2++;
      if (r.multiplier < 1.01) instant++;
    }

    // Baseline excludes the window so a small archive does not compare the
    // window with itself.
    const p0 = (baseline.lt2 - lt2) / outside;
    const q0 = (baseline.instant - instant) / outside;
    if (p0 <= 0 || p0 >= 1) return null; // degenerate archive: no spread to score against
    const z = (lt2 / n - p0) / Math.sqrt(p0 * (1 - p0) / n);
    const label = z >= TEMPERATURE_Z ? 'cold' : z <= -TEMPERATURE_Z ? 'hot' : 'regular';

    return {
      window: TEMPERATURE_WINDOW,
      label,
      z,
      threshold: TEMPERATURE_Z,
      pctLt2: 100 * lt2 / n,
      instants: instant,
      expectedInstants: q0 * n,
      baseline: { total: baseline.total, pctLt2: 100 * p0, pctInstant: 100 * q0 }
    };
  }

  // See STREAK_UNDER_X above. Under independent rounds, a run of at least
  // STREAK_MIN_LEN begins at a given round with probability (1-p)·p^minLen,
  // where p is this site's all-time share of rounds under the threshold; the
  // per-window odds treat those starts as a Poisson process at the observed
  // rounds-per-day. Returns null until the archive is big enough for p to be
  // worth anything.
  function buildStreakOdds() {
    const total = baseline.total;
    if (total < 1000) return null;
    const p = streak.lt / total;
    if (p <= 0 || p >= 1) return null;

    const perRound = (1 - p) * Math.pow(p, STREAK_MIN_LEN);
    const coveredDays = streak.coveredMs / (24 * 60 * 60 * 1000);
    const roundsPerDay = coveredDays > 0 ? total / coveredDays : null;
    const perDay = roundsPerDay === null ? null : perRound * roundsPerDay;
    const atLeastOne = (days) => perDay === null ? null : 1 - Math.exp(-perDay * days);

    return {
      threshold: STREAK_UNDER_X,
      minLen: STREAK_MIN_LEN,
      current: streak.current,
      longest: streak.longest,
      count: streak.count,
      last: streak.last,
      total,
      pUnder: p,
      perRound,
      // Chance the run the archive currently ends on goes on to reach minLen.
      reach: streak.current >= STREAK_MIN_LEN ? 1 : Math.pow(p, STREAK_MIN_LEN - streak.current),
      roundsPerDay,
      coveredDays,
      observedPerDay: coveredDays > 0 ? streak.count / coveredDays : null,
      odds: { hour: atLeastOne(1 / 24), day: atLeastOne(1), week: atLeastOne(7) }
    };
  }

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
    insert,
    readHistory,
    seedStreaks,
    buildAnalytics,
    buildTemperature,
    buildStreakOdds,
    close: () => { try { db.close(); } catch {} }
  };
}

module.exports = { createStore, PERIOD_MS, TEMPERATURE_WINDOW, TEMPERATURE_Z, STREAK_UNDER_X, STREAK_MIN_LEN };
