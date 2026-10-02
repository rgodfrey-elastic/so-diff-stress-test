#!/usr/bin/env bash
# Bulk blob update matrix: 3 server conditions x 4 levels.
# Each tick is one _bulk_update covering the entire pool; blob0 is mutated on every tick
# so the diff engine always sees a replace op and runs applyFieldSizeLimit for each object.
# Extra blob fields (blob1, blob2…) are noOps — measures their noOp comparison overhead too.
#
# Usage:
#   ./run_bulk_blob_matrix.sh <condition> <level|all>    e.g. ./run_bulk_blob_matrix.sh diff 2
#   ./run_bulk_blob_matrix.sh <condition> all             run levels 1-4 back to back
#
# Conditions (configure the server before running; this script cannot change them):
#   off          xpack.security.audit.enabled=false (or omitted)
#   audit        xpack.security.audit.enabled=true, console appender (json layout), diffs off
#   diff         as audit plus savedObjectDiff.enabled=true, typesToInclude ["index-pattern"]
#
# Levels (all use --single-batch --update-mode blob --blob-size 51200):
#   1  pool=5,  blob-fields=1, rpm=3   — 5 objects, 1 blob each (update payload: 5×50KB=250KB)
#   2  pool=10, blob-fields=1, rpm=3   — 10 objects, 1 blob each (update payload: 10×50KB=500KB)
#   3  pool=5,  blob-fields=3, rpm=3   — 5 objects, 3 blobs each; extra blobs are noOps per object
#   4  pool=10, blob-fields=3, rpm=3   — 10 objects, 3 blobs each; combines pool + field count overhead
#   5  pool=17, blob-fields=5,  rpm=20  — max safe pool (17×50KB=867KB payload), 5 blob fields,
#                                         high RPM so requests overlap; intended to find the limit
#   6  pool=17, blob-fields=10, rpm=60  — 10 blob fields doubles the mget response (~8.7MB/req);
#                                         60 RPM puts 2-3 requests in flight simultaneously
#
# Update payloads stay under 900KB (only blob0 is sent per tick, not all blob fields).
# Object size at rest: L1/L2 ~50KB, L3/L4 ~150KB. All within the 1MB Kibana limit.
#
# Requires KIBANA_URL, KIBANA_USERNAME, KIBANA_PASSWORD in the environment.
set -euo pipefail
cd "$(dirname "$0")"

cond="${1:?condition: off | audit | diff}"; level_arg="${2:?level: 1-6 or all}"
case "$cond" in off|audit|diff) ;; *) echo "unknown condition: $cond"; exit 2 ;; esac
mkdir -p results

run() {
  local lvl="$1" name="$2"; shift 2
  local out="results/${cond}_bulk_blob_B${lvl}_${name}.json"
  echo
  echo "=== [$cond] level $lvl: $name -> $out"
  local rpm="${rpm:-3}"
  echo "node so_diff_stress.js $* --single-batch --update-mode blob --blob-size 51200 --rpm $rpm --duration 300 --out $out --yes"
  node so_diff_stress.js "$@" \
    --single-batch \
    --update-mode blob \
    --blob-size 51200 \
    --rpm "$rpm" \
    --duration 300 \
    --out "$out" \
    --yes
}

failed=()
levels=("$level_arg"); [ "$level_arg" = all ] && levels=(1 2 3 4 5 6)
for l in "${levels[@]}"; do
  case "$l" in
    1) run 1 "pool5_1field"   --pool 5  --blob-fields 1 ;;
    2) run 2 "pool10_1field"  --pool 10 --blob-fields 1 ;;
    3) run 3 "pool5_3fields"  --pool 5  --blob-fields 3 ;;
    4) run 4 "pool10_3fields" --pool 10 --blob-fields 3 ;;
    5) rpm=20 run 5 "pool17_5fields_rpm20"  --pool 17 --blob-fields 5  ;;
    6) rpm=60 run 6 "pool17_10fields_rpm60" --pool 17 --blob-fields 10 ;;
    *) echo "unknown level: $l (use 1-6 or all)"; exit 2 ;;
  esac || { echo "level $l FAILED — continuing"; failed+=("$l"); }
done
[ ${#failed[@]} -eq 0 ] || echo "FAILED levels: ${failed[*]}"
