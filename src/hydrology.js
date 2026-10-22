/**
 * Depression filling, flow routing and flow accumulation.
 * The implementation is intentionally small and inspectable.
 *
 * On top of the routing data this module derives the surface-water layer:
 * inland lakes (`findLakes`), per-cell river width (`riverWidths`) and
 * waterfalls (`findFalls`). All of it is pure grid maths: no RNG, no DOM, and
 * no input array is mutated, so the same field always yields the same result.
 */

export class MinHeap {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }

  get size() {
    return this.items.length;
  }

  push(value) {
    const a = this.items;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(a[p], value) <= 0) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = value;
  }

  pop() {
    const a = this.items;
    if (a.length === 0) return undefined;
    const root = a[0];
    const last = a.pop();
    if (a.length === 0) return root;

    let i = 0;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      if (l >= a.length) break;
      let c = l;
      if (r < a.length && this.compare(a[r], a[l]) < 0) c = r;
      if (this.compare(a[c], last) >= 0) break;
      a[i] = a[c];
      i = c;
    }
    a[i] = last;
    return root;
  }
}

const NEIGHBORS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

const NEIGHBORS_4 = [
  [0, -1], [-1, 0], [1, 0], [0, 1],
];

/**
 * Priority-flood depression filling.
 * Cells at or below sea level, explicit outlets, and the outer boundary are
 * treated as open drains. Returns filled heights and the pop order.
 */
export function priorityFlood(height, n, options = {}) {
  const seaLevel = options.seaLevel ?? 0;
  const outlets = options.outlets || null;

  const filled = Float32Array.from(height);
  const visited = new Uint8Array(n * n);
  const order = new Int32Array(n * n);
  let orderLength = 0;

  const heap = new MinHeap((a, b) => filled[a] - filled[b]);

  function seed(i, h) {
    if (visited[i]) return;
    visited[i] = 1;
    filled[i] = h;
    heap.push(i);
  }

  // Sea cells are open drains.
  for (let i = 0; i < n * n; i++) {
    if (height[i] <= seaLevel) seed(i, height[i]);
  }

  // Explicit outlets (used by closed mountain valleys).
  if (outlets) {
    for (const i of outlets) seed(i, height[i]);
  }

  // Domain edges are open drains.
  for (let x = 0; x < n; x++) {
    seed(x, height[x]);
    seed((n - 1) * n + x, height[(n - 1) * n + x]);
  }
  for (let y = 0; y < n; y++) {
    seed(y * n, height[y * n]);
    seed(y * n + n - 1, height[y * n + n - 1]);
  }

  while (heap.size > 0) {
    const i = heap.pop();
    order[orderLength++] = i;

    const x = i % n;
    const y = (i / n) | 0;
    const h = filled[i];

    for (const [dx, dy] of NEIGHBORS_8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (visited[j]) continue;
      visited[j] = 1;
      // Raise enclosed depressions just enough to spill to the current cell.
      filled[j] = Math.max(height[j], h + 1e-4);
      heap.push(j);
    }
  }

  return { filled, order, orderLength };
}

/**
 * Steepest-descent flow direction (8-neighbour) plus flow accumulation.
 */
export function flowRouting(filled, n, order, orderLength) {
  const dir = new Int32Array(n * n).fill(-1);
  const drop = new Float32Array(n * n);

  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      const h = filled[i];
      let best = -1;
      let bestH = h;
      let bestDrop = 0;

      for (const [dx, dy] of NEIGHBORS_8) {
        const nx = x + dx;
        const ny = y + dy;
        const j = ny * n + nx;
        const nh = filled[j];
        if (nh < bestH - 1e-6) {
          bestH = nh;
          best = j;
          bestDrop = h - nh;
        }
      }

      dir[i] = best;
      drop[i] = bestDrop;
    }
  }

  const acc = new Float32Array(n * n).fill(1);

  // The priority-flood pop order is ascending; reversed is descending.
  for (let k = orderLength - 1; k >= 0; k--) {
    const i = order[k];
    const d = dir[i];
    if (d >= 0) acc[d] += acc[i];
  }

  return { dir, drop, acc };
}

