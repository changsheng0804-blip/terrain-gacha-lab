// RFC-001 PoC worker: run the stepper, record keyframes, ship them by transfer.
import { createWorldEvolution } from '../src/pipeline.js';
import { createRecorder } from '../src/timeline.js';
import { buildTownReplay } from '../src/town-replay.js';

self.onmessage = (ev) => {
  const cfg = ev.data;
  const t0 = performance.now();
  const rec = createRecorder({ keyframeEvery: cfg.keyframeEvery || 6 });
  const it = createWorldEvolution(cfg, { dropletBatch: 1024 });
  let r = it.next(); let frames = 0;
  while (!r.done) {
    rec.push(r.value); frames++;
    if (frames % 16 === 0) self.postMessage({ type: 'progress', stage: r.value.stage, value: r.value.progress });
    r = it.next();
  }
  const compute = performance.now() - t0;
  const recording = rec.finish();
  const { field, hydro, town } = r.value;
  const replay = buildTownReplay(town);
  const keys = recording.keys.map((k) => ({ stage: k.stage, progress: k.progress, height: k.height }));
  const water = hydro.waterMask.slice();
  const river = hydro.riverMask.slice();
  self.postMessage({
    type: 'done', compute, frames,
    grid: recording.grid, bytes: recording.bytes, keys,
    field: { n: field.n, cell: field.cell, size: field.size, x0: field.x0, y0: field.y0 },
    water, river,
    town: { roads: town.roads.map((r) => ({ cls: r.cls, pts: r.pts })), buildings: town.buildings, center: town.center },
    replay,
  }, [...keys.map((k) => k.height.buffer), water.buffer, river.buffer]);
};
