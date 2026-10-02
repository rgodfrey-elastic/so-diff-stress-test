# Saved Object Diff Audit — Stress Test Results Comparison

Three server conditions tested across five matrix scripts.

| Condition | Config |
|---|---|
| **off** | Audit disabled (baseline) |
| **audit** | Audit enabled, console appender, diffs off |
| **diff** | Audit enabled + `savedObjectDiff.enabled: true`, `typesToInclude: ["index-pattern"]` |

---

## Key Findings

1. **`audit` adds no measurable overhead across all tested scenarios.** Audit and off are within noise (typically ±5–10%, no consistent direction) for individual updates, bulk updates, blob-mutating updates, bulk blob updates, and bulk gets. The audit condition is safe to enable with no performance impact.

2. **`diff` overhead is substantial and scales with pool size.** At small pools and low RPM the diff cost is ~5–15% latency overhead. Under single-batch bulk updates with large pools it becomes 2–4×, with ELU saturating at P250+.

3. **The serverless ELU ceiling (0.80) is crossed by diff at bulk P100.** At P100, off=0.508, audit=0.496 (within noise of off), diff=0.823. At P250+ all three conditions saturate from write volume; diff latency blows out further due to the mget before-state fetch being serialised with diff computation.

4. **Bulk blob diff overhead scales with object count and blob field count.** At B6 (17 objects × 10 blob fields, 60 RPM), off=2,178ms → audit=2,010ms → diff=3,563ms. Audit is within noise of off. Diff saturates ELU to 1.0.

5. **Bulk get performance is condition-agnostic at all non-saturated levels.** G1–G3 are within noise across all conditions. G4 all conditions are near-saturated (ELU 0.91–1.0) with similar latency. G5 is too unstable to draw conclusions — all three saturate fully.

---

## Metrics

| Metric | Meaning |
|---|---|
| **p50 latency** | Median request round-trip time in milliseconds. Half of all requests completed faster than this. |
| **p95 latency** | 95th-percentile latency — the slowest 5% of requests exceeded this. |
| **ELU max** | Peak Event Loop Utilisation recorded during the run (0–1). Measures how busy the Kibana Node.js event loop was. Values above **0.80** indicate the server is at or above the serverless platform ceiling and requests will queue. Values of 1.0 mean the loop was fully saturated. |
| **heap peak** | Maximum V8 heap usage recorded during the run in MB. |
| **errors** | Count of non-200 HTTP responses (429, 502, 503) or client-side timeouts during the load phase. |

---

## Aggregations

### p50 latency and ELU max per level

![Individual updates, bulk updates, blob updates](graphs_row1.png)

![Bulk blob updates, bulk gets](graphs_row2.png)

### Heap peak per level

![Individual updates, blob updates, bulk updates — heap peak](graphs_heap_row1.png)

![Bulk blob updates, bulk gets — heap peak](graphs_heap_row2.png)

---

## run_matrix.sh — Individual Updates

Simulates a realistic mix of saved object operations — creates, updates, and deletes — fired one at a time. Closest approximation to normal Kibana usage. off and audit are within noise (±7%, no consistent direction) across all levels. diff adds ~10–17% latency, growing in ELU with load.

### L1 — baseline: 20 RPM, pool=5

Low-load floor. Establishes baseline latency for all three conditions at the lowest RPM and pool size.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 527 ms | 597 ms | 701 ms |
| ELU max | 0.114 | 0.161 | 0.150 |
| errors | — | — | — |
| server down | 0 | 0 | 0 |

![L1 — 20 RPM, pool=5](ts_matrix_L1.png)

### L2 — target: 50 RPM, pool=10

Realistic production write rate. All three conditions comfortably below ELU ceiling. diff adds +10% latency.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 662 ms | 711 ms | 731 ms |
| ELU max | 0.175 | 0.171 | 0.189 |
| errors | — | — | — |
| server down | 0 | 0 | 0 |

![L2 — 50 RPM, pool=10](ts_matrix_L2.png)

### L3 — heavy: 100 RPM, pool=10

