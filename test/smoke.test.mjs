import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { generateHeightField, carveValleyOutlet, TERRAIN_IDS } from '../src/terrains.js';
import { erodeDroplets, thermalErosion, smoothField } from '../src/erosion.js';
import { buildHydrology } from '../src/hydrology.js';
import { rngFor } from '../src/rng.js';

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

  let seaCount = 0;
  for (let i = 0; i < a.n * a.n; i++) seaCount += hydro.seaMask[i];

  console.log(
    `${type.padEnd(6)} h=${after.min.toFixed(1)}..${after.max.toFixed(1)}m`,
    `sea=${seaCount}`,
    `rivers=${hydro.riverCells}`,
    `maxAcc=${Math.round(hydro.maxAcc)}`,
    `hash=${hashArray(a.height)}`,
  );
}

console.log('smoke tests passed');
