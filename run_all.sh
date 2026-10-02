#!/usr/bin/env bash
# Runs all matrix scripts back to back for a given server condition.
#
# Usage:
#   ./run_all.sh <condition>    e.g. ./run_all.sh diff
#
# Conditions (configure the server before running):
#   off    xpack.security.audit.enabled=false (or omitted)
#   audit  xpack.security.audit.enabled=true, console appender, diffs off
#   diff   as audit plus savedObjectDiff.enabled=true, typesToInclude ["index-pattern"]
#
# Runs in order:
#   1. run_matrix.sh          — individual updates, mixed load levels
#   2. run_bulk_matrix.sh     — single-batch title updates, varying pool size
#   3. run_blob_matrix.sh     — individual blob-mutating updates, varying load
#   4. run_bulk_blob_matrix.sh — single-batch blob updates, varying pool + fields
#   5. run_bulk_get_matrix.sh  — read-only bulk gets, varying pool + RPM
#
# Each script continues through its own levels on failure; this script continues
# through scripts on failure and prints a summary at the end.
#
# Requires KIBANA_URL, KIBANA_USERNAME, KIBANA_PASSWORD in the environment.
set -uo pipefail
cd "$(dirname "$0")"

cond="${1:?condition: off | audit | diff}"
case "$cond" in off|audit|diff) ;; *) echo "unknown condition: $cond"; exit 2 ;; esac

failed=()
run_script() {
  local script="$1"
  echo
  echo "========================================"
  echo "  $script $cond all"
  echo "========================================"
  bash "$script" "$cond" all || { echo "$script FAILED — continuing"; failed+=("$script"); }
}

run_script run_matrix.sh
run_script run_bulk_matrix.sh
run_script run_blob_matrix.sh
run_script run_bulk_blob_matrix.sh
run_script run_bulk_get_matrix.sh

echo
echo "========================================"
echo "  ALL DONE [$cond]"
echo "========================================"
if [ ${#failed[@]} -eq 0 ]; then
  echo "All scripts completed successfully."
else
  echo "FAILED scripts: ${failed[*]}"
fi