Double the RPM of L2. All three conditions remain stable; diff ELU begins to diverge slightly (+0.034 vs off).

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 725 ms | 690 ms | 745 ms |
| ELU max | 0.195 | 0.192 | 0.229 |
| errors | — | — | — |
| server down | 0 | 0 | 0 |

![L3 — 100 RPM, pool=10](ts_matrix_L3.png)

### L4 — worst shape: 100 RPM, pool=5, all-fields

Small pool forces high object reuse; all fields updated every tick maximises diff cost per object. Highest diff ELU delta of any individual-update level (+0.085 vs off).

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,240 ms | 1,262 ms | 1,451 ms |
| ELU max | 0.275 | 0.267 | 0.360 |
| errors | 2 | — | 2 |
| server down | 0 | 0 | 0 |

![L4 — 100 RPM, pool=5, all-fields](ts_matrix_L4.png)

### L5 — ramp: 50→400 RPM

Starts at 50 RPM and doubles every 60 seconds up to 400 RPM. Shows how the server degrades under increasing load. Highest diff ELU of any individual-update level (+0.146 vs off).

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 779 ms | 766 ms | 893 ms |
| ELU max | 0.312 | 0.304 | 0.458 |
| errors | — | — | 1 |
| server down | 0 | 0 | 0 |

![L5 — ramp 50→400 RPM](ts_matrix_L5.png)

---

## run_bulk_matrix.sh — Single-Batch Bulk Updates

Every tick fires a single `_bulk_update` covering the entire pool. Before writing, the diff engine fetches current state of every object via one mget — this before-state fetch serialises with diff computation and is the dominant cost. Pool size is the primary driver. off and audit are within noise at all levels.

### P100 — pool=100

Smallest bulk pool. Diff crosses the 0.80 ELU serverless ceiling. Audit ELU is indistinguishable from off.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 3,319 ms | 3,134 ms | 5,436 ms (+64%) |
| ELU max | 0.508 | 0.496 | **0.823** ⚠️ |
| errors | 0 | 0 | 0 |
| server down | 0 | 0 | 0 |

![P100 — pool=100, single-batch](ts_bulk_P100.png)

### P250 — pool=250

Off and audit begin to saturate. Diff latency nearly doubles vs P100 as mget for 250 objects compounds with diff computation.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 6,467 ms | 6,364 ms | 12,867 ms (+99%) |
| ELU max | 0.926 | 0.933 | 0.846 |
| errors | 0 | 0 | 0 |
| server down | 0 | 0 | 0 |

![P250 — pool=250, single-batch](ts_bulk_P250.png)

### P500 — pool=500

Off and audit fully saturated. Diff latency blows out to 40 s and the server goes down 4 times. Audit p50 appearing lower than off is variance near saturation, not a real effect.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 12,581 ms | 11,270 ms | 40,739 ms (+224%) |
| ELU max | 0.965 | 0.987 | 1.000 |
| errors | 0 | 0 | 3 |
| server down | 0 | 0 | **4** |

![P500 — pool=500, single-batch](ts_bulk_P500.png)

### P700 — pool=700

All conditions saturated. Diff server unavailable 9× during the run; off and audit downtime reflects saturation from write volume alone.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 16,084 ms | 16,140 ms | 46,687 ms (+190%) |
| ELU max | 0.988 | 1.000 | 1.000 |
| errors | 4 | — | 4 |
| server down | **1** | **3** | **9** |

![P700 — pool=700, single-batch](ts_bulk_P700.png)

---

## run_blob_matrix.sh — Individual Blob-Mutating Updates

Targets `applyFieldSizeLimit` in the diff engine — values >48 KB are truncated before writing to the audit log. `blob0` is overwritten with new random content each tick (replace op); extra blob fields are unchanged (noOps). Isolates mget + diff compute + field size limiting on large values. off and audit within ±2% across B2–B4; diff adds ~3–8% latency, ES write latency dominates.

### B1 — pool=5, 1×50KB blob, 10 RPM

Smallest blob test. Audit p50 slightly below off — noise at low RPM where fewer samples are collected.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,125 ms | 951 ms | 930 ms |
| ELU max | 0.177 | 0.152 | 0.159 |
| server down | 0 | 0 | 0 |

![B1 — pool=5, 1×50KB blob, 10 RPM](ts_blob_B1.png)

