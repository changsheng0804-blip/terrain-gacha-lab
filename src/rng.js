/**
 * Small deterministic RNG helpers.
 * All randomness in the app is derived from a user-visible seed.
 */

export function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function hash2(x, y, seed = 0) {
  const h = Math.imul(x | 0, 0x1f1f1f1f)
    ^ Math.imul(y | 0, 0x27d4eb2d)
    ^ Math.imul(seed | 0, 0x165667b1);
  return hash32(h);
}

export function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(seed, label) {
  return mulberry32(hash2(seed, strHash(label)));
}

export function range(rng, min, max) {
  return min + (max - min) * rng();
}

export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick(rng, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum, useful for blending river beds into terrain. */
export function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
}
