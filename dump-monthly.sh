#!/usr/bin/env bash
#
# dump-monthly.sh — export crash_results.db into per-month archives.
#
# For every calendar month (UTC) present in the DB it writes:
#   db-archives/crash_YYYY-MM.csv           full rows for that month
#   db-archives/crash_YYYY-MM.summary.json  stats for that month
# plus two roll-ups:
#   db-archives/index.csv                   one line per month
#   db-archives/summary.json                every month summary in one file
#
# Re-running overwrites: previously generated files are wiped first, so stale
# months never linger. With -m only the selected months are touched; the
# roll-ups are always rebuilt from every summary in the output dir.
#
# Usage:
#   ./dump-monthly.sh [-d DB] [-o OUTDIR] [-m YYYY-MM] [-z] [-h]
#
#   -d DB       path to the SQLite file      (default: ./crash_results.db)
#   -o OUTDIR   output directory             (default: ./db-archives)
#   -m YYYY-MM  only this month (repeatable) (default: every month in the DB)
#   -z          gzip the CSVs (-9) after writing
#   -h          this help
#
# Read-only: the DB is opened readonly, so it is safe to run while capture.js
# is live.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

DB="$SCRIPT_DIR/crash_results.db"
OUTDIR="$SCRIPT_DIR/db-archives"
GZIP=0
MONTHS=()

usage() { sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while getopts ":d:o:m:zh" opt; do
  case "$opt" in
    d) DB="$OPTARG" ;;
    o) OUTDIR="$OPTARG" ;;
    m) MONTHS+=("$OPTARG") ;;
    z) GZIP=1 ;;
    h) usage; exit 0 ;;
    :) echo "dump-monthly: -$OPTARG needs an argument" >&2; exit 2 ;;
    \?) echo "dump-monthly: unknown option -$OPTARG" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -f "$DB" ]] || { echo "dump-monthly: no such database: $DB" >&2; exit 1; }

