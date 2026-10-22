import { clamp, rngFor, smoothstep } from './rng.js?v=19';
import { ZONE, ZONE_COLORS } from './town.js?v=24';
import { buildEcology, BIOME } from './ecology.js?v=1';

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function heightColor(h) {
  if (h < 0) return [8, 26, 55];
  if (h < 1.2) return mix([208, 194, 150], [190, 180, 140], h / 1.2);
  if (h < 90) return mix([92, 142, 82], [58, 108, 64], (h - 1.2) / 88.8);
  if (h < 260) return mix([58, 108, 64], [78, 92, 70], (h - 90) / 170);
  if (h < 520) return mix([112, 105, 94], [142, 134, 123], (h - 260) / 260);
  if (h < 900) return mix([142, 134, 123], [190, 190, 190], (h - 520) / 380);
  return mix([210, 214, 218], [244, 247, 250], clamp((h - 900) / 500, 0, 1));
}

function slopeColor(angle) {
  if (angle < 5) return mix([62, 132, 92], [120, 170, 90], angle / 5);
  if (angle < 15) return mix([120, 170, 90], [208, 186, 84], (angle - 5) / 10);
  if (angle < 30) return mix([208, 186, 84], [214, 126, 66], (angle - 15) / 15);
  return mix([214, 126, 66], [150, 66, 66], clamp((angle - 30) / 25, 0, 1));
}

function flowColor(t) {
  if (t < 0.33) return mix([16, 26, 44], [36, 84, 142], t / 0.33);
  if (t < 0.72) return mix([36, 84, 142], [74, 176, 214], (t - 0.33) / 0.39);
  return mix([74, 176, 214], [228, 247, 255], (t - 0.72) / 0.28);
}

function reflexColor(score) {
  // score in [-1, +1]
  // 明显的高对比度热力图色彩：
  // 正常自洽健康 (高分 >0.15): 纯正明亮的翠绿
  // 边缘疑难过渡 (-0.1 .. 0.15): 鲜艳明亮的柠檬黄 / 金黄
  // 违和病理异常 (低分 <-0.1): 高饱和度的朱红 / 亮红
  if (score >= 0.15) {
    const t = clamp((score - 0.15) / 0.45, 0, 1);
    return mix([50, 205, 50], [0, 255, 128], t); // Lime to bright Spring Green
  }
  if (score >= -0.1) {
    const t = clamp((score - (-0.1)) / 0.25, 0, 1);
    return mix([255, 215, 0], [173, 255, 47], t); // Gold to YellowGreen
  }
  const t = clamp((score - (-0.6)) / 0.5, 0, 1);
  return mix([255, 30, 30], [255, 140, 0], t); // Bright Red to DarkOrange
}

function shade(rgb, factor) {
  return [
    clamp(rgb[0] * factor, 0, 255),
    clamp(rgb[1] * factor, 0, 255),
    clamp(rgb[2] * factor, 0, 255),
  ];
}

function sampleGrid(arr, n, x, y) {
  const x0 = Math.min(n - 1, Math.max(0, Math.floor(x)));
  const y0 = Math.min(n - 1, Math.max(0, Math.floor(y)));
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));

  return arr[y0 * n + x0] * (1 - fx) * (1 - fy)
    + arr[y0 * n + x1] * fx * (1 - fy)
    + arr[y1 * n + x0] * (1 - fx) * fy
    + arr[y1 * n + x1] * fx * fy;
}

