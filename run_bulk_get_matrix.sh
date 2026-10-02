#!/usr/bin/env bash
# Bulk get matrix: 3 server conditions x 5 levels.
# Each tick fires one _bulk_get covering the entire pool (read-only; no writes during the run).
# Measures raw mget cost at different scales — the same operation the diff feature adds before
# every bulk update when savedObjectDiff.enabled=true.
#
# Usage:
#   ./run_bulk_get_matrix.sh <condition> <level|all>    e.g. ./run_bulk_get_matrix.sh diff 3
#   ./run_bulk_get_matrix.sh <condition> all             run levels 1-5 back to back
#
# Conditions (configure the server before running; this script cannot change them):
#   off          xpack.security.audit.enabled=false (or omitted)
#   audit        xpack.security.audit.enabled=true, console appender (json layout), diffs off
#   diff         as audit plus savedObjectDiff.enabled=true, typesToInclude ["index-pattern"]
#
# Levels (all use --single-batch --update-mode get, plain nested objects, no blobs):
#   1  pool=100, rpm=10  — one get every 6s,   100 objects per request
#   2  pool=100, rpm=20  — one get every 3s,   100 objects per request; requests start overlapping
#   3  pool=50,  rpm=50  — one get every 1.2s,  50 objects per request; high concurrency, small payload
#   4  pool=100, rpm=50  — one get every 1.2s, 100 objects per request; high concurrency, medium payload
#   5  pool=250, rpm=50  — one get every 1.2s, 250 objects per request; high concurrency, large payload
#
# Compare off vs audit vs diff to check whether having diff enabled changes raw mget cost
# (it should not — mget is upstream of the diff engine). Compare levels to see how mget
# latency and ELU scale with request size and concurrency.
#
# Requires KIBANA_URL, KIBANA_USERNAME, KIBANA_PASSWORD in the environment.
set -euo pipefail
cd "$(dirname "$0")"

cond="${1:?condition: off | audit | diff}"; level_arg="${2:?level: 1-5 or all}"
case "$cond" in off|audit|diff) ;; *) echo "unknown condition: $cond"; exit 2 ;; esac
mkdir -p results

run() {
  local lvl="$1" name="$2"; shift 2
  local out="results/${cond}_bulk_get_G${lvl}_${name}.json"
  echo
  echo "=== [$cond] level $lvl: $name -> $out"
  echo "node so_diff_stress.js $* --single-batch --update-mode get --panels 800 --duration 300 --out $out --yes"
  node so_diff_stress.js "$@" \
    --single-batch \
    --update-mode get \
    --panels 800 \
    --duration 300 \
    --out "$out" \
    --yes
}

failed=()
levels=("$level_arg"); [ "$level_arg" = all ] && levels=(1 2 3 4 5)
for l in "${levels[@]}"; do
  case "$l" in
    1) run 1 "pool100_rpm10"  --pool 100 --rpm 10 ;;
    2) run 2 "pool100_rpm20"  --pool 100 --rpm 20 ;;
    3) run 3 "pool50_rpm50"   --pool 50  --rpm 50 ;;
    4) run 4 "pool100_rpm50"  --pool 100 --rpm 50 ;;
    5) run 5 "pool250_rpm50"  --pool 250 --rpm 50 ;;
    *) echo "unknown level: $l (use 1-5 or all)"; exit 2 ;;
  esac || { echo "level $l FAILED — continuing"; failed+=("$l"); }
done
[ ${#failed[@]} -eq 0 ] || echo "FAILED levels: ${failed[*]}"
