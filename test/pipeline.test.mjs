/**
 * RFC-001 PoC checks:
 * 1. generateWorld (stepper fold) == current main.js sequence (test/judge/world.mjs), byte for byte.
 * 2. Any dropletBatch gives the same final state.
 * 3. Frames: progress monotone, stage order fixed.
 * 4. Town replay covers every road/parcel/building exactly once, monotone t, input untouched.
 * 5. Keyframe recorder: quantisation error <= 0.05 m, within budget.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TERRAIN_IDS } from '../src/terrains.js';
import { createWorldEvolution, generateWorld } from '../src/pipeline.js';
import { generateWorld as legacyWorld } from './judge/world.mjs';
import { buildTownReplay } from '../src/town-replay.js';
import { createRecorder } from '../src/timeline.js';

const sha = (x) => createHash('sha256').update(x instanceof Uint8Array || ArrayBuffer.isView(x) ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : JSON.stringify(x)).digest('hex').slice(0, 16);
const worldHash = (w) => ({
  height: sha(w.field.height), filled: sha(w.hydro.filled), acc: sha(w.hydro.acc),
  river: sha(w.hydro.riverMask), lake: sha(w.hydro.lakeMask),
  town: sha({ r: w.town.roads, rl: w.town.railway, p: w.town.parcels, b: w.town.buildings }),
});

const res = Number(process.env.RES || 256);
const seeds = [123456, 20261019];
const rows = [];
for (const type of TERRAIN_IDS) {
  for (const seed of seeds) {
    const cfg = { type, seed, size: 6000, res };
    const legacy = worldHash(await legacyWorld(cfg));
    const a = worldHash(generateWorld(cfg, { dropletBatch: 1024, ecology: false }));
    const b = worldHash(generateWorld(cfg, { dropletBatch: 997, ecology: false }));
    assert.deepEqual(a, legacy, `${type}/${seed}: stepper != legacy`);
    assert.deepEqual(b, legacy, `${type}/${seed}: batch 997 != legacy`);
    rows.push(`${type}/${seed} ok ${legacy.height} ${legacy.town}`);
  }
}

// Frames + recorder + replay on one world.
const it = createWorldEvolution({ type: 'river', seed: 20261019, size: 6000, res });
const rec = createRecorder({ keyframeEvery: 8 });
let last = -1; const stages = []; let r = it.next(); let lastHeight;
while (!r.done) {
  assert.ok(r.value.progress >= last, 'progress monotone'); last = r.value.progress;
  if (stages[stages.length - 1] !== r.value.stage) stages.push(r.value.stage);
  rec.push(r.value); lastHeight = r.value.height; r = it.next();
}
assert.deepEqual(stages, ['design', 'erosion', 'thermal', 'smooth', 'outlet', 'hydrology', 'ecology-natural', 'town', 'done']);
const recording = rec.finish();
const lastKey = recording.keys[recording.keys.length - 1].height;
let maxErr = 0;
for (let i = 0; i < lastHeight.length; i++) maxErr = Math.max(maxErr, Math.abs(lastKey[i] / 10 - lastHeight[i]));
assert.ok(maxErr <= 0.05 + 1e-6, `quantisation error ${maxErr}`);

const town = r.value.town;
const before = sha({ r: town.roads, p: town.parcels, b: town.buildings });
const replay = buildTownReplay(town);
assert.equal(before, sha({ r: town.roads, p: town.parcels, b: town.buildings }), 'replay must not mutate town');
const count = (k) => replay.events.filter((e) => e.kind === k).length;
assert.equal(count('arterial') + count('street'), town.roads.length);
assert.equal(count('parcel'), town.parcels.length);
assert.equal(count('building') + count('station'), town.buildings.length);
for (let i = 1; i < replay.events.length; i++) assert.ok(replay.events[i].t >= replay.events[i - 1].t);

console.log(rows.join('\n'));
console.log(`pipeline.test.mjs: ok (res ${res}, ${rows.length} worlds bit-exact vs legacy; ${recording.keys.length} keyframes, ${(recording.bytes / 1048576).toFixed(1)} MB, max quant err ${maxErr.toFixed(3)} m; ${replay.events.length} replay events)`);
