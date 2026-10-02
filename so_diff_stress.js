#!/usr/bin/env node
/*
 * Stress test for saved object diff auditing against a deployed Kibana (serverless or ECH).
 *
 * Continuously creates, updates, and deletes large nested `index-pattern` saved objects at a
 * paced rate while polling GET /api/status for event loop utilization (ELU), event loop delay
 * (ELD), heap, and response-time counters. Open-loop pacing: requests fire on a timer whether or
 * not earlier ones finished, so an overloaded server shows up as rising latency, inflight count,
 * and errors (429/503) rather than as a quietly lower rate.
 *
 * Required env:
 *   KIBANA_URL        e.g. https://my-project.kb.us-east-1.aws.elastic.cloud
 *   KIBANA_USERNAME   user with write access to saved objects / data views
 *   KIBANA_PASSWORD
 * Auth: sends HTTP Basic first. If the server answers 401 (basic disabled for users, as on
 * some serverless deployments) it logs in via POST /internal/security/login with the `basic`
 * provider and uses the returned session cookie. Override the provider with --login-provider.
 *
 * Intensity knobs (all optional):
 *   --rpm 60            total operations per minute (creates+updates+deletes)
 *   --ramp 30,60,120    run these rpm values in sequence instead of one --rpm
 *   --step 120          seconds per ramp step (default: --duration)
 *   --duration 300      seconds to run at --rpm
 *   --mix 1:6:1         create:update:delete ratio
 *   --update-mode mix   title | nested | all | mix  (what each update changes)
 *   --pool 10           target number of live objects (creates/deletes steer toward it)
 *   --panels 800        nested panels per object (~4 leaves each; 800 ≈ 3.2k leaves, ~80 KB)
 *   --max-inflight 50   safety cap; ticks are skipped (and counted) when this is reached
 *   --poll-ms 5000      /api/status poll interval (Kibana refreshes ops metrics every 5s)
 *   --out results.json  write per-sample metrics + summary to a file
 *   --keep              leave created objects in place
 *   --yes               skip the confirmation prompt
 *   --login-provider basic   provider name/type for the session-login fallback
 *   --cleanup-only so-stress-<ts>   delete leftovers from an earlier run (by id/name prefix) and exit
 *   --bulk              bulk mode: seed via _bulk_create, update via _bulk_update (no create/delete mix during run)
 *   --batch-size 10     objects per bulk request (default: 10); RPM is object-op rate, request rate = rpm / batch-size
 *   --single-batch      single-batch mode: seed sequentially, then each tick is one _bulk_update covering the entire pool;
 *                       RPM = full-pool requests per minute; best with --update-mode title or nested (not all)
 *   --blob-fields 0     number of large string attributes to add to each object (default: 0 = no blobs)
 *   --blob-size 51200   size in bytes of each blob attribute (default: 50 KB)
 *   --update-mode blob  change blob0 on every update (same size, counter suffix) so the diff sees a replace op
 *                       and runs applyFieldSizeLimit; automatically added to mix when --blob-fields > 0.
 *                       For bulk/single-batch: blob update payload = pool/batch-size × blob-size; keep under 900KB
 *
 * Cleanup: every created id is tracked; at exit (normal or Ctrl-C) remaining ids are bulk-deleted in
 * batches with retries, then verified with _bulk_get so nothing is left behind silently.
 */
const fs = require('fs');
const readline = require('readline');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };
const K = (process.env.KIBANA_URL || '').replace(/\/$/, '');
const USERNAME = process.env.KIBANA_USERNAME || String(arg('username', '')); const PASSWORD = process.env.KIBANA_PASSWORD || String(arg('password', ''));
const LOGIN_PROVIDER = String(arg('login-provider', 'basic'));
if (!K || !USERNAME || !PASSWORD) { console.error('Set KIBANA_URL, KIBANA_USERNAME and KIBANA_PASSWORD. See header for details.'); process.exit(2); }
const RPM = Number(arg('rpm', 60)); const RAMP = arg('ramp', '') ? String(arg('ramp', '')).split(',').map(Number) : null;
const DURATION = Number(arg('duration', 300)); const STEP = Number(arg('step', DURATION));
const [W_CREATE, W_UPDATE, W_DELETE] = String(arg('mix', '1:6:1')).split(':').map(Number);
const UPDATE_MODE = String(arg('update-mode', 'mix')); const POOL = Number(arg('pool', 10)); const PANELS = Number(arg('panels', 800));
const MAX_INFLIGHT = Number(arg('max-inflight', 50)); const POLL_MS = Number(arg('poll-ms', 5000)); const OUT = arg('out', ''); const KEEP = arg('keep', false) === true; const YES = arg('yes', false) === true;
const TYPE = String(arg('so-type', 'index-pattern')); const RUN = `so-stress-${Date.now()}`;
const BULK = arg('bulk', false) === true;
const BATCH_SIZE = Number(arg('batch-size', 10));
const SINGLE_BATCH = arg('single-batch', false) === true;
const BLOB_FIELDS = Number(arg('blob-fields', 0));
const BLOB_SIZE = Number(arg('blob-size', 51200)); // 50 KB default

