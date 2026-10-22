#!/usr/bin/env node
/**
 * The judge: generate a matrix of worlds and score them against explicit
 * invariants, so rule changes (by hand or by AI) can be iterated quickly and
 * measured instead of eyeballed.
 *
 *   node test/judge.mjs                 full matrix
 *   node test/judge.mjs --quick         smaller matrix (~10 s)
 *   node test/judge.mjs --update-baseline   accept the current scores (per mode)
 *   node test/judge.mjs --json          print the report as JSON
 *   node test/judge.mjs --out=FILE      where to write the full report
 *                                       (default: $TMPDIR/terrain-judge-report.json)
 *
 * Rules come in two kinds:
 *   gate    must pass; a failure exits with code 1.
 *   target  where the generator should get to; failures are reported, and only
 *           a regression against the saved baseline exits with code 1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateWorld } from './judge/world.mjs';
import { TERRAIN_IDS, TERRAINS } from '../src/terrains.js';
import { worldMetrics, worldHash } from './judge/metrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, 'judge.baseline.json');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const REPORT = outArg ? outArg.slice(6) : path.join(os.tmpdir(), 'terrain-judge-report.json');

const args = new Set(process.argv.slice(2));
const quick = args.has('--quick');

const MATRIX = quick
  ? { seeds: [11, 22, 33], size: 6000, res: 256, consistency: { seeds: [11], size: 4000, res: [256, 512] } }
  : { seeds: [11, 22, 33, 44, 55, 66], size: 6000, res: 256, consistency: { seeds: [11, 22], size: 4000, res: [512, 1024] } };

/* ------------------------------------------------------------------ */

const stats = {
  max: (a) => Math.max(...a),
  min: (a) => Math.min(...a),
  mean: (a) => a.reduce((s, v) => s + v, 0) / a.length,
  median: (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; },
  cv: (a) => { const m = stats.mean(a); return m > 0 ? Math.sqrt(stats.mean(a.map((v) => (v - m) ** 2))) / m : 0; },
};

/**
 * Each rule reduces the collected data to one number and compares it with a
 * threshold. `better` says which direction is an improvement.
 */
