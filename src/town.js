import { distanceTransform, MinHeap } from './hydrology.js?v=19';
import { fbm2 } from './noise.js?v=19';
import { clamp, randInt, range, rngFor } from './rng.js?v=19';
import { createOccupancy } from './occupancy.js?v=1';

const RAIL_HALF_WIDTH = 6;
// Depth fractions tried when a full-depth lot collides with something.
const DEPTH_STEPS = [1, 0.75, 0.55];
// Frontage shifts (fractions of lot width) tried along the road.
const SHIFT_STEPS = [0, 0.4, -0.4];

export const ZONE = {
  NONE: 0,
  CORE: 1,
  RES: 2,
  PADDY: 3,
  IND: 4,
  HAMLET: 5,
  WATER: 6,
};

export const ZONE_COLORS = {
  [ZONE.CORE]: [232, 170, 92],
  [ZONE.RES]: [196, 204, 116],
  [ZONE.PADDY]: [110, 170, 96],
  [ZONE.IND]: [176, 130, 196],
  [ZONE.HAMLET]: [186, 166, 142],
};

export const ZONE_NAMES = {
  [ZONE.NONE]: '无',
  [ZONE.CORE]: '中心',
  [ZONE.RES]: '住宅',
  [ZONE.PADDY]: '农田',
  [ZONE.IND]: '工业',
  [ZONE.HAMLET]: '集落',
  [ZONE.WATER]: '水面',
};

const NEIGHBORS = [
  [-1, -1, Math.SQRT2], [0, -1, 1], [1, -1, Math.SQRT2],
  [-1, 0, 1], [1, 0, 1],
  [-1, 1, Math.SQRT2], [0, 1, 1], [1, 1, Math.SQRT2],
];

function sampleHeight(field, x, z) {
  const { n, cell, x0, y0, height } = field;
  const gx = (x - x0) / cell;
  const gz = (z - y0) / cell;

  if (gx < 0 || gz < 0 || gx >= n - 1 || gz >= n - 1) return null;

  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const i = iz * n + ix;

  return height[i] * (1 - fx) * (1 - fz)
    + height[i + 1] * fx * (1 - fz)
    + height[i + n] * (1 - fx) * fz
    + height[i + n + 1] * fx * fz;
}

function slopeAt(field, x, z) {
  const d = field.cell * 0.5;
  const hx1 = sampleHeight(field, x + d, z);
  const hx0 = sampleHeight(field, x - d, z);
  const hz1 = sampleHeight(field, x, z + d);
  const hz0 = sampleHeight(field, x, z - d);

  if (hx1 == null || hx0 == null || hz1 == null || hz0 == null) return 90;

  const gx = (hx1 - hx0) / (2 * d);
  const gz = (hz1 - hz0) / (2 * d);
  return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
}

function indexAt(field, x, z) {
  const gx = clamp(Math.round((x - field.x0) / field.cell), 0, field.n - 1);
  const gz = clamp(Math.round((z - field.y0) / field.cell), 0, field.n - 1);
  return gz * field.n + gx;
}

function zoneAt(field, zones, x, z) {
  return zones[indexAt(field, x, z)];
}

function inBounds(field, x, z, margin = 0) {
  return x >= field.x0 + margin && x <= field.x0 + field.size - margin
    && z >= field.y0 + margin && z <= field.y0 + field.size - margin;
}

function slopeAtIndex(field, i) {
  const { n, height, cell } = field;
  const x = i % n;
  const y = (i / n) | 0;
  const ix = x === 0 ? i : i - 1;
  const ix2 = x === n - 1 ? i : i + 1;
  const iy = y === 0 ? i : i - n;
  const iy2 = y === n - 1 ? i : i + n;
  const gx = (height[ix2] - height[ix]) / (2 * cell);
  const gy = (height[iy2] - height[iy]) / (2 * cell);
  return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
}