function smoothPath(pts, samples = 5) {
  if (pts.length < 3) return pts;

  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const t2 = t * t;
      const t3 = t2 * t;

      out.push([
        0.5 * (2 * p1[0]
          + (-p0[0] + p2[0]) * t
          + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
          + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1]
          + (-p0[1] + p2[1]) * t
          + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
          + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function traceRiverPaths(hydro, n) {
  const { dir, acc, riverMask, seaMask, minAcc } = hydro;
  const hasUpstream = new Uint8Array(n * n);

  for (let i = 0; i < n * n; i++) {
    const d = dir[i];
    if (d >= 0 && riverMask[d]) hasUpstream[d] = 1;
  }

  const margin = 3;
  let sources = [];
  for (let i = 0; i < n * n; i++) {
    const x = i % n;
    const y = (i / n) | 0;
    if (x < margin || y < margin || x >= n - margin || y >= n - margin) continue;
    if (riverMask[i] && !hasUpstream[i]) sources.push(i);
  }
  if (sources.length === 0) {
    for (let i = 0; i < n * n; i++) {
      const x = i % n;
      const y = (i / n) | 0;
      if (x < margin || y < margin || x >= n - margin || y >= n - margin) continue;
      if (riverMask[i] && acc[i] >= minAcc * 4) sources.push(i);
    }
  }

  if (sources.length > 900) {
    sources.sort((a, b) => acc[b] - acc[a]);
    sources = sources.slice(0, 900);
  }

  const paths = [];

  for (const source of sources) {
    let i = source;
    const pts = [];

    for (let step = 0; step < 3000; step++) {
      pts.push([i % n + 0.5, ((i / n) | 0) + 0.5]);

      if (seaMask[i]) break;
      const d = dir[i];
      if (d < 0) break;
      if (!riverMask[d] && acc[d] < minAcc * 0.35) break;

      i = d;
    }

    let pathLength = 0;
    for (let k = 1; k < pts.length; k++) {
      pathLength += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }

    if (pts.length >= 4 && pathLength >= 5) {
      paths.push({ pts: smoothPath(pts, 5), acc: acc[source] });
    }
  }

  return paths;
}

function strokePath(ctx, pts, project) {
  const start = project(pts[0][0], pts[0][1]);
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  for (let i = 1; i < pts.length; i++) {
    const p = project(pts[i][0], pts[i][1]);
    ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
}

function drawRiverPaths(ctx, paths, maxAcc, project, scale, maxWidth = 46) {
  if (paths.length === 0) return;

  paths.sort((a, b) => a.acc - b.acc);

  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';

  // Dark channel base, so the river sits inside the terrain rather than on top.
  for (const path of paths) {
    const width = (1.1 + 4.0 * Math.sqrt(Math.max(1, path.acc) / maxAcc)) * scale;
    ctx.strokeStyle = 'rgba(26, 70, 98, 0.38)';
    ctx.lineWidth = Math.min(width * 2.0, maxWidth * 1.6);
    strokePath(ctx, path.pts, project);
  }

  // Water core.
  for (const path of paths) {
    const width = (0.8 + 3.4 * Math.sqrt(Math.max(1, path.acc) / maxAcc)) * scale;
    ctx.strokeStyle = 'rgba(92, 172, 218, 0.78)';
    ctx.lineWidth = Math.max(1, Math.min(width, maxWidth));
    strokePath(ctx, path.pts, project);
  }

  // Thin highlight along the centre.
  for (const path of paths) {
    const width = (0.4 + 1.4 * Math.sqrt(Math.max(1, path.acc) / maxAcc)) * scale;
    ctx.strokeStyle = 'rgba(178, 226, 244, 0.30)';
    ctx.lineWidth = Math.max(0.8, Math.min(width, maxWidth * 0.5));
    strokePath(ctx, path.pts, project);
  }

  ctx.restore();
}

export function renderTerrain(canvas, field, hydro, town, view = 'color', showTown = true, ecology = null) {
  const { n, height, cell, size } = field;
  // Only the color and town views consume ecology fields; other views keep
  // the old (cheaper) path even when a 7-arg call passes nothing.
  const needsEcology = view === 'color' || view === 'town';
  const eco = needsEcology ? (ecology || buildEcology(field, hydro, town)) : null;
  const outN = n * 2;
  const viewBounds = view === 'town' && town
    ? computeTownView(field, town)
    : { x0: field.x0, y0: field.y0, size: field.size };

  canvas.width = outN;
  canvas.height = outN;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(outN, outN);
  const data = image.data;

  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < n * n; i++) {
    if (height[i] < minH) minH = height[i];
    if (height[i] > maxH) maxH = height[i];
  }

  const light = [-0.48, 0.78, -0.4];
  const lightLen = Math.hypot(...light);
  light[0] /= lightLen;
  light[1] /= lightLen;
  light[2] /= lightLen;

  for (let oy = 0; oy < outN; oy++) {
    const wz = viewBounds.y0 + (oy / (outN - 1)) * viewBounds.size;
    const gy = (wz - field.y0) / cell;

    for (let ox = 0; ox < outN; ox++) {
      const wx = viewBounds.x0 + (ox / (outN - 1)) * viewBounds.size;
      const gx = (wx - field.x0) / cell;
      const i = oy * outN + ox;

      const h = sampleGrid(height, n, gx, gy);
      const sea = h <= 0;
      const dSea = sampleGrid(hydro.dSea, n, gx, gy);
      const dLand = sampleGrid(hydro.dLand, n, gx, gy);
      const acc = sampleGrid(hydro.acc, n, gx, gy);

      const eps = 0.5;
      const dhx = (sampleGrid(height, n, gx + eps, gy) - sampleGrid(height, n, gx - eps, gy)) / (2 * eps * cell);
      const dhy = (sampleGrid(height, n, gx, gy + eps) - sampleGrid(height, n, gx, gy - eps)) / (2 * eps * cell);
      const angle = Math.atan(Math.hypot(dhx, dhy)) * 180 / Math.PI;

      let rgb;
      let shadeFactor = 1;

      if (view === 'height') {
        const t = clamp((h - minH) / Math.max(1e-6, maxH - minH), 0, 1);
        const v = sea ? 18 : 24 + 220 * t;
        rgb = [v, v, v];
      } else if (view === 'slope') {
        rgb = sea ? [16, 32, 48] : slopeColor(angle);
      } else if (view === 'flow') {
        if (sea) {
          rgb = [12, 28, 48];
        } else {
          const t = clamp(Math.log1p(acc) / Math.log1p(hydro.maxAcc), 0, 1);
          rgb = flowColor(t);
        }
      } else if (view === 'reflex') {
        // 反射层诊断视图：利用传入的 reflexHeatmap 双线性采样打分
        if (field.__reflexHeatmap) {
          const hm = field.__reflexHeatmap;
          const u = clamp((wx - field.x0) / field.size, 0, 1);
          const v = clamp((wz - field.y0) / field.size, 0, 1);
          const s = sampleGrid(hm.scores, hm.cols, u * (hm.cols - 1), v * (hm.rows - 1));
          rgb = reflexColor(s);
          shadeFactor = 1.0; // 不压暗，保证鲜艳明亮对比
        } else {
          rgb = [40, 50, 60];
        }
      } else if (view === 'town') {
        rgb = sea ? [14, 32, 46] : mix([28, 32, 38], heightColor(h), 0.18);
        shadeFactor = 0.85;
        if (!sea && eco) {
          // Low-intensity forest tint only; tree canopies are skipped in the
          // town view so roads, parcels and rails stay readable.
          const forestV = sampleGrid(eco.forest, n, gx, gy);
          if (forestV > 0.15) {
            rgb = mix(rgb, [44, 78, 52], Math.min(0.34, 0.3 * forestV));
          }
        }
      } else {
        rgb = heightColor(h);

        if (sea) {
          let depth = clamp(dLand / 70, 0, 1);
          depth = clamp(depth + 0.03 * Math.sin(gx * 0.07 + gy * 0.05) * (1 - depth), 0, 1);
          const floorDepth = clamp(-h / 45, 0, 1);
          rgb = mix([64, 140, 176], [6, 20, 46], Math.max(depth, floorDepth * 0.7));
          if (dLand <= 4) rgb = mix(rgb, [96, 156, 172], 0.30);
          shadeFactor = 1;
        } else if (eco) {
          const b = sampleBiome(eco.biome, n, gx, gy);
          const moist = sampleGrid(eco.moisture, n, gx, gy);
          const forestV = sampleGrid(eco.forest, n, gx, gy);
          const rockV = sampleGrid(eco.rock, n, gx, gy);
          const snowV = sampleGrid(eco.snow, n, gx, gy);
          const beachV = sampleGrid(eco.beach, n, gx, gy);

          // Grass base modulated by elevation and moisture, so flats never
          // read as one flat swatch.
          rgb = mix([118, 150, 84], [140, 152, 94], clamp((h - 4) / 700, 0, 1));
          rgb = mix(rgb, [176, 162, 100], (1 - moist) * 0.38);

          if (b === BIOME.FOREST) {
            rgb = mix(rgb, [44, 82, 52], 0.42 + 0.38 * forestV);
          }
          if (b === BIOME.WETLAND) {
            rgb = mix(rgb, [66, 104, 80], 0.8);
          }

          // Rock and snow use the continuous ecology fields, giving soft
          // transitions instead of hard biome edges.
          if (rockV > 0.16) {
            rgb = mix(rgb, [140, 134, 122], smoothstep(0.16, 0.62, rockV));
          }
          if (snowV > 0.1) {
            rgb = mix(rgb, [233, 239, 245], smoothstep(0.1, 0.55, snowV));
          }
          if (beachV > 0.02) {
            rgb = mix(rgb, [214, 200, 152], Math.min(1, beachV) * 0.94);
          }

          const nx = -dhx;
          const ny = 1;
          const nz = -dhy;
          const inv = 1 / Math.hypot(nx, ny, nz);
          shadeFactor = clamp((nx * light[0] + ny * light[1] + nz * light[2]) * inv, 0.48, 1.32);
          shadeFactor *= 1 + 0.06 * clamp(h / 1200, 0, 1);

          if (dSea <= 4) rgb = mix(rgb, [96, 156, 172], 0.28);
        }
      }

      rgb = shade(rgb, shadeFactor);

      if (showTown && town && view !== 'height' && view !== 'slope' && view !== 'flow') {
        const zx = clamp(Math.round(gx), 0, n - 1);
        const zy = clamp(Math.round(gy), 0, n - 1);
        const zone = town.zones[zy * n + zx];
        if (zone !== ZONE.NONE && zone !== ZONE.WATER) {
          const strength = view === 'town' ? 0.65 : 0.32;
          rgb = mix(rgb, ZONE_COLORS[zone], strength);
        }
      }

      const p = i * 4;
      data[p] = rgb[0] | 0;
      data[p + 1] = rgb[1] | 0;
      data[p + 2] = rgb[2] | 0;
      data[p + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  let treeClusters = 0;
  if (view === 'color' && eco) {
    // Canopies sit on top of the base image but underneath rivers and the
    // town overlay, so roads/buildings always win.
    const clusters = buildTreeClusters(field, eco, town);
    treeClusters = clusters.length;
    drawTreeClusters(ctx, field, clusters, outN, viewBounds);
  }

  let riverPaths = 0;
  let riverSample = null;

  if (view === 'color' || view === 'flow' || view === 'town') {
    const paths = traceRiverPaths(hydro, n);
    riverPaths = paths.length;
    riverSample = paths[0] ? paths[0].pts.slice(0, 16) : null;
    const pixelPerGrid = cell / viewBounds.size * outN;
    const projectRiver = (gx, gy) => [
      (field.x0 + gx * cell - viewBounds.x0) / viewBounds.size * outN,
      (field.y0 + gy * cell - viewBounds.y0) / viewBounds.size * outN,
    ];
    ctx.save();
    if (view === 'flow') ctx.globalAlpha = 0.68;
    else if (view === 'town') ctx.globalAlpha = 0.55;
    drawRiverPaths(
      ctx,
      paths,
      hydro.maxAcc,
      projectRiver,
      pixelPerGrid,
      view === 'town' ? 20 : 46,
    );
    ctx.restore();
  }

  if (showTown && town && (view === 'color' || view === 'town' || view === 'reflex')) {
    drawTown(ctx, field, town, outN, view, viewBounds);
  }

  drawScaleBar(ctx, outN, viewBounds.size, view);

  return {
    minH,
    maxH,
    riverPaths,
    riverSample,
    townBuildings: town ? town.buildings.length : 0,
    townRoads: town ? town.roads.length : 0,
    viewBounds,
    treeClusters,
    ecoStats: eco ? eco.stats : null,
  };
}

function sampleBiome(biome, n, gx, gy) {
  const x = clamp(Math.round(gx), 0, n - 1);
  const y = clamp(Math.round(gy), 0, n - 1);
  return biome[y * n + x];
}

const TREE_CLUSTER_MAX = 5200;

/**
 * Deterministic canopy clusters for the color view.
 *
 * Candidates are every FOREST cell outside effective town zones (CORE/RES/
 * PADDY/IND/HAMLET). A partial Fisher-Yates driven by
 * rngFor(field.seed, 'trees2d:' + terrain.id) picks up to TREE_CLUSTER_MAX
 * clusters, so the same seed always yields the same forest.
 */
function buildTreeClusters(field, eco, town, maxClusters = TREE_CLUSTER_MAX) {
  const { n } = field;
  const { biome } = eco;
  const zones = town && town.zones && town.zones.length === n * n ? town.zones : null;
  const rng = rngFor(field.seed ?? 0, 'trees2d:' + (field.terrain?.id ?? 'unknown'));

  const candidates = [];
  for (let i = 0; i < n * n; i++) {
    if (biome[i] !== BIOME.FOREST) continue;
    if (zones && zones[i] !== ZONE.NONE && zones[i] !== ZONE.WATER) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) return [];

  const take = Math.min(candidates.length, maxClusters);
  for (let k = 0; k < take; k++) {
    const j = k + Math.floor(rng() * (candidates.length - k));
    const tmp = candidates[k];
    candidates[k] = candidates[j];
    candidates[j] = tmp;
  }

  const clusters = new Array(take);
  for (let k = 0; k < take; k++) {
    const i = candidates[k];
    const gx = (i % n) + 0.5;
    const gy = ((i / n) | 0) + 0.5;

    // Three canopy tiers plus a small jitter, expressed in grid cells.
    const tier = rng();
    let base = tier < 0.34 ? 1.15 : tier < 0.76 ? 1.6 : 2.2;
    base *= 0.85 + 0.3 * rng();

    const satellites = [];
    for (const spec of [0.52 + 0.16 * rng(), 0.3 + 0.14 * rng()]) {
      const ang = rng() * Math.PI * 2;
      satellites.push({
        dx: Math.cos(ang) * base * 0.55,
        dy: Math.sin(ang) * base * 0.55,
        r: base * spec,
      });
    }

    clusters[k] = { gx, gy, base, satellites };
  }
  return clusters;
}

/**
 * Draw canopy clusters as three merged fills (deep base + two lighter
 * satellite passes). Merging the arcs into one path per layer keeps the
 * ~5k-cluster case fast.
 */
function drawTreeClusters(ctx, field, clusters, outN, viewBounds) {
  if (clusters.length === 0) return;

  const scale = outN / viewBounds.size; // px per metre
  const pxPerCell = field.cell * scale;
  const project = (gx, gy) => [
    (field.x0 + gx * field.cell - viewBounds.x0) * scale,
    (field.y0 + gy * field.cell - viewBounds.y0) * scale,
  ];

  ctx.save();

  ctx.beginPath();
  for (const c of clusters) {
    const [px, py] = project(c.gx, c.gy);
    const r = Math.max(0.6, c.base * pxPerCell);
    ctx.moveTo(px + r, py);
    ctx.arc(px, py, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = 'rgba(24, 55, 35, 0.95)';
  ctx.fill();

  const drawSatellites = (sel, color) => {
    ctx.beginPath();
    for (const c of clusters) {
      const s = c.satellites[sel];
      const [px, py] = project(c.gx + s.dx, c.gy + s.dy);
      const r = Math.max(0.45, s.r * pxPerCell);
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = color;
    ctx.fill();
  };
  drawSatellites(0, 'rgba(46, 92, 55, 0.92)');
  drawSatellites(1, 'rgba(78, 130, 72, 0.85)');

  ctx.restore();
}

function computeTownView(field, town) {
  let c = town.center;

  if (town.buildings.length > 0) {
    let cx = 0;
    let cz = 0;
    for (const b of town.buildings) {
      cx += b.x;
      cz += b.z;
    }
    c = { x: cx / town.buildings.length, z: cz / town.buildings.length };
  }

  const dists = town.buildings
    .map((b) => Math.hypot(b.x - c.x, b.z - c.z))
    .sort((a, b) => a - b);

  const p90 = dists.length
    ? dists[Math.floor(dists.length * 0.9)]
    : field.size * 0.08;
  const half = clamp(p90 * 1.15, field.size * 0.05, field.size * 0.28);
  const size = half * 2;

  let x0 = c.x - half;
  let y0 = c.z - half;
  if (x0 < field.x0) x0 = field.x0;
  if (y0 < field.y0) y0 = field.y0;
  if (x0 + size > field.x0 + field.size) x0 = field.x0 + field.size - size;
  if (y0 + size > field.y0 + field.size) y0 = field.y0 + field.size - size;

  return { x0, y0, size };
}

const BUILDING_COLORS = {
  commercial: [226, 178, 104],
  apartment: [198, 154, 132],
  house: [210, 190, 158],
  industrial: [160, 138, 172],
  warehouse: [142, 152, 162],
  farmhouse: [184, 164, 132],
  station: [232, 190, 110],
};

function drawParcels(ctx, parcels, sx, sz, scale, view, outN) {
  if (!parcels || view !== 'town') return;

  ctx.save();
  ctx.lineWidth = 0.8;

  for (const parcel of parcels) {
    const px = sx(parcel.x);
    const pz = sz(parcel.z);
    if (px < -40 || pz < -40 || px > outN + 40 || pz > outN + 40) continue;

    const w = parcel.w * scale;
    const d = parcel.d * scale;
    if (w < 2.5 || d < 2.5) continue;

    const zc = ZONE_COLORS[parcel.zone];
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(parcel.angle);

    if (zc) {
      ctx.fillStyle = `rgba(${zc[0]},${zc[1]},${zc[2]},${parcel.built ? 0.02 : 0.05})`;
      ctx.fillRect(-w / 2, -d / 2, w, d);
    }

    ctx.strokeStyle = 'rgba(235,240,230,0.14)';
    ctx.strokeRect(-w / 2, -d / 2, w, d);
    ctx.restore();
  }

  ctx.restore();
}

function drawRailway(ctx, town, sx, sz, scale, view) {
  const rail = town.railway;
  if (!rail || rail.pts.length < 2) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const line = (pts, width, color) => {
    ctx.beginPath();
    ctx.moveTo(sx(pts[0][0]), sz(pts[0][1]));
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(sx(pts[i][0]), sz(pts[i][1]));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  const bedWidth = Math.max(view === 'town' ? 5.6 : 2.6, 9 * scale);
  line(rail.pts, bedWidth, view === 'town' ? 'rgba(48,29,17,0.98)' : 'rgba(16,12,10,0.95)');

  const offset = 1.6;
  const left = [];
  const right = [];

  for (let i = 0; i < rail.pts.length; i++) {
    const [x, z] = rail.pts[i];
    const [px, pz] = i === 0 ? rail.pts[1] : rail.pts[i - 1];
    const [nx, nz] = i === rail.pts.length - 1 ? rail.pts[i - 1] : rail.pts[i + 1];
    let tx = nx - px;
    let tz = nz - pz;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    left.push([x - tz * offset, z + tx * offset]);
    right.push([x + tz * offset, z - tx * offset]);
  }

  const railColor = view === 'town' ? 'rgba(255,190,82,0.98)' : 'rgba(224,184,120,0.75)';
  const railWidth = Math.max(view === 'town' ? 2.2 : 1.1, 1.7 * scale);
  line(left, railWidth, railColor);
  line(right, railWidth, railColor);

  if (view === 'town') {
    ctx.strokeStyle = 'rgba(255,222,164,0.9)';
    ctx.lineWidth = 1.4;
    let travelled = 0;

    for (let i = 1; i < rail.pts.length; i++) {
      const [ax, az] = rail.pts[i - 1];
      const [bx, bz] = rail.pts[i];
      const len = Math.hypot(bx - ax, bz - az);
      travelled += len;
      if (travelled < 10) continue;
      travelled = 0;

      const angle = Math.atan2(bz - az, bx - ax);
      const nx = -Math.sin(angle);
      const nz = Math.cos(angle);
      ctx.beginPath();
      ctx.moveTo(sx(bx + nx * 2.8), sz(bz + nz * 2.8));
      ctx.lineTo(sx(bx - nx * 2.8), sz(bz - nz * 2.8));
      ctx.stroke();
    }
  }

  const station = town.station;
  if (station) {
    const nx = -Math.sin(station.angle);
    const nz = Math.cos(station.angle);
    const off = station.platformD / 2 + 4;
    const px = sx(station.x + nx * (station.side || 1) * off);
    const pz = sz(station.z + nz * (station.side || 1) * off);
    const w = Math.max(3, station.platformW * scale);
    const d = Math.max(2, station.platformD * scale);

    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(station.angle);
    ctx.fillStyle = 'rgba(255,199,98,0.96)';
    ctx.strokeStyle = 'rgba(20,22,24,0.85)';
    ctx.lineWidth = 1.2;
    ctx.fillRect(-w / 2, -d / 2, w, d);
    ctx.strokeRect(-w / 2, -d / 2, w, d);
    ctx.fillStyle = 'rgba(120,60,24,0.95)';
    ctx.fillRect(-w * 0.18, -d * 0.32, w * 0.36, d * 0.64);
    ctx.restore();

    if (view === 'town') {
      ctx.save();
      ctx.font = '700 14px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(5,8,10,0.88)';
      ctx.fillStyle = '#ffe2a6';
      ctx.strokeText('駅', px, pz - d / 2 - 5);
      ctx.fillText('駅', px, pz - d / 2 - 5);
      ctx.restore();
    }
  }
}

function drawTown(ctx, field, town, outN, view, viewBounds) {
  const scale = outN / viewBounds.size;
  const sx = (x) => (x - viewBounds.x0) * scale;
  const sz = (z) => (z - viewBounds.y0) * scale;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  drawParcels(ctx, town.parcels, sx, sz, scale, view, outN);

  for (const road of town.roads) {
    if (road.pts.length < 2) continue;

    let color;
    if (view === 'town') {
      color = road.cls === 'arterial'
        ? 'rgba(245,240,225,0.92)'
        : road.cls === 'ring'
          ? 'rgba(220,220,210,0.82)'
          : 'rgba(195,200,205,0.72)';
    } else {
      color = road.cls === 'arterial'
        ? 'rgba(18,20,24,0.95)'
        : road.cls === 'ring'
          ? 'rgba(24,27,31,0.90)'
          : 'rgba(30,34,38,0.85)';
    }

    if (road.bridge) {
      color = view === 'town' ? 'rgba(150,200,220,0.90)' : 'rgba(30,60,72,0.85)';
    }

    ctx.lineCap = road.bridge ? 'butt' : 'round';

    const strokeRoad = () => {
      ctx.beginPath();
      ctx.moveTo(sx(road.pts[0][0]), sz(road.pts[0][1]));
      for (let i = 1; i < road.pts.length; i++) {
        ctx.lineTo(sx(road.pts[i][0]), sz(road.pts[i][1]));
      }
      ctx.stroke();
    };

    if (view === 'color') {
      ctx.strokeStyle = 'rgba(245,242,230,0.38)';
      ctx.lineWidth = Math.max(2.8, road.width * scale * 2.1);
      strokeRoad();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(view === 'town' ? 2.0 : 1.6, road.width * scale * (view === 'town' ? 1.15 : 1));
    strokeRoad();
  }

  drawRailway(ctx, town, sx, sz, scale, view);

  for (const b of town.buildings) {
    const px = sx(b.x);
    const pz = sz(b.z);
    if (px < -40 || pz < -40 || px > outN + 40 || pz > outN + 40) continue;

    const minSize = view === 'town' ? 4.0 : 3.2;
    const w = Math.max(minSize, b.w * scale);
    const d = Math.max(minSize, b.d * scale);
    const shadow = Math.min(7, 0.8 + b.h * 0.035 * scale);

    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(b.angle);

    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(-w / 2 + shadow, -d / 2 + shadow, w, d);

    const base = BUILDING_COLORS[b.type] || [190, 180, 160];
    const color = view === 'town' ? base : mix(base, [24, 26, 29], 0.55);
    ctx.fillStyle = `rgb(${color[0] | 0},${color[1] | 0},${color[2] | 0})`;
    ctx.fillRect(-w / 2, -d / 2, w, d);

    if (view === 'town') {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(-w / 2, -d / 2, w, Math.max(1, d * 0.2));
      ctx.strokeStyle = 'rgba(20,24,28,0.55)';
      ctx.lineWidth = 0.7;
      ctx.strokeRect(-w / 2, -d / 2, w, d);
    } else {
      ctx.strokeStyle = 'rgba(245,240,230,0.38)';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(-w / 2, -d / 2, w, d);
    }

    ctx.restore();
  }

  ctx.restore();
}

function drawScaleBar(ctx, n, size, view) {
  const candidates = [200, 500, 1000, 2000, 5000];
  let meters = candidates[candidates.length - 1];
  for (const c of candidates) {
    if (c / size * n >= 55) {
      meters = c;
      break;
    }
  }

  const px = meters / size * n;
  const x1 = n - 16;
  const x0 = x1 - px;
  const y = n - 18;

  ctx.save();
  ctx.lineWidth = Math.max(1, n / 700);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 4;

  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.moveTo(x0, y - 4);
  ctx.lineTo(x0, y + 4);
  ctx.moveTo(x1, y - 4);
  ctx.lineTo(x1, y + 4);
  ctx.stroke();

  ctx.font = `${Math.max(10, n / 64)}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(meters >= 1000 ? `${meters / 1000} km` : `${meters} m`, (x0 + x1) / 2, y - 8);

  if (view === 'flow') {
    ctx.textAlign = 'left';
    ctx.fillText('汇流累积', 12, 20);
  } else if (view === 'slope') {
    ctx.textAlign = 'left';
    ctx.fillText('坡度', 12, 20);
  } else if (view === 'height') {
    ctx.textAlign = 'left';
    ctx.fillText('高度', 12, 20);
  } else if (view === 'town') {
    ctx.textAlign = 'left';
    ctx.fillText('城镇', 12, 20);
  }

  ctx.restore();
}