/**
 * Multi-source BFS distance transform (4-neighbour, in cells).
 */
export function distanceTransform(mask, n) {
  const INF = 0x3fffffff;
  const dist = new Int32Array(n * n).fill(INF);
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < n * n; i++) {
    if (mask[i]) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const i = queue[head++];
    const x = i % n;
    const y = (i / n) | 0;
    const nd = dist[i] + 1;

    for (const [dx, dy] of NEIGHBORS_4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (dist[j] === INF) {
        dist[j] = nd;
        queue[tail++] = j;
      }
    }
  }

  return dist;
}

/**
 * Inland lakes.
 *
 * `priorityFlood` raises enclosed depressions up to their spill level, so every
 * cell with `filled > height` sits below a local water table. Those cells are
 * grouped into basins with 4-neighbour connectivity (diagonal-only touches stay
 * separate, which stops scattered puddles from chaining into one fake lake), and
 * a basin is kept only when it holds real water:
 *
 * - at least one cell impounds more than `minDepth` metres (default 1.5 m),
 * - the basin floor lies more than `minDepth` metres below the spill level,
 * - the submerged area is at least `minArea` square metres
 *   (default `max(800, size^2 * 2e-4)`, i.e. a few hundred m² on a 2 km map).
 *
 * Sea cells are never part of a lake: `seaMask` keeps its `height <= 0`
 * meaning, so water below sea level (a flooded caldera, for instance) stays
 * sea. A lake mask cell is always land that the fill raised under a spill
 * level, i.e. `height[i] < level`.
 *
 * Runs in O(n^2): one labelling pass plus two flat passes over the grid, never
 * one scan per lake.
 *
 * @returns {{ lakeMask: Uint8Array, lakes: object[], lakeCells: number }}
 *   `lakes` is sorted by area (largest first); each entry is
 *   `{ id, cells, waterCells, area, level, depth, minX, minY, maxX, maxY, cx, cz }`
 *   with `area`/`level`/`depth` in metres, `min*`/`max*` as grid indices and
 *   `cx`/`cz` as world metres. `level` is the water surface height a renderer
 *   needs for a horizontal lake plane.
 */
export function findLakes(field, filled, seaMask, options = {}) {
  const { n, cell, height, x0, y0 } = field;
  const total = n * n;
  const cellArea = cell * cell;
  const mapSize = field.size ?? n * cell;
  const minDepth = options.minDepth ?? 1.5;
  const minArea = options.minArea ?? Math.max(800, mapSize * mapSize * 2e-4);
  const FILL_EPS = 1e-6;
  const SHORE_EPS = 1e-3;

  const labels = new Int32Array(total).fill(-1);
  const stack = new Int32Array(total);
  const basins = [];

  const isBasin = (j) => labels[j] < 0 && !seaMask[j] && filled[j] - height[j] > FILL_EPS;

  for (let s = 0; s < total; s++) {
    if (labels[s] >= 0 || seaMask[s] || filled[s] - height[s] <= FILL_EPS) continue;

    const id = basins.length;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = id;

    let cells = 0;
    let coreCells = 0;
    let level = -Infinity;
    let floor = Infinity;
    let sumX = 0;
    let sumY = 0;
    let minX = n;
    let maxX = -1;
    let minY = n;
    let maxY = -1;

    while (sp > 0) {
      const i = stack[--sp];
      const h = height[i];
      const f = filled[i];
      cells++;
      if (f > level) level = f;
      if (h < floor) floor = h;
      if (f - h > minDepth) coreCells++;

      const x = i % n;
      const y = (i - x) / n;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && isBasin(i - 1)) { labels[i - 1] = id; stack[sp++] = i - 1; }
      if (x < n - 1 && isBasin(i + 1)) { labels[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && isBasin(i - n)) { labels[i - n] = id; stack[sp++] = i - n; }
      if (y < n - 1 && isBasin(i + n)) { labels[i + n] = id; stack[sp++] = i + n; }
    }

    basins.push({
      id, cells, coreCells, level, floor,
      depth: level - floor, sumX, sumY, minX, minY, maxX, maxY,
      waterCells: 0,
    });
  }

  // Pass 2: submerged cells per basin. A filled cell only counts as water when
  // it lies below the spill level; cells the fill merely touched are shoreline.
  for (let i = 0; i < total; i++) {
    const id = labels[i];
    if (id < 0) continue;
    if (height[i] < basins[id].level - SHORE_EPS) basins[id].waterCells++;
  }

  const lakes = [];
  const kept = new Uint8Array(basins.length);
  for (const b of basins) {
    const area = b.waterCells * cellArea;
    if (b.coreCells === 0 || b.depth <= minDepth || area < minArea) continue;
    b.area = area;
    kept[b.id] = 1;
    lakes.push(b);
  }

  // Pass 3: write the mask for the basins that survived.
  const lakeMask = new Uint8Array(total);
  let lakeCells = 0;
  for (let i = 0; i < total; i++) {
    const id = labels[i];
    if (id < 0 || !kept[id]) continue;
    if (height[i] >= basins[id].level - SHORE_EPS) continue;
    lakeMask[i] = 1;
    lakeCells++;
  }

  lakes.sort((p, q) => q.area - p.area || p.id - q.id);

  const described = lakes.map((b) => ({
    id: b.id,
    cells: b.cells,
    waterCells: b.waterCells,
    area: b.area,
    level: b.level,
    depth: b.depth,
    minX: b.minX,
    minY: b.minY,
    maxX: b.maxX,
    maxY: b.maxY,
    cx: x0 + (b.sumX / b.cells) * cell,
    cz: y0 + (b.sumY / b.cells) * cell,
  }));

  return { lakeMask, lakes: described, lakeCells };
}

