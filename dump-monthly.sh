#!/usr/bin/env bash
#
# dump-monthly.sh — export a site's crash database into per-month archives.
#
# Each monitored site has its own database and its own archive directory, so
# their rounds never mix:
#
#   stake    crash_results.db          -> db-archives/
#   shuffle  shuffle_crash_results.db  -> db-archives-shuffle/
#   roobet   roobet_crash_results.db   -> db-archives-roobet/
#
# For every calendar month (UTC) present in a DB it writes, in that site's dir:
#   crash_YYYY-MM.csv           full rows for that month
#   crash_YYYY-MM.summary.json  stats for that month
# plus two roll-ups:
#   index.csv                   one line per month
#   summary.json                every month summary in one file
#
# Re-running overwrites: previously generated files are wiped first, so stale
# months never linger. With -m only the selected months are touched; the
# roll-ups are always rebuilt from every summary in the output dir.
#
# Usage:
#   ./dump-monthly.sh [-s SITE] [-d DB] [-o OUTDIR] [-m YYYY-MM] [-z] [-h]
#
#   -s SITE     stake|shuffle|roobet (repeatable) (default: every site with a DB on disk)
#   -d DB       path to the SQLite file      (default: the site's own DB)
#   -o OUTDIR   output directory             (default: the site's own archive dir)
#   -m YYYY-MM  only this month (repeatable) (default: every month in the DB)
#   -z          gzip the CSVs (-9) after writing
#   -h          this help
#
# -d and -o describe a single archive, so they may only be combined with one
# site. Read-only: the DB is opened readonly, so it is safe to run while
# capture.js is live.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Site table — keep in sync with lib/sites.js (defaultDb) when adding a site.
SITE_ORDER=(stake shuffle roobet)
declare -A SITE_DB=(
  [stake]="crash_results.db"
  [shuffle]="shuffle_crash_results.db"
  [roobet]="roobet_crash_results.db"
)
declare -A SITE_OUT=(
  [stake]="db-archives"
  [shuffle]="db-archives-shuffle"
  [roobet]="db-archives-roobet"
)

DB=""
OUTDIR=""
DB_SET=0
OUT_SET=0
GZIP=0
MONTHS=()
SITES=()

# Prints the contiguous comment block below the shebang, so the help text cannot
# drift out of sync with a line range.
usage() { awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"; }

while getopts ":s:d:o:m:zh" opt; do
  case "$opt" in
    s) SITES+=("$OPTARG") ;;
    d) DB="$OPTARG"; DB_SET=1 ;;
    o) OUTDIR="$OPTARG"; OUT_SET=1 ;;
    m) MONTHS+=("$OPTARG") ;;
    z) GZIP=1 ;;
    h) usage; exit 0 ;;
    :) echo "dump-monthly: -$OPTARG needs an argument" >&2; exit 2 ;;
    \?) echo "dump-monthly: unknown option -$OPTARG" >&2; usage >&2; exit 2 ;;
  esac
done

