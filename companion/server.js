#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import { bearerToken, ipAllowed, newToken, requireLongToken, timingEqual, tokenHash } from './auth.js';
import { COMMAND_TYPES, ackCommand, buildAssignments, finishCommand, leaseNextCommand } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = Object.fromEntries(argv.map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1]?.startsWith('--') ? true : all[index + 1]] : null).filter(Boolean));
  const adminToken = String(args.adminToken || env.WAR_ADMIN_TOKEN || env.WAR_TOKEN || '');
  const enrollmentToken = String(args.enrollmentToken || env.WAR_ENROLLMENT_TOKEN || env.WAR_TOKEN || '');
  requireLongToken('WAR_ADMIN_TOKEN/--adminToken', adminToken);
  requireLongToken('WAR_ENROLLMENT_TOKEN/--enrollmentToken', enrollmentToken);
  const host = String(args.host || env.WAR_HOST || '127.0.0.1');
  const allow = String(args.allow || env.WAR_ALLOW || '127.0.0.1,::1').split(',').map((item) => item.trim()).filter(Boolean);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !args.allow && !env.WAR_ALLOW) {
    throw new Error('LAN bind requires explicit --allow/WAR_ALLOW');
  }
  return {
    host,
    port: Number(args.port || env.WAR_PORT || 17373),
    allow,
    adminToken,
    enrollmentToken,
    storePath: String(args.store || env.WAR_STORE || path.join(__dirname, 'war-companion-store.json')),
    leaseMs: Number(args.leaseMs || env.WAR_LEASE_MS || 30000)
  };
}

export function createServer(config, store) {
  const adminHash = tokenHash(config.adminToken);
  const enrollmentHash = tokenHash(config.enrollmentToken);

  return http.createServer(async (req, res) => {
    try {
      if (!ipAllowed(req.socket.remoteAddress, config.allow)) return json(res, 403, { error: 'IP not allowed' });
      if (req.method === 'OPTIONS') return cors(res, 204).end();
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: '0.2.0' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) return serveDashboard(res);
      if (req.method === 'GET' && url.pathname.startsWith('/dashboard.')) return serveAsset(res, url.pathname);

      if (url.pathname === '/v1/devices/enroll' && req.method === 'POST') {
        requireToken(req, enrollmentHash);
        const body = await readJson(req);
        const rawToken = newToken();
        const device = await store.update((state) => {
          const item = {
            id: body.deviceId || cryptoId('dev'),
            name: String(body.name || body.deviceName || 'Endpoint'),
            groupIds: Array.isArray(body.groupIds) ? body.groupIds : [],
            tokenHash: tokenHash(rawToken),
            createdAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            status: 'online',
            extensionVersion: body.extensionVersion || '',
            browser: body.browser || '',
            profiles: []
          };
          state.devices = state.devices.filter((device) => device.id !== item.id).concat(item);
          return item;
        });
        return json(res, 201, { ...publicDevice(device), deviceToken: rawToken });
      }

      if (url.pathname.startsWith('/v1/devices/')) return handleDeviceRoute(req, res, url, store, config);

      requireToken(req, adminHash);
      if (url.pathname === '/v1/devices' && req.method === 'GET') {
        return json(res, 200, { devices: store.snapshot().devices.map(publicDevice) });
      }
      if (url.pathname === '/v1/commands' && req.method === 'POST') return enqueueLegacyCommand(req, res, store);
      if (url.pathname === '/v1/commands/next' && req.method === 'GET') return legacyNextCommand(res, store, config);
      const legacyResult = url.pathname.match(/^\/v1\/commands\/([^/]+)\/result$/);
      if (legacyResult && req.method === 'POST') return legacyCommandResult(req, res, store, legacyResult[1]);
      const commandGet = url.pathname.match(/^\/v1\/commands\/([^/]+)$/);
      if (commandGet && req.method === 'GET') return getCommand(res, store, commandGet[1]);
      if (url.pathname === '/v1/batches' && req.method === 'POST') return createBatch(req, res, store);
      const batchGet = url.pathname.match(/^\/v1\/batches\/([^/]+)$/);
      if (batchGet && req.method === 'GET') return getBatch(res, store, batchGet[1]);
      const batchStop = url.pathname.match(/^\/v1\/batches\/([^/]+)\/stop$/);
      if (batchStop && req.method === 'POST') return stopBatch(res, store, batchStop[1]);
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      return json(res, error.status || 400, { error: error.message });
    }
  });
}