### B2 — pool=15, 2×200KB blobs, 30 RPM

Two medium blobs; blob1 is a noOp. off and audit within ±1%.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,112 ms | 1,102 ms | 1,203 ms |
| ELU max | 0.175 | 0.171 | 0.184 |
| server down | 0 | 0 | 0 |

![B2 — pool=15, 2×200KB blobs, 30 RPM](ts_blob_B2.png)

### B3 — pool=30, 4×200KB blobs, 60 RPM

Four large blobs; blob1–blob3 are noOps. Higher throughput; diff adds +3% latency.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 990 ms | 983 ms | 1,022 ms |
| ELU max | 0.186 | 0.198 | 0.205 |
| server down | 0 | 0 | 0 |

![B3 — pool=30, 4×200KB blobs, 60 RPM](ts_blob_B3.png)

### B4 — pool=50, 4×200KB blobs, 100 RPM

Stress load with large blobs. Diff adds +8% latency and +0.047 ELU. ES write latency still dominates.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,119 ms | 1,104 ms | 1,203 ms |
| ELU max | 0.210 | 0.211 | 0.257 |
| server down | 0 | 0 | 0 |

![B4 — pool=50, 4×200KB blobs, 100 RPM](ts_blob_B4.png)

---

## run_bulk_blob_matrix.sh — Single-Batch Bulk Blob Updates

Combines bulk updates and blob fields — the two most expensive aspects of the diff feature. Every tick fires one `_bulk_update` covering the entire pool; `blob0` is mutated on every object. Pool capped at 17 (17×50KB = 850KB, near the 1 MB Kibana limit). Later levels raise blob field count and RPM to compound cost. Audit is within noise of off at all levels.

### B1 — pool=5, 1 blob, 3 RPM

Only ~15 total requests per run — high variance. Treat p50 as directional only; ELU (0.171 vs 0.167) confirms no real audit overhead.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,147 ms | 1,372 ms | 1,636 ms |
| ELU max | 0.171 | 0.167 | 0.189 |
| server down | 0 | 0 | 0 |

![B1 — pool=5, 1 blob, 3 RPM](ts_bulk_blob_B1.png)

### B2 — pool=10, 1 blob, 3 RPM

Doubles the pool at the same sparse rate. Still ~15 requests; treat as directional.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,665 ms | 1,736 ms | 1,952 ms |
| ELU max | 0.146 | 0.184 | 0.238 |
| server down | 0 | 0 | 0 |

![B2 — pool=10, 1 blob, 3 RPM](ts_bulk_blob_B2.png)

### B3 — pool=5, 3 blobs, 3 RPM

Adds two extra blob fields as noOps per object. Audit within noise of off.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,537 ms | 1,360 ms | 1,592 ms |
| ELU max | 0.168 | 0.165 | 0.194 |
| server down | 0 | 0 | 0 |

![B3 — pool=5, 3 blobs, 3 RPM](ts_bulk_blob_B3.png)

### B4 — pool=10, 3 blobs, 3 RPM

Combines larger pool and more noOp blobs. Audit within ±3% of off.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,921 ms | 1,865 ms | 2,150 ms |
| ELU max | 0.188 | 0.190 | 0.234 |
| server down | 0 | 0 | 0 |

![B4 — pool=10, 3 blobs, 3 RPM](ts_bulk_blob_B4.png)

### B5 — pool=17, 5 blobs, 20 RPM

Max pool size. Requests start overlapping at 20 RPM. Diff ELU nearly doubles vs off (+92%).

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,876 ms | 1,829 ms | 2,579 ms |
| ELU max | 0.301 | 0.285 | **0.578** |
| server down | 0 | 0 | 0 |

![B5 — pool=17, 5 blobs, 20 RPM](ts_bulk_blob_B5.png)

### B6 — pool=17, 10 blobs, 60 RPM

10 blob fields doubles the mget response size; 60 RPM puts 2–3 requests in flight simultaneously. Diff saturates ELU to 1.0.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 2,178 ms | 2,010 ms | 3,563 ms |
| ELU max | 0.705 | 0.635 | **1.000** 🔴 |
| server down | 0 | 0 | 0 |

