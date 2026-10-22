#!/usr/bin/env node
/**
 * Browser smoke + screenshot check, driven through the Chrome DevTools
 * Protocol with the system Chrome. No npm dependencies (Node >= 22 for the
 * global WebSocket).
 *
 *   node scripts/visual-check.mjs [--out=DIR] [--types=river,caldera] [--seed=N] [--res=512]
 *
 * For each terrain it: generates in the real page, records the page's own
 * stage timings, the time to the first 3D frame, every console error / page
 * exception, and saves screenshots of the colour, town and 3D views (full map
 * and town close-up), plus a judge overlay that outlines in red every building
 * touching a road. A summary.json is written next to the screenshots.
 *
 * Env: CHROME_PATH to override the browser binary, PORT to pin the static
 * server port (default: a free port, so it never collides with other agents).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const OUT = path.resolve(arg('out', path.join(os.tmpdir(), `terrain-visual-${Date.now()}`)));
const TYPES = arg('types', 'river,slope,onsen,fjord,caldera').split(',');
const SEED = Number(arg('seed', '20261019'));
const RES = arg('res', '512');
// Other agents may already run dev servers; always use a free port unless told.
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const PORT = Number(process.env.PORT) || await freePort();
const DEBUG_PORT = await freePort();
const CHROME = process.env.CHROME_PATH
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('Chrome not found; set CHROME_PATH');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 30000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout');
    await sleep(step);
  }
}

/* ---------------------------- processes ---------------------------- */

