#!/usr/bin/env bash
# Blob field diff matrix: 3 server conditions x 4 load levels.
# Each tick mutates one blob field so the diff engine always sees a replace op,
# exercising the fieldSizeLimit path (values >48KB are truncated in the audit log).
#
# Usage:
#   ./run_blob_matrix.sh <condition> <level|all>    e.g. ./run_blob_matrix.sh diff 3
#   ./run_blob_matrix.sh <condition> all             run levels 1-4 back to back
#
# Conditions (configure the server before running; this script cannot change them):
#   off          xpack.security.audit.enabled=false (or omitted)
#   audit        xpack.security.audit.enabled=true, console appender (json layout), diffs off
#   diff         as audit plus savedObjectDiff.enabled=true, typesToInclude ["index-pattern"]
#
# Levels (all use --update-mode blob so blob0 is mutated on every tick):
#   1  pool=5,  blob-fields=1, blob-size=51200  (50KB),  rpm=10   — baseline, one small blob
#   2  pool=15, blob-fields=2, blob-size=204800 (200KB), rpm=30   — two medium blobs
#   3  pool=30, blob-fields=4, blob-size=204800 (200KB), rpm=60   — four medium blobs, higher load
#   4  pool=50, blob-fields=4, blob-size=204800 (200KB), rpm=100  — same shape, stress load
#
# Object sizes stay under the Kibana 1 MB payload limit (B1: 50 KB, B2: 400 KB, B3/B4: 800 KB).
# Compare off vs audit vs diff at the same level to isolate the diff engine's contribution.
#
# Requires KIBANA_URL, KIBANA_USERNAME, KIBANA_PASSWORD in the environment.
set -euo pipefail
cd "$(dirname "$0")"

cond="${1:?condition: off | audit | diff}"; level_arg="${2:?level: 1-4 or all}"
case "$cond" in off|audit|diff) ;; *) echo "unknown condition: $cond"; exit 2 ;; esac
mkdir -p results

run() {
  local lvl="$1" name="$2"; shift 2
  local out="results/${cond}_blob_B${lvl}_${name}.json"
  echo
  echo "=== [$cond] level $lvl: $name -> $out"
  echo "node so_diff_stress.js $* --update-mode blob --duration 300 --out $out --yes"
  node so_diff_stress.js "$@" --update-mode blob --duration 300 --out "$out" --yes
}

failed=()
levels=("$level_arg"); [ "$level_arg" = all ] && levels=(1 2 3 4)
for l in "${levels[@]}"; do
  case "$l" in
    1) run 1 "pool5_1field_50kb"    --pool 5  --blob-fields 1 --blob-size 51200  --rpm 10  ;;
    2) run 2 "pool15_2fields_200kb" --pool 15 --blob-fields 2 --blob-size 204800 --rpm 30  ;;
    3) run 3 "pool30_4fields_200kb" --pool 30 --blob-fields 4 --blob-size 204800 --rpm 60  ;;
    4) run 4 "pool50_4fields_200kb" --pool 50 --blob-fields 4 --blob-size 204800 --rpm 100 ;;
    *) echo "unknown level: $l (use 1-4 or all)"; exit 2 ;;
  esac || { echo "level $l FAILED — continuing"; failed+=("$l"); }
done
[ ${#failed[@]} -eq 0 ] || echo "FAILED levels: ${failed[*]}"
