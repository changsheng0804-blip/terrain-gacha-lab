/**
 * RFC-001 PoC: keyframe recorder (Int16, 0.1 m) + timeline lookup.
 * Non-normative presentation data; never hashed.
 */
const Q = 10; // 0.1 m

export function createRecorder({ budgetBytes = 48 << 20, keyframeEvery = 8 } = {}) {
  const keys = [];
  let erosionSteps = 0;
  let bytes = 0;
  let grid = 0;
  const snap = (frame) => {
    const h = frame.height;
    const q = new Int16Array(h.length);
    for (let i = 0; i < h.length; i++) q[i] = Math.max(-32768, Math.min(32767, Math.round(h[i] * Q)));
    bytes += q.byteLength;
    grid = frame.grid;
    keys.push({ stage: frame.stage, progress: frame.progress, height: q });
  };
  return {
    push(frame) {
      if (frame.stage === 'erosion') {
        erosionSteps++;
        if (erosionSteps % keyframeEvery !== 0 && frame.step !== frame.steps) return;
        if (bytes + frame.height.length * 2 > budgetBytes) return;
        snap(frame);
      } else if (frame.stage === 'design' || frame.stage === 'smooth' || frame.stage === 'outlet' || frame.stage === 'done') {
        snap(frame);
      }
    },
    finish() { return { grid, bytes, keys }; },
  };
}

/** t in 0..1 over the terrain part of the timeline. Returns two keyframes and a mix factor. */
export function frameAt(rec, t) {
  const k = rec.keys;
  const x = Math.max(0, Math.min(1, t)) * (k.length - 1);
  const i = Math.min(k.length - 2, Math.floor(x));
  return { a: k[i], b: k[i + 1], mix: x - i };
}

export function dequantInto(out, a, b, mix) {
  const inv = 1 / Q;
  for (let i = 0; i < out.length; i++) out[i] = (a.height[i] + (b.height[i] - a.height[i]) * mix) * inv;
  return out;
}
