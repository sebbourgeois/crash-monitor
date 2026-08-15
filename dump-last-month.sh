#!/usr/bin/env bash
#
# dump-last-month.sh — cron entry point: archive the month that just ended.
#
# Run on the 1st of the month, it resolves "yesterday" (still in the previous
# month, in UTC) and hands that YYYY-MM to dump-monthly.sh. Run on any other
# day it still archives the previous calendar month, so a missed or manually
# retried run does the same thing.
#
# Usage:
#   ./dump-last-month.sh [extra dump-monthly.sh args...]
#
# Any extra arguments are passed through, e.g. `./dump-last-month.sh -z` to
# gzip the CSV. Override the target month with MONTH=YYYY-MM for a backfill.
#
# Installed as:
#   5 0 1 * * /home/sb/github/stake-crash-archives/dump-last-month.sh >> ... 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The dumps bucket by UTC month and this host runs UTC, but force it so a
# machine on a local timezone still lines the two up.
export TZ=UTC

# First day of the current month, minus one day = some day in the previous
# month. Safer than arithmetic on the month number across a year boundary.
MONTH="${MONTH:-$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m)}"

[[ "$MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] ||
  { echo "dump-last-month: MONTH must be YYYY-MM, got '$MONTH'" >&2; exit 2; }

echo "=== dump-last-month $(date -u +%Y-%m-%dT%H:%M:%SZ) — archiving $MONTH ==="

# `-m` scopes both the write and the wipe to this month; the other months'
# archives are left in place and the roll-ups are rebuilt from all of them.
"$SCRIPT_DIR/dump-monthly.sh" -m "$MONTH" "$@"
