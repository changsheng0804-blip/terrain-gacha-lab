/**
 * Headless replica of the generation sequence in src/main.js, used only by
 * the judge. Kept inside test/ on purpose: the shared pipeline module belongs
 * to T09 (src/pipeline.js). When T09 lands, switch the import in judge.mjs to
 * `generateWorld` from src/pipeline.js and delete this file.
 */
import { generateHeightField, carveValleyOutlet } from '../../src/terrains.js';
import { erodeDroplets, thermalErosion, smoothField } from '../../src/erosion.js';
import { buildHydrology } from '../../src/hydrology.js';
import { generateTown } from '../../src/town.js';
import { rngFor } from '../../src/rng.js';

export async function generateWorld({ type, seed, size, res, erosion = true }) {
  const timings = { terrain: 0, erosion: 0, hydrology: 0, town: 0, total: 0 };
  let t = performance.now();
  const lap = (k) => { const now = performance.now(); timings[k] = now - t; timings.total += timings[k]; t = now; };

  const field = generateHeightField(type, seed, size, res);
  lap('terrain');

  let droplets = 0;
  if (erosion) {
    const tune = field.terrain.tune;
    const count = Math.min(Math.floor(field.n * field.n * tune.droplets), 320000);
    droplets = erodeDroplets(field.height, {
      n: field.n,
      seaLevel: 0,
      rng: rngFor(seed, `erosion:${type}`),
      droplets: count,
      life: tune.life,
      radius: tune.radius,
      erode: 0.3,
      deposit: 0.3,
    });
    thermalErosion(field.height, field.n, tune.talus, field.cell, 2);
    smoothField(field.height, field.n, tune.soft);
  }
  lap('erosion');

  const hydro = buildHydrology(field, { outlet: carveValleyOutlet(field) });
  lap('hydrology');

  const town = generateTown(field, hydro, seed);
  lap('town');

  return { field, hydro, town, droplets, timings };
}
