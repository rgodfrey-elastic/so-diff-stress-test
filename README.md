# Saved object diff audit stress test

`so_diff_stress.js` load-tests the saved object diff auditing feature
(`xpack.security.audit.savedObjectDiff.*`) against a deployed Kibana, such as a serverless QA
project, and reports how the server holds up. It measures cost and stability, not correctness of
the emitted diffs: audit logs on a serverless project are not readable from outside, so diff
content is covered separately by the Jest and Scout suites in the Kibana PR.

`so_diff_elu_load.js` is an earlier, simpler variant for a local Scout serverless stack. Use
`so_diff_stress.js` for anything deployed.

## Why this shape of test

The diff feature does all of its work synchronously on Kibana's single event loop thread: deep
cloning the existing attributes before the merge, flattening both before and after states, and
comparing them leaf by leaf. On a full laptop core that is a few milliseconds per write. Serverless
Kibana runs on roughly 0.125 vCPU, so the same work takes about eight times longer in wall-clock
terms and competes with every other request.

The question the test answers is therefore: at a given write rate, how much of the event loop does
the feature consume, and at what rate does Kibana stop keeping up? Kibana reports event loop
utilization (ELU) per five-second interval on `GET /api/status`. The working ceiling is 0.8; above
that, responsiveness degrades for every user of the deployment.

## What the script does

1. **Preflight.** Reads the target and credentials from the environment, checks the saved objects
   API is reachable, checks whether `/api/status` exposes process metrics to this user, and asks for
   confirmation with the projected operation count. Nothing is written before you answer.
2. **Seed.** Creates `--pool` objects of type `index-pattern`, each with `--panels` nested
   sub-objects. Every panel has four leaf values, so 800 panels is about 3,200 leaves and 80 KB.
   The nested shape mirrors real large objects such as dashboards and Lens visualizations; a flat
   object with thousands of top-level keys would exercise the diff but not the depth that makes the
   clone and flatten steps expensive.
3. **Load.** A timer fires at the configured rate. Each tick picks an operation by the `--mix`
   weights, defaulting to one create, six updates, one delete. Creates add an object to the pool,
   deletes remove a random one, and the chooser steers the pool back toward `--pool` if it drifts to
   half or double that size. Updates hit a random pool object.
4. **Monitor.** Every five seconds, matching Kibana's ops-metrics refresh, the script polls
   `/api/status` and prints one row. Rows are flagged when status leaves `available`, ELU exceeds
   0.8, or the window had errors.
5. **Drain and clean up.** After the run it waits for in-flight requests, deletes every object it
   created in batches, verifies with a bulk get, retries anything left, and reports the accounting.
   Ctrl-C triggers the same cleanup.
6. **Summarize.** Prints operation counts, latency percentiles per operation, ELU and event loop
   delay statistics, heap peak, status health, and object accounting. With `--out` all of it is
   written to a JSON file.

### Open-loop pacing

Requests fire on the timer whether or not earlier ones have returned. A server that cannot keep up
therefore shows rising latency, a climbing in-flight count, and eventually 429 or 503 responses,
rather than quietly serving a lower rate. `--max-inflight` is a safety cap; ticks beyond it are
skipped and counted so the effect is visible.

### Update modes

Every update changes something. `--update-mode mix` (default) rotates through the three shapes.

| Mode | What changes | Diff produced on an 800-panel object |
| --- | --- | --- |
| `title` | one top-level property | 1 replace op, ~3,200 noOps |
| `nested` | one leaf four levels deep inside one panel | 1 replace op, ~3,200 noOps |
| `all` | every panel's `title` and `label`, plus the top-level title | ~1,600 replace ops with old and new values, ~1,600 noOps |

`title` is the cheapest write with the largest unchanged-path list, so it stresses event size.
`nested` exercises the deep-merge path that the diff must snapshot correctly. `all` is the
compute-heavy case: full clone, merge, migrate, flatten twice, compare every leaf, and emit the
largest event.

Values embed the operation counter, so consecutive updates never coincide with the stored state
and no update is a no-op.

## Reading the output

Columns straight from `/api/status`:

- **status** overall health level. Anything but `available` is flagged.
- **ELU** event loop utilization over the last interval, 0 to 1. The primary metric. Ceiling 0.8.
- **ELDmax**, **ELDp99** event loop delay: the longest and 99th-percentile stall in ms during the
  interval. Synchronous diff work appears here.
- **heapMB** JavaScript heap in use. Watch the trend across a long run for retention.
- **kbn avg**, **kbn max** Kibana's own server-side response times for all requests it served,
  including background traffic from other clients.

Columns computed by the script from its own requests:

- **inflight** requests sent and not yet answered at the moment of the poll. The earliest
  saturation signal.
- **ok/err(5s)** the script's requests completed in the window, split by success.
- **p95ms(5s)** client-side 95th-percentile latency in the window, including network time.

When client latency is high but ELU is low, time is being spent outside Kibana's event loop: on the
network, in Elasticsearch, or waiting on I/O. When ELU climbs with the rate, the feature's CPU cost
is the limiting factor.