let sessionCookie; // set after a successful login fallback
const headers = () => ({
  ...(sessionCookie ? { cookie: sessionCookie } : { authorization: `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}` }),
  'kbn-xsrf': 'true',
  // Saved objects HTTP APIs are internal on serverless; this header is required there and harmless elsewhere.
  'x-elastic-internal-origin': 'kibana',
  'content-type': 'application/json',
});
// Basic auth rejected: obtain a session cookie through Kibana's login endpoint instead.
const loginForSession = async () => {
  const r = await fetch(`${K}/internal/security/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ providerType: LOGIN_PROVIDER, providerName: LOGIN_PROVIDER, currentURL: `${K}/login`, params: { username: USERNAME, password: PASSWORD } }), redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const setCookie = r.headers.get('set-cookie') || '';
  const sid = setCookie.split(/,(?=\s*\w+=)/).map((c) => c.split(';')[0].trim()).find((c) => c.startsWith('sid='));
  if (!r.ok || !sid) throw new Error(`login via provider "${LOGIN_PROVIDER}" failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  sessionCookie = sid;
};
const api = async (method, path, body) => {
  const t0 = performance.now();
  try {
    const r = await fetch(`${K}${path}`, { method, headers: headers(), body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { ok: r.ok, status: r.status, body: json, ms: performance.now() - t0 };
  } catch (e) { return { ok: false, status: 0, body: String(e), ms: performance.now() - t0 }; }
};
const buildNested = (title, n, salt = '') => { const panels = {}; for (let i = 0; i < n; i++) panels[`p${i}`] = { title: `Panel ${i}${salt}`, vis: { type: 'histogram', params: { buckets: i, label: `bucket-${i}${salt}` } } }; return { title, name: title, panels }; };
// Pre-computed blob attributes. Using a repeating pattern string — realistic in size, fast to generate.
// The same content is used across all objects so only the diff comparison cost is tested, not allocation.
const blobAttrs = BLOB_FIELDS > 0 ? Object.fromEntries(Array.from({ length: BLOB_FIELDS }, (_, i) => [`blob${i}`, 'A'.repeat(BLOB_SIZE)])) : {};
const buildAttrs = (title, n, salt = '') => BLOB_FIELDS > 0 ? { ...buildNested(title, n, salt), ...blobAttrs } : buildNested(title, n, salt);
const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const MB = (b) => (b / 1048576).toFixed(0); const f = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '  -');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readStatus = async () => {
  const r = await api('GET', '/api/status');
  const b = r.ok && typeof r.body === 'object' ? r.body : {}; const p = b.metrics?.process ?? {};
  return { http: r.status, ms: r.ms, level: b.status?.overall?.level ?? (r.ok ? '?' : `HTTP ${r.status}`), hasMetrics: !!b.metrics,
    elu: p.event_loop_utilization?.utilization ?? NaN, eld: p.event_loop_delay ?? NaN, eldP99: p.event_loop_delay_histogram?.percentiles?.['99'] ?? NaN,
    heap: p.memory?.heap?.used_in_bytes ?? NaN, heapLimit: p.memory?.heap?.size_limit ?? NaN, rss: p.memory?.resident_set_size_in_bytes ?? NaN,
    respAvg: b.metrics?.response_times?.avg_in_millis ?? NaN, respMax: b.metrics?.response_times?.max_in_millis ?? NaN, reqTotal: b.metrics?.requests?.total ?? NaN };
};

// Deletes the given ids in batches, retrying transient failures, then verifies with _bulk_get.
const cleanup = async (ids) => {
  if (!ids.length) { console.log('cleanup: nothing to delete'); return { requested: 0, verifiedDeleted: 0, remaining: [] }; }
  let remaining = [...new Set(ids)];
  for (let attempt = 1; attempt <= 5 && remaining.length; attempt++) {
    const failed = [];
    for (let i = 0; i < remaining.length; i += 100) {
      const batch = remaining.slice(i, i + 100);
      const r = await api('POST', '/api/saved_objects/_bulk_delete?force=true', batch.map((id) => ({ type: TYPE, id })));
      if (!r.ok) { failed.push(...batch); continue; }
      for (const st of r.body?.statuses ?? []) if (!st.success && st.error?.statusCode !== 404) failed.push(st.id);
    }
    // Verify: anything _bulk_get still finds is retried.
    const stillThere = [];
    const check = remaining.filter((id) => !failed.includes(id));
    for (let i = 0; i < check.length; i += 100) {
      const r = await api('POST', '/api/saved_objects/_bulk_get', check.slice(i, i + 100).map((id) => ({ type: TYPE, id })));
      for (const so of r.body?.saved_objects ?? []) if (!so.error) stillThere.push(so.id);
    }
    remaining = [...new Set([...failed, ...stillThere])];
    if (remaining.length) { console.log(`cleanup attempt ${attempt}: ${remaining.length} objects still present, retrying...`); await sleep(2000 * attempt); }
  }
  if (remaining.length) console.log(`cleanup INCOMPLETE: ${remaining.length} objects remain, e.g. ${remaining.slice(0, 3).join(', ')}. Re-run with --cleanup-only ${RUN}`);
  else console.log(`cleanup: verified ${ids.length} objects deleted`);
  return { requested: ids.length, verifiedDeleted: ids.length - remaining.length, remaining };
};
// Finds objects of an earlier run by name/title prefix (all modes keep the run prefix) and deletes them.
const cleanupByPrefix = async (prefix) => {
  const ids = new Set(); let page = 1;
  for (;;) {
    const r = await api('GET', `/api/saved_objects/_find?type=${TYPE}&search_fields=name&search_fields=title&search=${encodeURIComponent(prefix + '*')}&per_page=1000&page=${page}&fields=title`);
    if (!r.ok) { console.error(`find failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); process.exit(1); }
    const hits = (r.body.saved_objects ?? []).filter((so) => so.id.startsWith(prefix));
    hits.forEach((so) => ids.add(so.id));
    if ((r.body.saved_objects ?? []).length < 1000) break; page++;
  }
  console.log(`found ${ids.size} objects with prefix ${prefix}`);
  await cleanup([...ids]);
};
let createdRef = null; let cleaningUp = false;
process.on('SIGINT', async () => {
  if (cleaningUp) process.exit(130);
  cleaningUp = true;
  console.log(`\ninterrupted: ${KEEP ? 'leaving objects in place (--keep)' : `cleaning up ${createdRef?.size ?? 0} objects before exit`}`);
  if (!KEEP && createdRef) await cleanup([...createdRef]);
  process.exit(130);
});

(async () => {
  if (arg('cleanup-only', '')) {
    const prefix = String(arg('cleanup-only', ''));
    const probe = await api('GET', `/api/saved_objects/_find?type=${TYPE}&per_page=1`);
    if (probe.status === 401) await loginForSession();
    await cleanupByPrefix(prefix); return;
  }
  const plan = RAMP ? RAMP.map((r) => ({ rpm: r, seconds: STEP })) : [{ rpm: RPM, seconds: DURATION }];
  const totalOps = plan.reduce((a, s) => a + s.rpm * s.seconds / 60, 0);
  console.log(`target: ${K}`); console.log(`run:    ${RUN}`);
  const modeLabel = UPDATE_MODE === 'get' ? `mode=BULK-GET (${SINGLE_BATCH ? POOL : BATCH_SIZE} objects/request)` : SINGLE_BATCH ? `mode=SINGLE-BATCH (${POOL} objects/request)  updates=${UPDATE_MODE}` : BULK ? `mode=BULK  batch-size=${BATCH_SIZE}  updates=${UPDATE_MODE}` : `mix c:u:d=${W_CREATE}:${W_UPDATE}:${W_DELETE}  updates=${UPDATE_MODE}`;
  const approxAttrsBytes = Buffer.byteLength(JSON.stringify(buildAttrs('x', PANELS)));
  const blobLabel = BLOB_FIELDS > 0 ? `  blobs=${BLOB_FIELDS}x${(BLOB_SIZE / 1024).toFixed(0)}KB` : '';
  console.log(`plan:   ${plan.map((s) => `${s.rpm} rpm x ${s.seconds}s`).join(' -> ')}  (~${Math.round(totalOps)} ops)  ${modeLabel}  pool=${POOL}  panels=${PANELS}${blobLabel}  (~${(approxAttrsBytes / 1024).toFixed(0)} KB each)`);
  if (SINGLE_BATCH && (UPDATE_MODE === 'all' || UPDATE_MODE === 'mix')) console.warn(`warning: --single-batch with update-mode=${UPDATE_MODE} will send full objects per tick; a pool of ${POOL} x ~${(approxAttrsBytes / 1024).toFixed(0)}KB may exceed the 1MB limit. Use --update-mode title or nested.`);
  if (BLOB_FIELDS > 0 && BLOB_FIELDS * BLOB_SIZE > 700000) console.warn(`warning: blob payload ~${((BLOB_FIELDS * BLOB_SIZE) / 1024).toFixed(0)}KB per object may approach or exceed the 1MB request limit on creates. Reduce --blob-fields or --blob-size if you see 413 errors during seeding.`);
  if (BLOB_FIELDS > 0 && (BULK || SINGLE_BATCH) && (UPDATE_MODE === 'blob' || UPDATE_MODE === 'mix')) { const blobUpdatePayload = (SINGLE_BATCH ? POOL : BATCH_SIZE) * BLOB_SIZE; if (blobUpdatePayload > 900000) console.warn(`warning: blob update payload ~${(blobUpdatePayload / 1024).toFixed(0)}KB (${SINGLE_BATCH ? POOL : BATCH_SIZE} objects x ${(BLOB_SIZE / 1024).toFixed(0)}KB blob) will likely 413. Reduce --blob-size to ~${Math.floor(900000 / (SINGLE_BATCH ? POOL : BATCH_SIZE) / 1024)}KB or --pool/--batch-size.`); }

  // Preflight: auth + API reachability + status endpoint capability.
  let find = await api('GET', `/api/saved_objects/_find?type=${TYPE}&per_page=1`);
  if (find.status === 401) {
    console.log('basic auth rejected (401); logging in for a session cookie instead...');
    try { await loginForSession(); } catch (e) { console.error(`\nPreflight failed: ${e.message}`); process.exit(1); }
    find = await api('GET', `/api/saved_objects/_find?type=${TYPE}&per_page=1`);
  }
  if (!find.ok) { console.error(`\nPreflight failed: GET _find -> HTTP ${find.status}: ${JSON.stringify(find.body).slice(0, 300)}\nCheck KIBANA_URL and that the user can write data views / saved objects.`); process.exit(1); }
  console.log(`auth: ${sessionCookie ? 'session cookie (login fallback)' : 'HTTP Basic'} as ${USERNAME}`);
  const st = await readStatus();
  console.log(`status endpoint: HTTP ${st.http} level=${st.level} metrics=${st.hasMetrics ? 'available' : 'NOT exposed (will monitor HTTP health + client latency only)'}${st.hasMetrics ? ` ELU=${f(st.elu, 2)} ELD=${f(st.eld)}ms heap=${MB(st.heap)}/${MB(st.heapLimit)}MB` : ''}`);
  if (!YES) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const a = await new Promise((res) => rl.question(`\nThis will write ~${Math.round(totalOps)} saved object operations to ${K}. Continue? [y/N] `, res)); rl.close(); if (!/^y(es)?$/i.test(a.trim())) { console.log('aborted'); process.exit(0); } }

  // Seed the pool.
  const pool = []; let seq = 0;
  const newId = () => `${RUN}-${seq++}`;
  if (SINGLE_BATCH) {
    // Single-batch mode: seed one at a time — no payload limit concern, and the pool must be exact.
    const logEvery = Math.max(1, Math.floor(POOL / 10));
    for (let i = 0; i < POOL; i++) {
      const id = newId(); const r = await api('POST', `/api/saved_objects/${TYPE}/${id}?overwrite=true`, { attributes: buildAttrs(id, PANELS) });
      if (!r.ok) { console.error(`seed create failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); process.exit(1); }
      pool.push(id);
      if ((i + 1) % logEvery === 0 || i + 1 === POOL) process.stdout.write(`  seeding: ${i + 1}/${POOL} objects created\n`);
    }
  } else if (BULK) {
    // Cap seed batch size so one request never exceeds ~900 KB (Kibana limit is 1 MB).
    // Update batch size (BATCH_SIZE) can be larger because partial-attribute updates are tiny.
    const seedBatchSize = Math.max(1, Math.floor(900000 / approxAttrsBytes));
    console.log(`bulk seed: object size ~${Math.round(approxAttrsBytes / 1024)}KB → seed batch size capped at ${seedBatchSize} (update batch size=${BATCH_SIZE})`);
    for (let i = 0; i < POOL; i += seedBatchSize) {
      const items = [];
      for (let j = i; j < Math.min(i + seedBatchSize, POOL); j++) {
        const id = newId(); pool.push(id);
        items.push({ type: TYPE, id, attributes: buildAttrs(id, PANELS) });
      }
      const r = await api('POST', '/api/saved_objects/_bulk_create?overwrite=true', items);
      if (!r.ok) { console.error(`bulk seed failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); process.exit(1); }
      const failed = (r.body?.saved_objects ?? []).filter((so) => so.error);
      if (failed.length) { console.error(`bulk seed error in batch: ${JSON.stringify(failed[0])}`); process.exit(1); }
    }
  } else {
    for (let i = 0; i < POOL; i++) { const id = newId(); const r = await api('POST', `/api/saved_objects/${TYPE}/${id}?overwrite=true`, { attributes: buildAttrs(id, PANELS) }); if (!r.ok) { console.error(`seed create failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); process.exit(1); } pool.push(id); }
  }
  console.log(`seeded ${pool.length} objects\n`);

  // Monitoring.
  const samples = []; let polling = true; let inflight = 0; const created = new Set(pool); createdRef = created; const lat = { create: [], update: [], delete: [] }; const errs = { create: [], update: [], delete: [] }; const codes = {}; let skippedTicks = 0; let currentRpm = plan[0].rpm;
  const alerts = [];
  console.log('    t   rpm  status      ELU  ELDmax  ELDp99  heapMB  kbn avg  kbn max  inflight  ok/err(5s)  p95ms(5s)');
  let win = { ok: 0, err: 0, lat: [] };
  const poller = (async () => {
    const t0 = Date.now();
    while (polling) {
      const s = await readStatus(); s.t = (Date.now() - t0) / 1000; s.rpm = currentRpm; s.inflight = inflight; s.winOk = win.ok; s.winErr = win.err; s.winP95 = q(win.lat, 0.95); samples.push(s);
      const flag = (s.level !== 'available' && s.level !== '?') ? ' <-- STATUS' : (s.elu > 0.8 ? ' <-- ELU>0.8' : (s.winErr > 0 ? ' <-- errors' : ''));
      if (flag) alerts.push({ t: s.t, level: s.level, elu: s.elu, errors: s.winErr });
      console.log(`${f(s.t).padStart(5)}s ${String(currentRpm).padStart(5)}  ${String(s.level).padEnd(9)} ${f(s.elu, 2).padStart(6)} ${f(s.eld).padStart(7)} ${f(s.eldP99).padStart(7)} ${MB(s.heap).padStart(7)} ${f(s.respAvg).padStart(8)} ${f(s.respMax).padStart(8)} ${String(inflight).padStart(9)} ${`${win.ok}/${win.err}`.padStart(11)} ${f(s.winP95).padStart(10)}${flag}`);
      win = { ok: 0, err: 0, lat: [] };
      await sleep(POLL_MS);
    }
  })();

  // Operation chooser: weighted mix, steered so the pool stays near --pool.
  const pick = () => {
    let wc = W_CREATE, wu = W_UPDATE, wd = W_DELETE;
    if (pool.length < Math.max(1, POOL / 2)) { wd = 0; wc = Math.max(wc, 1); }
    if (pool.length > POOL * 2) { wc = 0; wd = Math.max(wd, 1); }
    if (pool.length === 0) return 'create';
    const r = Math.random() * (wc + wu + wd); return r < wc ? 'create' : r < wc + wu ? 'update' : 'delete';
  };
  // 'blob' mode: sends a same-size blob with a counter suffix so the diff sees a replace op,
  // triggering applyFieldSizeLimit and the full emit path. Only included in mix when blob fields exist.
  const makeBlobUpdate = (seq) => { const suffix = String(seq).padStart(12, '0'); return 'A'.repeat(Math.max(0, BLOB_SIZE - suffix.length)) + suffix; };
  const modes = UPDATE_MODE === 'mix' ? ['title', 'nested', 'all', ...(BLOB_FIELDS > 0 ? ['blob'] : [])] : [UPDATE_MODE];
  let opIndex = 0;
  const fire = () => {
    if (inflight >= MAX_INFLIGHT) { skippedTicks++; return; }
    const op = pick(); const i = opIndex++; inflight++;
    let p;
    if (op === 'create') { const id = newId(); created.add(id); p = api('POST', `/api/saved_objects/${TYPE}/${id}`, { attributes: buildAttrs(id, PANELS) }).then((r) => { if (r.ok) pool.push(id); return r; }); }
    else if (op === 'update') { const id = pool[Math.floor(Math.random() * pool.length)]; const mode = modes[i % modes.length]; const attributes = mode === 'title' ? { title: `${id}-t${i}` } : mode === 'nested' ? { panels: { [`p${i % PANELS}`]: { vis: { params: { label: `changed-${i}` } } } } } : mode === 'blob' ? { blob0: makeBlobUpdate(i) } : buildAttrs(`${id}-all${i}`, PANELS, `-s${i}`); p = api('PUT', `/api/saved_objects/${TYPE}/${id}`, { attributes }); }
    else { const idx = Math.floor(Math.random() * pool.length); const [id] = pool.splice(idx, 1); p = api('DELETE', `/api/saved_objects/${TYPE}/${id}?force=true`).then((r) => { if (r.ok) created.delete(id); else pool.push(id); return r; }); }
    p.then((r) => { inflight--; codes[r.status] = (codes[r.status] || 0) + 1; if (r.ok) { lat[op].push(r.ms); win.ok++; win.lat.push(r.ms); } else { errs[op].push({ status: r.status, body: JSON.stringify(r.body).slice(0, 160) }); win.err++; } });
  };

  // Bulk update: one _bulk_update request per tick.
  // SINGLE_BATCH: covers every object in the pool; RPM = full-pool requests/min.
  // BULK: covers BATCH_SIZE random objects; RPM = object-op rate.
  let bulkObjectOps = 0;
  const fireBulk = () => {
    if (inflight >= MAX_INFLIGHT) { skippedTicks++; return; }
    if (pool.length === 0) { skippedTicks++; return; }
    const i = opIndex++; inflight++;
    const mode = modes[i % modes.length];
    // Single-batch: update every pool object in one request (deterministic, no duplicates).
    // Bulk: pick batch-size random objects (with replacement).
    const ids = SINGLE_BATCH ? [...pool] : Array.from({ length: Math.min(BATCH_SIZE, pool.length) }, () => pool[Math.floor(Math.random() * pool.length)]);
    const updates = ids.map((id, j) => {
      const attributes = mode === 'title' ? { title: `${id}-t${i}` }
        : mode === 'nested' ? { panels: { [`p${(i + j) % PANELS}`]: { vis: { params: { label: `changed-${i}-${j}` } } } } }
        : mode === 'blob' ? { blob0: makeBlobUpdate(i * 1000 + j) }
        : buildAttrs(`${id}-all${i}`, PANELS, `-s${i}-${j}`);
      return { type: TYPE, id, attributes };
    });
    api('PUT', '/api/saved_objects/_bulk_update', updates).then((r) => {
      inflight--;
      codes[r.status] = (codes[r.status] || 0) + 1;
      if (r.ok) {
        const ok = (r.body?.saved_objects ?? []).filter((so) => !so.error).length || ids.length;
        bulkObjectOps += ok;
        lat.update.push(r.ms); win.ok++; win.lat.push(r.ms);
      } else {
        errs.update.push({ status: r.status, body: JSON.stringify(r.body).slice(0, 160) }); win.err++;
      }
    });
  };

  // Bulk get: one _bulk_get request per tick (read-only; measures raw mget cost).
  // Use with --single-batch (covers pool) or --bulk (covers batch-size random objects).
  const fireGet = () => {
    if (inflight >= MAX_INFLIGHT) { skippedTicks++; return; }
    if (pool.length === 0) { skippedTicks++; return; }
    inflight++;
    const ids = SINGLE_BATCH ? [...pool] : Array.from({ length: Math.min(BATCH_SIZE, pool.length) }, () => pool[Math.floor(Math.random() * pool.length)]);
    api('POST', '/api/saved_objects/_bulk_get', ids.map((id) => ({ type: TYPE, id }))).then((r) => {
      inflight--;
      codes[r.status] = (codes[r.status] || 0) + 1;
      if (r.ok) { bulkObjectOps += ids.length; lat.update.push(r.ms); win.ok++; win.lat.push(r.ms); }
      else { errs.update.push({ status: r.status, body: JSON.stringify(r.body).slice(0, 160) }); win.err++; }
    });
  };

  const tStart = Date.now();
  for (const step of plan) {
    currentRpm = step.rpm;
    // single-batch: rpm = full-pool requests/min; bulk: rpm = object-ops/min (request rate = rpm/batch-size)
    const interval = SINGLE_BATCH ? 60000 / step.rpm : BULK ? BATCH_SIZE * 60000 / step.rpm : 60000 / step.rpm;
    const end = Date.now() + step.seconds * 1000;
    await new Promise((resolve) => { const timer = setInterval(() => { if (Date.now() >= end) { clearInterval(timer); resolve(); return; } if (UPDATE_MODE === 'get') fireGet(); else if (SINGLE_BATCH || BULK) fireBulk(); else fire(); }, interval); });
  }
  const drainDeadline = Date.now() + 300000; while (inflight > 0 && Date.now() < drainDeadline) await sleep(250);
  if (inflight > 0) console.log(`warning: ${inflight} requests still in flight after 5 minutes; cleanup will run anyway and verify`);
  await sleep(POLL_MS); polling = false; await poller;
  const elapsed = (Date.now() - tStart) / 1000;

  // Summary.
  const elus = samples.map((s) => s.elu).filter(Number.isFinite); const elds = samples.map((s) => s.eld).filter(Number.isFinite);
  const allOk = Object.values(lat).reduce((a, l) => a + l.length, 0); const allErr = Object.values(errs).reduce((a, l) => a + l.length, 0);
  // Object accounting: seeded + created-during-run - deleted-during-run should equal what cleanup removes.
  const aliveAtEnd = created.size;
  const cleanupResult = KEEP ? null : await cleanup([...created]);
  const summaryLines = []; const say = (line) => { summaryLines.push(line); console.log(line); };
  say('\n==================== SUMMARY ====================');
  say(`ops: ${allOk + allErr} completed in ${f(elapsed)}s (${f((allOk + allErr) / elapsed * 60, 1)} rpm achieved), ok=${allOk} errors=${allErr}, ticks skipped at max-inflight=${skippedTicks}, still inflight=${inflight}`);
  say(`http codes: ${JSON.stringify(codes)}`);
  for (const op of ['create', 'update', 'delete']) if (lat[op].length || errs[op].length) { const bulkNote = op === 'update' && (BULK || SINGLE_BATCH) ? `  [${bulkObjectOps} object-ops in ${lat.update.length} bulk requests, ${SINGLE_BATCH ? `pool=${POOL}` : `batch-size=${BATCH_SIZE}`} objects/request]` : ''; say(`  ${op.padEnd(7)} n=${String(lat[op].length).padStart(5)}  p50=${f(q(lat[op], 0.5))}ms  p95=${f(q(lat[op], 0.95))}ms  max=${f(Math.max(0, ...lat[op]))}ms  errors=${errs[op].length}${bulkNote}`); }
  say(`objects: seeded=${POOL}  created during run=${lat.create.length}  deleted during run=${lat.delete.length}  alive at end of load=${aliveAtEnd}  ${cleanupResult ? `cleanup deleted=${cleanupResult.verifiedDeleted} (verified)  remaining=${cleanupResult.remaining.length}` : 'cleanup skipped (--keep)'}`);
  if (aliveAtEnd !== POOL + lat.create.length - lat.delete.length) say(`  note: alive-at-end differs from seeded+created-deleted by ${aliveAtEnd - (POOL + lat.create.length - lat.delete.length)}; this happens when a create or delete request failed (see errors).`);
  if (elus.length) { say(`ELU:  mean=${f(elus.reduce((a, b) => a + b, 0) / elus.length, 2)}  p95=${f(q(elus, 0.95), 2)}  max=${f(Math.max(...elus), 2)}   (ceiling 0.80)`); say(`ELD:  median-of-max=${f(q(elds, 0.5))}ms  max=${f(Math.max(...elds))}ms`); say(`heap: peak=${MB(Math.max(...samples.map((s) => s.heap).filter(Number.isFinite)))}MB of ${MB(samples.find((s) => Number.isFinite(s.heapLimit))?.heapLimit ?? NaN)}MB`); }
  else say('ELU/ELD: not available (status endpoint did not expose process metrics for this key)');
  const statusBad = samples.filter((s) => s.level !== 'available' && s.level !== '?');
  say(`status: ${statusBad.length ? `${statusBad.length} of ${samples.length} polls NOT available (first at ${f(statusBad[0].t)}s: ${statusBad[0].level})` : `available in all ${samples.length} polls`}; status endpoint latency p95=${f(q(samples.map((s) => s.ms), 0.95))}ms`);
  if (alerts.length) say(`alerts: ${alerts.length} (first: ${JSON.stringify(alerts[0])})`);
  const firstErrs = Object.entries(errs).flatMap(([op, l]) => l.slice(0, 2).map((e) => ({ op, ...e }))); if (firstErrs.length) say(`sample errors: ${JSON.stringify(firstErrs)}`);
  if (OUT) {
    const pct = (a, x) => (a.length ? q(a, x) : null);
    const summary = {
      startedAt: new Date(tStart).toISOString(), finishedAt: new Date().toISOString(), elapsedSeconds: elapsed,
      opsCompleted: allOk + allErr, opsOk: allOk, opsErrors: allErr, rpmAchieved: (allOk + allErr) / elapsed * 60, skippedTicks, stillInflight: inflight, httpCodes: codes,
      latencyMs: Object.fromEntries(['create', 'update', 'delete'].map((op) => [op, { n: lat[op].length, p50: pct(lat[op], 0.5), p95: pct(lat[op], 0.95), max: lat[op].length ? Math.max(...lat[op]) : null, errors: errs[op].length, ...((BULK || SINGLE_BATCH) && op === 'update' ? { bulkObjectOps, bulkRequests: lat.update.length, ...(SINGLE_BATCH ? { poolSize: POOL } : { batchSize: BATCH_SIZE }) } : {}) }])),
      elu: elus.length ? { mean: elus.reduce((a, b) => a + b, 0) / elus.length, p95: q(elus, 0.95), max: Math.max(...elus), ceiling: 0.8 } : null,
      eldMs: elds.length ? { medianOfMax: q(elds, 0.5), max: Math.max(...elds) } : null,
      heapPeakBytes: samples.map((s) => s.heap).filter(Number.isFinite).length ? Math.max(...samples.map((s) => s.heap).filter(Number.isFinite)) : null,
      statusPolls: samples.length, statusNotAvailablePolls: statusBad.length, alerts,
      objects: { seeded: POOL, createdDuringRun: lat.create.length, deletedDuringRun: lat.delete.length, aliveAtEndOfLoad: aliveAtEnd, cleanupDeleted: cleanupResult?.verifiedDeleted ?? null, cleanupRemaining: cleanupResult?.remaining ?? null, kept: KEEP },
    };
    const config = {
      target: K, run: RUN, username: USERNAME, authMode: sessionCookie ? 'session-cookie' : 'basic', loginProvider: LOGIN_PROVIDER,
      rpm: RAMP ? null : RPM, ramp: RAMP, stepSeconds: RAMP ? STEP : null, durationSeconds: RAMP ? null : DURATION, plan,
      singleBatch: SINGLE_BATCH, bulk: BULK, batchSize: BULK ? BATCH_SIZE : null, mix: (BULK || SINGLE_BATCH) ? null : { create: W_CREATE, update: W_UPDATE, delete: W_DELETE }, updateMode: UPDATE_MODE, pool: POOL, panels: PANELS,
      approxObjectBytes: approxAttrsBytes, blobFields: BLOB_FIELDS, blobSize: BLOB_FIELDS > 0 ? BLOB_SIZE : null, maxInflight: MAX_INFLIGHT, pollMs: POLL_MS, keep: KEEP,
      argv: process.argv.slice(2).filter((a, i, arr) => !(arr[i - 1] === '--password')),
    };
    fs.writeFileSync(OUT, JSON.stringify({ config, summary, summaryText: summaryLines.map((l) => l.replace(/^\n/, '')), samples, latency: lat, errors: errs }, null, 2));
    console.log(`wrote ${OUT}`);
  }

  if (KEEP) console.log(`kept ${created.size} objects with id prefix ${RUN}`);
})().catch((e) => { console.error(e); process.exit(1); });
