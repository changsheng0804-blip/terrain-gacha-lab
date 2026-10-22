/**
 * RFC-001 PoC: stepper core + synchronous fold facade.
 * Pure: no DOM/canvas/window. Order mirrors src/main.js exactly:
 * design -> droplets (micro-batches) -> thermal -> smooth -> outlet -> hydrology -> town.
 * Ecology is computed twice: natural (town = null) before the town, final after.
 */
import { generateHeightField, carveValleyOutlet } from './terrains.js';
import { erodeDroplets, thermalErosion, smoothField } from './erosion.js';
import { buildHydrology } from './hydrology.js';
import { generateTown } from './town.js';
import { buildEcology } from './ecology.js';
import { rngFor } from './rng.js';

const MAX_DROPLETS = 320000;

export function* createWorldEvolution(config, opts = {}) {
  const { type, seed, size, res, erosion = true, townMode = 'classic', events = [] } = config;
  const { dropletBatch = 1024, ecology = true } = opts;
  if (townMode !== 'classic') throw new Error(`townMode '${townMode}' not implemented`);
  if (events.length) throw new Error('events not implemented');

  const frame = (stage, progress, extra = {}) => ({
    stage, progress, step: 0, steps: 1, droplets, height: field.height, grid: field.n,
    hydro, ecologyNatural, town, ecology: eco, ...extra,
  });

  let droplets = 0;
  let hydro = null;
  let ecologyNatural = null;
  let town = null;
  let eco = null;

  const field = generateHeightField(type, seed, size, res);
  yield frame('design', 0.05);

  if (erosion) {
    const tune = field.terrain.tune;
    const total = Math.min(Math.floor(field.n * field.n * tune.droplets), MAX_DROPLETS);
    const rng = rngFor(seed, `erosion:${type}`);
    const options = {
      n: field.n, seaLevel: 0, rng, droplets: 0,
      life: tune.life, radius: tune.radius, erode: 0.3, deposit: 0.3,
    };
    const steps = Math.ceil(total / dropletBatch);
    for (let s = 0; s < steps; s++) {
      options.droplets = Math.min(dropletBatch, total - droplets);
      droplets += erodeDroplets(field.height, options);
      yield frame('erosion', 0.05 + 0.5 * (droplets / total), { step: s + 1, steps });
    }
    thermalErosion(field.height, field.n, tune.talus, field.cell, 2);
    yield frame('thermal', 0.57);
    smoothField(field.height, field.n, tune.soft);
    yield frame('smooth', 0.58);
  }

  const outlets = carveValleyOutlet(field);
  yield frame('outlet', 0.59);
  hydro = buildHydrology(field, { outlet: outlets });
  yield frame('hydrology', 0.7);

  if (ecology) {
    ecologyNatural = buildEcology(field, hydro, null);
    yield frame('ecology-natural', 0.75);
  }

  town = generateTown(field, hydro, seed);
  yield frame('town', 0.95);

  if (ecology) {
    eco = buildEcology(field, hydro, town);
  }
  yield frame('done', 1);
  return { field, hydro, town, ecology: eco, ecologyNatural, droplets };
}

export function generateWorld(config, opts = {}) {
  const t0 = performance.now();
  const it = createWorldEvolution(config, opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return { ...r.value, timings: { total: performance.now() - t0 } };
}