async function handleDeviceRoute(req, res, url, store, config) {
  const match = url.pathname.match(/^\/v1\/devices\/([^/]+)(?:\/(.+))?$/);
  const deviceId = decodeURIComponent(match?.[1] || '');
  const suffix = match?.[2] || '';
  const device = store.snapshot().devices.find((item) => item.id === deviceId);
  if (!device) return json(res, 404, { error: 'Device not found' });
  requireToken(req, device.tokenHash);

  if (suffix === 'register' && req.method === 'POST') {
    const body = await readJson(req);
    await store.update((state) => {
      const item = state.devices.find((device) => device.id === deviceId);
      Object.assign(item, {
        name: String(body.name || item.name),
        groupIds: Array.isArray(body.groupIds) ? body.groupIds : item.groupIds,
        extensionVersion: body.extensionVersion || item.extensionVersion,
        browser: body.browser || item.browser,
        profiles: Array.isArray(body.profiles) ? body.profiles : item.profiles,
        capabilities: body.capabilities || item.capabilities,
        lastSeenAt: new Date().toISOString(),
        status: 'online'
      });
    });
    return json(res, 200, { ok: true });
  }
  if (suffix === 'heartbeat' && req.method === 'POST') {
    const body = await readJson(req);
    await store.update((state) => {
      const item = state.devices.find((device) => device.id === deviceId);
      item.status = body.status || 'online';
      item.runState = body.runState || null;
      item.lastSeenAt = new Date().toISOString();
    });
    return json(res, 200, { ok: true });
  }
  if (suffix === 'commands/next' && req.method === 'GET') {
    const command = await store.update((state) => leaseNextCommand(state, deviceId, config.leaseMs));
    if (!command) return empty(res);
    return json(res, 200, command);
  }
  const ack = suffix.match(/^commands\/([^/]+)\/ack$/);
  if (ack && req.method === 'POST') {
    const body = await readJson(req);
    const command = await store.update((state) => ackCommand(state, deviceId, ack[1], body.leaseId));
    return json(res, 200, command);
  }
  const result = suffix.match(/^commands\/([^/]+)\/result$/);
  if (result && req.method === 'POST') {
    const body = await readJson(req);
    const command = await store.update((state) => finishCommand(state, deviceId, result[1], body.leaseId, body.result || body));
    return json(res, 200, command);
  }
  return json(res, 404, { error: 'Not found' });
}

async function createBatch(req, res, store) {
  const body = await readJson(req);
  const now = new Date().toISOString();
  const batchId = cryptoId('batch');
  const batch = await store.update((state) => {
    const devices = state.devices.filter((device) => (body.deviceIds || []).includes(device.id));
    if (!devices.length) throw new Error('No target devices');
    const commands = buildAssignments({
      devices,
      type: body.type || 'run_profile',
      profileId: body.profileId,
      inputs: body.inputs || {},
      dataset: body.dataset || [],
      assignmentMode: body.assignmentMode || 'same',
      allowDuplicate: body.allowDuplicate !== false,
      seed: body.seed || batchId
    }).map((command, index) => ({ ...command, batchId, notBefore: new Date(Date.now() + Number(body.delayMs || 0) * index).toISOString() }));
    const item = {
      id: batchId,
      name: body.name || `Batch ${batchId}`,
      profileId: body.profileId,
      status: 'queued',
      assignmentMode: body.assignmentMode || 'same',
      allowDuplicate: body.allowDuplicate !== false,
      createdAt: now,
      commandIds: commands.map((command) => command.id)
    };
    state.commands.push(...commands);
    state.batches.push(item);
    return summarizeBatch(item, commands);
  });
  return json(res, 201, batch);
}

function getBatch(res, store, id) {
  const state = store.snapshot();
  const batch = state.batches.find((item) => item.id === id);
  if (!batch) return json(res, 404, { error: 'Batch not found' });
  const commands = state.commands.filter((command) => command.batchId === id);
  return json(res, 200, summarizeBatch(batch, commands));
}

async function stopBatch(res, store, id) {
  const batch = await store.update((state) => {
    const item = state.batches.find((batch) => batch.id === id);
    if (!item) throw new Error('Batch not found');
    item.status = 'cancelled';
    for (const command of state.commands.filter((command) => command.batchId === id && !['succeeded', 'failed'].includes(command.status))) {
      command.status = 'cancelled';
      command.completedAt = new Date().toISOString();
    }
    return summarizeBatch(item, state.commands.filter((command) => command.batchId === id));
  });
  return json(res, 200, batch);
}

async function enqueueLegacyCommand(req, res, store) {
  const body = await readJson(req);
  if (!COMMAND_TYPES.has(body.type)) return json(res, 400, { error: 'Unsupported command type' });
  const state = store.snapshot();
  const deviceId = body.deviceId || state.devices[0]?.id || 'legacy';
  const command = {
    id: cryptoId('cmd'),
    deviceId,
    type: body.type,
    profileId: body.profileId,
    runId: body.runId,
    inputs: body.inputs || {},
    status: 'queued',
    attempt: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    notBefore: new Date().toISOString()
  };
  await store.update((state) => {
    if (!state.devices.some((device) => device.id === deviceId)) state.devices.push({ id: deviceId, name: 'Legacy endpoint', tokenHash: '', createdAt: new Date().toISOString(), lastSeenAt: null, status: 'unknown', profiles: [] });
    state.commands.push(command);
  });
  return json(res, 202, command);
}