function findCenter(field, hydro) {
  const { n, height, cell, x0, y0, size } = field;
  const cx = n >> 1;
  const cy = n >> 1;
  const radius = Math.max(6, Math.floor(n * 0.18));

  let best = -1;
  let bestScore = Infinity;

  for (let y = cy - radius; y <= cy + radius; y += 2) {
    for (let x = cx - radius; x <= cx + radius; x += 2) {
      if (x < 2 || y < 2 || x >= n - 2 || y >= n - 2) continue;
      const i = y * n + x;
      if (hydro.seaMask[i]) continue;

      const h = height[i];
      if (h <= 1.5 || h > 360) continue;

      const slope = slopeAtIndex(field, i);
      const dRiver = hydro.dRiver[i] * cell;
      const score = slope * 1.5
        + Math.max(0, h - 200) * 0.02
        + Math.min(dRiver, 700) * 0.002;

      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
  }

  if (best < 0) {
    for (let i = 0; i < n * n; i += 3) {
      if (!hydro.seaMask[i] && height[i] > 1.5 && height[i] < 320) {
        best = i;
        break;
      }
    }
  }

  const wx = best >= 0 ? x0 + (best % n) * cell : (x0 + size / 2);
  const wz = best >= 0 ? y0 + ((best / n) | 0) * cell : (y0 + size / 2);

  return { index: best, x: wx, z: wz };
}

function computeZones(field, hydro, rng) {
  const { n, height, cell, size } = field;
  const count = n * n;
  const cost = new Float32Array(count).fill(Infinity);
  const done = new Uint8Array(count);
  const center = findCenter(field, hydro);

  if (center.index < 0) {
    return {
      zones: new Uint8Array(count),
      cost,
      center,
      stats: { corePct: 0, resPct: 0, paddyPct: 0, indPct: 0, hamletPct: 0 },
    };
  }

  const heap = new MinHeap((a, b) => cost[a] - cost[b]);
  cost[center.index] = 0;
  heap.push(center.index);

  while (heap.size > 0) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;

    const x = i % n;
    const y = (i / n) | 0;
    const c = cost[i];

    for (const [dx, dy, dist] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;

      const j = ny * n + nx;
      if (done[j]) continue;
      if (hydro.seaMask[j]) continue;

      const slope = slopeAtIndex(field, j);
      const h = height[j];
      const slopePenalty = 1 + Math.min(5, slope / 8);
      const heightPenalty = 1 + Math.max(0, h - 220) / 320;
      const dRiver = hydro.dRiver[j] * cell;
      const riverBonus = 1 - 0.15 * Math.exp(-dRiver / 500);
      const step = cell * dist * slopePenalty * heightPenalty * riverBonus;

      if (c + step < cost[j]) {
        cost[j] = c + step;
        heap.push(j);
      }
    }
  }

  const zones = new Uint8Array(count);
  const coreR = size * 0.06;
  const resR = size * 0.18;
  const indR = size * 0.26;
  const paddyR = size * 0.36;
  const hamletR = size * 0.50;
  const zoneCounts = new Array(7).fill(0);
  let landCells = 0;

  for (let i = 0; i < count; i++) {
    if (hydro.seaMask[i]) {
      zones[i] = ZONE.WATER;
      continue;
    }

    landCells++;

    const x = i % n;
    const y = (i / n) | 0;
    const h = height[i];
    const slope = slopeAtIndex(field, i);
    const dRiver = hydro.dRiver[i] * cell;
    const c = cost[i];
    const cEff = Number.isFinite(c)
      ? c * (1 + 0.18 * fbm2(x / 350, y / 350, 3, 9173))
      : c;

    let zone = ZONE.NONE;

    if (Number.isFinite(cEff) && slope <= 20 && h <= 420) {
      if (cEff <= coreR) zone = ZONE.CORE;
      else if (cEff <= resR) zone = ZONE.RES;
      else if (cEff <= indR && (dRiver < 700 || h < 90)) zone = ZONE.IND;
      else if (cEff <= paddyR && slope < 7 && dRiver < 1200) zone = ZONE.PADDY;
      else if (cEff <= hamletR && slope < 14) zone = ZONE.HAMLET;
    }

    zones[i] = zone;
    zoneCounts[zone]++;
  }

  const pct = (v) => landCells > 0 ? v / landCells * 100 : 0;

  return {
    zones,
    cost,
    center,
    stats: {
      corePct: pct(zoneCounts[ZONE.CORE]),
      resPct: pct(zoneCounts[ZONE.RES]),
      paddyPct: pct(zoneCounts[ZONE.PADDY]),
      indPct: pct(zoneCounts[ZONE.IND]),
      hamletPct: pct(zoneCounts[ZONE.HAMLET]),
    },
  };
}

