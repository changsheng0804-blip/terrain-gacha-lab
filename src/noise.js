import { hash2 } from './rng.js?v=13';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 2D value noise in [-1, 1]. */
export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  const a = hash2(xi, yi, seed) / 4294967296;
  const b = hash2(xi + 1, yi, seed) / 4294967296;
  const c = hash2(xi, yi + 1, seed) / 4294967296;
  const d = hash2(xi + 1, yi + 1, seed) / 4294967296;

  return (lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1);
}

/** Fractal Brownian motion with an approximately normalized output. */
export function fbm2(x, y, octaves = 4, seed = 0, lacunarity = 2, gain = 0.5) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }

  return sum / norm;
}

/** Ridged multifractal, good for mountain crests. */
export function ridged2(x, y, octaves = 4, seed = 0) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(valueNoise2(x * freq, y * freq, seed + o * 137));
    n *= n;
    sum += amp * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }

  return sum / norm;
}