for m in "${MONTHS[@]:-}"; do
  [[ -z "$m" || "$m" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] ||
    { echo "dump-monthly: -m expects YYYY-MM, got '$m'" >&2; exit 2; }
done

# --- locate a node that can load better-sqlite3 -------------------------------
# The native module is built against one ABI; the `node` on PATH may be another
# (the service pins v20.18.0). Probe candidates and take the first that loads.
find_node() {
  local candidates=()
  [[ -n "${NODE_BIN:-}" ]] && candidates+=("$NODE_BIN")
  candidates+=("$(command -v node || true)")
  # newest nvm versions first, they are the likeliest rebuild targets
  while IFS= read -r n; do candidates+=("$n"); done < <(
    ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV || true
  )
  local n
  # The native binding is loaded lazily by the Database constructor, so the
  # probe has to actually open a DB — a bare require() succeeds on any ABI.
  local probe="new (require('$SCRIPT_DIR/node_modules/better-sqlite3'))(':memory:').close()"
  for n in "${candidates[@]}"; do
    [[ -n "$n" && -x "$n" ]] || continue
    if "$n" -e "$probe" >/dev/null 2>&1; then
      printf '%s\n' "$n"
      return 0
    fi
  done
  return 1
}

NODE="$(find_node)" || {
  cat >&2 <<'EOF'
dump-monthly: could not find a node able to load better-sqlite3.
  Run `npm rebuild better-sqlite3` with the node you intend to use, or set
  NODE_BIN=/path/to/node (the service uses ~/.nvm/versions/node/v20.18.0/bin/node).
EOF
  exit 1
}

mkdir -p "$OUTDIR"

# Wipe previously generated files only — anything else in OUTDIR is left alone.
# With -m the wipe is scoped to the selected months, so a monthly cron run does
# not destroy the archives it is not regenerating.
shopt -s nullglob
if ((${#MONTHS[@]})); then
  for m in "${MONTHS[@]}"; do
    rm -f "$OUTDIR/crash_$m.csv" "$OUTDIR/crash_$m.csv.gz" "$OUTDIR/crash_$m.summary.json"
  done
else
  rm -f "$OUTDIR"/crash_[0-9][0-9][0-9][0-9]-[0-9][0-9].csv \
        "$OUTDIR"/crash_[0-9][0-9][0-9][0-9]-[0-9][0-9].csv.gz \
        "$OUTDIR"/crash_[0-9][0-9][0-9][0-9]-[0-9][0-9].summary.json
fi
rm -f "$OUTDIR/index.csv" "$OUTDIR/summary.json"   # always rebuilt from every summary on disk
shopt -u nullglob

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/dump.js" <<'NODE_EOF'
'use strict';
const fs = require('fs');
const path = require('path');
// This file lives in a temp dir, so better-sqlite3 is resolved from the
// project directory rather than relative to the script.
const Database = require(path.join(process.env.DUMP_PROJECT_DIR, 'node_modules', 'better-sqlite3'));

const [dbPath, outDir, monthFilterRaw] = process.argv.slice(2);
const monthFilter = monthFilterRaw ? new Set(monthFilterRaw.split(',').filter(Boolean)) : null;
// The shell gzips the CSVs after this script exits; the roll-ups must name the
// files as they will exist on disk.
const csvSuffix = process.env.DUMP_GZIP === '1' ? '.csv.gz' : '.csv';

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Tier boundaries mirror the palette documented in CLAUDE.md.
const TIERS = [
  { key: 'red',       label: '< 1.01x',        test: m => m < 1.01 },
  { key: 'orange',    label: '1.01x - 1.99x',  test: m => m < 2 },
  { key: 'green',     label: '2x - 99.99x',    test: m => m < 100 },
  { key: 'purple',    label: '100x - 999.99x', test: m => m < 1000 },
  { key: 'turquoise', label: '>= 1000x',       test: () => true },
];

const csvCell = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};

const round = (n, d = 6) => (n === null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));

const months = db.prepare(`
  SELECT strftime('%Y-%m', ts_ms / 1000, 'unixepoch') AS month, COUNT(*) AS n
  FROM crash_results
  WHERE ts_ms IS NOT NULL
  GROUP BY month
  ORDER BY month
`).all().filter(r => r.month && (!monthFilter || monthFilter.has(r.month)));

const orphans = db.prepare('SELECT COUNT(*) AS n FROM crash_results WHERE ts_ms IS NULL').get().n;
if (orphans > 0) {
  console.error(`  ! ${orphans} row(s) have a NULL ts_ms and are not in any monthly dump`);
}

if (!months.length) {
  console.error(monthFilter ? '  ! no rows for the requested month(s)' : '  ! database is empty');
}

const COLUMNS = [
  'gameId', 'multiplier', 'timestamp', 'ts_ms', 'iso_utc',
  'gamesSinceLast1x', 'gamesSinceLast1000x', 'gamesSinceDouble1x',
];

const rowStmt = db.prepare(`
  SELECT gameId, multiplier, timestamp, ts_ms,
         gamesSinceLast1x, gamesSinceLast1000x, gamesSinceDouble1x
  FROM crash_results
  WHERE ts_ms >= ? AND ts_ms < ?
  ORDER BY ts_ms ASC, gameId ASC
`);

const summaries = [];

for (const { month } of months) {
  const [y, mo] = month.split('-').map(Number);
  const startMs = Date.UTC(y, mo - 1, 1);
  const endMs = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1);

  const csvPath = path.join(outDir, `crash_${month}.csv`);
  const fd = fs.openSync(csvPath, 'w');

  let buf = COLUMNS.join(',') + '\n';
  const flush = (force) => {
    if (buf.length >= 1 << 20 || (force && buf.length)) {
      fs.writeSync(fd, buf);
      buf = '';
    }
  };

  const multipliers = [];
  const tierCounts = Object.fromEntries(TIERS.map(t => [t.key, 0]));
  const byDay = new Map();
  let count = 0, sum = 0, firstMs = null, lastMs = null;
  let prevMs = null, maxGapMs = 0, maxGapAt = null;

  for (const r of rowStmt.iterate(startMs, endMs)) {
    const iso = new Date(r.ts_ms).toISOString();
    buf += [
      csvCell(r.gameId), csvCell(r.multiplier), csvCell(r.timestamp), csvCell(r.ts_ms), iso,
      csvCell(r.gamesSinceLast1x), csvCell(r.gamesSinceLast1000x), csvCell(r.gamesSinceDouble1x),
    ].join(',') + '\n';
    flush(false);

    count++;
    const m = r.multiplier;
    sum += m;
    multipliers.push(m);
    tierCounts[TIERS.find(t => t.test(m)).key]++;

    const day = iso.slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);

    if (firstMs === null) firstMs = r.ts_ms;
    lastMs = r.ts_ms;
    if (prevMs !== null && r.ts_ms - prevMs > maxGapMs) {
      maxGapMs = r.ts_ms - prevMs;
      maxGapAt = new Date(prevMs).toISOString();
    }
    prevMs = r.ts_ms;
  }
  flush(true);
  fs.closeSync(fd);

  const sorted = multipliers.slice().sort((a, b) => a - b);
  const countAtLeast = x => {
    const i = sorted.findIndex(v => v >= x);
    return i === -1 ? 0 : sorted.length - i;
  };
  const share = n => (count ? round((n / count) * 100, 4) : null);

  const summary = {
    month,
    generatedAt: new Date().toISOString(),
    source: path.basename(dbPath),
    csvFile: `crash_${month}${csvSuffix}`,
    rows: count,
    firstResult: firstMs === null ? null : new Date(firstMs).toISOString(),
    lastResult: lastMs === null ? null : new Date(lastMs).toISOString(),
    coverage: {
      // rounds observed vs. the ~1 per 25s cadence the game runs at
      daysWithData: byDay.size,
      largestGapSeconds: round(maxGapMs / 1000, 1),
      largestGapStart: maxGapAt,
    },
    multiplier: {
      min: round(sorted[0] ?? null),
      max: round(sorted[sorted.length - 1] ?? null),
      mean: count ? round(sum / count) : null,
      median: round(pct(sorted, 50)),
      p25: round(pct(sorted, 25)),
      p75: round(pct(sorted, 75)),
      p90: round(pct(sorted, 90)),
      p95: round(pct(sorted, 95)),
      p99: round(pct(sorted, 99)),
    },
    distribution: TIERS.map(t => ({
      tier: t.key,
      range: t.label,
      count: tierCounts[t.key],
      percent: share(tierCounts[t.key]),
    })),
    thresholds: [1.01, 2, 5, 10, 50, 100, 1000].map(x => ({
      atLeast: x,
      count: countAtLeast(x),
      percent: share(countAtLeast(x)),
    })),
    instantCrashes: {
      count: tierCounts.red,
      percent: share(tierCounts.red),
    },
    resultsPerDay: [...byDay.entries()].sort().map(([date, n]) => ({ date, count: n })),
    topMultipliers: db.prepare(`
      SELECT gameId, multiplier, timestamp, ts_ms
      FROM crash_results
      WHERE ts_ms >= ? AND ts_ms < ?
      ORDER BY multiplier DESC
      LIMIT 10
    `).all(startMs, endMs),
  };

  fs.writeFileSync(
    path.join(outDir, `crash_${month}.summary.json`),
    JSON.stringify(summary, null, 2) + '\n'
  );

  summaries.push(summary);
  console.log(
    `  ${month}  ${String(count).padStart(7)} rows  ` +
    `avg ${String(summary.multiplier.mean ?? '-').padStart(9)}x  ` +
    `max ${String(summary.multiplier.max ?? '-').padStart(11)}x  ` +
    `-> ${path.basename(csvPath)}`
  );
}

