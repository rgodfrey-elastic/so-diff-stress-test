#!/usr/bin/env bash
# Runs one cell of the test matrix: 3 server conditions x 5 load levels.
#   ./run_matrix.sh <condition> <level>     e.g. ./run_matrix.sh audit 3
#   ./run_matrix.sh <condition> all         run levels 1-5 back to back
# Conditions (set on the server before running; the script cannot change them):
#   off          audit logging disabled
#   audit        xpack.security.audit.enabled=true, console appender (json layout), diffs off
#   diff         as audit plus savedObjectDiff.enabled=true, typesToInclude ["index-pattern"]
#   audit_otel   optional: as audit but with the otel appender (needs a collector url)
#   diff_otel    optional: as diff but with the otel appender
# Run all five levels for off / audit / diff. The otel variants are only needed if a collector is available.
# Requires KIBANA_URL, KIBANA_USERNAME, KIBANA_PASSWORD in the environment.
set -euo pipefail
cd "$(dirname "$0")"
cond="${1:?condition: off | audit | diff | audit_otel | diff_otel}"; level="${2:?level: 1-5 or all}"
case "$cond" in off|audit|diff|audit_otel|diff_otel) ;; *) echo "unknown condition: $cond"; exit 2;; esac
mkdir -p results
run() { # level name args...
  local lvl="$1" name="$2"; shift 2
  local out="results/${cond}_L${lvl}_${name}.json"
  echo; echo "=== [$cond] level $lvl: $name -> $out"; echo "node so_diff_stress.js $* --yes --out $out"
  node so_diff_stress.js "$@" --yes --out "$out"
}
failed=()
levels=("$level"); [ "$level" = all ] && levels=(1 2 3 4 5)
for l in "${levels[@]}"; do
  case "$l" in
    1) run 1 baseline      --rpm 20  --duration 180 --pool 5  --panels 200 ;;
    2) run 2 target_50rpm  --rpm 50  --duration 300 --pool 10 --panels 800 ;;
    3) run 3 heavy_100rpm  --rpm 100 --duration 300 --pool 10 --panels 800 ;;
    4) run 4 worst_shape   --rpm 100 --duration 300 --pool 5  --panels 2000 --update-mode all ;;
    5) run 5 ramp_to_limit --ramp 50,100,200,400 --step 120 --pool 10 --panels 800 --max-inflight 100 ;;
    *) echo "unknown level: $l"; exit 2 ;;
  esac || { echo "level $l FAILED — continuing"; failed+=("$l"); }
done
[ ${#failed[@]} -eq 0 ] || echo "FAILED levels: ${failed[*]}"