const server = spawn(process.execPath, ['serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tgl-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1440,960',
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-swiftshader',
  'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// Make sure the server answering on PORT is ours (serves this worktree).
await waitFor(async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/scripts/visual-check.mjs`, { method: 'HEAD' });
    return r.ok;
  } catch { return false; }
}, 10000);

/* ------------------------------ CDP -------------------------------- */

const target = await waitFor(async () => {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    return list.find((t) => t.type === 'page');
  } catch { return null; }
});

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push({ kind: 'exception', text: msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text });
  } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
    errors.push({ kind: 'console', text: msg.params.args.map((a) => a.value ?? a.description).join(' ') });
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error'
    && !/favicon\.ico/.test(msg.params.entry.url || '')) {
    errors.push({ kind: 'log', text: `${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim() });
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name, selector = '.canvas-wrap', zoom = null) => {
  const rect = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
  let clip = { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 };
  if (zoom) {
    // zoom = { cx, cy } in 0..1 of the element, magnified 2x around that point
    const w = rect.w / 2;
    const h = rect.h / 2;
    clip = {
      x: rect.x + Math.min(Math.max(0, zoom.cx * rect.w - w / 2), rect.w - w),
      y: rect.y + Math.min(Math.max(0, zoom.cy * rect.h - h / 2), rect.h - h),
      width: w, height: h, scale: 2,
    };
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return path.basename(file);
};
const frames = (n = 2) => evaluate(`new Promise((r) => { let k = ${n}; const f = () => (--k <= 0 ? r(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

/* ----------------------------- checks ------------------------------ */

const statusDone = `(() => { const s = document.getElementById('status')?.textContent || ''; return /完成|3D ·/.test(s) && window.__tgl && window.__tgl.state ? s : ''; })()`;

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await waitFor(() => evaluate(statusDone), 60000);

const results = [];
for (const type of TYPES) {
  const errBefore = errors.length;
  const row = { type, seed: SEED, res: Number(RES), shots: {} };

  // Configure through the real controls, then press generate.
  const t0 = Date.now();
  await evaluate(`(() => {
    document.querySelector('#views button[data-view="color"]').click();
    document.getElementById('type').value = ${JSON.stringify(type)};
    document.getElementById('seed').value = '${SEED}';
    document.getElementById('res').value = '${RES}';
    document.getElementById('status').textContent = '';
    document.getElementById('generate').click();
    return true;
  })()`);
  await waitFor(() => evaluate(statusDone), 120000);
  row.generateWallMs = Date.now() - t0;
  Object.assign(row, await evaluate(`(() => {
    const t = window.__tgl;
    return {
      timings: Object.fromEntries(Object.entries(t.timings).map(([k, v]) => [k, Math.round(v)])),
      buildings: t.town.buildings.length,
      station: t.town.buildings.some((b) => b.type === 'station'),
      stats: document.getElementById('stats').innerText.replace(/\\n/g, ' | '),
    };
  })()`));
  await frames();
  row.shots.color = await shot(`${type}-color`, '#canvas');

  await evaluate(`document.querySelector('#views button[data-view="town"]').click(), true`);
  await frames();
  row.shots.town = await shot(`${type}-town`, '#canvas');

  // Judge overlay: outline in red every building whose footprint touches a
  // road (same geometry as test/judge), then a 2x close-up of the centre.
  const overlay = await evaluate(`(async () => {
    const g = await import('/test/judge/geometry.mjs');
    const t = window.__tgl;
    const canvas = document.getElementById('canvas');
    const vb = (t.renderInfo && t.renderInfo.viewBounds) || { x0: t.field.x0, y0: t.field.y0, size: t.field.size };
    const k = canvas.width / vb.size;
    const P = ([x, z]) => [(x - vb.x0) * k, (z - vb.y0) * k];
    const idx = g.indexSegments(t.town.roads.map((r) => ({ pts: r.pts, hw: r.width / 2 })));
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.lineWidth = Math.max(2, canvas.width / 600);
    ctx.strokeStyle = '#ff2d55';
    ctx.fillStyle = 'rgba(255,45,85,0.35)';
    let flagged = 0;
    for (const b of t.town.buildings) {
      const [x0, z0, x1, z1] = g.obbBounds(b);
      let hit = false;
      for (const s of idx.hash.query(x0 - 8, z0 - 8, x1 + 8, z1 + 8)) {
        if (g.segObbDist(b, s.a, s.b) < s.hw) { hit = true; break; }
      }
      if (!hit) continue;
      flagged++;
      const c = g.obbCorners(b, 1).map(P);
      ctx.beginPath();
      ctx.moveTo(c[0][0], c[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    const cx = (t.town.center.x - vb.x0) / vb.size;
    const cy = (t.town.center.z - vb.y0) / vb.size;
    return { flagged, total: t.town.buildings.length, cx, cy };
  })()`);
  row.onRoad = { flagged: overlay.flagged, pct: Math.round(overlay.flagged / Math.max(1, overlay.total) * 1000) / 10 };
  row.shots.overlay = await shot(`${type}-town-onroad`, '#canvas');
  row.shots.overlayZoom = await shot(`${type}-town-onroad-zoom`, '#canvas', { cx: overlay.cx, cy: overlay.cy });

  // 3D: time from switching the view to the second rendered frame.
  const t3 = await evaluate(`(async () => {
    const t0 = performance.now();
    document.querySelector('#views button[data-view="3d"]').click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - t0);
  })()`);
  row.firstFrame3dMs = t3;
  await sleep(400);
  row.shots.town3d = await shot(`${type}-3d-town`, '#canvas3d');

  await evaluate(`(() => {
    const c = document.getElementById('canvas3d');
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return true;
  })()`);
  await sleep(700);
  row.shots.full3d = await shot(`${type}-3d-full`, '#canvas3d');

  row.errors = errors.slice(errBefore);
  row.budgetOk = (row.timings.total + row.firstFrame3dMs) < 2000;
  results.push(row);
  console.log(`${type.padEnd(8)} gen ${String(row.timings.total).padStart(5)} ms  3D first frame ${String(row.firstFrame3dMs).padStart(4)} ms  buildings ${String(row.buildings).padStart(5)}  station ${row.station ? 'yes' : 'NO '}  onRoad ${String(row.onRoad.pct).padStart(4)}%  errors ${row.errors.length}  ${row.budgetOk ? '' : '(over 2 s budget)'}`);
}

const summary = {
  url: `http://127.0.0.1:${PORT}/`,
  chrome: CHROME,
  seed: SEED,
  res: Number(RES),
  results,
  pageErrors: errors,
};
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\nscreenshots + summary.json → ${OUT}`);
console.log(`page errors: ${errors.length}`);
ws.close();
cleanup();
process.exit(errors.length ? 1 : 0);