/**
 * River width in metres for every cell of the grid.
 *
 * `width = baseWidth + widthSpan * sqrt(acc / maxAcc)`, capped at `maxWidth`
 * (defaults 2 m, 18 m, 24 m, so the main stem approaches 20 m). Both terms of
 * the ratio are cell counts, which makes the result independent of `res`: the
 * same catchment gets the same width whatever the grid spacing.
 *
 * Values are computed for all cells, not only `riverMask` ones, so the renderer
 * can pick whatever it needs. Widths below one cell are physical, not a bug:
 * drawing code should clamp a band to `field.cell` when it wants visible lines.
 */
export function riverWidths(acc, maxAcc, count, options = {}) {
  const baseWidth = options.baseWidth ?? 2;
  const widthSpan = options.widthSpan ?? 18;
  const maxWidth = options.maxWidth ?? 24;

  const width = new Float32Array(count);
  const inv = maxAcc > 0 ? 1 / maxAcc : 0;

  for (let i = 0; i < count; i++) {
    const t = acc[i] * inv;
    const w = baseWidth + widthSpan * Math.sqrt(t > 0 ? t : 0);
    width[i] = w > maxWidth ? maxWidth : w;
  }

  return width;
}

/**
 * Waterfalls along the D8 flow graph.
 *
 * A fall is a flow edge that loses more than `minDrop` metres (default 8 m) in
 * a single step while carrying at least `minAcc` upstream cells, so only
 * established rivers qualify - cliff faces without catchment stay dry. `drop`
 * per cell comes from `flowRouting` and is the loss towards the steepest
 * downstream neighbour.
 *
 * Candidates are ordered by drop (largest first, index as a deterministic
 * tie-break) and capped at `maxFalls` (default 120) to keep the render layer
 * usable. Adjacent edges of one cliff would otherwise yield dozens of near
 * duplicates, so accepted falls are kept at least `minSepCells` cells apart in
 * both grid axes (default 2; pass 0 to disable).
 *
 * `minDrop` is an absolute height loss per grid step, so fine grids split one
 * cliff into several smaller steps and report fewer falls. Lower
 * `options.falls.minDrop` when generating at a high `res` if more falls are
 * wanted.
 *
 * @returns {{ x: number, z: number, drop: number }[]} world metres at the brink
 *   cell - the upstream end of the falling edge, always a `riverMask` cell.
 */
