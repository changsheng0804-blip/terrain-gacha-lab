import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { generateHeightField, carveValleyOutlet, TERRAIN_IDS } from '../src/terrains.js';
import { erodeDroplets, thermalErosion, smoothField } from '../src/erosion.js';
import { buildHydrology, findLakes } from '../src/hydrology.js';
import { rngFor } from '../src/rng.js';

const DIST_INF = 0x3fffffff;
const MAX_FALLS = 120;
const MIN_FALL_DROP = 8;

function hashArray(arr) {
  const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function minMax(arr) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of arr) {
    if (!Number.isFinite(v)) throw new Error('non-finite height');
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

let lakeTotal = 0;
let fallTotal = 0;
let capHit = false;

for (const type of TERRAIN_IDS) {
  const size = 2000;
  const res = 192;

  const a = generateHeightField(type, 123456, size, res);
  const b = generateHeightField(type, 123456, size, res);

  assert.equal(hashArray(a.height), hashArray(b.height), `${type}: seed must be deterministic`);

  const before = minMax(a.height);
  assert.ok(before.max > before.min, `${type}: height range should be non-zero`);
  assert.ok(before.max > 20, `${type}: terrain should have relief`);

  // Erosion should run and keep the field finite.
  const rng = rngFor(123456, `erosion:${type}`);
  erodeDroplets(a.height, {
    n: a.n,
    seaLevel: 0,
    rng,
    droplets: 1200,
    life: 24,
    radius: 2,
    erode: 0.3,
    deposit: 0.3,
  });
  thermalErosion(a.height, a.n, a.terrain.tune.talus, a.cell, 1);
  smoothField(a.height, a.n, a.terrain.tune.soft * 0.5);
  const after = minMax(a.height);
  assert.ok(after.max > after.min, `${type}: erosion should preserve relief`);

  const outlets = carveValleyOutlet(a);
  const hydro = buildHydrology(a, { outlet: outlets });

  assert.ok(hydro.maxAcc >= 1, `${type}: flow accumulation should be positive`);
  assert.ok(hydro.riverCells > 0, `${type}: expected at least one river cell`);

  // ---- T06: lakes, river width, waterfalls -------------------------------

  const total = a.n * a.n;

  assert.ok(hydro.lakeMask instanceof Uint8Array, `${type}: lakeMask should be a Uint8Array`);
  assert.ok(hydro.waterMask instanceof Uint8Array, `${type}: waterMask should be a Uint8Array`);
  assert.ok(hydro.dLake instanceof Int32Array, `${type}: dLake should be an Int32Array`);
  assert.ok(hydro.riverWidth instanceof Float32Array, `${type}: riverWidth should be a Float32Array`);
  assert.ok(Array.isArray(hydro.falls), `${type}: falls should be an array`);

  for (const [name, arr] of [
    ['lakeMask', hydro.lakeMask],
    ['waterMask', hydro.waterMask],
    ['dLake', hydro.dLake],
    ['riverWidth', hydro.riverWidth],
  ]) {
    assert.equal(arr.length, total, `${type}: ${name} should cover every cell`);
  }

  let seaCount = 0;
  let lakeCells = 0;
  let seaOverlap = 0;
  let subSeaLake = 0;
  let waterBad = 0;
  let dLakeMin = Infinity;
  let dLakeMax = -Infinity;
  let widthMin = Infinity;
  let widthMax = -Infinity;
  let widest = 0;

  for (let i = 0; i < total; i++) {
    const sea = hydro.seaMask[i];
    const lake = hydro.lakeMask[i];
    seaCount += sea;
    lakeCells += lake;
    if (lake && sea) seaOverlap++;
    if (lake && a.height[i] <= 0) subSeaLake++;
    if (hydro.waterMask[i] !== (sea || lake ? 1 : 0)) waterBad++;

    const d = hydro.dLake[i];
    if (d < dLakeMin) dLakeMin = d;
    if (d > dLakeMax) dLakeMax = d;

    const w = hydro.riverWidth[i];
    if (!Number.isFinite(w)) throw new Error(`${type}: non-finite riverWidth at ${i}`);
    if (w < widthMin) widthMin = w;
    if (w > widthMax) widthMax = w;

    if (hydro.acc[i] > hydro.acc[widest]) widest = i;
  }

  // seaMask keeps its meaning, lakeMask stays inland, waterMask is the union.
  assert.equal(seaOverlap, 0, `${type}: lakeMask must not overlap seaMask`);
  assert.equal(subSeaLake, 0, `${type}: lake cells must sit above sea level`);
  assert.equal(waterBad, 0, `${type}: waterMask must equal seaMask | lakeMask`);

  if (lakeCells > 0) {
    assert.equal(dLakeMin, 0, `${type}: lake cells should have dLake = 0`);
    assert.ok(dLakeMax > 0 && dLakeMax < DIST_INF, `${type}: dLake should stay bounded when a lake exists`);
  } else {
    assert.equal(dLakeMin, DIST_INF, `${type}: without lakes dLake stays at the transform's INF`);
  }

  // River width: bounded, widest at the largest catchment, monotonic in acc.
  assert.ok(widthMin >= 2, `${type}: riverWidth should start at 2 m, got ${widthMin}`);
  assert.ok(widthMax <= 24, `${type}: riverWidth must stay under the 24 m cap, got ${widthMax}`);
  assert.ok(
    Math.abs(hydro.riverWidth[widest] - 20) < 1e-3,
    `${type}: the largest catchment should be ~20 m wide, got ${hydro.riverWidth[widest]}`,
  );

  const sample = [];
  for (let i = 0; i < total; i += 7) sample.push(i);
  sample.sort((p, q) => hydro.acc[p] - hydro.acc[q]);
  for (let k = 1; k < sample.length; k++) {
    assert.ok(
      hydro.riverWidth[sample[k]] >= hydro.riverWidth[sample[k - 1]] - 1e-6,
      `${type}: riverWidth must not shrink as acc grows (cell ${sample[k]})`,
    );
  }

  // Waterfalls: contract shape, on a river, sorted, capped, inside the map.
  assert.ok(hydro.falls.length <= MAX_FALLS, `${type}: falls must be capped at ${MAX_FALLS}`);
  for (const f of hydro.falls) {
    assert.deepEqual(
      Object.keys(f).sort(),
      ['drop', 'x', 'z'],
      `${type}: a fall should expose exactly { x, z, drop }`,
    );
    assert.ok(
      Number.isFinite(f.x) && Number.isFinite(f.z) && Number.isFinite(f.drop),
      `${type}: fall needs finite x/z/drop`,
    );
    assert.ok(f.drop > MIN_FALL_DROP, `${type}: fall drop should exceed ${MIN_FALL_DROP} m, got ${f.drop}`);
    assert.ok(
      f.x >= a.x0 && f.x <= a.x0 + a.size && f.z >= a.y0 && f.z <= a.y0 + a.size,
      `${type}: fall (${f.x}, ${f.z}) is outside the map`,
    );
    const gx = Math.round((f.x - a.x0) / a.cell);
    const gz = Math.round((f.z - a.y0) / a.cell);
    assert.equal(
      hydro.riverMask[gz * a.n + gx],
      1,
      `${type}: fall at (${f.x}, ${f.z}) should sit on a river cell`,
    );
  }
  for (let k = 1; k < hydro.falls.length; k++) {
    assert.ok(
      hydro.falls[k - 1].drop >= hydro.falls[k].drop,
      `${type}: falls should be sorted by descending drop`,
    );
  }

  // With the drop/separation filters relaxed the cap has to hold everywhere.
  const loose = buildHydrology(a, { outlet: outlets, falls: { minDrop: 0, minSepCells: 0 } });
  assert.ok(loose.falls.length <= MAX_FALLS, `${type}: relaxed falls must stay capped at ${MAX_FALLS}`);
  if (loose.falls.length === MAX_FALLS) capHit = true;

  // Determinism: rebuilding from the same field must not change anything, and
  // buildHydrology must not touch the input heights.
  const heightBefore = hashArray(a.height);
  const again = buildHydrology(a, { outlet: outlets });
  assert.equal(hashArray(a.height), heightBefore, `${type}: buildHydrology must not mutate the field`);
  assert.equal(hashArray(again.lakeMask), hashArray(hydro.lakeMask), `${type}: lakeMask must be deterministic`);
  assert.equal(hashArray(again.waterMask), hashArray(hydro.waterMask), `${type}: waterMask must be deterministic`);
  assert.equal(hashArray(again.dLake), hashArray(hydro.dLake), `${type}: dLake must be deterministic`);
  assert.equal(hashArray(again.riverWidth), hashArray(hydro.riverWidth), `${type}: riverWidth must be deterministic`);
  assert.deepEqual(again.falls, hydro.falls, `${type}: falls must be deterministic`);

  // Lake records agree with the mask and carry a usable water level.
  const { lakes, lakeCells: counted, lakeMask } = findLakes(a, hydro.filled, hydro.seaMask);
  assert.equal(hashArray(lakeMask), hashArray(hydro.lakeMask), `${type}: findLakes should match hydro.lakeMask`);
  assert.equal(counted, lakeCells, `${type}: lake cell count should match the mask`);
  let waterSum = 0;
  for (const lake of lakes) {
    assert.ok(lake.waterCells > 0 && lake.area > 0, `${type}: a lake needs real water area`);
    assert.ok(Number.isFinite(lake.level), `${type}: lake level must be finite`);
    assert.ok(lake.depth > 1.5, `${type}: lake depth should exceed 1.5 m, got ${lake.depth}`);
    waterSum += lake.waterCells;
  }
  assert.equal(waterSum, lakeCells, `${type}: lake records should cover every lake cell`);
  for (let k = 1; k < lakes.length; k++) {
    assert.ok(lakes[k - 1].area >= lakes[k].area, `${type}: lakes should be sorted by area`);
  }

  lakeTotal += lakeCells;
  fallTotal += hydro.falls.length;

  console.log(
    `${type.padEnd(6)} h=${after.min.toFixed(1)}..${after.max.toFixed(1)}m`,
    `sea=${seaCount}`,
    `rivers=${hydro.riverCells}`,
    `lakes=${lakes.length}/${lakeCells}cells`,
    `falls=${hydro.falls.length}`,
    `width=${widthMin.toFixed(1)}..${widthMax.toFixed(1)}m`,
    `maxAcc=${Math.round(hydro.maxAcc)}`,
    `hash=${hashArray(a.height)}`,
  );
}

assert.ok(lakeTotal > 0, 'expected at least one inland lake across the terrain set');
assert.ok(fallTotal > 0, 'expected at least one waterfall across the terrain set');
assert.ok(capHit, `expected the ${MAX_FALLS}-fall cap to bind for at least one terrain`);

console.log(`hydrology totals: lakeCells=${lakeTotal} falls=${fallTotal}`);
console.log('smoke tests passed');
