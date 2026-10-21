import { generateHeightField, carveValleyOutlet } from './terrains.js?v=9';
import { erodeDroplets, thermalErosion, smoothField } from './erosion.js?v=9';
import { buildHydrology } from './hydrology.js?v=9';
import { renderTerrain } from './render.js?v=9';
import { generateTown, ZONE_NAMES } from './town.js?v=9';
import { rngFor } from './rng.js?v=9';
import { create3DView } from './view3d.js?v=13';

const $ = (id) => document.getElementById(id);

const canvas = $('canvas');
const canvas3d = $('canvas3d');
const canvasWrap = document.querySelector('.canvas-wrap');
const hintEl = $('hint');
const statusEl = $('status');
const hoverEl = $('hover');
const statsEl = $('stats');
const generateBtn = $('generate');

const state = {
  type: 'river',
  seed: 20261019,
  size: 6000,
  res: 512,
  erosion: true,
  view: 'color',
  showTown: true,
};

let field = null;
let hydro = null;
let town = null;
let viewBounds = null;
let timings = null;
let droplets = 0;
let generating = false;
let view3d = null;
let view3dReady = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function get3D() {
  if (!view3d) view3d = create3DView(canvas3d);
  return view3d;
}

function syncMode(resetCamera = false) {
  const active3d = state.view === '3d';
  canvasWrap.classList.toggle('mode3d', active3d);
  hintEl.textContent = active3d
    ? '拖动旋转 · 滚轮缩放 · 双击切换全图/城镇。'
    : '鼠标移到画布上查看高度、坡度、汇流量与分区。';

  if (!active3d) {
    if (view3d) view3d.setActive(false);
    return true;
  }

  if (!field || !hydro) return false;

  try {
    const v = get3D();
    v.update(field, hydro, town, state.showTown, resetCamera || !view3dReady);
    v.setActive(true);
    view3dReady = true;
    return true;
  } catch (err) {
    console.error(err);
    canvasWrap.classList.remove('mode3d');
    setStatus(`3D 初始化失败：${err.message}`);
    return false;
  }
}

