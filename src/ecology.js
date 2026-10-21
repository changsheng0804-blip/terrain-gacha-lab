/**
 * Ecology data layer.
 *
 * Pure data: reads a height field, hydrology and optional town, and returns
 * per-cell ecology fields shared by the 2D and 3D viewers. No DOM, no canvas,
 * no mutation of the inputs.
 */

import { clamp, rngFor, smoothstep } from './rng.js';

export const BIOME = {
  WATER: 0,
  BEACH: 1,
  GRASS: 2,
  FOREST: 3,
  ROCK: 4,
  SNOW: 5,
  WETLAND: 6,
};

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Low-frequency value noise on a coarse lattice, bilinearly interpolated with
 * a smoothstep fade. Two octaves are mixed for natural-looking patches.
 * The lattice values are drawn once from the ecosystem RNG, so the whole
 * jitter field is deterministic for a given seed + terrain.
 */
function buildJitter(n, rng) {
  const specs = [
    { g: 9, w: 0.62 },
    { g: 23, w: 0.38 },
  ];
  const layers = specs.map((spec) => {
    const values = new Float32Array(spec.g * spec.g);
    for (let i = 0; i < values.length; i++) values[i] = rng() * 2 - 1;
    return { ...spec, values };
  });

  const out = new Float32Array(n * n);
  const denom = Math.max(1, n - 1);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let v = 0;
      for (const layer of layers) {
        const g = layer.g;
        const lx = (x / denom) * (g - 1);
        const ly = (y / denom) * (g - 1);
        const ix = Math.min(g - 2, Math.floor(lx));
        const iy = Math.min(g - 2, Math.floor(ly));
        let tx = lx - ix;
        let ty = ly - iy;
        tx = tx * tx * (3 - 2 * tx);
        ty = ty * ty * (3 - 2 * ty);

        const a = layer.values[iy * g + ix];
        const b = layer.values[iy * g + ix + 1];
        const c = layer.values[(iy + 1) * g + ix];
        const d = layer.values[(iy + 1) * g + ix + 1];
        const top = a + (b - a) * tx;
        const bottom = c + (d - c) * tx;
        v += (top + (bottom - top) * ty) * layer.w;
      }
      out[y * n + x] = clamp(v, -1, 1);
    }
  }

  return out;
}

/** Local slope in degrees from central differences. */
function slopeDegrees(height, n, cell, i, x, y) {
  const xm = x > 0 ? i - 1 : i;
  const xp = x < n - 1 ? i + 1 : i;
  const ym = y > 0 ? i - n : i;
  const yp = y < n - 1 ? i + n : i;

  const dxCells = xp - xm;
  const dyCells = yp - ym;
  const gx = dxCells > 0 ? (height[xp] - height[xm]) / (dxCells * cell) : 0;
  const gy = dyCells > 0 ? (height[yp] - height[ym]) / (dyCells * cell) : 0;
  return Math.atan(Math.hypot(gx, gy)) * RAD_TO_DEG;
}

/** Positive on local ridgelines/peaks, zero on planar slopes. */
function ridgeValue(height, n, i, x, y, relief) {
  const left = x > 0 ? height[i - 1] : height[i];
  const right = x < n - 1 ? height[i + 1] : height[i];
  const up = y > 0 ? height[i - n] : height[i];
  const down = y < n - 1 ? height[i + n] : height[i];
  const avg = (left + right + up + down) * 0.25;
  return clamp((height[i] - avg) / (relief * 0.045 + 1), 0, 1);
}

// Mirrors ZONE in town.js (NONE, CORE, RES, PADDY, IND, HAMLET, WATER).
// Kept local so this data module stays dependency-free.
const TOWN_ZONE_FACTOR = [1, 0.08, 0.18, 0.30, 0.12, 0.35, 0];

function townAttenuation(zone) {
  return TOWN_ZONE_FACTOR[zone] ?? 1;
}

function resolveSnowline(field, minH, maxH) {
  const relief = Math.max(1e-3, maxH - minH);
  let snowline = maxH - 0.18 * relief;

  const declared = field.terrain?.snowline ?? field.params?.snowline;
  if (Number.isFinite(declared)) {
    // Values in 0..1 are a fraction of the relief; larger values are metres.
    snowline = declared <= 1 ? minH + relief * declared : declared;
  }
  return snowline;
}

function resolveForestBias(field) {
  const bias = field.terrain?.forestBias ?? field.params?.forestBias;
  return Number.isFinite(bias) ? clamp(bias, -0.6, 0.6) : 0;
}

/**
 * Build the ecology field for a generated terrain.
 *
 * @param {object} field  HeightField from generateHeightField (n, cell, height, seed, terrain).
 * @param {object} hydro  Hydrology from buildHydrology.
 * @param {object|null} town  Optional town; effective zones suppress forest.
 * @returns {{moisture: Float32Array, forest: Float32Array, rock: Float32Array,
 *   snow: Float32Array, beach: Uint8Array, biome: Uint8Array,
 *   stats: {forestPct: number, grassPct: number, rockPct: number,
 *   snowPct: number, beachPct: number, wetlandPct: number}}}
 */