async function legacyNextCommand(res, store, config) {
  const state = store.snapshot();
  const deviceId = state.devices[0]?.id || 'legacy';
  const command = await store.update((state) => leaseNextCommand(state, deviceId, config.leaseMs));
  if (!command) return empty(res);
  return json(res, 200, command);
}

async function legacyCommandResult(req, res, store, commandId) {
  const body = await readJson(req);
  await store.update((state) => {
    const command = state.commands.find((item) => item.id === commandId);
    if (!command) throw new Error('Command not found');
    command.status = body.ok === false ? 'failed' : 'succeeded';
    command.result = body;
    command.completedAt = new Date().toISOString();
  });
  return json(res, 200, { ok: true });
}

function getCommand(res, store, id) {
  const command = store.snapshot().commands.find((item) => item.id === id);
  if (!command) return json(res, 404, { error: 'Command not found' });
  return json(res, 200, command);
}

function summarizeBatch(batch, commands) {
  const counts = commands.reduce((acc, command) => {
    acc[command.status] = (acc[command.status] || 0) + 1;
    return acc;
  }, {});
  return { ...batch, counts, commands };
}

function publicDevice(device) {
  const { tokenHash: _tokenHash, ...safe } = device;
  return safe;
}

function requireToken(req, expectedHash) {
  if (!timingEqual(tokenHash(bearerToken(req)), expectedHash)) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
}

function cryptoId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 65536) {
        const error = new Error('Payload too large');
        error.status = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  cors(res, status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function empty(res) {
  cors(res, 204);
  res.end();
}

function cors(res, status) {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return res;
}

function serveDashboard(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(DASHBOARD_HTML);
}

function serveAsset(res, pathname) {
  if (pathname === '/dashboard.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(DASHBOARD_JS);
    return;
  }
  res.writeHead(404).end();
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WAR Companion Hub</title>
  <style>
    body{margin:0;font:14px system-ui;background:#f6f7fb;color:#172033}
    header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #d8deea;background:#fff}
    main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px}
    section{background:#fff;border:1px solid #d8deea;border-radius:8px;padding:14px}
    input,select,textarea,button{font:inherit;border:1px solid #cbd3e1;border-radius:7px;padding:8px}
    button{cursor:pointer;background:#245cff;color:#fff;border-color:#245cff}
    table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #eef2f7;padding:8px;text-align:left}textarea{width:100%;min-height:90px;box-sizing:border-box}code{word-break:break-all}
  </style>
</head>
<body>
  <header><h1>WAR Companion Hub</h1><input id="token" type="password" placeholder="Admin token"></header>
  <main>
    <section><h2>Endpoints</h2><button id="refresh">Refresh</button><table><thead><tr><th></th><th>Name</th><th>Status</th><th>Profiles</th></tr></thead><tbody id="devices"></tbody></table></section>
    <section><h2>Create batch</h2><label>Profile ID <input id="profileId"></label><label>Mode <select id="mode"><option>same</option><option>per_device</option><option>random_pool</option><option>mapping</option></select></label><label><input id="allowDup" type="checkbox" checked> allow duplicate random inputs</label><label>Dataset JSON <textarea id="dataset">[{}]</textarea></label><button id="run">Run selected</button><pre id="status"></pre></section>
    <section style="grid-column:1/-1"><h2>Batches</h2><pre id="batches"></pre></section>
  </main>
  <script src="/dashboard.js"></script>
</body>
</html>`;

const DASHBOARD_JS = `let devices=[];let batches=[];const $=id=>document.getElementById(id);const auth=()=>({Authorization:'Bearer '+$('token').value,'Content-Type':'application/json'});async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{...auth(),...(opts.headers||{})}});if(!r.ok)throw new Error(await r.text());return r.status===204?null:r.json()}async function refresh(){const data=await api('/v1/devices');devices=data.devices||[];$('devices').innerHTML=devices.map(d=>'<tr><td><input type="checkbox" value="'+d.id+'"></td><td>'+esc(d.name||d.id)+'<br><code>'+esc(d.id)+'</code></td><td>'+esc(d.status||'unknown')+'</td><td>'+esc((d.profiles||[]).map(p=>p.name||p.id).join(', '))+'</td></tr>').join('');}function selected(){return [...document.querySelectorAll('tbody input:checked')].map(x=>x.value)}$('refresh').onclick=()=>refresh().catch(show);$('run').onclick=async()=>{try{const dataset=JSON.parse($('dataset').value||'[{}]');const body={deviceIds:selected(),profileId:$('profileId').value,assignmentMode:$('mode').value,allowDuplicate:$('allowDup').checked,dataset};const batch=await api('/v1/batches',{method:'POST',body:JSON.stringify(body)});batches.unshift(batch);$('batches').textContent=JSON.stringify(batches,null,2);show(batch)}catch(e){show(e)}};function show(x){$('status').textContent=x instanceof Error?x.message:JSON.stringify(x,null,2)}function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = parseArgs();
  const store = new JsonStore(config.storePath);
  await store.load();
  createServer(config, store).listen(config.port, config.host, () => {
    console.log(`WAR companion hub listening on http://${config.host}:${config.port}`);
  });
}
