import { generateHeightField, carveValleyOutlet } from './terrains.js?v=20';
import { erodeDroplets, thermalErosion, smoothField } from './erosion.js?v=19';
import { buildHydrology } from './hydrology.js?v=20';
import { renderTerrain } from './render.js?v=22';
import { generateTown, ZONE_NAMES } from './town.js?v=24';
import { rngFor } from './rng.js?v=19';
import { create3DView } from './view3d.js?v=30';
import { createRecorder } from './timeline.js';
import { buildTownReplay } from './town-replay.js';
import { computeReflexHeatmap } from './reflex/heatmap.js?v=2';

const $ = (id) => document.getElementById(id);

const canvas = $('canvas');
const canvas3d = $('canvas3d');
const canvasWrap = document.querySelector('.canvas-wrap');
const hintEl = $('hint');
const statusEl = $('status');
const hoverEl = $('hover');
const statsEl = $('stats');
const generateBtn = $('generate');
const minimapCanvas = $('minimapCanvas');
const minimapBox = $('minimapBox');
const timelineBar = $('timelineBar');
const timelinePlayBtn = $('timelinePlay');
const timelineSlider = $('timelineSlider');
const timelineLabel = $('timelineLabel');

let focusedSliceBounds = null; // 当前保持聚焦的 600m 区域 (在各个视图间切换时保持一致)

