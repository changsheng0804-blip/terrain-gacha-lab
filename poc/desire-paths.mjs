#!/usr/bin/env node
/**
 * RFC-001 PoC / E1-lite: desire-path road emergence on real generated terrain.
 * Validates (or refutes) the Phase 3 claims: synchronous traffic hardening
 * converges to a shared trunk network, is order-independent, stays within a
 * time budget, and a cross field changes alignment. Not production code.
 *
 *   node poc/desire-paths.mjs [--types=river,fjord,caldera] [--res=512] [--out=DIR]
 */
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { createHash } from 'node:crypto';
import { generateWorld } from '../src/pipeline.js';
import { rngFor } from '../src/rng.js';

const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : d; };
const TYPES = arg('types', 'river,fjord,caldera').split(','); const RES = +arg('res', '512');
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'rfc001-desire'))); fs.mkdirSync(OUT, { recursive: true });
const CG = 30;            // coarse cell, m
const YEARS = 30, RHO = +arg('rho', '0.25'), NUCLEI = 10, HOMES = 12;
// Thresholds in steady-state flow units: a cell carrying f trips/year settles at tau = f / RHO.
const T_UP = 2 / RHO, T_ART = 12 / RHO;
const DIRS = []; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const g = Math.abs(dx) + Math.abs(dy); if (!g) continue; if (Math.max(Math.abs(dx), Math.abs(dy)) === 2 && (Math.abs(dx) === Math.abs(dy) || dx === 0 || dy === 0)) continue; DIRS.push([dx, dy, Math.hypot(dx, dy), Math.atan2(dy, dx)]); }

