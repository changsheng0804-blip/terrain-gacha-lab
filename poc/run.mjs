#!/usr/bin/env node
// RFC-001 PoC driver: serve the worktree, open poc/timeline.html in Chrome (CDP), play, scrub, screenshot, report.
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), `rfc001-poc-${Date.now()}`)));
const TYPES = arg('types', 'river,fjord,caldera').split(','); const RES = arg('res', '512');
const HEADLESS = arg('headless', '1') === '1';
fs.mkdirSync(OUT, { recursive: true });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const PORT = await freePort(), DBG = await freePort();
const CHROME = process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 60000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error('timeout'); await sleep(150); } };
const server = spawn(process.execPath, ['serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-chrome-'));
const chrome = spawn(CHROME, [...(HEADLESS ? ['--headless=new'] : []), `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`, '--window-size=1280,800', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} try { server.kill('SIGKILL'); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/poc/run.mjs`, { method: 'HEAD' })).ok; } catch { return false; } });
const target = await waitFor(async () => { try { return (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find((t) => t.type === 'page'); } catch { return null; } });
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 1; const pend = new Map(); const errors = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ')); };
const send = (method, params = {}) => new Promise((r, j) => { const i = id++; pend.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
await send('Runtime.enable'); await send('Page.enable');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const summary = [];
for (const type of TYPES) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/poc/timeline.html?type=${type}&res=${RES}&dur=10000` });
  await waitFor(() => ev('window.__poc && window.__poc.done'), 90000);
  const s = await ev(`(() => { const s = window.__poc.stats; return { ...s, play: s.play.map(p => p.update), playTotal: s.play.map(p => p.total), raf: s.raf.slice(5) }; })()`);
  // terrain-phase vs town-phase update cost
  const n = s.play.length, cut = Math.floor(n * 0.6);
  const scrub = await ev(`(() => { const out = []; for (let k = 0; k < 40; k++) { const u = ((k * 0.6180339) % 1); out.push(window.__poc.show(u).total); } return out; })()`);
  const shots = [];
  for (const u of [0.05, 0.3, 0.6, 0.8, 1]) {
    await ev(`window.__poc.show(${u}), 0`); await sleep(120);
    const img = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, `${type}-${String(Math.round(u * 100)).padStart(3, '0')}.png`); fs.writeFileSync(f, Buffer.from(img.data, 'base64')); shots.push(path.basename(f));
  }
  const row = { type, res: +RES, workerComputeMs: Math.round(s.workerCompute), workerWallMs: Math.round(s.workerWall), keyframes: s.keyframes, keyMB: +s.keyMB.toFixed(1), buildings: s.buildings, roads: s.roads,
    frames: n, updateTerrainMeanMs: +mean(s.play.slice(0, cut)).toFixed(2), updateTerrainP95Ms: +pct(s.play.slice(0, cut), 0.95).toFixed(2),
    updateTownMeanMs: +mean(s.play.slice(cut)).toFixed(2), frameTotalP95Ms: +pct(s.playTotal, 0.95).toFixed(2),
    rafMeanMs: +mean(s.raf).toFixed(2), rafP95Ms: +pct(s.raf, 0.95).toFixed(2), scrubMeanMs: +mean(scrub).toFixed(2), scrubMaxMs: +Math.max(...scrub).toFixed(2), shots };
  summary.push(row); console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ summary, errors }, null, 2));
console.log(`errors: ${errors.length}${errors.length ? '\n' + errors.join('\n') : ''}\nout: ${OUT}`);
process.exit(errors.length ? 1 : 0);