const RULES = [
  // ---- gates: things that are true today and must stay true ----
  { id: 'determinism', kind: 'gate', label: '同输入两次生成完全一致（不一致的世界数）',
    value: (d) => d.determinismFailures, op: '<=', limit: 0, better: 'lower' },
  { id: 'hydro_sinks', kind: 'gate', label: '陆地内部无排水死点（最多格数）',
    value: (d) => stats.max(d.worlds.map((w) => w.m.hydro_sinks)), op: '<=', limit: 0, better: 'lower' },
  { id: 'hydro_mass', kind: 'gate', label: '汇流守恒误差（最大）',
    value: (d) => stats.max(d.worlds.map((w) => w.m.hydro_mass_error)), op: '<=', limit: 1e-6, better: 'lower' },
  { id: 'hydro_uphill', kind: 'gate', label: '河道逆坡格子（最多）',
    value: (d) => stats.max(d.worlds.map((w) => w.m.hydro_uphill_river_cells)), op: '<=', limit: 0, better: 'lower' },


  // ---- targets: where the town generator should get to ----
  { id: 'island_rail_dry', kind: 'target', label: '海岛铁路不下海（落水点最多）',
    value: (d) => stats.max(d.worlds.filter((w) => TERRAINS[w.type].island).map((w) => w.m.rail_wet_points).concat(0)),
    op: '<=', limit: 0, better: 'lower' },
  { id: 'bld_on_road', kind: 'target', label: '建筑压在道路上（最差世界 %）',
    value: (d) => stats.max(d.worlds.map((w) => w.m.bld_on_road_pct)), op: '<=', limit: 1, better: 'lower' },
  { id: 'bld_overlap', kind: 'target', label: '建筑互相重叠（最差世界 %）',
    value: (d) => stats.max(d.worlds.map((w) => w.m.bld_overlap_pct)), op: '<=', limit: 0.5, better: 'lower' },
  { id: 'bld_on_rail', kind: 'target', label: '建筑压在铁路上（最差世界 %）',
    value: (d) => stats.max(d.worlds.map((w) => w.m.bld_on_rail_pct)), op: '<=', limit: 0, better: 'lower' },
  { id: 'bld_bad_site', kind: 'target', label: '建筑落在水面/无分区/陡坡（最差世界 %）',
    value: (d) => stats.max(d.worlds.map((w) => w.m.bld_bad_site_pct)), op: '<=', limit: 0.5, better: 'lower' },
  { id: 'bld_in_river', kind: 'target', label: '建筑压在河道上（按汇流面积定河宽，最差世界 %）',
    value: (d) => stats.max(d.worlds.map((w) => w.m.bld_in_river_pct)), op: '<=', limit: 0, better: 'lower' },
  { id: 'station_rate', kind: 'target', label: '有站房的世界比例 %',
    value: (d) => stats.mean(d.worlds.map((w) => w.m.station_building)) * 100, op: '>=', limit: 100, better: 'higher' },
  { id: 'road_connected', kind: 'target', label: '道路主连通分量占总长（最差世界 %）',
    value: (d) => stats.min(d.worlds.map((w) => w.m.road_main_component_pct)), op: '>=', limit: 90, better: 'higher' },
  { id: 'road_dead_ends', kind: 'target', label: '道路断头端点比例（平均 %）',
    value: (d) => stats.mean(d.worlds.map((w) => w.m.road_dead_end_pct)), op: '<=', limit: 35, better: 'lower' },
  { id: 'town_min_size', kind: 'target', label: '最小城镇建筑数（任一地形任一 seed）',
    value: (d) => stats.min(d.worlds.map((w) => w.m.buildings)), op: '>=', limit: 150, better: 'higher' },
  { id: 'town_stability', kind: 'target', label: '建筑数跨 seed 变异系数（最差地形）',
    value: (d) => stats.max(TERRAIN_IDS.map((t) => stats.cv(d.worlds.filter((w) => w.type === t).map((w) => w.m.buildings)))),
    op: '<=', limit: 0.35, better: 'lower' },
  { id: 'res_buildings', kind: 'target', label: '分辨率一致性：建筑数 低/高 比（最差）',
    value: (d) => stats.min(d.consistency.map((c) => c.bldRatio)), op: '>=', limit: 0.8, better: 'higher' },
  { id: 'res_rivers', kind: 'target', label: '分辨率一致性：河网面积 低/高 比（最差）',
    value: (d) => stats.min(d.consistency.map((c) => c.riverRatio)), op: '>=', limit: 0.7, better: 'higher' },
  { id: 'res_core', kind: 'target', label: '分辨率一致性：中心区面积 低/高 比（最差）',
    value: (d) => stats.min(d.consistency.map((c) => c.coreRatio)), op: '>=', limit: 0.8, better: 'higher' },
];

const ratio = (a, b) => (Math.max(a, b) > 0 ? Math.min(a, b) / Math.max(a, b) : 1);

/* ------------------------------------------------------------------ */

async function collect() {
  const worlds = [];
  let determinismFailures = 0;

  for (const type of TERRAIN_IDS) {
    for (const seed of MATRIX.seeds) {
      const opts = { type, seed, size: MATRIX.size, res: MATRIX.res, erosion: true };
      const world = await generateWorld(opts);
      worlds.push({ type, seed, m: worldMetrics(world) });

      // Determinism: regenerate the first seed of every terrain.
      if (seed === MATRIX.seeds[0]) {
        const again = await generateWorld(opts);
        if (worldHash(world) !== worldHash(again)) determinismFailures++;
      }
      if (!args.has('--json')) process.stdout.write('.');
    }
  }

  const consistency = [];
  const C = MATRIX.consistency;
  for (const type of TERRAIN_IDS) {
    for (const seed of C.seeds) {
      const runs = [];
      for (const res of C.res) {
        const w = await generateWorld({ type, seed, size: C.size, res, erosion: true });
        const n = w.field.n;
        let core = 0;
        for (let i = 0; i < n * n; i++) if (w.town.zones[i] === 1) core++;
        runs.push({
          res,
          buildings: w.town.buildings.length,
          river: w.hydro.riverCells * w.field.cell ** 2,
          core: core * w.field.cell ** 2,
        });
        if (!args.has('--json')) process.stdout.write('·');
      }
      const [a, b] = runs;
      consistency.push({
        type, seed,
        res: C.res,
        buildings: [a.buildings, b.buildings],
        bldRatio: ratio(a.buildings, b.buildings),
        riverRatio: ratio(a.river, b.river),
        coreRatio: ratio(a.core, b.core),
      });
    }
  }
  if (!args.has('--json')) process.stdout.write('\n');

  return { worlds, consistency, determinismFailures };
}