// Roll-ups always describe every month sitting in the output directory, not
// just the ones this run rebuilt — otherwise a `-m` run (the monthly cron)
// would shrink index.csv to a single line.
const onDisk = fs.readdirSync(outDir)
  .filter(f => /^crash_\d{4}-\d{2}\.summary\.json$/.test(f))
  .map(f => {
    const fresh = summaries.find(s => `crash_${s.month}.summary.json` === f);
    if (fresh) return fresh;
    try {
      return JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    } catch (err) {
      console.error(`  ! ignoring unreadable ${f}: ${err.message}`);
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => a.month.localeCompare(b.month));

const indexRows = ['month,rows,first_result,last_result,min_multiplier,mean_multiplier,max_multiplier,instant_crash_pct,csv_file'];
for (const s of onDisk) {
  indexRows.push([
    s.month, s.rows, s.firstResult ?? '', s.lastResult ?? '',
    s.multiplier.min ?? '', s.multiplier.mean ?? '', s.multiplier.max ?? '',
    s.instantCrashes.percent ?? '', s.csvFile ?? `crash_${s.month}.csv`,
  ].map(csvCell).join(','));
}
fs.writeFileSync(path.join(outDir, 'index.csv'), indexRows.join('\n') + '\n');

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: path.basename(dbPath),
  regeneratedThisRun: summaries.map(s => s.month),
  rowsWithoutTimestamp: orphans,
  totalRows: onDisk.reduce((a, s) => a + s.rows, 0),
  months: onDisk,
}, null, 2) + '\n');

db.close();
NODE_EOF

MONTH_ARG=""
if ((${#MONTHS[@]})); then
  MONTH_ARG="$(IFS=,; echo "${MONTHS[*]}")"
fi

echo "dump-monthly: $DB -> $OUTDIR  (node $("$NODE" -p 'process.versions.node'))"
DUMP_PROJECT_DIR="$SCRIPT_DIR" DUMP_GZIP="$GZIP" "$NODE" "$WORK/dump.js" "$DB" "$OUTDIR" "$MONTH_ARG"

if ((GZIP)); then
  # Only touch what this run wrote. Gzipping a month it did not regenerate
  # would rename a file that the month's own summary already points at.
  shopt -s nullglob
  if ((${#MONTHS[@]})); then
    csvs=()
    for m in "${MONTHS[@]}"; do
      [[ -f "$OUTDIR/crash_$m.csv" ]] && csvs+=("$OUTDIR/crash_$m.csv")
    done
  else
    csvs=("$OUTDIR"/crash_[0-9][0-9][0-9][0-9]-[0-9][0-9].csv)
  fi
  shopt -u nullglob
  if ((${#csvs[@]})); then
    echo "dump-monthly: gzipping ${#csvs[@]} csv file(s)"
    gzip -9 -f "${csvs[@]}"
  fi
fi

echo "dump-monthly: done"
du -sh "$OUTDIR" 2>/dev/null | awk '{print "dump-monthly: " $1 " in " $2}'
