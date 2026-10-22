/**
 * RFC-001 PoC: derive a construction order from a finished classic town.
 * Read-only on `town`. Every road / parcel / building gets exactly one event.
 */
const ORDER = ['center', 'arterial', 'rail', 'station', 'street', 'parcel', 'building'];
const SPAN = { center: [0, 0.02], arterial: [0.02, 0.22], rail: [0.22, 0.32], station: [0.32, 0.34], street: [0.34, 0.55], parcel: [0.55, 0.75], building: [0.6, 1.0] };

export function buildTownReplay(town) {
  const cx = town.center ? town.center.x : 0;
  const cz = town.center ? town.center.z : 0;
  const dist = (x, z) => Math.hypot(x - cx, z - cz);
  const groups = { center: [], arterial: [], rail: [], station: [], street: [], parcel: [], building: [] };

  groups.center.push({ ref: -1, key: 0 });
  town.roads.forEach((r, i) => {
    const p = r.pts;
    const key = Math.min(dist(p[0][0], p[0][1]), dist(p[p.length - 1][0], p[p.length - 1][1]));
    (r.cls === 'arterial' ? groups.arterial : groups.street).push({ ref: i, key });
  });
  if (town.railway) groups.rail.push({ ref: 0, key: 0 });
  town.parcels.forEach((p, i) => groups.parcel.push({ ref: i, key: dist(p.x, p.z) }));
  town.buildings.forEach((b, i) => {
    if (b.type === 'station') groups.station.push({ ref: i, key: 0 });
    else groups.building.push({ ref: i, key: dist(b.x, b.z) });
  });

  const events = [];
  for (const kind of ORDER) {
    const g = groups[kind].sort((a, b) => a.key - b.key || a.ref - b.ref);
    const [a, b] = SPAN[kind];
    g.forEach((e, k) => events.push({ t: a + (b - a) * (g.length > 1 ? k / (g.length - 1) : 0), kind, ref: e.ref }));
  }
  events.sort((p, q) => p.t - q.t || ORDER.indexOf(p.kind) - ORDER.indexOf(q.kind) || p.ref - q.ref);
  return { duration: 1, events };
}

/** Building indices sorted by appearance time, plus each one's time. */
export function buildingOrder(replay, count) {
  const order = [];
  const time = new Float32Array(count).fill(1);
  for (const e of replay.events) {
    if (e.kind === 'building' || e.kind === 'station') { order.push(e.ref); time[e.ref] = e.t; }
  }
  return { order, time };
}