for m in "${MONTHS[@]:-}"; do
  [[ -z "$m" || "$m" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] ||
    { echo "dump-monthly: -m expects YYYY-MM, got '$m'" >&2; exit 2; }
done

for s in "${SITES[@]:-}"; do
  [[ -z "$s" || -n "${SITE_DB[$s]:-}" ]] ||
    { echo "dump-monthly: unknown site '$s' (known: ${SITE_ORDER[*]})" >&2; exit 2; }
done

# No -s: archive every site that actually has a database, so the monthly cron
# picks a new site up on its own. With -d/-o the run describes one archive, and
# stake stays the default for backwards compatibility.
if ((${#SITES[@]} == 0)); then
  if ((DB_SET || OUT_SET)); then
    SITES=(stake)
  else
    for s in "${SITE_ORDER[@]}"; do
      [[ -f "$SCRIPT_DIR/${SITE_DB[$s]}" ]] && SITES+=("$s")
    done
    ((${#SITES[@]})) || {
      echo "dump-monthly: no site database found in $SCRIPT_DIR (looked for: ${SITE_DB[*]})" >&2
      exit 1
    }
  fi
fi

if ((${#SITES[@]} > 1)) && ((DB_SET || OUT_SET)); then
  echo "dump-monthly: -d/-o describe one archive — use a single -s with them" >&2
  exit 2
fi

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

# One site: wipe what this run is about to regenerate, dump, then gzip.
dump_site() {
  local site="$1" db="$2" outdir="$3"

  echo "dump-monthly: [$site] $db -> $outdir"
  mkdir -p "$outdir" || return 1

  # Wipe previously generated files only — anything else in the output dir is
  # left alone. With -m the wipe is scoped to the selected months, so a monthly
  # cron run does not destroy the archives it is not regenerating.
  shopt -s nullglob
  if ((${#MONTHS[@]})); then
    local m
    for m in "${MONTHS[@]}"; do
      rm -f "$outdir/crash_$m.csv" "$outdir/crash_$m.csv.gz" "$outdir/crash_$m.summary.json"
    done
  else
    rm -f "$outdir"/crash_[0-9][0-9][0-9][0-9]-[0-9][0-9].csv \
          "$outdir"/crash_[0-9][0-9][0-9][0-9]-[0-9][0-9].csv.gz \
          "$outdir"/crash_[0-9][0-9][0-9][0-9]-[0-9][0-9].summary.json
  fi
  rm -f "$outdir/index.csv" "$outdir/summary.json"   # always rebuilt from every summary on disk
  shopt -u nullglob

  # Explicit rather than leaning on errexit: this runs from an `if !` in the
  # caller, and the exact errexit semantics inside a function called that way
  # are too subtle to bet the other sites' archives on.
  if ! DUMP_PROJECT_DIR="$SCRIPT_DIR" DUMP_GZIP="$GZIP" "$NODE" "$WORK/dump.js" "$db" "$outdir" "$MONTH_ARG"; then
    return 1
  fi

  if ((GZIP)); then
    # Only touch what this run wrote. Gzipping a month it did not regenerate
    # would rename a file that the month's own summary already points at.
    local csvs=()
    shopt -s nullglob
    if ((${#MONTHS[@]})); then
      local m
      for m in "${MONTHS[@]}"; do
        [[ -f "$outdir/crash_$m.csv" ]] && csvs+=("$outdir/crash_$m.csv")
      done
    else
      csvs=("$outdir"/crash_[0-9][0-9][0-9][0-9]-[0-9][0-9].csv)
    fi
    shopt -u nullglob
    if ((${#csvs[@]})); then
      echo "dump-monthly: [$site] gzipping ${#csvs[@]} csv file(s)"
      gzip -9 -f "${csvs[@]}"
    fi
  fi

  du -sh "$outdir" 2>/dev/null | awk -v s="$site" '{print "dump-monthly: [" s "] " $1 " in " $2}'
}

echo "dump-monthly: sites: ${SITES[*]}  (node $("$NODE" -p 'process.versions.node'))"

# One site's failure must not cost the others their archive — a cron run covers
# every site, so failures are collected and reported at the end instead of
# aborting the loop.
FAILED=()
for site in "${SITES[@]}"; do
  db="$DB"
  outdir="$OUTDIR"
  ((DB_SET)) || db="$SCRIPT_DIR/${SITE_DB[$site]}"
  ((OUT_SET)) || outdir="$SCRIPT_DIR/${SITE_OUT[$site]}"

  if [[ ! -f "$db" ]]; then
    echo "dump-monthly: [$site] no such database: $db" >&2
    FAILED+=("$site")
    continue
  fi
  if ! dump_site "$site" "$db" "$outdir"; then
    echo "dump-monthly: [$site] failed" >&2
    FAILED+=("$site")
  fi
done

if ((${#FAILED[@]})); then
  echo "dump-monthly: failed for: ${FAILED[*]}" >&2
  exit 1
fi

echo "dump-monthly: done"