function traceArterial(field, hydro, zones, startX, startZ, angle, maxLength, rng) {
  const pts = [];
  let x = startX;
  let z = startZ;
  let a = angle;
  const step = Math.max(18, field.cell * 2);
  let waterRun = 0;
  let noneRun = 0;
  let bridge = false;

  for (let travelled = 0; travelled < maxLength; travelled += step) {
    pts.push([x, z]);

    let bestA = a;
    let bestCost = Infinity;

    for (const da of [-0.20, 0, 0.20]) {
      const na = a + da;
      const nx = x + Math.cos(na) * step;
      const nz = z + Math.sin(na) * step;
      if (!inBounds(field, nx, nz, field.cell * 1.5)) continue;

      const h = sampleHeight(field, nx, nz);
      if (h == null) continue;

      const slope = slopeAt(field, nx, nz);
      const water = h <= 0 ? 20 : 1;
      const mountain = h > 350 ? 8 : h > 220 ? 2.5 : 1;
      const turn = Math.abs(da) * 7;
      const candidate = slope * 0.3 + water + mountain + turn + rng() * 0.6;

      if (candidate < bestCost) {
        bestCost = candidate;
        bestA = na;
      }
    }

    if (!Number.isFinite(bestCost)) break;

    a = bestA;
    x += Math.cos(a) * step;
    z += Math.sin(a) * step;

    const h = sampleHeight(field, x, z);
    if (h == null) break;

    if (h <= 0) {
      waterRun++;
      bridge = true;
      if (waterRun > 4) break;
    } else {
      waterRun = 0;
    }

    const zone = zoneAt(field, zones, x, z);
    if (zone === ZONE.NONE || zone === ZONE.WATER) {
      noneRun++;
      if (noneRun > 3) break;
    } else {
      noneRun = 0;
    }
  }

  return { pts, bridge };
}

function buildRoads(field, hydro, center, zones, rng) {
  const { size, x0, y0 } = field;
  const roads = [];

  const arterialCount = randInt(rng, 5, 7);
  const baseAngle = rng() * Math.PI * 2;

  for (let k = 0; k < arterialCount; k++) {
    const angle = baseAngle + k / arterialCount * Math.PI * 2 + range(rng, -0.18, 0.18);
    const path = traceArterial(field, hydro, zones, center.x, center.z, angle, size * 0.28, rng);
    if (path.pts.length >= 5) {
      roads.push({ pts: path.pts, width: 14, cls: 'arterial', bridge: path.bridge });
    }
  }

  const ringRadii = [0.06, 0.12, 0.19].map((f) => size * f * range(rng, 0.9, 1.1));

  for (const radius of ringRadii) {
    const phase = rng() * Math.PI * 2;
    let segment = [];

    for (let a = 0; a <= Math.PI * 2 + 0.001; a += Math.PI / 60) {
      const wobble = 1
        + 0.08 * Math.sin(a * 3 + phase)
        + 0.04 * Math.sin(a * 7 + phase * 1.7);
      const r = radius * wobble;
      const x = center.x + Math.cos(a) * r;
      const z = center.z + Math.sin(a) * r;
      const zid = zoneAt(field, zones, x, z);

      const ok = inBounds(field, x, z, field.cell)
        && sampleHeight(field, x, z) > 0.8
        && slopeAt(field, x, z) < 18
        && zid !== ZONE.WATER
        && zid !== ZONE.NONE;

      if (ok) {
        segment.push([x, z]);
      } else if (segment.length >= 4) {
        roads.push({ pts: segment, width: 8, cls: 'ring' });
        segment = [];
      } else {
        segment = [];
      }
    }

    if (segment.length >= 4) {
      roads.push({ pts: segment, width: 8, cls: 'ring' });
    }
  }

  // Local streets branch off the arterial roads at regular intervals.
  for (const road of roads.filter((r) => r.cls === 'arterial')) {
    let travelled = 0;
    let nextStreet = range(rng, 65, 120);

    for (let i = 1; i < road.pts.length && roads.length < 360; i++) {
      const [x0p, z0p] = road.pts[i - 1];
      const [x1p, z1p] = road.pts[i];
      const segLen = Math.hypot(x1p - x0p, z1p - z0p);
      travelled += segLen;

      if (travelled < nextStreet) continue;
      travelled = 0;
      nextStreet = range(rng, 65, 120);

      const angle = Math.atan2(z1p - z0p, x1p - x0p);
      const nx = -Math.sin(angle);
      const nz = Math.cos(angle);

      for (const side of [-1, 1]) {
        const maxStreet = range(rng, 90, 280);
        const pts = [];
        let sx = x1p + nx * side * (road.width / 2 + 2);
        let sz = z1p + nz * side * (road.width / 2 + 2);

        for (let d = 0; d <= maxStreet; d += 12) {
          if (!inBounds(field, sx, sz, field.cell)) break;

          const h = sampleHeight(field, sx, sz);
          const zid = zoneAt(field, zones, sx, sz);
          if (h == null || h <= 0.8 || slopeAt(field, sx, sz) > 18
            || zid === ZONE.NONE || zid === ZONE.WATER) break;

          pts.push([sx, sz]);
          sx += nx * side * 12;
          sz += nz * side * 12;
        }

        if (pts.length >= 4) {
          roads.push({ pts, width: 6, cls: 'street' });
        }
      }
    }
  }

  return roads;
}

