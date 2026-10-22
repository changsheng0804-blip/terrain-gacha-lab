/**
 * Occupancy layer for town generation.
 *
 * One place that knows what already occupies the ground: road strips, the
 * railway, river channels (as width-aware polylines) and the rectangles of parcels / buildings that have
 * been placed. Generators ask `canPlace(rect)` before committing a rectangle
 * and call `add(rect)` afterwards. All tests are exact 2D geometry in metres,
 * so the result does not depend on the height-field resolution.
 *
 * A rectangle is { x, z, angle, w, d }: centre, rotation (radians, along w),
 * width along the angle and depth across it.
 */

const CELL = 40; // spatial hash bucket size in metres

/**
 * Half width (m) of a river channel draining `areaM2` square metres.
 * Shared contract: the judge uses the same formula for its own check.
 */
export function riverHalfWidth(areaM2) {
  return Math.min(30, Math.max(3, 1.5 + 0.004 * Math.sqrt(areaM2)));
}

/**
 * River channels as polyline segments in metres: each river cell links to
 * its downstream cell, with a half width from its drainage area. Independent
 * of grid resolution apart from where the centreline runs.
 */
export function riverSegments(field, hydro) {
  const { n, cell, x0, y0 } = field;
  const segs = [];
  if (!hydro || !hydro.riverMask) return segs;
  const area = cell * cell;
  for (let i = 0; i < n * n; i++) {
    if (!hydro.riverMask[i]) continue;
    const d = hydro.dir[i];
    if (d < 0) continue;
    segs.push({
      a: [x0 + (i % n) * cell, y0 + ((i / n) | 0) * cell],
      b: [x0 + (d % n) * cell, y0 + ((d / n) | 0) * cell],
      hw: riverHalfWidth(hydro.acc[i] * area),
    });
  }
  return segs;
}

function corners(r, pad = 0) {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const hw = r.w / 2 + pad;
  const hd = r.d / 2 + pad;
  return [
    [r.x + hw * c - hd * s, r.z + hw * s + hd * c],
    [r.x - hw * c - hd * s, r.z - hw * s + hd * c],
    [r.x - hw * c + hd * s, r.z - hw * s - hd * c],
    [r.x + hw * c + hd * s, r.z + hw * s - hd * c],
  ];
}

function bounds(pts) {
  let minX = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxZ = -Infinity;
  for (const [x, z] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
}

function inRect(r, x, z) {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const dx = x - r.x;
  const dz = z - r.z;
  return Math.abs(dx * c + dz * s) <= r.w / 2 && Math.abs(-dx * s + dz * c) <= r.d / 2;
}

function pointSeg(px, pz, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

function cross(p, q, r) {
  return Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
}

function segSeg(a, b, c, d) {
  if (cross(a, b, c) !== cross(a, b, d) && cross(c, d, a) !== cross(c, d, b)) return 0;
  return Math.min(pointSeg(a[0], a[1], c, d), pointSeg(b[0], b[1], c, d),
    pointSeg(c[0], c[1], a, b), pointSeg(d[0], d[1], a, b));
}

/** Distance from segment a-b to rectangle r (0 when they touch). */
function segRect(r, a, b) {
  if (inRect(r, a[0], a[1]) || inRect(r, b[0], b[1])) return 0;
  const k = corners(r);
  let best = Infinity;
  for (let i = 0; i < 4 && best > 0; i++) best = Math.min(best, segSeg(a, b, k[i], k[(i + 1) % 4]));
  return best;
}

/** Separating-axis overlap test between two rectangles, with a gap margin. */
function rectsOverlap(a, b, gap) {
  const ka = corners(a, gap / 2);
  const kb = corners(b, gap / 2);
  for (const ang of [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2]) {
    const ax = Math.cos(ang);
    const az = Math.sin(ang);
    let minA = Infinity; let maxA = -Infinity; let minB = Infinity; let maxB = -Infinity;
    for (const [x, z] of ka) { const p = x * ax + z * az; if (p < minA) minA = p; if (p > maxA) maxA = p; }
    for (const [x, z] of kb) { const p = x * ax + z * az; if (p < minB) minB = p; if (p > maxB) maxB = p; }
    if (maxA <= minB || maxB <= minA) return false;
  }
  return true;
}

class Hash {
  constructor() { this.map = new Map(); }

  insert(item, [minX, minZ, maxX, maxZ]) {
    for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz++) {
      for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
        const key = gx * 73856093 ^ gz * 19349663;
        let bucket = this.map.get(key);
        if (!bucket) { bucket = []; this.map.set(key, bucket); }
        bucket.push(item);
      }
    }
  }

  *query([minX, minZ, maxX, maxZ]) {
    const seen = new Set();
    for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz++) {
      for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
        const bucket = this.map.get(gx * 73856093 ^ gz * 19349663);
        if (!bucket) continue;
        for (const it of bucket) {
          if (seen.has(it)) continue;
          seen.add(it);
          yield it;
        }
      }
    }
  }
}