export function buildEcology(field, hydro, town = null) {
  const { n, cell, height } = field;
  if (!n || !height) throw new Error('buildEcology: field.n and field.height are required');
  if (!hydro || !hydro.dRiver || !hydro.dSea) {
    throw new Error('buildEcology: hydro.dRiver and hydro.dSea are required');
  }

  const count = n * n;
  const moisture = new Float32Array(count);
  const forest = new Float32Array(count);
  const rock = new Float32Array(count);
  const snow = new Float32Array(count);
  const beach = new Uint8Array(count);
  const biome = new Uint8Array(count);

  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < count; i++) {
    const h = height[i];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const relief = Math.max(1e-3, maxH - minH);
  const snowline = resolveSnowline(field, minH, maxH);
  const forestBias = resolveForestBias(field);
  const forestBiasScale = 1 + forestBias;

  const seed = field.seed ?? 0;
  const terrainId = field.terrain?.id ?? 'unknown';
  const rng = rngFor(seed, `ecology:${terrainId}`);
  const jitter = buildJitter(n, rng);

  const maxAcc = Math.max(1, hydro.maxAcc || 1);
  const minAcc = Math.max(1, hydro.minAcc || 1);
  const logMaxAcc = Math.log1p(maxAcc);
  const hasSea = !!field.terrain?.hasSea;
  const zones = town?.zones;
  const useZones = zones && zones.length === count;

  const biomeCounts = new Array(7).fill(0);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const h = height[i];
      const hRel = clamp((h - minH) / relief, 0, 1);
      const slope = slopeDegrees(height, n, cell, i, x, y);
      const ridge = ridgeValue(height, n, i, x, y, relief);
      const dRiverM = hydro.dRiver[i] * cell;
      const dSeaM = hydro.dSea[i] * cell;
      const acc = hydro.acc ? hydro.acc[i] : 1;

      const isSea = hydro.seaMask ? hydro.seaMask[i] !== 0 : h <= 0;
      const isRiver = hydro.riverMask ? hydro.riverMask[i] !== 0 : false;
      const isWater = isSea || isRiver || h <= 0;
      const j = jitter[i];
      const j01 = 0.5 + 0.5 * j;

      if (isWater) {
        moisture[i] = 1;
        forest[i] = 0;
        rock[i] = 0;
        snow[i] = 0;
        beach[i] = 0;
        biome[i] = BIOME.WATER;
        biomeCounts[BIOME.WATER]++;
        continue;
      }

      // --- moisture -------------------------------------------------------
      const nearWater = Math.exp(-dRiverM / 140);
      const flowWet = maxAcc > minAcc
        ? clamp(Math.log1p(Math.max(1, acc)) / logMaxAcc, 0, 1)
        : 0;
      const lowSlope = 1 - smoothstep(6, 38, slope);
      const lowElev = 1 - smoothstep(0.55, 0.95, hRel);
      const coastWet = hasSea ? Math.exp(-dSeaM / 260) : 0;

      let m = 0.34 * nearWater
        + 0.30 * Math.pow(flowWet, 0.65)
        + 0.16 * lowSlope
        + 0.12 * lowElev
        + 0.08 * coastWet;
      m += (j01 - 0.5) * 0.16;
      m = clamp(m, 0, 1);
      moisture[i] = m;

      // --- beach ----------------------------------------------------------
      const beachWidth = 28 + 14 * j01;
      const isBeach = h > 0 && h < 4.5 && dSeaM < beachWidth && !isRiver;
      beach[i] = isBeach ? 1 : 0;

      // --- snow -----------------------------------------------------------
      const snowFade = smoothstep(snowline - relief * 0.02, snowline + relief * 0.05, h);
      const snowHold = 1 - 0.62 * smoothstep(32, 62, slope);
      let sn = snowFade * snowHold * (0.88 + 0.24 * j01);
      sn = clamp(sn, 0, 1);
      snow[i] = sn;

      // --- rock -----------------------------------------------------------
      const slopeRock = smoothstep(20, 48, slope);
      const altRock = smoothstep(0.55, 0.88, hRel);
      const ridgeRock = smoothstep(0.12, 0.6, ridge);
      let rk = 0.62 * slopeRock + 0.28 * altRock + 0.28 * ridgeRock
        + 0.10 * (j01 - 0.5) - 0.08;
      rk = clamp(rk, 0, 1);
      rock[i] = rk;

      // --- forest ---------------------------------------------------------
      const habitat = smoothstep(0.30, 0.55, m)
        * (1 - smoothstep(34, 58, slope))
        * (1 - 0.65 * smoothstep(0.68, 0.92, hRel));
      const townFactor = useZones ? townAttenuation(zones[i]) : 1;
      let fr = habitat
        * forestBiasScale
        * (1 - sn)
        * (1 - rk)
        * (1 - beach[i])
        * (0.84 + 0.32 * j01)
        * townFactor;
      fr = clamp(fr, 0, 1);
      forest[i] = fr;

      // --- wetland --------------------------------------------------------
      const isWetland = m > 0.60
        && slope < 6
        && h < 160
        && !isBeach
        && (dRiverM < 520 || flowWet > 0.45);

      // --- biome priority: water > beach > snow > rock > forest > wetland > grass
      let b = BIOME.GRASS;
      if (isBeach) b = BIOME.BEACH;
      else if (sn > 0.5) b = BIOME.SNOW;
      else if (rk > 0.55) b = BIOME.ROCK;
      else if (fr > 0.45) b = BIOME.FOREST;
      else if (isWetland) b = BIOME.WETLAND;
      biome[i] = b;
      biomeCounts[b]++;
    }
  }

  const pct = (value) => count > 0 ? (value / count) * 100 : 0;
  return {
    moisture,
    forest,
    rock,
    snow,
    beach,
    biome,
    stats: {
      forestPct: pct(biomeCounts[BIOME.FOREST]),
      grassPct: pct(biomeCounts[BIOME.GRASS]),
      rockPct: pct(biomeCounts[BIOME.ROCK]),
      snowPct: pct(biomeCounts[BIOME.SNOW]),
      beachPct: pct(biomeCounts[BIOME.BEACH]),
      wetlandPct: pct(biomeCounts[BIOME.WETLAND]),
    },
  };
}