### Object accounting

`create n` and `delete n` in the summary count paced operations during the load phase. They exclude
the seeded objects and the cleanup pass. The `objects:` line reconciles them:

```
objects: seeded=10  created during run=38  deleted during run=28  alive at end of load=20  cleanup deleted=20 (verified)  remaining=0
```

Seeded plus created minus deleted should equal alive-at-end, which should equal cleanup-deleted.
A mismatch means a create or delete request failed, and a follow-up line says so.

## Usage

```
export KIBANA_URL=https://<project>.kb.<region>.aws.elastic.cloud
export KIBANA_USERNAME=<user>
export KIBANA_PASSWORD=<password>
```

Authentication sends HTTP Basic first. If the server answers 401, the script logs in through
`POST /internal/security/login` with the `basic` provider (override with `--login-provider`) and
uses the session cookie. The preflight prints which path was used.

Smoke test, confirms auth, reachability, metrics exposure, and cleanup:

```
node so_diff_stress.js --rpm 20 --duration 60 --pool 3 --panels 100
```

A fixed rate with results saved:

```
node so_diff_stress.js --rpm 50 --duration 300 --pool 10 --panels 800 --out qa_50rpm.json
```

Find the knee by stepping through rates:

```
node so_diff_stress.js --ramp 25,50,100,200 --step 120 --pool 10 --panels 800 --out qa_ramp.json
```

Worst case, every update rewrites every leaf:

```
node so_diff_stress.js --rpm 100 --duration 300 --update-mode all --panels 2000 --pool 5 --out qa_worst.json
```

Remove leftovers from an interrupted or failed run, using the prefix printed as `run:` at startup:

```
node so_diff_stress.js --cleanup-only so-stress-<timestamp>
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--rpm` | 60 | total operations per minute |
| `--ramp a,b,c` | | run these rpm values in sequence instead of `--rpm` |
| `--step` | `--duration` | seconds per ramp step |
| `--duration` | 300 | seconds at a fixed rate |
| `--mix c:u:d` | 1:6:1 | create : update : delete weights |
| `--update-mode` | mix | `title`, `nested`, `all`, or `mix` |
| `--pool` | 10 | target number of live objects |
| `--panels` | 800 | nested panels per object, about four leaves each |
| `--max-inflight` | 50 | safety cap on concurrent requests |
| `--poll-ms` | 5000 | status poll interval |
| `--out` | | write results JSON to this file |
| `--keep` | | leave created objects in place |
| `--yes` | | skip the confirmation prompt |
| `--login-provider` | basic | provider for the session-login fallback |
| `--cleanup-only <prefix>` | | delete an earlier run's objects and exit |

## Test matrix: three server conditions, five load levels

The comparison that matters is the same load run against three server configurations, so the only
variable is the setting under test:

| Condition | Server configuration | Levels |
| --- | --- | --- |
| `off` | audit logging disabled | 1 to 5 |
| `audit` | `xpack.security.audit.enabled: true` with a `console` appender (JSON layout), diffs off | 1 to 5 |
| `diff` | as `audit` plus `savedObjectDiff.enabled: true`, `typesToInclude: ["index-pattern"]` | 1 to 5 |
| `audit_otel` | optional: as `audit` but with the `otel` appender | as needed |
| `diff_otel` | optional: as `diff` but with the `otel` appender | as needed |

Kibana audit logging needs an appender to be configured; with `enabled: true` and no appender the
audit logger stays off, and since the diff feature is gated on the audit logger, diffs stay off too.

The `console` appender writes audit events as JSON lines to Kibana's stdout, the same stream its
regular server logs use, so on a container platform they are collected with everything else. It is
the closest analogue to a local `file` appender and is the primary setup for this matrix.

The `otel` appender instead ships each event over HTTP to an OpenTelemetry collector at a
configured URL; production serverless uses it because the platform provides that collector. It does
the same diff computation and event serialization as `console`, then adds attribute flattening and
one more serialization of `kibana.diff` into a string, roughly a millisecond or two per event. The
OTel conditions are therefore a refinement, not a requirement, and only worth running if a
collector URL is available.

The delta between `off` and `audit` is what audit logging already cost before the diff feature. The
delta between `audit` and `diff` is the feature's cost.

### The five levels

| Level | Name | Load | What it tests |
| --- | --- | --- | --- |
| 1 | `baseline` | 20 rpm, 3 min, 5 objects of 200 panels | Light traffic, small objects. Confirms the setup and gives a latency floor. |
| 2 | `target_50rpm` | 50 rpm, 5 min, 10 objects of 800 panels | The 50 rpm serverless target with large objects. The headline comparison. |
| 3 | `heavy_100rpm` | 100 rpm, 5 min, 10 objects of 800 panels | Double the target rate. Shows how cost scales with rate. |
| 4 | `worst_shape` | 100 rpm, 5 min, 5 objects of 2000 panels, every update rewrites every leaf | Maximum compute per write and the largest events. |
| 5 | `ramp_to_limit` | 50 → 100 → 200 → 400 rpm, 2 min each, 10 objects of 800 panels | Finds where ELU crosses 0.8 or errors begin. Errors at the top step are expected. |