/**
 * @param field  height field (for the river mask lookup)
 * @param hydro  hydrology result; its riverMask marks channel cells
 * @param opts   { roadClearance, riverClearance } extra metres kept free
 */
export function createOccupancy(field, hydro, opts = {}) {
  const roadClearance = opts.roadClearance ?? 1;
  const riverClearance = opts.riverClearance ?? 0;
  const strips = new Hash(); // road / rail segments with a half width
  const layers = { parcel: new Hash(), building: new Hash() };

  /** Register a polyline strip (road, railway) with its half width. */
  function addStrip(pts, halfWidth, kind = 'road') {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = { a, b, hw: halfWidth, kind };
      strips.insert(seg, [
        Math.min(a[0], b[0]) - halfWidth, Math.min(a[1], b[1]) - halfWidth,
        Math.max(a[0], b[0]) + halfWidth, Math.max(a[1], b[1]) + halfWidth,
      ]);
    }
  }

  /** Does r touch a river channel (plus riverClearance)? */
  function onRiver(r) {
    const box = bounds(corners(r));
    const pad = 32 + riverClearance;
    box[0] -= pad; box[1] -= pad; box[2] += pad; box[3] += pad;
    for (const s of strips.query(box)) {
      if (s.kind !== 'river') continue;
      if (segRect(r, s.a, s.b) < s.hw + riverClearance) return true;
    }
    return false;
  }

  /** Does r touch a road/rail strip? Kinds in `ignore` are skipped. */
  function hitsStrip(r, ignore = null) {
    const box = bounds(corners(r));
    const pad = 12 + roadClearance;
    box[0] -= pad; box[1] -= pad; box[2] += pad; box[3] += pad;
    for (const s of strips.query(box)) {
      if (s.kind === 'river') continue;
      if (ignore && ignore.includes(s.kind)) continue;
      if (segRect(r, s.a, s.b) < s.hw + roadClearance) return true;
    }
    return false;
  }

  function hitsLayer(layer, r, gap) {
    const box = bounds(corners(r, gap));
    for (const other of layers[layer].query(box)) {
      if (rectsOverlap(r, other, gap)) return true;
    }
    return false;
  }

  /**
   * Can rectangle r go on the ground? `layer` is 'parcel' or 'building';
   * rectangles only collide with others in the same layer (a building sits
   * inside its parcel by design). `gap` keeps a minimum distance in metres.
   * `ignoreStrips` lists strip kinds to disregard (e.g. ['street']).
   */
  function canPlace(r, layer = 'building', gap = 0, ignoreStrips = null) {
    if (hitsStrip(r, ignoreStrips)) return false;
    if (onRiver(r)) return false;
    if (hitsLayer(layer, r, gap)) return false;
    return true;
  }

  function add(r, layer = 'building') {
    layers[layer].insert(r, bounds(corners(r)));
  }

  for (const seg of riverSegments(field, hydro)) {
    strips.insert({ ...seg, kind: 'river' }, [
      Math.min(seg.a[0], seg.b[0]) - seg.hw, Math.min(seg.a[1], seg.b[1]) - seg.hw,
      Math.max(seg.a[0], seg.b[0]) + seg.hw, Math.max(seg.a[1], seg.b[1]) + seg.hw,
    ]);
  }

  return { addStrip, canPlace, add, onRiver, hitsStrip };
}