function coarse(w) {
  const f = w.field, n = f.n, m = Math.floor(f.size / CG) + 1, s = (n - 1) / (m - 1);
  const h = new Float32Array(m * m), water = new Uint8Array(m * m), river = new Uint8Array(m * m);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) { const i = Math.min(n - 1, Math.round(y * s)) * n + Math.min(n - 1, Math.round(x * s)); h[y * m + x] = f.height[i]; water[y * m + x] = w.hydro.waterMask[i]; river[y * m + x] = w.hydro.riverMask[i]; }
  return { m, h, water, river, x0: f.x0, y0: f.y0 };
}
function crossField(g) { // 4-RoSy: contour tangent weighted by slope, smoothed in 4θ space
  const { m, h } = g, c = new Float32Array(m * m), s = new Float32Array(m * m);
  for (let y = 1; y < m - 1; y++) for (let x = 1; x < m - 1; x++) { const i = y * m + x; const gx = (h[i + 1] - h[i - 1]) / (2 * CG), gy = (h[i + m] - h[i - m]) / (2 * CG); const sl = Math.hypot(gx, gy); const th = Math.atan2(gy, gx) + Math.PI / 2; const w = Math.min(1, sl / 0.08) + (g.water[i] ? 0 : 0.05); c[i] = w * Math.cos(4 * th); s[i] = w * Math.sin(4 * th); }
  for (let pass = 0; pass < 4; pass++) for (const a of [c, s]) { const b = a.slice(); for (let y = 1; y < m - 1; y++) for (let x = 1; x < m - 1; x++) { const i = y * m + x; a[i] = (b[i] * 4 + b[i - 1] + b[i + 1] + b[i - m] + b[i + m]) / 8; } }
  const theta = new Float32Array(m * m), str = new Float32Array(m * m);
  for (let i = 0; i < m * m; i++) { theta[i] = Math.atan2(s[i], c[i]) / 4; str[i] = Math.min(1, Math.hypot(c[i], s[i]) * 2); }
  return { theta, str };
}
function slopeOf(g, i, j) { return Math.abs(g.h[j] - g.h[i]); }
function sites(g, w, rng) { // nuclei: flat dry land, best-candidate sampling around the classic centre
  const { m } = g; const ok = []; for (let y = 3; y < m - 3; y++) for (let x = 3; x < m - 3; x++) { const i = y * m + x; if (g.water[i] || g.river[i] || g.h[i] <= 2) continue; const sl = Math.max(slopeOf(g, i, i + 1), slopeOf(g, i, i + m)) / CG; if (sl < 0.12) ok.push(i); }
  const cx = Math.round((w.town.center.x - g.x0) / CG), cy = Math.round((w.town.center.z - g.y0) / CG); const centre = cy * m + cx;
  const nuc = [centre];
  for (let k = 1; k < NUCLEI; k++) { let best = -1, bs = -1; for (let t = 0; t < 40; t++) { const c = ok[Math.floor(rng() * ok.length)]; let d = Infinity; for (const q of nuc) d = Math.min(d, Math.hypot((c % m) - (q % m), ((c / m) | 0) - ((q / m) | 0))); const dc = Math.hypot((c % m) - cx, ((c / m) | 0) - cy); const sc = Math.min(d, 25) - dc * 0.08; if (sc > bs) { bs = sc; best = c; } } nuc.push(best); }
  const homes = nuc.map((q) => { const out = []; for (let t = 0; t < HOMES; t++) { for (let tries = 0; tries < 20; tries++) { const x = (q % m) + Math.round((rng() - 0.5) * 12), y = ((q / m) | 0) + Math.round((rng() - 0.5) * 12); const i = y * m + x; if (x > 1 && y > 1 && x < m - 2 && y < m - 2 && !g.water[i]) { out.push(i); break; } } } return out; });
  return { nuc, homes };
}
// Dijkstra from one destination over the frozen cost; typed-array binary heap.
function dijkstra(g, cost, src, dist, par, heapI, heapD, targets = null) {
  let need = targets ? targets.size : -1;
  const N = g.m * g.m; dist.fill(Infinity); par.fill(-1); let hs = 0;
  const push = (i, d) => { let k = hs++; while (k > 0) { const p = (k - 1) >> 1; if (heapD[p] < d || (heapD[p] === d && heapI[p] < i)) break; heapI[k] = heapI[p]; heapD[k] = heapD[p]; k = p; } heapI[k] = i; heapD[k] = d; };
  const pop = () => { const top = heapI[0]; const li = heapI[--hs], ld = heapD[hs]; let k = 0; for (;;) { let c = 2 * k + 1; if (c >= hs) break; if (c + 1 < hs && (heapD[c + 1] < heapD[c] || (heapD[c + 1] === heapD[c] && heapI[c + 1] < heapI[c]))) c++; if (heapD[c] > ld || (heapD[c] === ld && heapI[c] > li)) break; heapI[k] = heapI[c]; heapD[k] = heapD[c]; k = c; } heapI[k] = li; heapD[k] = ld; return top; };
  dist[src] = 0; push(src, 0); const m = g.m;
  while (hs) { const d0 = heapD[0]; const i = pop(); if (d0 > dist[i]) continue; if (targets && targets.has(i) && --need <= 0) break; const x = i % m, y = (i / m) | 0;
    for (let k = 0; k < DIRS.length; k++) { const [dx, dy] = DIRS[k]; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= m || ny >= m) continue; const j = ny * m + nx; const c = cost(i, j, k); if (c === Infinity) continue; const nd = d0 + c; if (nd < dist[j]) { dist[j] = nd; par[j] = i; push(j, nd); } } }
}
function simulate(g, field, st, opt, shuffleSeed = 0) {
  const { m } = g; const N = m * m; const tau = new Float32Array(N);
  const dist = new Float64Array(N), par = new Int32Array(N), hI = new Int32Array(N * 8), hD = new Float64Array(N * 8);
  const cost = (i, j, k) => { if (g.water[j] && !g.river[j]) return Infinity; const [, , len, ang] = DIRS[k]; const grade = slopeOf(g, i, j) / (len * CG); if (grade > 0.35) return Infinity;
    let c = len * (1 + 40 * Math.max(0, grade - 0.03) ** 2) * (g.river[j] ? 6 : 1);
    if (opt.lambda) { const th = field.theta[i]; const sn = Math.sin(2 * (ang - th)); c *= 1 + opt.lambda * sn * sn * field.str[i]; }
    if (opt.gamma) { const t = 0.5 * (tau[i] + tau[j]); c /= 1 + opt.gamma * Math.log1p(t); }
    return c; };
  // trips: every home -> its nucleus centre; every nucleus -> centre; every nucleus -> nearest 2 nuclei
  const dests = st.nuc.map((q, k) => k);
  // gravity-style volumes (trips/year): home->own nucleus 1, nucleus->centre 6, nucleus->2 nearest nuclei 3
  const trips = []; st.nuc.forEach((q, k) => { for (const hm of st.homes[k]) trips.push([hm, k, 1]); if (k) trips.push([q, 0, 6]); const near = st.nuc.map((r, j) => [j, Math.hypot((q % m) - (r % m), ((q / m) | 0) - ((r / m) | 0))]).filter((a) => a[0] !== k).sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, 2); for (const [j] of near) trips.push([q, j, 3]); });
  if (shuffleSeed) { const r = rngFor(shuffleSeed, 'shuffle'); for (let i = trips.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [trips[i], trips[j]] = [trips[j], trips[i]]; } }
  const byDest = new Map(); for (const t of trips) { if (!byDest.has(t[1])) byDest.set(t[1], []); byDest.get(t[1]).push(t); }
  const destOrder = [...byDest.keys()].sort((a, b) => a - b); // fixed order => order-independent
  let prevLen = 0, stable = 0, converged = YEARS; const history = [];
  const hard = new Uint8Array(N);
  for (let y = 0; y < YEARS; y++) {
    const dep = new Float32Array(N);
    for (const d of destOrder) { const os = byDest.get(d); dijkstra(g, cost, st.nuc[d], dist, par, hI, hD, new Set(os.map((t) => t[0]))); for (const [o, , wt] of os) { let i = o; let guard = 0; while (i !== -1 && guard++ < N) { dep[i] += wt; const p = par[i]; if (p !== -1) { const dx = (p % m) - (i % m), dy = ((p / m) | 0) - ((i / m) | 0); if (Math.abs(dx) === 2 || Math.abs(dy) === 2) dep[i + Math.trunc(dy / 2) * m + Math.trunc(dx / 2)] += wt; } i = p; } } }
    for (let i = 0; i < N; i++) { tau[i] = (1 - RHO) * tau[i] + dep[i]; if (tau[i] > T_UP) hard[i] = 1; else if (tau[i] < T_UP * 0.4) hard[i] = 0; }
    let len = 0, tsum = 0; for (let i = 0; i < N; i++) { len += hard[i]; tsum += tau[i]; } history.push(len);
    const steady = tsum * RHO; // converged when tau is within 2% of its steady state for these flows
    const depSum = dep.reduce((a, b) => a + b, 0);
    if (Math.abs(steady - depSum) / depSum < 0.02 && prevLen && Math.abs(len - prevLen) / prevLen < 0.01) { if (++stable >= 2 && converged === YEARS) { converged = y + 1; if (opt.stopOnConverge) break; } } else stable = 0; prevLen = len;
  }
  return { tau, hard, trips, history, converged };
}
function metrics(g, field, res, st) {
  const { m } = g; const { hard, tau } = res; let cells = 0, art = 0, par = 0, alignSum = 0, alignN = 0;
  for (let y = 4; y < m - 4; y++) for (let x = 4; x < m - 4; x++) { const i = y * m + x; if (!hard[i]) continue; cells++; if (tau[i] > T_ART) art++;
    // local direction from hardened neighbours (structure tensor in 2θ)
    let c2 = 0, s2 = 0; for (const [dx, dy, , a] of DIRS) if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && hard[(y + dy) * m + x + dx]) { c2 += Math.cos(2 * a); s2 += Math.sin(2 * a); }
    if (Math.hypot(c2, s2) < 0.5) continue; const a = Math.atan2(s2, c2) / 2; const px = -Math.sin(a), py = Math.cos(a);
    let gap = false, hit = false; for (const sgn of [1, -1]) { let empty = false; for (let d = 1; d <= 4; d++) { const j = Math.round(y + sgn * py * d) * m + Math.round(x + sgn * px * d); if (!hard[j]) empty = true; else if (empty && d >= 2) { hit = true; break; } else if (!empty) break; } } if (hit) par++;
    const sn = Math.sin(2 * (a - field.theta[i])); alignSum += Math.abs(sn) * field.str[i]; alignN += field.str[i]; }
  // detour index on the hardened network: nucleus -> centre
  const N = m * m, dist = new Float64Array(N), parA = new Int32Array(N), hI = new Int32Array(N * 8), hD = new Float64Array(N * 8);
  dijkstra(g, (i, j, k) => (hard[j] ? DIRS[k][2] : Infinity), st.nuc[0], dist, parA, hI, hD);
  const det = []; let disc = 0; for (let k = 1; k < st.nuc.length; k++) { const q = st.nuc[k], e = Math.hypot((q % m) - (st.nuc[0] % m), ((q / m) | 0) - ((st.nuc[0] / m) | 0)); if (!isFinite(dist[q])) disc++; else det.push(dist[q] / e); }
  det.sort((a, b) => a - b);
  return { networkKm: +(cells * CG / 1000).toFixed(1), arterialKm: +(art * CG / 1000).toFixed(1), parallelPct: +(100 * par / Math.max(1, cells)).toFixed(1), misalign: +(alignSum / Math.max(1e-9, alignN)).toFixed(3), detourMedian: det.length ? +det[det.length >> 1].toFixed(2) : null, disconnected: disc };
}
function savePPM(file, g, res) { const { m } = g; const buf = Buffer.alloc(m * m * 3); for (let i = 0; i < m * m; i++) { const x = i % m; const sh = g.h[Math.min(m * m - 1, i + 1)] - g.h[i]; let v = g.water[i] ? [70, 110, 140] : [150 + Math.max(-40, Math.min(40, sh * 4)), 160 + Math.max(-40, Math.min(40, sh * 4)), 120]; if (res.hard[i]) v = res.tau[i] > T_ART ? [190, 30, 30] : [250, 240, 220]; buf.set(v.map((u) => Math.max(0, Math.min(255, u | 0))), i * 3); } fs.writeFileSync(file, Buffer.concat([Buffer.from(`P6 ${m} ${m} 255\n`), buf])); }

