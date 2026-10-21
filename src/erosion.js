/**
 * Particle-based hydraulic erosion ("droplet erosion").
 * This is a compact, independent implementation of the well-known technique:
 * each droplet follows the gradient, carries sediment, erodes when it has
 * spare capacity, and deposits when it slows down or climbs.
 */

export function erodeDroplets(height, options) {
  const {
    n,
    seaLevel = 0,
    rng,
    droplets,
    life = 30,
    radius = 3,
    inertia = 0.05,
    capacity = 4,
    minCapacity = 0.01,
    erode = 0.3,
    deposit = 0.3,
    evaporation = 0.01,
    gravity = 4,
  } = options;

  const H = height;
  const kernel = [];
  let weightSum = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= radius) {
        const w = radius + 0.5 - d;
        kernel.push({ dx, dy, w });
        weightSum += w;
      }
    }
  }
  for (const k of kernel) k.w /= weightSum;

  const margin = radius + 1;
  const maxCoord = n - margin - 1;
  const span = maxCoord - margin;
  let simulated = 0;

  for (let d = 0; d < droplets; d++) {
    let x = margin + rng() * span;
    let y = margin + rng() * span;
    let dirX = 0;
    let dirY = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < life; step++) {
      const xi = x | 0;
      const yi = y | 0;
      const fx = x - xi;
      const fy = y - yi;
      const i00 = yi * n + xi;

      const h00 = H[i00];
      const h10 = H[i00 + 1];
      const h01 = H[i00 + n];
      const h11 = H[i00 + n + 1];
      const h = h00 * (1 - fx) * (1 - fy)
        + h10 * fx * (1 - fy)
        + h01 * (1 - fx) * fy
        + h11 * fx * fy;

      if (h <= seaLevel) break;

      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;

      dirX = dirX * inertia - gx * (1 - inertia);
      dirY = dirY * inertia - gy * (1 - inertia);

      const len = Math.hypot(dirX, dirY);
      if (len < 1e-9) break;
      dirX /= len;
      dirY /= len;

      const nx = x + dirX;
      const ny = y + dirY;

      if (nx < margin || ny < margin || nx >= n - margin || ny >= n - margin) break;

      const nxi = nx | 0;
      const nyi = ny | 0;
      const nfx = nx - nxi;
      const nfy = ny - nyi;
      const j00 = nyi * n + nxi;

      const nh00 = H[j00];
      const nh10 = H[j00 + 1];
      const nh01 = H[j00 + n];
      const nh11 = H[j00 + n + 1];
      const nh = nh00 * (1 - nfx) * (1 - nfy)
        + nh10 * nfx * (1 - nfy)
        + nh01 * (1 - nfx) * nfy
        + nh11 * nfx * nfy;

      const delta = nh - h;
      const cap = Math.max(-delta * speed * water * capacity, minCapacity);

      if (sediment > cap || delta > 0) {
        // Deposit at the current cell.
        const amount = delta > 0
          ? Math.min(delta, sediment)
          : (sediment - cap) * deposit;
        sediment -= amount;
        H[i00] += amount * (1 - fx) * (1 - fy);
        H[i00 + 1] += amount * fx * (1 - fy);
        H[i00 + n] += amount * (1 - fx) * fy;
        H[i00 + n + 1] += amount * fx * fy;
      } else {
        // Erode a small disc around the current cell.
        const amount = Math.min((cap - sediment) * erode, -delta);
        for (const k of kernel) {
          const kx = xi + k.dx;
          const ky = yi + k.dy;
          if (kx < 0 || ky < 0 || kx >= n || ky >= n) continue;
          const idx = ky * n + kx;
          const take = Math.min(H[idx], amount * k.w);
          H[idx] -= take;
          sediment += take;
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed - delta * gravity));
      water *= 1 - evaporation;
      x = nx;
      y = ny;
    }

    simulated++;
  }

  return simulated;
}

/**
 * Thermal erosion: move material downhill when a slope exceeds the talus angle.
 */
export function thermalErosion(height, n, talusDeg, cell, iterations = 2) {
  const maxDiff = Math.tan(talusDeg * Math.PI / 180) * cell;
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 1],
  ];

  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const i = y * n + x;
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          const diff = height[i] - height[j];
          if (diff > maxDiff) {
            const move = (diff - maxDiff) * 0.5;
            height[i] -= move;
            height[j] += move;
            moved += move;
          }
        }
      }
    }
    if (moved < 0.01) break;
  }
}

/** Light 3x3 blur blended into the original field. */
export function smoothField(height, n, blend) {
  if (blend <= 0) return;

  const src = Float32Array.from(height);
  const keep = 1 - blend;

  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      const avg = (
        src[i - n - 1] + src[i - n] + src[i - n + 1] +
        src[i - 1] + src[i] + src[i + 1] +
        src[i + n - 1] + src[i + n] + src[i + n + 1]
      ) / 9;
      height[i] = src[i] * keep + avg * blend;
    }
  }
}
