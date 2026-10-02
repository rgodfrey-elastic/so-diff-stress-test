#!/usr/bin/env node
/*
 * Paced load generator for saved object diff auditing under a CPU quota.
 * Creates N large nested index-patterns, then issues updates at a fixed rate (open loop, so
 * saturation shows up as growing latency rather than a lower rate) while polling /api/status
 * for event loop utilization (ELU, per 5s interval), event loop delay (ELD, max per interval),
 * and Kibana's own response-time counters.
 *
 * Usage: node so_diff_elu_load.js --rpm 50 --duration 120 [--objects 5] [--panels 800]
 *        [--mode title|nested|all|mix] [--poll-ms 5000] [--keep]
 * Env:   KIBANA_URL (default http://localhost:5620), KIBANA_USERNAME / KIBANA_PASSWORD (default elastic_serverless / changeme)
 */
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); if (i === -1) return d; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };
const RPM = Number(arg('rpm', 50)), DURATION = Number(arg('duration', 120)), OBJECTS = Number(arg('objects', 5));
const PANELS = Number(arg('panels', 800)), MODE = String(arg('mode', 'mix')), POLL_MS = Number(arg('poll-ms', 5000)), KEEP = arg('keep', false) === true;
const K = process.env.KIBANA_URL || 'http://localhost:5620', AUTH = `${process.env.KIBANA_USERNAME || 'elastic_serverless'}:${process.env.KIBANA_PASSWORD || 'changeme'}`;
const TYPE = 'index-pattern', RUN = `elu-${Date.now()}`;
const headers = { authorization: `Basic ${Buffer.from(AUTH).toString('base64')}`, 'kbn-xsrf': 'true', 'x-elastic-internal-origin': 'kibana', 'content-type': 'application/json' };
const api = async (method, path, body) => { const t0 = performance.now(); const r = await fetch(`${K}${path}`, { method, headers, body: body && JSON.stringify(body) }); const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { ok: r.ok, status: r.status, body: json, ms: performance.now() - t0 }; };
const buildNested = (title, n, salt = '') => { const panels = {}; for (let i = 0; i < n; i++) panels[`p${i}`] = { title: `Panel ${i}${salt}`, vis: { type: 'histogram', params: { buckets: i, label: `bucket-${i}${salt}` } } }; return { title, name: title, panels }; };
const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const MB = (b) => (b / 1048576).toFixed(0);
const status = async () => { const { body } = await api('GET', '/api/status'); const p = body?.metrics?.process ?? {}; return { level: body?.status?.overall?.level ?? '?', elu: p.event_loop_utilization?.utilization ?? NaN, eld: p.event_loop_delay ?? NaN, eldP99: p.event_loop_delay_histogram?.percentiles?.['99'] ?? NaN, heap: p.memory?.heap?.used_in_bytes ?? 0, rss: p.memory?.resident_set_size_in_bytes ?? 0, respAvg: body?.metrics?.response_times?.avg_in_millis ?? NaN, respMax: body?.metrics?.response_times?.max_in_millis ?? NaN }; };

