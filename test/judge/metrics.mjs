import {
  SpatialHash, indexSegments, obbBounds, obbCorners, obbOverlap, segObbDist, segSegDist,
} from './geometry.mjs';

const ZONE_NONE = 0;
const ZONE_WATER = 6;
const RAIL_HALF_WIDTH = 5;

function sampleH(field, x, z) {
  const { n, cell, x0, y0, height } = field;
  const gx = Math.max(0, Math.min(n - 1, Math.round((x - x0) / cell)));
  const gz = Math.max(0, Math.min(n - 1, Math.round((z - y0) / cell)));
  return height[gz * n + gx];
}

function idxAt(field, x, z) {
  const { n, cell, x0, y0 } = field;
  const gx = Math.max(0, Math.min(n - 1, Math.round((x - x0) / cell)));
  const gz = Math.max(0, Math.min(n - 1, Math.round((z - y0) / cell)));
  return gz * n + gx;
}

function slopeDeg(field, i) {
  const { n, height, cell } = field;
  const x = i % n;
  const y = (i / n) | 0;
  const gx = (height[x === n - 1 ? i : i + 1] - height[x === 0 ? i : i - 1]) / (2 * cell);
  const gy = (height[y === n - 1 ? i : i + n] - height[y === 0 ? i : i - n]) / (2 * cell);
  return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
}

