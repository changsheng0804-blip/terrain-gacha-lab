import { clamp } from './rng.js?v=9';
import { ZONE, ZONE_COLORS } from './town.js?v=9';

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

function drawRiverPaths(ctx, paths, maxAcc, project, scale) {
  if (paths.length === 0) return;

  paths.sort((a, b) => a.acc - b.acc);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Dark channel base, so the river sits inside the terrain rather than on top.
  for (const path of paths) {
    const width = (1.1 + 4.0 * Math.sqrt(Math.max(1, path.acc) / maxAcc)) * scale;
    ctx.strokeStyle = 'rgba(26, 70, 98, 0.38)';
    ctx.lineWidth = width * 2.0;
    strokePath(ctx, path.pts, project);
  }

  // Water core.
  for (const path of paths) {
    const width = (0.8 + 3.4 * Math.sqrt(Math.max(1, path.acc) / maxAcc)) * scale;
    ctx.strokeStyle = 'rgba(92, 172, 218, 0.78)';
    ctx.lineWidth = Math.max(1, width);
    strokePath(ctx, path.pts, project);
  }

  // Thin highlight along the centre.
  for (const path of paths) {
    const width = (0.4 + 1.4 * Math.sqrt(Math.max(1, path.acc) / maxAcc)) * scale;
    ctx.strokeStyle = 'rgba(178, 226, 244, 0.30)';
    ctx.lineWidth = Math.max(0.8, width);
    strokePath(ctx, path.pts, project);
  }

  ctx.restore();
}

export function renderTerrain(canvas, field, hydro, town, view = 'color', showTown = true) {
  const { n, height, cell, size } = field;
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
      } else if (view === 'town') {
        rgb = sea ? [8, 14, 20] : mix([28, 32, 38], heightColor(h), 0.18);
        shadeFactor = 0.85;
      } else {
        rgb = heightColor(h);

        if (sea) {
          let depth = clamp(dLand / 70, 0, 1);
          depth = clamp(depth + 0.03 * Math.sin(gx * 0.07 + gy * 0.05) * (1 - depth), 0, 1);
          const floorDepth = clamp(-h / 45, 0, 1);
          rgb = mix([64, 140, 176], [6, 20, 46], Math.max(depth, floorDepth * 0.7));
          if (dLand <= 4) rgb = mix(rgb, [96, 156, 172], 0.30);
          shadeFactor = 1;
        } else {
          const beachLimit = 0.8 + 2.0
            * (0.5 + 0.5 * Math.sin(gx * 0.02 + gy * 0.035))
            * (0.6 + 0.4 * Math.sin(gx * 0.011 - gy * 0.017));

          if (h < beachLimit && dSea <= 10) {
            rgb = mix([212, 200, 158], [188, 178, 138], clamp(h / beachLimit, 0, 1));
          } else if (h < 3.2) {
            rgb = mix([92, 142, 82], [58, 108, 64], clamp(h / 3.2, 0, 1));
          }

          const nx = -dhx;
          const ny = 1;
          const nz = -dhy;
          const inv = 1 / Math.hypot(nx, ny, nz);
          shadeFactor = clamp((nx * light[0] + ny * light[1] + nz * light[2]) * inv, 0.48, 1.32);
          shadeFactor *= 1 + 0.06 * clamp(h / 1200, 0, 1);

          if (h > 8 && h < 420 && angle > 5) {
            const forest = clamp((angle - 5) / 18, 0, 0.35);
            rgb = mix(rgb, [38, 82, 52], forest);
          }

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
    drawRiverPaths(ctx, paths, hydro.maxAcc, projectRiver, pixelPerGrid);
    ctx.restore();
  }

  if (showTown && town && (view === 'color' || view === 'town')) {
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
  };
}

function computeTownView(field, town) {
  const c = town.center;
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
};

function drawTown(ctx, field, town, outN, view, viewBounds) {
  const scale = outN / viewBounds.size;
  const sx = (x) => (x - viewBounds.x0) * scale;
  const sz = (z) => (z - viewBounds.y0) * scale;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

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
