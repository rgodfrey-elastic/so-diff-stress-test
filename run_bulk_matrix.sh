#!/usr/bin/env bash
# Single-batch bulk update matrix: 3 server conditions x 4 pool sizes.
# Each tick sends one _bulk_update covering the entire pool; tests how the server
# handles large bulk writes as pool size grows — and where it breaks under diff load.
#
# Usage:
#   ./run_bulk_matrix.sh <condition> <pool>     e.g. ./run_bulk_matrix.sh diff 250
#   ./run_bulk_matrix.sh <condition> all         run all 4 pool sizes back to back
#
# Conditions (configure the server before running; this script cannot change them):
#   off          xpack.security.audit.enabled=false (or omitted)
#   audit        xpack.security.audit.enabled=true, console appender (json layout), diffs off
#   diff         as audit plus savedObjectDiff.enabled=true, typesToInclude ["index-pattern"]
#
# Pool sizes: 100, 250, 500, 700
#   Each run seeds <pool> objects sequentially then fires --single-batch updates at 3 rpm
#   (one full-pool bulk update every 20 seconds) for 5 minutes = 15 bulk requests.
#   update-mode=title: only the title field changes per object, keeping the payload small.
#
# Requires KIBANA_URL, KIBANA_USERNAME, KIBANA_PASSWORD in the environment.
set -euo pipefail
cd "$(dirname "$0")"

cond="${1:?condition: off | audit | diff}"; pool_arg="${2:?pool: 100 | 250 | 500 | 700 | all}"
case "$cond" in off|audit|diff) ;; *) echo "unknown condition: $cond"; exit 2 ;; esac
mkdir -p results

run() {
  local pool="$1"
  local out="results/${cond}_bulk_P${pool}.json"
  echo
  echo "=== [$cond] pool=$pool -> $out"
  echo "node so_diff_stress.js --single-batch --pool $pool --panels 800 --update-mode title --rpm 3 --duration 300 --out $out --yes"
  node so_diff_stress.js \
    --single-batch \
    --pool "$pool" \
    --panels 800 \
    --update-mode title \
    --rpm 3 \
    --duration 300 \
    --out "$out" \
    --yes
}

failed=()
pools=("$pool_arg"); [ "$pool_arg" = all ] && pools=(100 250 500 700)
for p in "${pools[@]}"; do
  case "$p" in
    100|250|500|700) run "$p" ;;
    *) echo "unknown pool size: $p (use 100, 250, 500, 700, or all)"; exit 2 ;;
  esac || { echo "pool=$p FAILED — continuing"; failed+=("$p"); }
done
[ ${#failed[@]} -eq 0 ] || echo "FAILED pools: ${failed[*]}"
