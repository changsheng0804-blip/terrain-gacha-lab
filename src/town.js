import { MinHeap } from './hydrology.js?v=9';
import { fbm2 } from './noise.js?v=9';
import { clamp, randInt, range, rngFor } from './rng.js?v=9';

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
      if (h > 360) continue;

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
      if (!hydro.seaMask[i] && height[i] < 320) {
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

function dimensionsFor(zone, rng, distanceFromCenter, size) {
  if (zone === ZONE.CORE) {
    const centrality = 1 - clamp(distanceFromCenter / (size * 0.35), 0, 1);
    const floors = Math.max(2, Math.min(8, Math.round(2 + rng() * 6 * (0.35 + centrality * 0.65))));
    return {
      w: range(rng, 10, 26),
      d: range(rng, 10, 22),
      floors,
      type: rng() < 0.55 ? 'commercial' : 'apartment',
    };
  }

  if (zone === ZONE.RES) {
    const floors = randInt(rng, 1, 3);
    return {
      w: range(rng, 8, 16),
      d: range(rng, 8, 15),
      floors,
      type: rng() < 0.16 ? 'apartment' : 'house',
    };
  }

  if (zone === ZONE.IND) {
    return {
      w: range(rng, 20, 42),
      d: range(rng, 16, 32),
      floors: randInt(rng, 1, 2),
      type: rng() < 0.6 ? 'warehouse' : 'industrial',
    };
  }

  if (zone === ZONE.HAMLET) {
    return {
      w: range(rng, 7, 13),
      d: range(rng, 7, 11),
      floors: randInt(rng, 1, 2),
      type: rng() < 0.65 ? 'farmhouse' : 'house',
    };
  }

  return {
    w: range(rng, 6, 10),
    d: range(rng, 6, 9),
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

function overlaps(hash, x, z, radius) {
  const cx = Math.floor(x / 60);
  const cz = Math.floor(z / 60);

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

function placeBuildings(field, center, zones, roads, rng) {
  const buildings = [];
  const hash = new Map();
  const maxBuildings = 2200;

  for (const road of roads) {
    if (buildings.length >= maxBuildings) break;

    const spacing = road.cls === 'arterial'
      ? range(rng, 14, 24)
      : road.cls === 'ring'
        ? range(rng, 16, 26)
        : range(rng, 10, 18);

    let travelled = 0;

    for (let i = 1; i < road.pts.length && buildings.length < maxBuildings; i++) {
      const [x0, z0] = road.pts[i - 1];
      const [x1, z1] = road.pts[i];
      const segLen = Math.hypot(x1 - x0, z1 - z0);
      travelled += segLen;

      if (travelled < spacing) continue;
      travelled = 0;

      const angle = Math.atan2(z1 - z0, x1 - x0);
      const nx = -Math.sin(angle);
      const nz = Math.cos(angle);

      for (const side of [-1, 1]) {
        const probeX = x1 + nx * side * 12;
        const probeZ = z1 + nz * side * 12;
        const zone = zoneAt(field, zones, probeX, probeZ);

        let probability = 0;
        if (zone === ZONE.CORE) probability = 0.90;
        else if (zone === ZONE.RES) probability = 0.75;
        else if (zone === ZONE.IND) probability = 0.55;
        else if (zone === ZONE.HAMLET) probability = 0.40;
        else if (zone === ZONE.PADDY) probability = 0.12;

        if (probability === 0 || rng() > probability) continue;

        const distanceFromCenter = Math.hypot(x1 - center.x, z1 - center.z);
        const dims = dimensionsFor(zone, rng, distanceFromCenter, field.size);
        const setback = range(rng, 2.5, 7.5);
        const offset = road.width / 2 + setback + dims.d / 2;
        const bx = x1 + nx * side * offset;
        const bz = z1 + nz * side * offset;

        const centerZone = zoneAt(field, zones, bx, bz);
        if (![ZONE.CORE, ZONE.RES, ZONE.IND, ZONE.HAMLET, ZONE.PADDY].includes(centerZone)) continue;

        if (!footprintOK(field, bx, bz, angle, dims.w, dims.d)) continue;

        const radius = Math.hypot(dims.w, dims.d) / 2 * 0.85;
        if (overlaps(hash, bx, bz, radius)) continue;

        const height = dims.floors * 3.2 + (dims.type === 'house' ? 1.5 : 0);
        const building = {
          x: bx,
          z: bz,
          angle,
          w: dims.w,
          d: dims.d,
          floors: dims.floors,
          h: height,
          type: dims.type,
          zone,
        };

        buildings.push(building);

        const key = hashKey(bx, bz);
        if (!hash.has(key)) hash.set(key, []);
        hash.get(key).push({ x: bx, z: bz, r: radius });
      }
    }
  }

  return buildings;
}

/**
 * Generate a simplified town: reachability zones, arterial/ring/street roads,
 * and building footprints with height and type.
 */
export function generateTown(field, hydro, seed) {
  const rng = rngFor(seed, `town:${field.terrain.id}`);
  const zoneResult = computeZones(field, hydro, rng);
  const roads = buildRoads(field, hydro, zoneResult.center, zoneResult.zones, rng);
  const buildings = placeBuildings(field, zoneResult.center, zoneResult.zones, roads, rng);

  let arterialKm = 0;
  let streetKm = 0;
  for (const road of roads) {
    const km = roadLength(road) / 1000;
    if (road.cls === 'arterial') arterialKm += km;
    else if (road.cls === 'street') streetKm += km;
  }

  return {
    zones: zoneResult.zones,
    zoneStats: zoneResult.stats,
    center: zoneResult.center,
    roads,
    buildings,
    stats: {
      buildings: buildings.length,
      roads: roads.length,
      arterialKm,
      streetKm,
      ...zoneResult.stats,
    },
  };
}