function roadLength(road) {
  let length = 0;
  for (let i = 1; i < road.pts.length; i++) {
    length += Math.hypot(
      road.pts[i][0] - road.pts[i - 1][0],
      road.pts[i][1] - road.pts[i - 1][1],
    );
  }
  return length;
}

function smoothPath(pts, passes = 1) {
  let out = pts;
  for (let p = 0; p < passes; p++) {
    const next = [out[0]];
    for (let i = 1; i < out.length - 1; i++) {
      next.push([
        (out[i - 1][0] + out[i][0] * 2 + out[i + 1][0]) / 4,
        (out[i - 1][1] + out[i][1] * 2 + out[i + 1][1]) / 4,
      ]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

function simplifyPath(pts, minDist) {
  if (pts.length <= 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= minDist) {
      out.push(pts[i]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function polylineLength(pts) {
  let length = 0;
  for (let i = 1; i < pts.length; i++) {
    length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return length;
}

function distanceToPolyline(pts, x, z) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1);
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) best = d;
  }
  return best;
}

function pickStation(field, hydro, zones, center, pts, rng) {
  let best = null;
  let bestScore = Infinity;

  for (let i = 1; i < pts.length - 1; i++) {
    const [x, z] = pts[i];
    const d = Math.hypot(x - center.x, z - center.z);
    if (d < 60 || d > 800) continue;

    const zone = zoneAt(field, zones, x, z);
    if (zone === ZONE.WATER) continue;

    const gi = indexAt(field, x, z);
    const riverDist = hydro.dRiver[gi] * field.cell;
    const riverPenalty = riverDist < 80 ? (80 - riverDist) / 80 * 2.5 : 0;

    const h = sampleHeight(field, x, z);
    if (h == null || h <= 1.2) continue;

    const slope = slopeAt(field, x, z);
    if (slope > 10) continue;

    const zonePenalty = zone === ZONE.CORE ? 0
      : zone === ZONE.RES ? 0.6
        : zone === ZONE.IND ? 1.4
          : zone === ZONE.HAMLET ? 1.8
            : zone === ZONE.PADDY ? 2.0
              : 3.0;
    const score = slope * 0.8 + d / 120 + zonePenalty + riverPenalty;

    if (score < bestScore) {
      bestScore = score;
      const [nx, nz] = pts[i + 1] || pts[i - 1];
      best = {
        x,
        z,
        angle: Math.atan2(nz - z, nx - x),
        platformW: 70,
        platformD: 14,
        side: rng() < 0.5 ? -1 : 1,
      };
    }
  }

  if (best) return best;

  const [x, z] = pts[0];
  const [nx, nz] = pts[1] || [x + 1, z];
  return {
    x,
    z,
    angle: Math.atan2(nz - z, nx - x),
    platformW: 70,
    platformD: 14,
    side: 1,
  };
}

function oceanDistance(hydro, n) {
  const ocean = new Uint8Array(n * n);
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;

  const seed = (i) => {
    if (hydro.seaMask[i] && !ocean[i]) {
      ocean[i] = 1;
      queue[tail++] = i;
    }
  };

  for (let x = 0; x < n; x++) {
    seed(x);
    seed((n - 1) * n + x);
  }
  for (let y = 0; y < n; y++) {
    seed(y * n);
    seed(y * n + n - 1);
  }

  const steps = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  while (head < tail) {
    const i = queue[head++];
    const x = i % n;
    const y = (i / n) | 0;
    for (const [dx, dy] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (!hydro.seaMask[j] || ocean[j]) continue;
      ocean[j] = 1;
      queue[tail++] = j;
    }
  }

  return distanceTransform(ocean, n);
}

function traceRailway(field, hydro, zones, center, rng) {
  if (center.index < 0) return null;

  const { n, cell, height, x0, y0 } = field;
  const count = n * n;
  const cost = new Float32Array(count).fill(Infinity);
  const prev = new Int32Array(count).fill(-1);
  const done = new Uint8Array(count);
  const heap = new MinHeap((a, b) => cost[a] - cost[b]);

  // The town centre can sit on a low coastal cell. Start the rail at the
  // nearest buildable land cell so it does not follow the river out to sea.
  let start = center.index;
  if (height[start] <= 1.2) {
    const cx = start % n;
    const cy = (start / n) | 0;
    const search = Math.max(12, Math.floor(n * 0.14));
    let bestDist = Infinity;

    for (let dz = -search; dz <= search; dz++) {
      for (let dx = -search; dx <= search; dx++) {
        const x = cx + dx;
        const z = cy + dz;
        if (x < 0 || z < 0 || x >= n || z >= n) continue;
        const j = z * n + x;
        if (height[j] <= 1.5 || hydro.seaMask[j]) continue;
        if (slopeAtIndex(field, j) > 15) continue;
        const d = dx * dx + dz * dz;
        if (d < bestDist) {
          bestDist = d;
          start = j;
        }
      }
    }
  }

  cost[start] = 0;
  heap.push(start);

  const island = Boolean(field.terrain.island);
  const mapSize = field.size || n * cell;
  const oceanD = island ? oceanDistance(hydro, n) : null;
  let goal = -1;
  let fallback = -1;
  let fallbackCost = Infinity;
  let coastGoal = -1;
  let coastCost = -Infinity;

  while (heap.size > 0) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;

    const x = i % n;
    const y = (i / n) | 0;
    const boundary = x === 0 || y === 0 || x === n - 1 || y === n - 1;

    if (boundary) {
      if (!island && height[i] > 0.8) {
        goal = i;
        break;
      }
      if (cost[i] < fallbackCost) {
        fallback = i;
        fallbackCost = cost[i];
      }
    }

    if (island && height[i] > 1.5 && oceanD[i] * cell < 160) {
      const wx = x0 + x * cell;
      const wz = y0 + y * cell;
      const radial = Math.hypot(wx - center.x, wz - center.z);
      if (radial > mapSize * 0.16 && cost[i] > coastCost) {
        coastCost = cost[i];
        coastGoal = i;
      }
    }

    const c = cost[i];

    for (const [dx, dy, dist] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;

      const j = ny * n + nx;
      if (done[j]) continue;

      const h = height[j];
      const slope = slopeAtIndex(field, j);
      const water = h <= 0.8 ? 1200 : 1;
      const riverCross = hydro.dRiver[j] * cell < 18 ? 8 : 1;
      const slopePenalty = 1 + Math.min(12, slope / 3.2);
      const heightPenalty = 1 + Math.max(0, h - 240) / 200;
      const step = cell * dist * water * riverCross * slopePenalty * heightPenalty;

      if (c + step < cost[j]) {
        cost[j] = c + step;
        prev[j] = i;
        heap.push(j);
      }
    }
  }

  if (island) {
    goal = coastGoal >= 0 ? coastGoal : fallback;
  } else if (goal < 0) {
    goal = fallback;
  }

  if (goal < 0) return null;

  const raw = [];
  for (let i = goal; i !== -1; i = prev[i]) {
    raw.push([x0 + (i % n) * cell, y0 + ((i / n) | 0) * cell]);
    if (i === start) break;
  }
  raw.reverse();
  if (raw.length < 5) return null;

  let bridge = false;
  for (const [x, z] of raw) {
    const gi = indexAt(field, x, z);
    const h = height[gi];
    if (h <= 0.8 || hydro.dRiver[gi] * cell < 18) {
      bridge = true;
      break;
    }
  }

  const pts = simplifyPath(smoothPath(raw, 2), Math.max(12, cell * 1.2));
  if (pts.length < 2) return null;

  const station = pickStation(field, hydro, zones, center, pts, rng);
  return {
    pts,
    length: polylineLength(pts),
    bridge,
    station,
  };
}

function parcelDimensions(zone, roadCls, rng) {
  const street = roadCls === 'street';

  if (zone === ZONE.CORE) {
    return { w: range(rng, street ? 10 : 14, street ? 18 : 24), d: range(rng, 24, 40) };
  }
  if (zone === ZONE.RES) {
    return { w: range(rng, street ? 10 : 13, street ? 18 : 22), d: range(rng, 22, 36) };
  }
  if (zone === ZONE.IND) {
    return { w: range(rng, 26, 48), d: range(rng, 38, 64) };
  }
  if (zone === ZONE.HAMLET) {
    return { w: range(rng, 18, 34), d: range(rng, 28, 48) };
  }
  return { w: range(rng, 30, 60), d: range(rng, 45, 80) };
}

function parcelOK(field, x, z, angle, w, d) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = w / 2;
  const hd = d / 2;
  const points = [
    [0, 0],
    [hw, hd], [-hw, hd], [hw, -hd], [-hw, -hd],
    [hw, 0], [-hw, 0], [0, hd], [0, -hd],
  ];

  for (const [dx, dz] of points) {
    const px = x + dx * cos - dz * sin;
    const pz = z + dx * sin + dz * cos;
    if (!inBounds(field, px, pz, field.cell)) return false;
    const h = sampleHeight(field, px, pz);
    if (h == null || h <= 1.0) return false;
    if (slopeAt(field, px, pz) > 20) return false;
  }

  return true;
}

function buildParcels(field, hydro, zones, roads, railway, rng, occ) {
  const parcels = [];
  const maxParcels = 4200;
  const railPts = railway ? railway.pts : null;
  const station = railway ? railway.station : null;

  const addParcel = (px, pz, angle, dims, zone, roadCls) => {
    if (![ZONE.CORE, ZONE.RES, ZONE.IND, ZONE.PADDY, ZONE.HAMLET].includes(zone)) return false;
    if (!parcelOK(field, px, pz, angle, dims.w, dims.d)) return false;
    if (railPts && distanceToPolyline(railPts, px, pz) < 20 + Math.max(dims.w, dims.d) * 0.35) return false;
    if (station && Math.hypot(px - station.x, pz - station.z) < Math.max(station.platformW, station.platformD) * 0.8) return false;

    // Exact rectangle test against roads, rail, river channels and the lots
    // already placed. Adjacent lots may touch but never overlap.
    const rect = { x: px, z: pz, angle, w: dims.w, d: dims.d };
    if (!occ.canPlace(rect, 'parcel', 0)) return false;
    occ.add(rect, 'parcel');

    parcels.push({
      index: parcels.length,
      x: px,
      z: pz,
      angle,
      w: dims.w,
      d: dims.d,
      zone,
      road: roadCls,
      built: false,
    });

    return true;
  };

  for (const road of roads) {
    if (parcels.length >= maxParcels) break;

    let travelled = 0;
    let nextParcel = range(rng, 8, 16);

    for (let i = 1; i < road.pts.length && parcels.length < maxParcels; i++) {
      const [x0, z0] = road.pts[i - 1];
      const [x1, z1] = road.pts[i];
      const segLen = Math.hypot(x1 - x0, z1 - z0);
      travelled += segLen;

      if (travelled < nextParcel) continue;
      travelled = 0;

      const angle = Math.atan2(z1 - z0, x1 - x0);
      const nx = -Math.sin(angle);
      const nz = Math.cos(angle);

      for (const side of [-1, 1]) {
        const probeX = x1 + nx * side * (road.width / 2 + 8);
        const probeZ = z1 + nz * side * (road.width / 2 + 8);
        const probeZone = zoneAt(field, zones, probeX, probeZ);
        if (![ZONE.CORE, ZONE.RES, ZONE.IND, ZONE.PADDY, ZONE.HAMLET].includes(probeZone)) continue;

        const frontDims = parcelDimensions(probeZone, road.cls, rng);
        const setback = range(rng, 2, 6);
        // Lots keep their frontage on the road; when the full depth would run
        // into another road, a river or a neighbour, try shallower lots.
        let frontDepth = 0;
        let shift = 0;
        const tx = Math.cos(angle);
        const tz = Math.sin(angle);
        search:
        for (const k of DEPTH_STEPS) {
          for (const sh of SHIFT_STEPS) {
            const dims = { w: frontDims.w, d: frontDims.d * k };
            const off = road.width / 2 + setback + dims.d / 2;
            const along = sh * frontDims.w;
            const fx = x1 + nx * side * off + tx * along;
            const fz = z1 + nz * side * off + tz * along;
            if (addParcel(fx, fz, angle, dims, zoneAt(field, zones, fx, fz), road.cls)) {
              frontDepth = dims.d;
              shift = along;
              break search;
            }
          }
        }

        // Urban blocks get a second row of back lots. This is the parcel-level
        // equivalent of the depth seen in real block subdivision.
        const rearDims = [ZONE.CORE, ZONE.RES, ZONE.IND].includes(probeZone)
          ? parcelDimensions(probeZone, road.cls, rng) : null;
        const rearGap = rearDims ? range(rng, 3, 7) : 0;
        if (rearDims && frontDepth > 0) {
          for (const k of DEPTH_STEPS) {
            const dims = { w: rearDims.w, d: rearDims.d * k };
            const off = road.width / 2 + setback + frontDepth + rearGap + dims.d / 2;
            const rx = x1 + nx * side * off + tx * shift;
            const rz = z1 + nz * side * off + tz * shift;
            if (addParcel(rx, rz, angle, dims, zoneAt(field, zones, rx, rz), road.cls)) break;
          }
        }

        nextParcel = frontDims.w + range(rng, 1, 5);
      }
    }
  }

  return parcels;
}

function dimensionsForParcel(zone, parcel, rng, distanceFromCenter, size) {
  if (zone === ZONE.CORE) {
    const centrality = 1 - clamp(distanceFromCenter / (size * 0.35), 0, 1);
    const floors = Math.max(2, Math.min(8, Math.round(2 + rng() * 6 * (0.35 + centrality * 0.65))));
    return {
      w: clamp(parcel.w * range(rng, 0.55, 0.8), 8, 26),
      d: clamp(parcel.d * range(rng, 0.45, 0.65), 8, 22),
      floors,
      type: rng() < 0.55 ? 'commercial' : 'apartment',
    };
  }

  if (zone === ZONE.RES) {
    return {
      w: clamp(parcel.w * range(rng, 0.5, 0.75), 7, 16),
      d: clamp(parcel.d * range(rng, 0.45, 0.65), 7, 15),
      floors: randInt(rng, 1, 3),
      type: rng() < 0.16 ? 'apartment' : 'house',
    };
  }

  if (zone === ZONE.IND) {
    return {
      w: clamp(parcel.w * range(rng, 0.65, 0.85), 18, 42),
      d: clamp(parcel.d * range(rng, 0.55, 0.75), 14, 32),
      floors: randInt(rng, 1, 2),
      type: rng() < 0.6 ? 'warehouse' : 'industrial',
    };
  }

  if (zone === ZONE.HAMLET) {
    return {
      w: clamp(parcel.w * range(rng, 0.4, 0.6), 6, 13),
      d: clamp(parcel.d * range(rng, 0.35, 0.55), 6, 11),
      floors: randInt(rng, 1, 2),
      type: rng() < 0.65 ? 'farmhouse' : 'house',
    };
  }

  return {
    w: clamp(parcel.w * range(rng, 0.2, 0.35), 5, 10),
    d: clamp(parcel.d * range(rng, 0.15, 0.3), 5, 9),
    floors: 1,
    type: 'farmhouse',
  };
}

function footprintOK(field, x, z, angle, w, d) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const points = [
    [0, 0],
    [w / 2, d / 2],
    [-w / 2, d / 2],
    [w / 2, -d / 2],
    [-w / 2, -d / 2],
  ];

  for (const [dx, dz] of points) {
    const px = x + dx * cos - dz * sin;
    const pz = z + dx * sin + dz * cos;
    if (!inBounds(field, px, pz, field.cell)) return false;
    const h = sampleHeight(field, px, pz);
    if (h == null || h <= 0.8) return false;
    if (slopeAt(field, px, pz) > 16) return false;
  }

  return true;
}

function hashKey(x, z, cell = 60) {
  return `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
}

function overlaps(hash, x, z, radius, cell = 60) {
  const cx = Math.floor(x / cell);
  const cz = Math.floor(z / cell);

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = hash.get(`${cx + dx},${cz + dz}`);
      if (!bucket) continue;
      for (const b of bucket) {
        if (Math.hypot(b.x - x, b.z - z) < b.r + radius) return true;
      }
    }
  }

  return false;
}

function placeBuildings(field, zones, parcels, center, rng, occ) {
  const buildings = [];
  const maxBuildings = 2400;

  for (const parcel of parcels) {
    if (buildings.length >= maxBuildings) break;

    let probability = 0;
    if (parcel.zone === ZONE.CORE) probability = 0.92;
    else if (parcel.zone === ZONE.RES) probability = 0.72;
    else if (parcel.zone === ZONE.IND) probability = 0.55;
    else if (parcel.zone === ZONE.HAMLET) probability = 0.38;
    else if (parcel.zone === ZONE.PADDY) probability = 0.10;

    if (probability === 0 || rng() > probability) continue;

    const distanceFromCenter = Math.hypot(parcel.x - center.x, parcel.z - center.z);
    const dims = dimensionsForParcel(parcel.zone, parcel, rng, distanceFromCenter, field.size);

    if (!footprintOK(field, parcel.x, parcel.z, parcel.angle, dims.w, dims.d)) continue;

    const rect = { x: parcel.x, z: parcel.z, angle: parcel.angle, w: dims.w, d: dims.d };
    if (!occ.canPlace(rect, 'building', 1)) continue;

    const height = dims.floors * 3.2 + (dims.type === 'house' ? 1.5 : 0);
    const building = {
      x: parcel.x,
      z: parcel.z,
      angle: parcel.angle,
      w: dims.w,
      d: dims.d,
      floors: dims.floors,
      h: height,
      type: dims.type,
      zone: parcel.zone,
      parcel: parcel.index,
    };

    buildings.push(building);
    parcel.built = true;
    occ.add(rect, 'building');
  }

  return buildings;
}

/**
 * Reserve the station building before any lots are cut: infrastructure gets
 * first claim on the ground. Tries both sides of the platform at several
 * positions; if every spot is crossed by a local street, the best spot wins
 * and the streets that cross it are cut back (a small station square).
 * May shorten or drop entries of `roads` (street class only).
 */
function placeStationBuilding(field, zones, railway, roads, hydro) {
  const station = railway ? railway.station : null;
  if (!station) return null;
  const tx = Math.cos(station.angle);
  const tz = Math.sin(station.angle);
  const nx = -tz;
  const nz = tx;
  const w = 28;
  const d = 12;
  const base = station.platformD + 12;

  const occ = createOccupancy(field, hydro);
  for (const road of roads) occ.addStrip(road.pts, road.width / 2, road.cls);
  occ.addStrip(railway.pts, RAIL_HALF_WIDTH, 'rail');

  const candidates = [];
  for (const offset of [base, base + 12, base + 26]) {
    for (const along of [0, 18, -18, 36, -36, 60, -60]) {
      for (const side of [station.side, -station.side]) {
        const bx = station.x + tx * along + nx * side * offset;
        const bz = station.z + tz * along + nz * side * offset;
        const zone = zoneAt(field, zones, bx, bz);
        if (![ZONE.CORE, ZONE.RES, ZONE.IND, ZONE.HAMLET, ZONE.PADDY].includes(zone)) continue;
        if (!footprintOK(field, bx, bz, station.angle, w, d)) continue;
        candidates.push({ rect: { x: bx, z: bz, angle: station.angle, w, d }, zone });
      }
    }
  }

  let pick = candidates.find((c) => occ.canPlace(c.rect, 'parcel'));
  if (!pick) {
    pick = candidates.find((c) => occ.canPlace(c.rect, 'parcel', 0, ['street']));
    if (pick) trimStreets(roads, pick.rect);
  }
  if (!pick) return null;

  const { rect, zone } = pick;
  return {
    x: rect.x,
    z: rect.z,
    angle: rect.angle,
    w,
    d,
    floors: 2,
    h: 8,
    type: 'station',
    zone,
    station: true,
  };
}

/** Cut every street that enters rect (plus clearance) back to the part before it. */
function trimStreets(roads, rect) {
  const pad = 6;
  const c = Math.cos(rect.angle);
  const s = Math.sin(rect.angle);
  const inside = ([x, z]) => {
    const dx = x - rect.x;
    const dz = z - rect.z;
    return Math.abs(dx * c + dz * s) <= rect.w / 2 + pad && Math.abs(-dx * s + dz * c) <= rect.d / 2 + pad;
  };
  for (let i = roads.length - 1; i >= 0; i--) {
    const road = roads[i];
    if (road.cls !== 'street') continue;
    const cut = road.pts.findIndex(inside);
    if (cut < 0) continue;
    if (cut < 4) roads.splice(i, 1);
    else road.pts = road.pts.slice(0, cut);
  }
}

/**
 * Generate a simplified town: reachability zones, arterial/ring/street roads,
 * and building footprints with height and type.
 */
export function generateTown(field, hydro, seed) {
  const rng = rngFor(seed, `town:${field.terrain.id}`);
  const zoneResult = computeZones(field, hydro, rng);
  const roads = buildRoads(field, hydro, zoneResult.center, zoneResult.zones, rng);
  const railway = traceRailway(field, hydro, zoneResult.zones, zoneResult.center, rng);

  // Everything placed from here on is checked against one occupancy layer.
  const occ = createOccupancy(field, hydro);
  const stationBuilding = placeStationBuilding(field, zoneResult.zones, railway, roads, hydro);
  for (const road of roads) occ.addStrip(road.pts, road.width / 2, road.cls);
  if (railway) occ.addStrip(railway.pts, RAIL_HALF_WIDTH, 'rail');
  if (stationBuilding) {
    const rect = { x: stationBuilding.x, z: stationBuilding.z, angle: stationBuilding.angle, w: stationBuilding.w, d: stationBuilding.d };
    occ.add(rect, 'parcel');
    occ.add(rect, 'building');
  }

  const parcels = buildParcels(field, hydro, zoneResult.zones, roads, railway, rng, occ);
  const buildings = placeBuildings(
    field,
    zoneResult.zones,
    parcels,
    zoneResult.center,
    rng,
    occ,
  );
  if (stationBuilding) buildings.push(stationBuilding);

  let arterialKm = 0;
  let streetKm = 0;
  for (const road of roads) {
    const km = roadLength(road) / 1000;
    if (road.cls === 'arterial') arterialKm += km;
    else if (road.cls === 'street') streetKm += km;
  }

  let builtParcels = 0;
  for (const parcel of parcels) {
    if (parcel.built) builtParcels++;
  }

  return {
    zones: zoneResult.zones,
    zoneStats: zoneResult.stats,
    center: zoneResult.center,
    roads,
    railway,
    station: railway ? railway.station : null,
    parcels,
    buildings,
    stats: {
      buildings: buildings.length,
      roads: roads.length,
      arterialKm,
      streetKm,
      railKm: railway ? railway.length / 1000 : 0,
      station: railway && railway.station ? 1 : 0,
      parcels: parcels.length,
      builtParcels,
      ...zoneResult.stats,
    },
  };
}