export function findFalls(field, flow, options = {}) {
  const { n, cell, x0, y0 } = field;
  const { dir, drop, acc, minAcc, seaMask } = flow;
  const minDrop = options.minDrop ?? 8;
  const maxFalls = options.maxFalls ?? 120;
  const minSepCells = options.minSepCells ?? 2;
  const total = n * n;

  const candidates = [];
  for (let i = 0; i < total; i++) {
    if (seaMask && seaMask[i]) continue;
    if (dir[i] < 0) continue;
    if (drop[i] <= minDrop) continue;
    if (acc[i] < minAcc) continue;
    candidates.push(i);
  }

  candidates.sort((p, q) => drop[q] - drop[p] || p - q);

  const picked = [];
  for (const i of candidates) {
    if (picked.length >= maxFalls) break;
    if (minSepCells > 0) {
      const x = i % n;
      const y = (i - x) / n;
      let tooClose = false;
      for (const k of picked) {
        const kx = k % n;
        const ky = (k - kx) / n;
        if (Math.abs(kx - x) <= minSepCells && Math.abs(ky - y) <= minSepCells) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
    }
    picked.push(i);
  }

  return picked.map((i) => {
    const x = i % n;
    const y = (i - x) / n;
    return { x: x0 + x * cell, z: y0 + y * cell, drop: drop[i] };
  });
}

/**
 * Convenience wrapper used by the UI and tests.
 *
 * `options` accepts `outlet` (carved valley outlets for sea-less terrains) plus
 * optional pass-through tuning for the new layers: `options.lakes`,
 * `options.riverWidth` and `options.falls` are forwarded to `findLakes`,
 * `riverWidths` and `findFalls`. All of them default to the documented values,
 * so existing calls are unchanged.
 */
export function buildHydrology(field, options = {}) {
  const { n, height, terrain } = field;
  const seaLevel = 0;
  const seaMask = new Uint8Array(n * n);

  for (let i = 0; i < n * n; i++) {
    if (height[i] <= seaLevel) seaMask[i] = 1;
  }

  let outlets = null;
  if (!terrain.hasSea && options.outlet) {
    outlets = options.outlet;
  }

  const { filled, order, orderLength } = priorityFlood(height, n, {
    seaLevel,
    outlets,
  });
  const { dir, drop, acc } = flowRouting(filled, n, order, orderLength);

  const riverMask = new Uint8Array(n * n);
  let riverCells = 0;
  let maxAcc = 0;

  // minA is expressed in square metres, so convert it to a cell count.
  const minAcc = terrain.tune.minA / Math.max(1e-6, field.cell * field.cell);

  for (let i = 0; i < n * n; i++) {
    if (acc[i] > maxAcc) maxAcc = acc[i];
    if (!seaMask[i] && acc[i] >= minAcc) {
      riverMask[i] = 1;
      riverCells++;
    }
  }

  const dSea = distanceTransform(seaMask, n);
  const dRiver = distanceTransform(riverMask, n);

  // Distance to land is useful for ocean bathymetry shading.
  const landMask = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) landMask[i] = seaMask[i] ? 0 : 1;
  const dLand = distanceTransform(landMask, n);

  // Surface water: inland lakes plus the sea, and how far every cell is from
  // the nearest lake. `dLake` stays at the distance transform's INF value when
  // a terrain has no lake at all.
  const { lakeMask } = findLakes(field, filled, seaMask, options.lakes);

  const waterMask = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) waterMask[i] = seaMask[i] || lakeMask[i] ? 1 : 0;

  const dLake = distanceTransform(lakeMask, n);
  const riverWidth = riverWidths(acc, maxAcc, n * n, options.riverWidth);
  const falls = findFalls(field, { dir, drop, acc, minAcc, seaMask }, options.falls);

  return {
    filled,
    order,
    orderLength,
    dir,
    drop,
    acc,
    maxAcc,
    minAcc,
    seaMask,
    riverMask,
    riverCells,
    dSea,
    dRiver,
    dLand,
    lakeMask,
    waterMask,
    dLake,
    riverWidth,
    falls,
  };
}
