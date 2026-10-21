/**
 * Small 2D geometry kit for the judge. World units are metres, (x, z) plane.
 * Buildings are oriented rectangles: centre (x, z), angle, width w (along
 * angle), depth d (across).
 */

export function obbCorners(b, pad = 0) {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const hw = b.w / 2 + pad;
  const hd = b.d / 2 + pad;
  return [
    [b.x + hw * c - hd * s, b.z + hw * s + hd * c],
    [b.x - hw * c - hd * s, b.z - hw * s + hd * c],
    [b.x - hw * c + hd * s, b.z - hw * s - hd * c],
    [b.x + hw * c + hd * s, b.z + hw * s - hd * c],
  ];
}

export function pointInObb(b, x, z) {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const dx = x - b.x;
  const dz = z - b.z;
  const u = dx * c + dz * s;
  const v = -dx * s + dz * c;
  return Math.abs(u) <= b.w / 2 && Math.abs(v) <= b.d / 2;
}

function pointSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function segsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

export function segSegDist(a, b, c, d) {
  if (segsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegDist(a[0], a[1], c[0], c[1], d[0], d[1]),
    pointSegDist(b[0], b[1], c[0], c[1], d[0], d[1]),
    pointSegDist(c[0], c[1], a[0], a[1], b[0], b[1]),
    pointSegDist(d[0], d[1], a[0], a[1], b[0], b[1]),
  );
}

/** Distance from a segment to an oriented rectangle (0 when they touch). */
export function segObbDist(b, a, c) {
  if (pointInObb(b, a[0], a[1]) || pointInObb(b, c[0], c[1])) return 0;
  const k = obbCorners(b);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const dd = segSegDist(a, c, k[i], k[(i + 1) % 4]);
    if (dd < best) best = dd;
    if (best === 0) return 0;
  }
  return best;
}

/** Separating-axis test for two oriented rectangles. */
export function obbOverlap(a, b, tol = 0.05) {
  const ka = obbCorners(a);
  const kb = obbCorners(b);
  const axes = [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2];
  for (const ang of axes) {
    const ax = Math.cos(ang);
    const az = Math.sin(ang);
    let minA = Infinity; let maxA = -Infinity;
    let minB = Infinity; let maxB = -Infinity;
    for (const [x, z] of ka) { const p = x * ax + z * az; if (p < minA) minA = p; if (p > maxA) maxA = p; }
    for (const [x, z] of kb) { const p = x * ax + z * az; if (p < minB) minB = p; if (p > maxB) maxB = p; }
    if (maxA <= minB + tol || maxB <= minA + tol) return false;
  }
  return true;
}

/** Uniform-grid spatial index over axis-aligned bounding boxes. */
export class SpatialHash {
  constructor(cell = 40) {
    this.cell = cell;
    this.map = new Map();
  }

  insert(item, minX, minZ, maxX, maxZ) {
    const c = this.cell;
    for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz++) {
      for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx++) {
        const key = `${gx},${gz}`;
        let bucket = this.map.get(key);
        if (!bucket) { bucket = []; this.map.set(key, bucket); }
        bucket.push(item);
      }
    }
  }

  query(minX, minZ, maxX, maxZ) {
    const c = this.cell;
    const out = new Set();
    for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz++) {
      for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx++) {
        const bucket = this.map.get(`${gx},${gz}`);
        if (bucket) for (const it of bucket) out.add(it);
      }
    }
    return out;
  }
}

export function obbBounds(b, pad = 0) {
  const k = obbCorners(b, pad);
  let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
  for (const [x, z] of k) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
}

/** Index every segment of a set of polylines, each tagged with a half width. */
export function indexSegments(polylines, cell = 40) {
  const hash = new SpatialHash(cell);
  const segs = [];
  polylines.forEach((pl, owner) => {
    for (let i = 1; i < pl.pts.length; i++) {
      const a = pl.pts[i - 1];
      const b = pl.pts[i];
      const seg = { a, b, hw: pl.hw, owner };
      segs.push(seg);
      const pad = pl.hw;
      hash.insert(seg,
        Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad,
        Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad);
    }
  });
  return { hash, segs };
}