Total load time is about 33 minutes per condition.

### Commands

`run_matrix.sh` runs any cell or a whole condition and prints the exact command before running it.
Results land in `results/<condition>_L<level>_<name>.json`.

```
./run_matrix.sh off all        # audit disabled on the server
./run_matrix.sh audit all      # audit on with the console appender, diffs off
./run_matrix.sh diff all       # diffs on, index-pattern allow-listed
./run_matrix.sh diff 4         # a single cell
./run_matrix.sh diff_otel 2    # optional, once a collector url is known
```

The equivalent explicit commands for one condition, here `diff`; substitute the condition name in
the output filenames for the others:

```
node so_diff_stress.js --rpm 20  --duration 180 --pool 5  --panels 200 --yes --out results/diff_L1_baseline.json
node so_diff_stress.js --rpm 50  --duration 300 --pool 10 --panels 800 --yes --out results/diff_L2_target_50rpm.json
node so_diff_stress.js --rpm 100 --duration 300 --pool 10 --panels 800 --yes --out results/diff_L3_heavy_100rpm.json
node so_diff_stress.js --rpm 100 --duration 300 --pool 5  --panels 2000 --update-mode all --yes --out results/diff_L4_worst_shape.json
node so_diff_stress.js --ramp 50,100,200,400 --step 120 --pool 10 --panels 800 --max-inflight 100 --yes --out results/diff_L5_ramp_to_limit.json
```

Server configuration per condition. These are Kibana settings, not Elasticsearch settings, even
though Elasticsearch has a setting of the same name for its own audit log:

```yaml
# audit: audit events go to Kibana's stdout alongside the server logs
xpack.security.audit.enabled: true
xpack.security.audit.appender:
  type: console
  layout:
    type: json

# diff: add to the above
xpack.security.audit.savedObjectDiff.enabled: true
xpack.security.audit.savedObjectDiff.typesToInclude: ["index-pattern"]

# audit_otel / diff_otel (optional): replace the appender block
xpack.security.audit.appender:
  type: otel
  protocol: http
  url: <OTLP logs endpoint of a collector you control>
```

### Procedure

1. Export `KIBANA_URL`, `KIBANA_USERNAME`, and `KIBANA_PASSWORD`.
2. Confirm the server is in the `off` condition and run its five levels.
3. Enable audit logging with the console appender, wait for Kibana to restart and report
   `available`, and run the `audit` levels.
4. Enable diffs with `index-pattern` in `typesToInclude`, restart, and run the `diff` levels.
5. Optional: if a collector URL is available, switch the appender to `otel` and rerun levels 2 and 4
   as `diff_otel`, then with diffs off as `audit_otel`.
6. Run the levels in order within a condition and leave about a minute between them so heap and
   ELU settle before the next starts.
7. Levels 1 to 4 should complete with no 429 or 503 responses; any that appear are findings. Level
   5 is expected to fail at its top step.
8. If a run aborts, remove its leftovers before continuing:
   `node so_diff_stress.js --cleanup-only so-stress-<timestamp>` using the prefix printed as `run:`.
9. Try to run all conditions within the same few hours so background load on the project is
   comparable.

### Comparing results

For each level, put `summary.elu`, `summary.eldMs`, and `summary.latencyMs.update` from the three
condition files side by side. For example:

```
for c in off audit diff; do echo "== $c"; jq -c '.summary | {elu, eldMs, update: .latencyMs.update}' results/${c}_L2_target_50rpm.json; done
```

For level 5, compare the per-step rows in `samples` (each carries the `rpm` in force at that
moment) to see at which step each condition crossed 0.8 ELU or started producing errors.

## Results file

Written only with `--out`. Top-level sections:

- `config` every input, the derived rate plan, object size, auth mode, and the command line
  (with any `--password` value stripped)
- `summary` structured numbers: counts, achieved rpm, HTTP codes, latency percentiles, ELU and
  ELD statistics, heap peak, status polls, alerts, object accounting
- `summaryText` the printed summary, line by line
- `samples` one entry per status poll
- `latency` per-request timings by operation
- `errors` every failed request with status and body

## Collected results

The `results/` directory contains a full set of runs across all five matrix scripts and three
conditions (off / audit / diff). `results/comparison_report.md` walks through each matrix and level
with stats tables and time-series charts. Chart images (`ts_*.png`, `graphs_*.png`) are generated by
`gen_charts.py` from the JSON files.

## Caveats

- The `index-pattern` type must be listed in the deployment's
  `xpack.security.audit.savedObjectDiff.typesToInclude`, otherwise writes are audited but no diff
  is computed and the test measures the wrong thing.
- Depending on the user's role, serverless may return the status level but withhold process
  metrics. The preflight reports which case applies; without metrics the script still monitors HTTP
  health and client latency, which shows saturation but not ELU.
- Kibana's `kbn avg` and `kbn max` include requests from other clients, so a busy project skews
  them independently of this test.