const STOP = arg('stop', '1') === '1';
const VARIANTS = { A_shortest: { gamma: 0, lambda: 0, stopOnConverge: STOP }, B_desire: { gamma: +arg("gamma","1.5"), lambda: 0, stopOnConverge: STOP }, C_desire_field: { gamma: +arg("gamma","1.5"), lambda: +arg("lambda","1.2"), stopOnConverge: STOP } };
const report = [];
for (const type of TYPES) {
  const w = generateWorld({ type, seed: 20261019, size: 6000, res: RES }, { ecology: false });
  const g = coarse(w); const field = crossField(g); const st = sites(g, w, rngFor(20261019, `evolve:sites:${type}`));
  for (const [name, opt] of Object.entries(VARIANTS)) {
    const t0 = performance.now(); const r = simulate(g, field, st, opt); const ms = performance.now() - t0;
    const r2 = simulate(g, field, st, opt, 7); const h = (x) => createHash('sha256').update(Buffer.from(x.buffer)).digest('hex').slice(0, 12);
    const row = { type, variant: name, grid: g.m, trips: r.trips.length, years: YEARS, convergedYear: r.converged, ms: Math.round(ms), orderIndependent: h(r.tau) === h(r2.tau), ...metrics(g, field, r, st) };
    report.push(row); console.log(JSON.stringify(row)); savePPM(path.join(OUT, `${type}-${name}.ppm`), g, r);
  }
}
fs.writeFileSync(path.join(OUT, 'desire-report.json'), JSON.stringify(report, null, 2));
console.log('out:', OUT);