export function fnv(buf) {
  let h = 2166136261 >>> 0;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function worldHash(world) {
  const t = world.town;
  const townKey = JSON.stringify({
    b: t.buildings.map((b) => [b.x, b.z, b.angle, b.w, b.d, b.h, b.type]),
    r: t.roads.map((r) => r.pts),
    rail: t.railway ? t.railway.pts : null,
  });
  return `${fnv(world.field.height)}-${fnv(new TextEncoder().encode(townKey))}`;
}

/* ------------------------------------------------------------------ */
/* Hydrology                                                           */
/* ------------------------------------------------------------------ */

export function hydrologyMetrics(world) {
  const { field, hydro } = world;
  const { n } = field;
  let sinks = 0;
  let terminalAcc = 0;
  let uphill = 0;

  for (let i = 0; i < n * n; i++) {
    const d = hydro.dir[i];
    const x = i % n;
    const y = (i / n) | 0;
    const boundary = x === 0 || y === 0 || x === n - 1 || y === n - 1;
    if (d < 0) {
      terminalAcc += hydro.acc[i];
      if (!boundary && !hydro.seaMask[i]) sinks++;
    } else if (hydro.riverMask[i] && hydro.filled[d] >= hydro.filled[i]) {
      uphill++;
    }
  }

  let seaCells = 0;
  for (let i = 0; i < n * n; i++) seaCells += hydro.seaMask[i];
  const cellArea = field.cell * field.cell;

  return {
    hydro_sinks: sinks,
    hydro_mass_error: Math.abs(terminalAcc - n * n) / (n * n),
    hydro_uphill_river_cells: uphill,
    river_area_km2: hydro.riverCells * cellArea / 1e6,
    sea_area_km2: seaCells * cellArea / 1e6,
  };
}

/* ------------------------------------------------------------------ */
/* Town                                                                */
/* ------------------------------------------------------------------ */

export function townMetrics(world) {
  const { field, town } = world;
  const blds = town.buildings;
  const N = Math.max(1, blds.length);

  // Roads and railway as thick polylines.
  const roadIdx = indexSegments(town.roads.map((r) => ({ pts: r.pts, hw: r.width / 2 })));
  const railIdx = town.railway
    ? indexSegments([{ pts: town.railway.pts, hw: RAIL_HALF_WIDTH }])
    : null;

  let onRoad = 0;
  let onRail = 0;
  let badSite = 0;
  let inRiver = 0;
  const bHash = new SpatialHash(40);
  let overlapping = 0;

  blds.forEach((b, k) => {
    const [minX, minZ, maxX, maxZ] = obbBounds(b);

    let hitRoad = false;
    for (const s of roadIdx.hash.query(minX - 8, minZ - 8, maxX + 8, maxZ + 8)) {
      if (segObbDist(b, s.a, s.b) < s.hw) { hitRoad = true; break; }
    }
    if (hitRoad) onRoad++;

    if (railIdx && !b.station) {
      for (const s of railIdx.hash.query(minX - 6, minZ - 6, maxX + 6, maxZ + 6)) {
        if (segObbDist(b, s.a, s.b) < s.hw) { onRail++; break; }
      }
    }

    const i = idxAt(field, b.x, b.z);
    const zone = town.zones[i];
    const h = field.height[i];
    if (h <= 0.8 || zone === ZONE_NONE || zone === ZONE_WATER || slopeDeg(field, i) > 20) badSite++;

    // Rivers are land cells in the zone map, so check the footprint against
    // the river mask explicitly (centre + four corners).
    const pts = [[b.x, b.z], ...obbCorners(b)];
    if (pts.some(([x, z]) => world.hydro.riverMask[idxAt(field, x, z)])) inRiver++;

    let hit = false;
    for (const other of bHash.query(minX, minZ, maxX, maxZ)) {
      if (obbOverlap(b, blds[other])) { hit = true; break; }
    }
    if (hit) overlapping++;
    bHash.insert(k, minX, minZ, maxX, maxZ);
  });

  // Road network: components, dead ends and length over water.
  const roads = town.roads;
  const parent = roads.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const lengths = roads.map((r) => {
    let L = 0;
    for (let i = 1; i < r.pts.length; i++) L += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
    return L;
  });

  for (const s of roadIdx.segs) {
    const pad = s.hw + 3;
    for (const t of roadIdx.hash.query(
      Math.min(s.a[0], s.b[0]) - pad, Math.min(s.a[1], s.b[1]) - pad,
      Math.max(s.a[0], s.b[0]) + pad, Math.max(s.a[1], s.b[1]) + pad,
    )) {
      if (t.owner === s.owner) continue;
      if (find(t.owner) === find(s.owner)) continue;
      if (segSegDist(s.a, s.b, t.a, t.b) <= s.hw + t.hw + 3) parent[find(s.owner)] = find(t.owner);
    }
  }

  const compLen = new Map();
  let totalLen = 0;
  roads.forEach((_, i) => {
    const r = find(i);
    compLen.set(r, (compLen.get(r) || 0) + lengths[i]);
    totalLen += lengths[i];
  });
  const largest = Math.max(0, ...compLen.values());

  const margin = field.cell * 3;
  const edge = (x, z) => x < field.x0 + margin || z < field.y0 + margin
    || x > field.x0 + field.size - margin || z > field.y0 + field.size - margin;
  let ends = 0;
  let deadEnds = 0;
  roads.forEach((r, ri) => {
    for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) {
      if (edge(p[0], p[1])) continue;
      ends++;
      let joined = false;
      for (const s of roadIdx.hash.query(p[0] - 20, p[1] - 20, p[0] + 20, p[1] + 20)) {
        if (s.owner === ri) continue;
        if (segSegDist(p, p, s.a, s.b) <= r.width / 2 + s.hw + 3) { joined = true; break; }
      }
      if (!joined) deadEnds++;
    }
  });

  let wetRoad = 0;
  for (const s of roadIdx.segs) {
    if (sampleH(field, (s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2) <= 0) {
      wetRoad += Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    }
  }

  // Railway.
  let railWet = 0;
  if (town.railway) {
    for (const [x, z] of town.railway.pts) if (sampleH(field, x, z) <= 0.8) railWet++;
  }

  return {
    buildings: blds.length,
    core_pct: town.zoneStats.corePct,
    bld_on_road_pct: onRoad / N * 100,
    bld_overlap_pct: overlapping / N * 100,
    bld_on_rail_pct: onRail / N * 100,
    bld_bad_site_pct: badSite / N * 100,
    bld_in_river_pct: inRiver / N * 100,
    station_building: blds.some((b) => b.type === 'station') ? 1 : 0,
    road_km: totalLen / 1000,
    road_main_component_pct: totalLen > 0 ? largest / totalLen * 100 : 0,
    road_dead_end_pct: ends > 0 ? deadEnds / ends * 100 : 0,
    road_over_water_m: wetRoad,
    rail_km: town.railway ? town.railway.length / 1000 : 0,
    rail_wet_points: railWet,
  };
}

export function worldMetrics(world) {
  return {
    ...hydrologyMetrics(world),
    ...townMetrics(world),
    ms_total: world.timings.total,
  };
}
