import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { generateHeightField, carveValleyOutlet, TERRAIN_IDS } from '../src/terrains.js';
import { buildHydrology } from '../src/hydrology.js';
import { generateTown, ZONE } from '../src/town.js';
import { buildEcology, BIOME } from '../src/ecology.js';

const SEED = 777123;
const SIZE = 2400;
const RES = 160;

function hashArray(arr) {
  const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function assertUnitRange(arr, label) {
  assert.equal(arr.length > 0, true, `${label}: empty array`);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    assert.ok(Number.isFinite(v), `${label}[${i}]: non-finite`);
    assert.ok(v >= 0 && v <= 1, `${label}[${i}]: ${v} outside 0..1`);
  }
}

function slopeAt(field, i) {
  const { n, cell, height } = field;
  const x = i % n;
  const y = (i / n) | 0;
  const xm = x > 0 ? i - 1 : i;
  const xp = x < n - 1 ? i + 1 : i;
  const ym = y > 0 ? i - n : i;
  const yp = y < n - 1 ? i + n : i;
  const dx = xp - xm;
  const dy = yp - ym;
  const gx = dx > 0 ? (height[xp] - height[xm]) / (dx * cell) : 0;
  const gy = dy > 0 ? (height[yp] - height[ym]) / (dy * cell) : 0;
  return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
}

function build(type, seed) {
  const field = generateHeightField(type, seed, SIZE, RES);
  const hydro = buildHydrology(field, { outlet: carveValleyOutlet(field) });
  const town = generateTown(field, hydro, seed);
  const ecology = buildEcology(field, hydro, town);
  return { field, hydro, town, ecology };
}

let builtCount = 0;
let townCompared = 0;
let wetlandTerrains = 0;
const validBiomes = new Set(Object.values(BIOME));