function judge(data, baseline) {
  return RULES.map((r) => {
    const value = r.value(data);
    const pass = r.op === '<=' ? value <= r.limit : value >= r.limit;
    let regression = false;
    let prev = null;
    if (baseline && baseline.rules && r.id in baseline.rules) {
      prev = baseline.rules[r.id];
      const tol = Math.max(Math.abs(prev) * 0.05, 1e-9);
      regression = r.better === 'lower' ? value > prev + tol : value < prev - tol;
    }
    return { id: r.id, kind: r.kind, label: r.label, value, op: r.op, limit: r.limit, pass, prev, regression };
  });
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (Math.abs(v) < 1e-3 && v !== 0) return v.toExponential(1);
  return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1);
}

function printTable(results, data) {
  const rows = results.map((r) => [
    r.pass ? 'PASS' : (r.kind === 'gate' ? 'FAIL' : 'TODO'),
    r.kind,
    r.id,
    fmt(r.value),
    `${r.op} ${fmt(r.limit)}`,
    r.prev === null ? '' : `${fmt(r.prev)}${r.regression ? '  ↓REGRESSED' : ''}`,
    r.label,
  ]);
  const head = ['', 'kind', 'rule', 'value', 'limit', 'baseline', ''];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const line = (row) => row.map((c, i) => (i === row.length - 1 ? c : String(c).padEnd(widths[i]))).join('  ');
  console.log(line(head));
  for (const row of rows) console.log(line(row));

  console.log('\nper terrain (mean over seeds):');
  for (const t of TERRAIN_IDS) {
    const ws = data.worlds.filter((w) => w.type === t);
    const mean = (k) => stats.mean(ws.map((w) => w.m[k]));
    console.log(`  ${t.padEnd(8)} bld ${fmt(mean('buildings')).padStart(6)}  onRoad ${fmt(mean('bld_on_road_pct')).padStart(5)}%  overlap ${fmt(mean('bld_overlap_pct')).padStart(5)}%  deadEnds ${fmt(mean('road_dead_end_pct')).padStart(5)}%  connected ${fmt(mean('road_main_component_pct')).padStart(5)}%  ${fmt(mean('ms_total'))} ms`);
  }
  console.log('\nresolution consistency:');
  for (const c of data.consistency) {
    console.log(`  ${c.type.padEnd(8)} seed ${c.seed}  res ${c.res.join('/')}  buildings ${c.buildings.join(' → ')}  ratios bld ${fmt(c.bldRatio)} river ${fmt(c.riverRatio)} core ${fmt(c.coreRatio)}`);
  }
}

const MODE = quick ? 'quick' : 'full';
const baselineFile = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const baseline = baselineFile[MODE] || null;
const sameMatrix = baseline && JSON.stringify(baseline.matrix) === JSON.stringify(MATRIX);
const data = await collect();
const results = judge(data, sameMatrix ? baseline : null);

const report = { matrix: MATRIX, results, worlds: data.worlds, consistency: data.consistency };
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printTable(results, data);
  if (baseline && !sameMatrix) console.log('\n(baseline was recorded with a different matrix; regression check skipped)');
}

if (args.has('--update-baseline')) {
  const rules = Object.fromEntries(results.map((r) => [r.id, r.value]));
  baselineFile[MODE] = { matrix: MATRIX, rules };
  fs.writeFileSync(BASELINE, `${JSON.stringify(baselineFile, null, 2)}\n`);
  console.log(`\nbaseline (${MODE}) updated → ${path.relative(process.cwd(), BASELINE)}`);
}

const gateFail = results.filter((r) => r.kind === 'gate' && !r.pass);
const regressions = results.filter((r) => r.regression);
const todo = results.filter((r) => r.kind === 'target' && !r.pass);
if (!args.has('--json')) {
  console.log(`\ngates ${results.filter((r) => r.kind === 'gate').length - gateFail.length}/${results.filter((r) => r.kind === 'gate').length} · targets ${results.filter((r) => r.kind === 'target').length - todo.length}/${results.filter((r) => r.kind === 'target').length} · regressions ${regressions.length}`);
}
process.exitCode = gateFail.length || (regressions.length && !args.has('--update-baseline')) ? 1 : 0;