function updateMinimap() {
  if (!field || !minimapCanvas) return;
  const ctx = minimapCanvas.getContext('2d');
  const size = 96;
  const n = field.n;
  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  // 绘制低分辨率整体全景 (高度+水体基底)
  for (let y = 0; y < size; y++) {
    const gy = Math.floor((y / size) * n);
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x / size) * n);
      const idx = gy * n + gx;
      const k = (y * size + x) * 4;
      const h = field.height[idx];
      const isSea = hydro && hydro.seaMask && hydro.seaMask[idx];
      if (isSea || h <= 0) {
        data[k] = 22; data[k + 1] = 68; data[k + 2] = 104; data[k + 3] = 255;
      } else {
        const u = Math.min(1, Math.max(0, h / 350));
        data[k] = 40 + u * 120;
        data[k + 1] = 75 + u * 80;
        data[k + 2] = 45 + u * 40;
        data[k + 3] = 255;
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // 绘制城镇中心点
  if (town && town.center) {
    const cx = ((town.center.x - field.x0) / field.size) * size;
    const cz = ((town.center.z - field.y0) / field.size) * size;
    ctx.fillStyle = '#ffcc00';
    ctx.beginPath();
    ctx.arc(cx, cz, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  updateMinimapBox();
}

function updateMinimapBox() {
  if (!field || !minimapBox) return;
  const vb = viewBounds || { x0: field.x0, y0: field.y0, size: field.size };
  const size = 96;
  const left = Math.max(0, Math.min(size, ((vb.x0 - field.x0) / field.size) * size));
  const top = Math.max(0, Math.min(size, ((vb.y0 - field.y0) / field.size) * size));
  const w = Math.max(4, Math.min(size - left, (vb.size / field.size) * size));
  const h = Math.max(4, Math.min(size - top, (vb.size / field.size) * size));

  minimapBox.style.left = `${left}px`;
  minimapBox.style.top = `${top}px`;
  minimapBox.style.width = `${w}px`;
  minimapBox.style.height = `${h}px`;
}

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
let recording = null;
let replay = null;
let timelinePlaying = false;
let timelineRaf = null;
let timelineStart = null;
const TIMELINE_DURATION = 8000;
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
    if (timelineBar) timelineBar.hidden = true;
    stopTimeline();
    return true;
  }

  if (!field || !hydro) return false;

  try {
    const v = get3D();
    v.update(field, hydro, town, state.showTown, resetCamera || !view3dReady);
    if (recording && replay) {
      v.initTimeline(recording, replay);
      if (timelineBar) timelineBar.hidden = false;
      applyTimeline(Number(timelineSlider.value) / 1000);
    }
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

    // Record timeline and replay events for 3D playback (ADR-001)
    try {
      const rec = createRecorder(f.n, { keyframeEvery: 6 });
      rec.record(f.height);
      recording = rec.finish();
      replay = buildTownReplay(town);
    } catch (e) {
      console.warn('Timeline recording skipped:', e);
      recording = null;
      replay = null;
    }

    // Compute Reflex Heatmap for Cognitive X-Ray View
    try {
      field.__reflexHeatmap = computeReflexHeatmap({ field, hydro, town, ecology: null }, 160);
      updateAnomalyUI();
    } catch (e) {
      console.error('Reflex heatmap computation error:', e);
      field.__reflexHeatmap = null;
    }

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
    updateMinimap();
    window.__tgl = {
      field,
      hydro,
      town,
      state,
      timings,
      renderInfo,
      get view3d() { return view3d; },
    };
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
    <span class="k">铁路</span><span class="v">${town ? town.stats.railKm.toFixed(1) : '0.0'} km · ${town && town.stats.station ? '有车站' : '无车站'}</span>
    <span class="k">地块</span><span class="v">${fmt(town ? town.stats.parcels : 0)}（已建 ${fmt(town ? town.stats.builtParcels : 0)}）</span>
    <span class="k">中心/住宅</span><span class="v">${town ? town.zoneStats.corePct.toFixed(1) : '0.0'}% / ${town ? town.zoneStats.resPct.toFixed(1) : '0.0'}%</span>
    <span class="k">城镇</span><span class="v">${fmt(timings.town || 0)} ms</span>
    ${field && field.__reflexHeatmap ? `<span class="k">反射健康率</span><span class="v" style="color:${field.__reflexHeatmap.stats.healthyPct > 85 ? '#42d47e' : '#e4b230'}">${field.__reflexHeatmap.stats.healthyPct.toFixed(1)}%</span>` : ''}
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

  let reflexTxt = '';
  if (state.view === 'reflex' && field.__reflexHeatmap) {
    const hm = field.__reflexHeatmap;
    const u = Math.max(0, Math.min(1, (worldX - field.x0) / field.size));
    const v = Math.max(0, Math.min(1, (worldY - field.y0) / field.size));
    const ti = Math.min(hm.cols - 1, Math.floor(u * hm.cols));
    const tj = Math.min(hm.rows - 1, Math.floor(v * hm.rows));
    const s = hm.scores[tj * hm.cols + ti];
    const status = s >= 0.2 ? '🟢 自洽健康' : s >= -0.15 ? '🟡 边缘疑难' : '🔴 违和病理';
    reflexTxt = ` · 反射评分: ${s.toFixed(2)} (${status})`;
  }

  hoverEl.textContent = `x ${fmt(worldX)} m · y ${fmt(worldY)} m · 高度 ${h.toFixed(1)} m · 坡度 ${slope.toFixed(1)}° · 汇流 ${fmt(acc)}${zone ? ` · ${zone}` : ''}${reflexTxt}`;
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
      railway: town.railway ? {
        lengthKm: town.railway.length / 1000,
        bridge: town.railway.bridge,
        station: town.station,
        points: town.railway.pts,
      } : null,
      parcels: town.parcels.map((p) => ({
        x: Math.round(p.x * 10) / 10,
        z: Math.round(p.z * 10) / 10,
        angle: Math.round(p.angle * 1000) / 1000,
        w: Math.round(p.w * 10) / 10,
        d: Math.round(p.d * 10) / 10,
        zone: p.zone,
        built: p.built,
      })),
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
      if (syncMode(false)) {
        if (focusedSliceBounds && view3d && view3dReady) {
          const cx = focusedSliceBounds.x0 + focusedSliceBounds.size / 2;
          const cz = focusedSliceBounds.y0 + focusedSliceBounds.size / 2;
          view3d.focusPoint(cx, cz, 520);
        }
        setStatus(`3D · ${fmt(timings.total)} ms`);
      }
      return;
    }

    const reflexLegend = $('reflexLegend');
    const reflexNavWrap = $('reflexNavWrap');
    if (reflexLegend) {
      reflexLegend.hidden = (state.view !== 'reflex');
    }
    if (reflexNavWrap) {
      reflexNavWrap.hidden = (state.view !== 'reflex');
    }

    const info = renderTerrain(canvas, field, hydro, town, state.view, state.showTown, null, focusedSliceBounds);
    viewBounds = info.viewBounds;
    updateMinimapBox();
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

// --- Timeline controls ---
function applyTimeline(u) {
  if (timelineLabel) timelineLabel.textContent = `${Math.round(u * 100)}%`;
  if (view3d && view3dReady) {
    view3d.setTimeline(u);
  }
}

function stopTimeline() {
  timelinePlaying = false;
  if (timelinePlayBtn) timelinePlayBtn.textContent = '▶ 演化';
  if (timelineRaf) {
    cancelAnimationFrame(timelineRaf);
    timelineRaf = null;
  }
}

function startTimeline() {
  if (!view3dReady) return;
  timelinePlaying = true;
  if (timelinePlayBtn) timelinePlayBtn.textContent = '⏸ 暂停';
  timelineStart = performance.now() - (Number(timelineSlider.value) / 1000) * TIMELINE_DURATION;
  if (Number(timelineSlider.value) >= 1000) {
    timelineStart = performance.now();
    timelineSlider.value = '0';
  }

  function tick(now) {
    if (!timelinePlaying) return;
    const elapsed = now - timelineStart;
    const u = Math.min(1, elapsed / TIMELINE_DURATION);
    timelineSlider.value = String(Math.round(u * 1000));
    applyTimeline(u);
    if (u >= 1) {
      stopTimeline();
      return;
    }
    timelineRaf = requestAnimationFrame(tick);
  }
  timelineRaf = requestAnimationFrame(tick);
}

if (timelinePlayBtn) {
  timelinePlayBtn.addEventListener('click', () => {
    if (timelinePlaying) stopTimeline();
    else startTimeline();
  });
}

if (timelineSlider) {
  timelineSlider.addEventListener('input', () => {
    stopTimeline();
    applyTimeline(Number(timelineSlider.value) / 1000);
  });
}

let currentAnomalyIndex = -1;

function updateAnomalyUI() {
  const countEl = $('anomalyCount');
  const cardEl = $('anomalyCard');
  if (!field || !field.__reflexHeatmap || !field.__reflexHeatmap.anomalies.length) {
    if (countEl) countEl.textContent = '0';
    if (cardEl) {
      cardEl.textContent = '未发现明显违和切片 (全域自洽)';
      cardEl.classList.remove('danger');
    }
    currentAnomalyIndex = -1;
    return;
  }

  const anomalies = field.__reflexHeatmap.anomalies;
  if (countEl) countEl.textContent = String(anomalies.length);
  if (currentAnomalyIndex < 0 || currentAnomalyIndex >= anomalies.length) {
    currentAnomalyIndex = 0;
  }
  showAnomalyCard(anomalies[currentAnomalyIndex]);
}

function showAnomalyCard(anomaly) {
  const cardEl = $('anomalyCard');
  if (!cardEl || !anomaly) return;

  const isDanger = anomaly.score < -0.15;
  cardEl.classList.toggle('danger', isDanger);
  const tag = isDanger ? '🔴 病态违和' : '🟡 边缘疑难';
  const causeList = (anomaly.feat.conflicts || []).map((c) => `• ${c}`).join('<br>');

  cardEl.innerHTML = `
    <b>#${currentAnomalyIndex + 1} ${tag}</b> (评分: ${anomaly.score.toFixed(2)})<br>
    坐标: (${Math.round(anomaly.cx)}, ${Math.round(anomaly.cz)}) · 分区: ${anomaly.feat.dominantZone}<br>
    坡度: 平均 ${anomaly.feat.slopeMean.toFixed(1)}° (最大 ${anomaly.feat.slopeMax.toFixed(1)}°)<br>
    建筑: ${anomaly.feat.buildingCount} 栋 · 道路: ${anomaly.feat.roadDensityKm2.toFixed(1)} km/km²
    <div class="anomaly-cause">${causeList}</div>
  `;
}

function focusCurrentAnomaly() {
  if (!field || !field.__reflexHeatmap) return;
  const anomalies = field.__reflexHeatmap.anomalies;
  if (!anomalies || !anomalies.length) return;

  currentAnomalyIndex = (currentAnomalyIndex + 1) % anomalies.length;
  const a = anomalies[currentAnomalyIndex];
  showAnomalyCard(a);

  // 记录当前聚焦的 600m 空间范围 (供彩色/坡度/高度/3D 跨视图无缝保持一致)
  focusedSliceBounds = {
    x0: a.cx - 300,
    y0: a.cz - 300,
    size: 600,
  };

  // 1. 若处于 3D 模式，平滑飞行镜头到目标点 (保持俯瞰切片特写)
  if (state.view === '3d' && view3d && view3dReady) {
    view3d.focusPoint(a.cx, a.cz, 520);
    setStatus(`聚焦违和切片 #${currentAnomalyIndex + 1} · (${Math.round(a.cx)}, ${Math.round(a.cz)})`);
    updateMinimapBox();
    return;
  }

  // 2. 若处于 2D 模式，居中裁剪显示该切片特写
  const info = renderTerrain(canvas, field, hydro, town, state.view, state.showTown, null, focusedSliceBounds);
  viewBounds = info.viewBounds;
  updateMinimapBox();
  setStatus(`聚焦违和切片 #${currentAnomalyIndex + 1} · (${Math.round(a.cx)}, ${Math.round(a.cz)})`);
}

const btnNextAnomaly = $('btnNextAnomaly');
if (btnNextAnomaly) {
  btnNextAnomaly.addEventListener('click', focusCurrentAnomaly);
}

// Initial render.
generate();