(async () => {
  console.log(`${K} run=${RUN} objects=${OBJECTS} panels=${PANELS} rpm=${RPM} duration=${DURATION}s mode=${MODE}`);
  const base = await status();
  console.log(`baseline: status=${base.level} ELU=${base.elu.toFixed(2)} ELD=${base.eld.toFixed(0)}ms heap=${MB(base.heap)}MB\n`);
  const ids = [];
  for (let i = 0; i < OBJECTS; i++) { const id = `${RUN}-${i}`; const r = await api('POST', `/api/saved_objects/${TYPE}/${id}?overwrite=true`, { attributes: buildNested(id, PANELS) }); if (!r.ok) { console.error(`create failed ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`); process.exit(1); } ids.push(id); }
  console.log(`created ${ids.length} objects (${(Buffer.byteLength(JSON.stringify(buildNested('x', PANELS))) / 1024).toFixed(0)} KB attrs each)\n`);
  const samples = []; let polling = true;
  console.log('   t    status      ELU    ELD max  ELD p99  heap MB  resp avg  resp max  inflight');
  let inflight = 0;
  const poller = (async () => { const t0 = Date.now(); while (polling) { try { const s = await status(); samples.push(s); console.log(`${String(((Date.now() - t0) / 1000).toFixed(0)).padStart(4)}s  ${s.level.padEnd(9)} ${s.elu.toFixed(2).padStart(6)} ${s.eld.toFixed(0).padStart(9)} ${s.eldP99.toFixed(0).padStart(8)} ${MB(s.heap).padStart(8)} ${s.respAvg.toFixed(0).padStart(9)} ${s.respMax.toFixed(0).padStart(9)} ${String(inflight).padStart(9)}`); } catch (e) { console.log(`   status poll failed: ${e.message}`); } await new Promise((r) => setTimeout(r, POLL_MS)); } })();
  const modes = MODE === 'mix' ? ['title', 'nested', 'all'] : [MODE]; const lat = []; const errors = []; let sent = 0; const interval = 60000 / RPM; const tStart = Date.now();
  const fire = (i) => { const id = ids[i % ids.length]; const mode = modes[i % modes.length]; const attributes = mode === 'title' ? { title: `${id}-t${i}` } : mode === 'nested' ? { panels: { [`p${i % PANELS}`]: { vis: { params: { label: `changed-${i}` } } } } } : buildNested(`${id}-all${i}`, PANELS, `-s${i}`); inflight++; api('PUT', `/api/saved_objects/${TYPE}/${id}`, { attributes }).then((r) => { inflight--; if (r.ok) lat.push(r.ms); else errors.push({ i, status: r.status, body: JSON.stringify(r.body).slice(0, 120) }); }).catch((e) => { inflight--; errors.push({ i, status: 0, body: e.message }); }); };
  await new Promise((resolve) => { const timer = setInterval(() => { if (Date.now() - tStart >= DURATION * 1000) { clearInterval(timer); resolve(); return; } fire(sent++); }, interval); });
  const drainDeadline = Date.now() + 60000; while (inflight > 0 && Date.now() < drainDeadline) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, POLL_MS)); polling = false; await poller;
  const elus = samples.map((s) => s.elu).filter((x) => !isNaN(x)); const elds = samples.map((s) => s.eld).filter((x) => !isNaN(x));
  console.log('\n==================== SUMMARY ====================');
  console.log(`sent ${sent} updates in ${DURATION}s (${(sent / DURATION * 60).toFixed(1)} rpm target ${RPM}); ok=${lat.length} errors=${errors.length} still inflight=${inflight}`);
  console.log(`update latency: p50=${q(lat, 0.5).toFixed(0)}ms  p95=${q(lat, 0.95).toFixed(0)}ms  max=${Math.max(0, ...lat).toFixed(0)}ms`);
  console.log(`ELU: mean=${(elus.reduce((a, b) => a + b, 0) / (elus.length || 1)).toFixed(2)}  p95=${q(elus, 0.95).toFixed(2)}  max=${Math.max(0, ...elus).toFixed(2)}   (Rudolf's ceiling: 0.80)`);
  console.log(`ELD max: median=${q(elds, 0.5).toFixed(0)}ms  max=${Math.max(0, ...elds).toFixed(0)}ms`);
  console.log(`heap peak=${MB(Math.max(0, ...samples.map((s) => s.heap)))}MB  status: ${samples.every((s) => s.level === 'available') ? 'available throughout' : 'DEGRADED at some point'}`);
  if (errors.length) console.log(`first errors: ${JSON.stringify(errors.slice(0, 3))}`);
  if (!KEEP) { await api('POST', '/api/saved_objects/_bulk_delete?force=true', ids.map((id) => ({ type: TYPE, id }))); console.log('cleanup: objects deleted'); }
})().catch((e) => { console.error(e); process.exit(1); });