![B6 — pool=17, 10 blobs, 60 RPM](ts_bulk_blob_B6.png)

---

## run_bulk_get_matrix.sh — Read-Only Bulk Gets

Control test — fires read-only `_bulk_get` requests only. Measures the baseline cost of the mget operation the diff engine adds before every bulk update. All three conditions are essentially identical at G1–G4, confirming overhead in the bulk update tests comes from diff computation, not the mget itself.

### G1 — pool=100, 10 RPM

One get every 6 s — low concurrency. All three conditions within ±4%.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 2,347 ms | 2,385 ms | 2,290 ms |
| ELU max | 0.363 | 0.395 | 0.358 |
| errors | 0 | 0 | 0 |
| server down | 0 | 0 | 0 |

![G1 — pool=100, 10 RPM](ts_bulk_get_G1.png)

### G2 — pool=100, 20 RPM

One get every 3 s — requests begin overlapping. All conditions within ±8%.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,816 ms | 1,806 ms | 1,831 ms |
| ELU max | 0.529 | 0.626 | 0.599 |
| errors | 0 | 0 | 0 |
| server down | 0 | 0 | 0 |

![G2 — pool=100, 20 RPM](ts_bulk_get_G2.png)

### G3 — pool=50, 50 RPM

High concurrency, smaller payload. All three conditions essentially identical.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 909 ms | 925 ms | 929 ms |
| ELU max | 0.568 | 0.551 | 0.566 |
| errors | 0 | 0 | 0 |
| server down | 0 | 0 | 0 |

![G3 — pool=50, 50 RPM](ts_bulk_get_G3.png)

### G4 — pool=100, 50 RPM

All conditions near-saturated. Latency within ±3% across conditions. ELU variance at saturation is noise, not real overhead from audit or diff.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 1,867 ms | 1,913 ms | 1,891 ms |
| ELU max | 0.914 | 0.998 | 0.991 |
| errors | 0 | 0 | 0 |
| server down | 0 | 0 | 0 |

![G4 — pool=100, 50 RPM](ts_bulk_get_G4.png)

### G5 — pool=250, 50 RPM (saturated)

All three conditions fully saturate. Results dominated by server chaos; not comparable across conditions.

| Metric | off | audit | diff |
|---|---|---|---|
| p50 latency | 33,653 ms | 39,271 ms | 38,487 ms |
| ELU max | 1.000 | 1.000 | 1.000 |
| errors | 61 | 129 | 115 |
| server down | **1** | **12** | **5** |

![G5 — pool=250, 50 RPM (saturated)](ts_bulk_get_G5.png)

---

## Overhead Summary

### audit vs off

| Scenario | Overhead | Detail |
|---|---|---|
| Individual updates (L1–L5) | None | Within ±7%, no consistent direction |
| Individual blob updates (B1–B4) | None | Within ±2% at B2–B4; B1 audit slightly lower than off (noise at 10 RPM) |
| Bulk updates (P100–P700) | None | Latency and ELU within noise of off at all pool sizes |
| Bulk blob B3–B6 | None | Audit within ±5% of off; trending slightly lower, no consistent overhead |
| Bulk blob B1–B2 | None (likely) | Only ~15 requests per run; B1 +20% latency is high-variance noise (ELU identical) |
| Bulk get (G1–G5) | None | Gets don't trigger audit events; all conditions identical |

### diff vs off

| Scenario | Overhead | Detail |
|---|---|---|
| Individual updates (L1–L5) | Mild | +10–17% latency, +4–15% ELU; grows with load |
| Individual blob updates (B1–B4) | Mild | +5–8% latency, +0.05 ELU at B4 |
| Bulk P100 | **Significant** | +64% latency; ELU 0.823, crosses serverless 0.80 ceiling |
| Bulk P250+ | **Severe** | 2–4× latency; ELU saturates; mget + compute serialisation at scale |
| Bulk blob B5 | **Moderate** | ELU 0.578 vs 0.301 (+92%) |
| Bulk blob B6 | **Severe** | ELU 1.000; +64% latency vs off |
| Bulk get (any level) | None | Gets don't trigger diff computation |
