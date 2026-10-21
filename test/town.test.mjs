import assert from 'node:assert/strict';

import { generateHeightField, carveValleyOutlet, TERRAIN_IDS } from '../src/terrains.js';
import { buildHydrology } from '../src/hydrology.js';
import { generateTown, ZONE } from '../src/town.js';

function zoneAt(field, zones, x, z) {
  const gx = Math.max(0, Math.min(field.n - 1, Math.round((x - field.x0) / field.cell)));
  const gz = Math.max(0, Math.min(field.n - 1, Math.round((z - field.y0) / field.cell)));
  return zones[gz * field.n + gx];
}

for (const type of TERRAIN_IDS) {
  const seed = 777123;
  const field = generateHeightField(type, seed, 3000, 160);
  const outlets = carveValleyOutlet(field);
  const hydro = buildHydrology(field, { outlet: outlets });
  const town = generateTown(field, hydro, seed);

  assert.ok(town.roads.length > 0, `${type}: expected roads`);
  assert.ok(town.buildings.length > 0, `${type}: expected buildings`);
  assert.ok(town.parcels.length > 0, `${type}: expected parcels`);
  assert.ok(town.stats.builtParcels > 0, `${type}: expected built parcels`);
  assert.ok(town.railway && town.railway.pts.length >= 2, `${type}: expected railway`);
  assert.ok(town.station, `${type}: expected station`);
  assert.ok(
    town.buildings.some((b) => b.type === 'station'),
    `${type}: expected a station building`,
  );

  if (field.terrain.island) {
    const wet = town.railway.pts.filter(([x, z]) => {
      const gx = Math.max(0, Math.min(field.n - 1, Math.round((x - field.x0) / field.cell)));
      const gz = Math.max(0, Math.min(field.n - 1, Math.round((z - field.y0) / field.cell)));
      return field.height[gz * field.n + gx] <= 0.8;
    });
    assert.equal(wet.length, 0, `${type}: island railway should stay on land`);
  }

  const zoneCounts = new Array(7).fill(0);
  for (const zone of town.zones) zoneCounts[zone]++;
  assert.ok(
    zoneCounts[ZONE.CORE] + zoneCounts[ZONE.RES] > 0,
    `${type}: expected a core or residential zone`,
  );

  for (const b of town.buildings) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.z), `${type}: finite building position`);
    assert.ok(b.w > 0 && b.d > 0 && b.h > 0, `${type}: positive building size`);
    const zone = zoneAt(field, town.zones, b.x, b.z);
    assert.ok(
      [ZONE.CORE, ZONE.RES, ZONE.IND, ZONE.HAMLET, ZONE.PADDY].includes(zone),
      `${type}: building on a valid zone`,
    );
  }

  for (const p of town.parcels) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `${type}: finite parcel position`);
    assert.ok(p.w > 0 && p.d > 0, `${type}: positive parcel size`);
    assert.ok(
      [ZONE.CORE, ZONE.RES, ZONE.IND, ZONE.HAMLET, ZONE.PADDY].includes(p.zone),
      `${type}: parcel on a valid zone`,
    );
    assert.equal(typeof p.built, 'boolean', `${type}: parcel built flag`);
  }

  const snapshotA = JSON.stringify({
    buildings: town.buildings.map((b) => [b.x, b.z, b.w, b.d, b.type]),
    parcels: town.parcels.map((p) => [p.x, p.z, p.w, p.d, p.zone]),
    railway: town.railway.pts,
    station: town.station,
  });
  const townB = generateTown(field, hydro, seed);
  const snapshotB = JSON.stringify({
    buildings: townB.buildings.map((b) => [b.x, b.z, b.w, b.d, b.type]),
    parcels: townB.parcels.map((p) => [p.x, p.z, p.w, p.d, p.zone]),
    railway: townB.railway.pts,
    station: townB.station,
  });
  assert.equal(snapshotA, snapshotB, `${type}: town generation should be deterministic`);

  console.log(
    type.padEnd(6),
    `roads=${town.roads.length}`,
    `buildings=${town.buildings.length}`,
    `core=${town.zoneStats.corePct.toFixed(1)}%`,
    `res=${town.zoneStats.resPct.toFixed(1)}%`,
    `arterial=${town.stats.arterialKm.toFixed(1)}km`,
    `rail=${town.stats.railKm.toFixed(1)}km`,
    `parcels=${town.stats.builtParcels}/${town.stats.parcels}`,
  );
}

console.log('town tests passed');