function fmt(n, digits = 0) {
  return Number(n).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function readUi() {
  state.type = $('type').value;
  state.seed = Math.max(1, Math.floor(Number($('seed').value) || 1));
  state.size = Number($('size').value);
  state.res = Number($('res').value);
  state.erosion = $('erosion').checked;
}

async function generate() {
  if (generating) return;
  generating = true;
  generateBtn.disabled = true;
  setStatus('生成地形…');
  await nextFrame();

  readUi();

  try {
    const t0 = performance.now();
    const f = generateHeightField(state.type, state.seed, state.size, state.res);
    const t1 = performance.now();

    droplets = 0;
    if (state.erosion) {
      setStatus('水滴侵蚀…');
      await nextFrame();

      const tune = f.terrain.tune;
      const cells = f.n * f.n;
      const count = Math.min(Math.floor(cells * tune.droplets), 320000);
      const rng = rngFor(state.seed, `erosion:${state.type}`);

      droplets = erodeDroplets(f.height, {
        n: f.n,
        seaLevel: 0,
        rng,
        droplets: count,
        life: tune.life,
        radius: tune.radius,
        erode: 0.3,
        deposit: 0.3,
      });

      thermalErosion(f.height, f.n, tune.talus, f.cell, 2);
      smoothField(f.height, f.n, tune.soft);
    }
    const t2 = performance.now();

    setStatus('填洼与汇流…');
    await nextFrame();

    const outlets = carveValleyOutlet(f);
    const h = buildHydrology(f, { outlet: outlets });
    const t3 = performance.now();

    setStatus('生成城镇…');
    await nextFrame();
    const townData = generateTown(f, h, state.seed);
    const t4 = performance.now();

    field = f;
    hydro = h;
    town = townData;
    timings = {
      terrain: t1 - t0,
      erosion: t2 - t1,
      hydrology: t3 - t2,
      town: t4 - t3,
      total: t4 - t0,
    };

    const renderInfo = renderTerrain(canvas, field, hydro, town, state.view, state.showTown);
    const { minH, maxH } = renderInfo;
    viewBounds = renderInfo.viewBounds;
    window.__tgl = { field, hydro, town, state, timings, renderInfo };
    updateStats(minH, maxH);
    const ok3d = syncMode(true);
    if (state.view !== '3d' || ok3d) setStatus(`完成 · ${fmt(timings.total)} ms`);
  } catch (err) {
    console.error(err);
    setStatus(`生成失败：${err.message}`);
  } finally {
    generating = false;
    generateBtn.disabled = false;
  }
}

function updateStats(minH = 0, maxH = 0) {
  if (!field || !hydro) {
    statsEl.textContent = '尚未生成';
    return;
  }

  const n = field.n;
  let seaCells = 0;
  for (let i = 0; i < n * n; i++) seaCells += hydro.seaMask[i];
  const seaPct = seaCells / (n * n) * 100;

  statsEl.innerHTML = `
    <span class="k">高度</span><span class="v">${fmt(minH)} – ${fmt(maxH)} m</span>
    <span class="k">海面占比</span><span class="v">${seaPct.toFixed(1)}%</span>
    <span class="k">河网格子</span><span class="v">${fmt(hydro.riverCells)}</span>
    <span class="k">水滴</span><span class="v">${fmt(droplets)}</span>
    <span class="k">地形</span><span class="v">${fmt(timings.terrain)} ms</span>
    <span class="k">侵蚀</span><span class="v">${fmt(timings.erosion)} ms</span>
    <span class="k">水文</span><span class="v">${fmt(timings.hydrology)} ms</span>
    <span class="k">建筑</span><span class="v">${fmt(town ? town.stats.buildings : 0)}</span>
    <span class="k">道路</span><span class="v">${fmt(town ? town.stats.roads : 0)} · ${town ? (town.stats.arterialKm + town.stats.streetKm).toFixed(1) : '0.0'} km</span>
    <span class="k">中心/住宅</span><span class="v">${town ? town.zoneStats.corePct.toFixed(1) : '0.0'}% / ${town ? town.zoneStats.resPct.toFixed(1) : '0.0'}%</span>
    <span class="k">城镇</span><span class="v">${fmt(timings.town || 0)} ms</span>
    <span class="k">总计</span><span class="v">${fmt(timings.total)} ms</span>
  `;
}

function slopeAt(i) {
  const n = field.n;
  const x = i % n;
  const y = (i / n) | 0;
  const ix = x === 0 ? i : i - 1;
  const ix2 = x === n - 1 ? i : i + 1;
  const iy = y === 0 ? i : i - n;
  const iy2 = y === n - 1 ? i : i + n;
  const gx = (field.height[ix2] - field.height[ix]) / (2 * field.cell);
  const gy = (field.height[iy2] - field.height[iy]) / (2 * field.cell);
  return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
}

canvas.addEventListener('pointermove', (event) => {
  if (state.view === '3d' || !field || !hydro) {
    hoverEl.textContent = '';
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const vb = viewBounds || { x0: field.x0, y0: field.y0, size: field.size };
  const worldX = vb.x0 + (event.clientX - rect.left) / rect.width * vb.size;
  const worldY = vb.y0 + (event.clientY - rect.top) / rect.height * vb.size;
  const x = Math.floor((worldX - field.x0) / field.cell);
  const y = Math.floor((worldY - field.y0) / field.cell);

  if (x < 0 || y < 0 || x >= field.n || y >= field.n) {
    hoverEl.textContent = '';
    return;
  }

  const i = y * field.n + x;
  const h = field.height[i];
  const slope = slopeAt(i);
  const acc = hydro.acc[i];
  const zone = town ? ZONE_NAMES[town.zones[i]] : '';

  hoverEl.textContent = `x ${fmt(worldX)} m · y ${fmt(worldY)} m · 高度 ${h.toFixed(1)} m · 坡度 ${slope.toFixed(1)}° · 汇流 ${fmt(acc)}${zone ? ` · ${zone}` : ''}`;
});

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

$('exportPng').addEventListener('click', () => {
  if (!field) return;

  if (state.view === '3d') {
    const a = document.createElement('a');
    a.href = get3D().capture();
    a.download = `terrain-${state.type}-${state.seed}-3d.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }

  canvas.toBlob((blob) => {
    if (blob) download(blob, `terrain-${state.type}-${state.seed}.png`);
  }, 'image/png');
});

$('exportJson').addEventListener('click', () => {
  if (!field) return;

  const previewSize = 48;
  const step = Math.max(1, Math.floor(field.n / previewSize));
  const preview = [];
  for (let y = 0; y < previewSize; y++) {
    const row = [];
    for (let x = 0; x < previewSize; x++) {
      const i = Math.min(field.n - 1, y * step) * field.n + Math.min(field.n - 1, x * step);
      row.push(Math.round(field.height[i] * 10) / 10);
    }
    preview.push(row);
  }

  const data = {
    app: 'terrain-gacha-lab',
    version: 1,
    type: state.type,
    seed: state.seed,
    size: state.size,
    res: state.res,
    erosion: state.erosion,
    view: state.view,
    params: field.params,
    tune: field.terrain.tune,
    stats: {
      riverCells: hydro.riverCells,
      maxAccumulation: hydro.maxAcc,
      droplets,
      timings,
    },
    town: town ? {
      stats: town.stats,
      center: town.center,
      buildings: town.buildings,
    } : null,
    heightPreview: preview,
  };

  download(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    `terrain-${state.type}-${state.seed}.json`,
  );
});

$('dice').addEventListener('click', () => {
  $('seed').value = String(Math.floor(Math.random() * 999999998) + 1);
  generate();
});

generateBtn.addEventListener('click', generate);

for (const id of ['type', 'size', 'res', 'erosion']) {
  $(id).addEventListener('change', generate);
}

$('seed').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') generate();
});

document.querySelectorAll('#views button').forEach((button) => {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b === button));

    if (!field || !hydro) {
      syncMode(false);
      return;
    }

    if (state.view === '3d') {
      if (syncMode(false)) setStatus(`3D · ${fmt(timings.total)} ms`);
      return;
    }

    const info = renderTerrain(canvas, field, hydro, town, state.view, state.showTown);
    viewBounds = info.viewBounds;
    if (window.__tgl) window.__tgl.renderInfo = info;
    syncMode(false);
    setStatus(`完成 · ${fmt(timings.total)} ms`);
  });
});

$('showTown').addEventListener('change', () => {
  state.showTown = $('showTown').checked;

  if (!field || !hydro) return;

  if (state.view === '3d') {
    if (view3dReady) get3D().setShowTown(state.showTown);
    else syncMode(false);
    return;
  }

  const info = renderTerrain(canvas, field, hydro, town, state.view, state.showTown);
  viewBounds = info.viewBounds;
  if (window.__tgl) window.__tgl.renderInfo = info;
  syncMode(false);
});

// Initial render.
generate();
