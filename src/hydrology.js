/**
 * Depression filling, flow routing and flow accumulation.
 * The implementation is intentionally small and inspectable.
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

/** Convenience wrapper used by the UI and tests. */
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
  };
}