for (const type of TERRAIN_IDS) {
  const { field, hydro, town, ecology } = build(type, SEED);
  const count = field.n * field.n;
  const label = `${type}`;

  assert.equal(ecology.moisture.length, count, `${label}: moisture length`);
  assert.equal(ecology.forest.length, count, `${label}: forest length`);
  assert.equal(ecology.rock.length, count, `${label}: rock length`);
  assert.equal(ecology.snow.length, count, `${label}: snow length`);
  assert.equal(ecology.beach.length, count, `${label}: beach length`);
  assert.equal(ecology.biome.length, count, `${label}: biome length`);

  assertUnitRange(ecology.moisture, `${label}.moisture`);
  assertUnitRange(ecology.forest, `${label}.forest`);
  assertUnitRange(ecology.rock, `${label}.rock`);
  assertUnitRange(ecology.snow, `${label}.snow`);

  for (let i = 0; i < count; i++) {
    assert.ok(ecology.beach[i] === 0 || ecology.beach[i] === 1, `${label}: beach[${i}] not 0/1`);
    assert.ok(validBiomes.has(ecology.biome[i]), `${label}: biome[${i}]=${ecology.biome[i]}`);
  }

  for (const [key, value] of Object.entries(ecology.stats)) {
    assert.ok(Number.isFinite(value), `${label}: stats.${key} not finite`);
    assert.ok(value >= 0 && value <= 100, `${label}: stats.${key}=${value} outside 0..100`);
  }
  if (ecology.stats.wetlandPct > 0) wetlandTerrains++;

  // Each cell has exactly one biome, so the reported percentages describe the
  // whole grid excluding water (which is tracked separately).
  const biomeSums = ecology.stats.forestPct + ecology.stats.grassPct
    + ecology.stats.rockPct + ecology.stats.snowPct
    + ecology.stats.beachPct + ecology.stats.wetlandPct;
  let waterCells = 0;
  for (let i = 0; i < count; i++) if (ecology.biome[i] === BIOME.WATER) waterCells++;
  const waterPct = count > 0 ? waterCells / count * 100 : 0;
  assert.ok(Math.abs(biomeSums + waterPct - 100) < 1e-6, `${label}: biome percentages should sum to 100`);

  // Water cells never carry forest; sea cells must be WATER biome.
  for (let i = 0; i < count; i++) {
    if (field.height[i] <= 0 || hydro.seaMask[i] || (hydro.lakeMask && hydro.lakeMask[i])) {
      assert.equal(ecology.forest[i], 0, `${label}: forest at water cell ${i}`);
      assert.equal(ecology.biome[i], BIOME.WATER, `${label}: biome at water cell ${i}`);
    }
  }

  // Snowline: cells above the relative snowline should be clearly snowy.
  let minH = Infinity;
  let maxH = -Infinity;
  for (const h of field.height) {
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const relief = Math.max(1e-3, maxH - minH);
  const snowline = maxH - 0.18 * relief;
  let above = 0;
  let snowSum = 0;
  for (let i = 0; i < count; i++) {
    if (field.height[i] >= snowline) {
      above++;
      snowSum += ecology.snow[i];
    }
  }
  assert.ok(above > 20, `${label}: expected cells above snowline`);
  assert.ok(snowSum / above > 0.4, `${label}: snow above snowline should be significant`);

  // Determinism: identical inputs produce byte-identical fields.
  const again = buildEcology(field, hydro, town);
  assert.equal(hashArray(again.forest), hashArray(ecology.forest), `${label}: forest determinism`);
  assert.equal(hashArray(again.moisture), hashArray(ecology.moisture), `${label}: moisture determinism`);
  assert.equal(hashArray(again.biome), hashArray(ecology.biome), `${label}: biome determinism`);

  // Inputs are read-only for the ecology layer.
  const heightHash = hashArray(field.height);
  const accHash = hashArray(hydro.acc);
  const zoneHash = hashArray(town.zones);
  buildEcology(field, hydro, town);
  assert.equal(hashArray(field.height), heightHash, `${label}: field.height mutated`);
  assert.equal(hashArray(hydro.acc), accHash, `${label}: hydro.acc mutated`);
  assert.equal(hashArray(town.zones), zoneHash, `${label}: town.zones mutated`);

  // town is optional: the no-town path must not throw and must never have
  // less canopy than the town-attenuated version.
  const noTown = buildEcology(field, hydro);
  assert.equal(noTown.forest.length, count, `${label}: no-town forest length`);
  assertUnitRange(noTown.forest, `${label}.noTown.forest`);
  for (let i = 0; i < count; i++) {
    assert.ok(
      noTown.forest[i] + 1e-6 >= ecology.forest[i],
      `${label}: no-town forest[${i}] below town-attenuated forest`,
    );
  }

  // Near-water lowland forest vs dry, high, far-from-river ground.
  let nearSum = 0;
  let nearCount = 0;
  let drySum = 0;
  let dryCount = 0;
  for (let i = 0; i < count; i++) {
    if (field.height[i] <= 0 || hydro.seaMask[i] || hydro.riverMask[i]) continue;
    const slope = slopeAt(field, i);
    const dRiverM = hydro.dRiver[i] * field.cell;
    if (dRiverM < 80 && slope < 12) {
      nearSum += ecology.forest[i];
      nearCount++;
    }
    if (slope > 20 && dRiverM > 300 && field.height[i] > 20) {
      drySum += ecology.forest[i];
      dryCount++;
    }
  }
  assert.ok(nearCount > 50, `${label}: expected near-water samples`);
  assert.ok(dryCount > 50, `${label}: expected dry high-slope samples`);
  assert.ok(
    nearSum / nearCount > drySum / dryCount + 0.05,
    `${label}: near-water forest (${(nearSum / nearCount).toFixed(2)}) should exceed dry slopes (${(drySum / dryCount).toFixed(2)})`,
  );

  // Town attenuation: effective zones should carry less canopy than
  // non-town ground at a comparable elevation.
  if (town && town.zones && town.center && town.center.index >= 0) {
    const n = field.n;
    const cx = Math.round((town.center.x - field.x0) / field.cell);
    const cy = Math.round((town.center.z - field.y0) / field.cell);
    const centerH = field.height[cy * n + cx];
    let urbanSum = 0;
    let urbanCount = 0;
    let openSum = 0;
    let openCount = 0;
    for (let i = 0; i < count; i++) {
      const zone = town.zones[i];
      if (zone >= ZONE.CORE && zone <= ZONE.HAMLET) {
        urbanSum += ecology.forest[i];
        urbanCount++;
      } else if (zone === ZONE.NONE && Math.abs(field.height[i] - centerH) < 50) {
        openSum += ecology.forest[i];
        openCount++;
      }
    }
    const urbanMean = urbanCount > 0 ? urbanSum / urbanCount : 0;
    const openMean = openCount > 0 ? openSum / openCount : 0;
    if (openCount > 50 && openMean > 0.08) {
      assert.ok(
        urbanMean < openMean,
        `${label}: town forest (${urbanMean.toFixed(2)}) should be below open ground (${openMean.toFixed(2)})`,
      );
      townCompared++;
    }
  }

  builtCount++;
}

assert.equal(builtCount, TERRAIN_IDS.length, 'all terrains should build');
assert.ok(townCompared >= 3, 'expected a meaningful town/open comparison on most terrains');
assert.ok(wetlandTerrains > 0, 'expected at least one terrain with visible wetland');

// Different seeds must change the ecology on at least one terrain (and the
// same seed must stay stable, already asserted above).
let changedTerrains = 0;
for (const type of TERRAIN_IDS) {
  const a = build(type, SEED);
  const b = build(type, SEED + 17);
  if (hashArray(a.ecology.forest) !== hashArray(b.ecology.forest)) changedTerrains++;
}
assert.ok(changedTerrains > 0, 'different seeds should change forest on at least one terrain');

console.log(`ecology.test.mjs: ok (${TERRAIN_IDS.length} terrains, ${townCompared} town comparisons)`);
