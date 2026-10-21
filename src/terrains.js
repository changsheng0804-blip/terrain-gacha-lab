import { range, randInt, rngFor, smoothstep, smin } from './rng.js?v=13';
import { fbm2, ridged2 } from './noise.js?v=13';

function makeSeeds(rng) {
  return {
    s1: randInt(rng, 1, 0x3fffffff),
    s2: randInt(rng, 1, 0x3fffffff),
    s3: randInt(rng, 1, 0x3fffffff),
    s4: randInt(rng, 1, 0x3fffffff),
  };
}

/**
 * Each terrain is a parameterised analytic height field.
 * RNG chooses a "design"; noise and smooth min/max add natural detail.
 */

const river = {
  id: 'river',
  label: '川沿いの谷',
  hasSea: true,
  tune: { droplets: 0.8, life: 32, radius: 3, talus: 35, soft: 0.3, minA: 180000 },

  params(rng) {
    return {
      rotate: range(rng, 0, Math.PI * 2),
      coastV: -range(rng, 380, 700),
      coastWig: range(rng, 200, 500),
      coastWig2: range(rng, 60, 180),
      coastPhase: range(rng, 0, Math.PI * 2),
      coastPhase2: range(rng, 0, Math.PI * 2),
      riverAmp: range(rng, 120, 320),
      riverFreq: range(rng, 0.35, 0.9) / 1000,
      riverPhase: range(rng, 0, Math.PI * 2),
      mountainH: range(rng, 380, 700),
      mountainStart: range(rng, 350, 800),
      valleyWidth: range(rng, 110, 240),
      hillH: range(rng, 20, 60),
      warp: range(rng, 70, 180),
      ...makeSeeds(rng),
    };
  },

  height(u, v, p) {
    const coast = p.coastV
      + p.coastWig * Math.sin(u / 7000 * Math.PI * 2 + p.coastPhase)
      + p.coastWig2 * Math.sin(u / 2200 * Math.PI * 2 + p.coastPhase2);
    const d = v - coast;
    if (d < 0) return Math.max(-45, d * 0.035);

    const riverX = p.riverAmp * Math.sin(v * p.riverFreq + p.riverPhase);
    const dRiver = Math.abs(u - riverX);

    const inland = smoothstep(0, 1600, d);
    const mountainMask = smoothstep(p.mountainStart, p.mountainStart + 1600, d);
    const n1 = fbm2(u / 1400, v / 1400, 5, p.s1);
    const n2 = ridged2(u / 1100, v / 1100, 5, p.s2);
    const n3 = fbm2(u / 520, v / 520, 4, p.s3);

    const mountains = p.mountainH * mountainMask
      * (0.35 + 0.35 * (0.5 + 0.5 * n1) + 0.30 * n2 * n2);
    const hills = p.hillH * inland * (0.5 + 0.5 * n3);
    const valley = smoothstep(p.valleyWidth * 0.7, p.valleyWidth * 2.4, dRiver);

    let h = 2 + 0.012 * d + (mountains + hills) * valley;

    // Carve the river bed only near the channel; otherwise the low bed target
    // would flatten the entire inland terrain through the smooth minimum.
    if (dRiver < p.valleyWidth * 3) {
      const bed = 1.2 + 0.006 * d;
      const bedTarget = bed + 0.5 * Math.max(0, dRiver - p.valleyWidth * 0.5);
      h = smin(h, bedTarget, 18);
    }

    if (d < 140) h = Math.max(h, 1.2 + 0.02 * d);
    return h;
  },
};

const slope = {
  id: 'slope',
  label: '海辺の坂',
  hasSea: true,
  tune: { droplets: 0.65, life: 30, radius: 3, talus: 38, soft: 0.3, minA: 120000 },

  params(rng) {
    const ravines = [];
    const ravineCount = randInt(rng, 2, 4);
    for (let i = 0; i < ravineCount; i++) {
      ravines.push({
        u: range(rng, -1600, 1600),
        width: range(rng, 50, 110),
        depth: range(rng, 25, 65),
        bend: range(rng, -80, 80),
      });
    }

    const islands = [];
    const islandCount = randInt(rng, 0, 2);
    for (let i = 0; i < islandCount; i++) {
      islands.push({
        u: range(rng, -1500, 1500),
        v: range(rng, -1400, -650),
        radius: range(rng, 90, 260),
        height: range(rng, 20, 70),
      });
    }

    return {
      rotate: range(rng, 0, Math.PI * 2),
      coastV: -range(rng, 120, 320),
      coastWig: range(rng, 80, 200),
      coastWig2: range(rng, 20, 70),
      coastPhase: range(rng, 0, Math.PI * 2),
      coastPhase2: range(rng, 0, Math.PI * 2),
      bayU: range(rng, -300, 300),
      bayW: range(rng, 350, 750),
      bayDepth: range(rng, 100, 280),
      hillH: range(rng, 100, 220),
      mtnH: range(rng, 280, 560),
      warp: range(rng, 40, 120),
      ravines,
      islands,
      ...makeSeeds(rng),
    };
  },

  height(u, v, p) {
    const coast = p.coastV
      + p.coastWig * Math.sin(u / 5000 * Math.PI * 2 + p.coastPhase)
      + p.coastWig2 * Math.sin(u / 1800 * Math.PI * 2 + p.coastPhase2)
      + p.bayDepth * Math.exp(-Math.pow((u - p.bayU) / p.bayW, 2));

    const d = v - coast;
    if (d < 0) return Math.max(-35, d * 0.045);

    const n1 = fbm2(u / 600, v / 600, 4, p.s1);
    const n2 = fbm2(u / 1600, v / 1600, 4, p.s2);
    const n3 = ridged2(u / 1300, v / 1300, 4, p.s3);

    let h = 1.5 + 0.075 * d;
    h += p.hillH * smoothstep(100, 750, d) * (0.5 + 0.5 * n1);
    h += p.mtnH * smoothstep(1100, 3200, d)
      * (0.30 + 0.35 * (0.5 + 0.5 * n2) + 0.35 * n3 * n3);

    for (const r of p.ravines) {
      const center = r.u + r.bend * Math.sin(v / 900);
      const q = Math.abs(u - center);
      h -= r.depth * Math.exp(-Math.pow(q / r.width, 2)) * smoothstep(30, 260, d);
    }

    for (const island of p.islands) {
      const dist = Math.hypot(u - island.u, v - island.v) / island.radius;
      if (dist < 1.4) {
        h = Math.max(h, island.height * Math.max(0, 1 - dist * dist) * (0.8 + 0.4 * n2));
      }
    }

    return Math.max(h, 1.2 + 0.01 * d);
  },
};

const onsen = {
  id: 'onsen',
  label: '山あいの温泉街',
  hasSea: false,
  tune: { droplets: 0.75, life: 30, radius: 2, talus: 42, soft: 0.25, minA: 150000 },

  params(rng) {
    const tribs = [];
    const tribCount = randInt(rng, 4, 7);
    for (let i = 0; i < tribCount; i++) {
      tribs.push({
        s: range(rng, -2800, 2800),
        side: rng() < 0.5 ? -1 : 1,
        len: range(rng, 300, 850),
        width: range(rng, 40, 90),
        depth: range(rng, 25, 70),
        curve: range(rng, -120, 120),
      });
    }

    return {
      rotate: range(rng, 0, Math.PI * 2),
      floor0: range(rng, 160, 380),
      floorG: range(rng, 0.012, 0.025),
      riverAmp: range(rng, 50, 140),
      riverFreq: range(rng, 0.6, 1.4) / 1000,
      riverPhase: range(rng, 0, Math.PI * 2),
      riverAmp2: range(rng, 30, 100),
      riverFreq2: range(rng, 1.5, 3.0) / 1000,
      riverPhase2: range(rng, 0, Math.PI * 2),
      riverWiggle: range(rng, 20, 60),
      wallStart: range(rng, 40, 90),
      wallA: range(rng, 0.012, 0.030),
      mtnH: range(rng, 300, 650),
      warp: range(rng, 40, 100),
      tribs,
      ...makeSeeds(rng),
    };
  },

  height(u, v, p) {
    const riverX = p.riverAmp * Math.sin(v * p.riverFreq + p.riverPhase)
      + p.riverAmp2 * Math.sin(v * p.riverFreq2 + p.riverPhase2)
      + p.riverWiggle * fbm2(v / 1000, 3.7, 3, p.s4);
    const dRiver = Math.abs(u - riverX);

    const n1 = fbm2(u / 1200, v / 1200, 5, p.s1);
    const n2 = ridged2(u / 900, v / 900, 5, p.s2);

    const floor = p.floor0 + p.floorG * v;
    const wall = p.wallA * Math.pow(Math.max(0, dRiver - p.wallStart), 1.20);
    const mountain = p.mtnH * smoothstep(400, 2000, dRiver)
      * (0.25 + 0.35 * (0.5 + 0.5 * n1) + 0.40 * n2 * n2);

    let h = floor + wall + mountain;

    // Side gullies make the valley read as a drainage network rather than
    // two perfectly smooth walls.
    for (const t of p.tribs) {
      const du = (u - riverX) * t.side;
      if (du <= 0 || du >= t.len) continue;
      const center = t.s + t.curve * Math.sin(du / t.len * Math.PI);
      const q = Math.abs(v - center);
      const fade = smoothstep(t.len, t.len * 0.2, du);
      h -= t.depth * Math.exp(-Math.pow(q / t.width, 2)) * fade;
    }

    if (dRiver < 520) {
      h = smin(h, floor + 0.08 * dRiver, 18);
    }
    return h;
  },
};

/**
 * Curved centreline of the main fjord channel. v is the inland coordinate.
 */
function fjordCenter(v, p) {
  return p.fjordU
    + p.fjordAmp1 * Math.sin(v * p.fjordFreq1 + p.fjordPhase1)
    + p.fjordAmp2 * Math.sin(v * p.fjordFreq2 + p.fjordPhase2);
}

const fjord = {
  id: 'fjord',
  label: 'フィヨルド',
  hasSea: true,
  tune: { droplets: 0.72, life: 32, radius: 3, talus: 34, soft: 0.3, minA: 150000 },

  params(rng) {
    const coastV = -range(rng, 900, 1450);
    const fjordLen = range(rng, 2300, 3100);
    const branches = [];
    const branchCount = randInt(rng, 2, 3);
    for (let i = 0; i < branchCount; i++) {
      branches.push({
        joinFrac: range(rng, 0.34, 0.72),
        len: range(rng, 500, 1100),
        slope: (rng() < 0.5 ? -1 : 1) * range(rng, 0.25, 0.8),
        bend: range(rng, -220, 220),
        widthFrac: range(rng, 0.45, 0.68),
        depthFrac: range(rng, 0.45, 0.72),
      });
    }

    return {
      rotate: range(rng, 0, Math.PI * 2),
      coastV,
      coastWig: range(rng, 200, 380),
      coastWig2: range(rng, 50, 140),
      coastPhase1: range(rng, 0, Math.PI * 2),
      coastPhase2: range(rng, 0, Math.PI * 2),
      fjordU: range(rng, -380, 380),
      fjordAmp1: range(rng, 180, 360),
      fjordFreq1: range(rng, 0.34, 0.58) / 1000,
      fjordPhase1: range(rng, 0, Math.PI * 2),
      fjordAmp2: range(rng, 50, 120),
      fjordFreq2: range(rng, 1.1, 1.9) / 1000,
      fjordPhase2: range(rng, 0, Math.PI * 2),
      fjordLen,
      halfW: range(rng, 120, 195),
      depth: range(rng, 65, 108),
      wallGrad: range(rng, 1.15, 1.9),
      mountainH: range(rng, 360, 700),
      mountainStart: range(rng, 280, 620),
      hillH: range(rng, 25, 70),
      warp: range(rng, 60, 130),
      branches,
      ...makeSeeds(rng),
    };
  },

  height(u, v, p) {
    const coast = p.coastV
      + p.coastWig * Math.sin(u / 5200 * Math.PI * 2 + p.coastPhase1)
      + p.coastWig2 * Math.sin(u / 1700 * Math.PI * 2 + p.coastPhase2);
    const d = v - coast;

    // Open sea outside the coast. The fjord mouth is simply part of this sea.
    if (d < 0) return Math.max(-70, d * 0.045);

    const n1 = fbm2(u / 1350, v / 1350, 5, p.s1);
    const n2 = ridged2(u / 1000, v / 1000, 5, p.s2);
    const n3 = fbm2(u / 480, v / 480, 4, p.s3);

    const inland = smoothstep(0, 1500, d);
    const mountain = p.mountainH * smoothstep(p.mountainStart, p.mountainStart + 1900, d)
      * (0.30 + 0.36 * (0.5 + 0.5 * n1) + 0.34 * n2 * n2);
    const hills = p.hillH * inland * (0.5 + 0.5 * n3);

    let h = 2 + 0.012 * d + mountain + hills;

    const endV = p.coastV + p.fjordLen;
    const endFade = 1 - smoothstep(endV - 520, endV, v);

    // U-shaped trench: parabolic below the waterline, then a steep wall.
    const du = Math.abs(u - fjordCenter(v, p));
    const t = du / p.halfW;
    let bed = t <= 1
      ? -p.depth * (1 - t * t)
      : (t - 1) * p.halfW * p.wallGrad;
    bed += (1 - endFade) * 1400;

    // Small side fjords branch off the main channel and shallow out inland.
    for (const b of p.branches) {
      const joinV = p.coastV + b.joinFrac * p.fjordLen;
      if (v < joinV) continue;
      const ds = v - joinV;
      const center = fjordCenter(joinV, p) + b.slope * ds
        + b.bend * Math.sin(Math.min(1.4, ds / b.len) * Math.PI);
      const db = Math.abs(u - center);
      const tb = db / (p.halfW * b.widthFrac);
      const branchEnd = joinV + b.len;
      const bEndFade = 1 - smoothstep(branchEnd - 300, branchEnd, v);
      let bBed = tb <= 1
        ? -p.depth * b.depthFrac * (1 - tb * tb)
        : (tb - 1) * p.halfW * b.widthFrac * p.wallGrad;
      bBed += (1 - bEndFade) * 900;
      bed = Math.min(bed, bBed);
    }

    h = smin(h, bed, 20);

    // Keep a thin beach strip so the shoreline reads cleanly, but never dam
    // the fjord mouth where the channel must meet the open sea.
    if (d < 90 && bed > 0) h = Math.max(h, 0.8 + 0.02 * d);
    return h;
  },
};

/**
 * Radial helper for the volcanic island: low apron outside the crater rim.
 */
function calderaBody(r, p) {
  return p.bodyH
    * smoothstep(p.craterR * 0.9, p.craterR * 1.35, r)
    * (1 - smoothstep(p.R * 0.62, p.R, r));
}

const caldera = {
  id: 'caldera',
  label: '火山島のカルデラ',
  hasSea: true,
  island: true,
  tune: { droplets: 0.7, life: 32, radius: 3, talus: 36, soft: 0.3, minA: 120000 },

  params(rng) {
    const R = range(rng, 1250, 2200);
    const gullies = [];
    const gullyCount = randInt(rng, 5, 8);
    const gullyPhase = range(rng, 0, Math.PI * 2);
    for (let i = 0; i < gullyCount; i++) {
      const major = i < 2;
      gullies.push({
        angle: gullyPhase + i / gullyCount * Math.PI * 2 + range(rng, -0.16, 0.16),
        width: major ? range(rng, 0.12, 0.19) : range(rng, 0.07, 0.12),
        depth: major ? range(rng, 34, 58) : range(rng, 12, 26),
      });
    }

    return {
      rotate: range(rng, 0, Math.PI * 2),
      cx: range(rng, -420, 420),
      cy: range(rng, -420, 420),
      R,
      craterR: range(rng, 300, Math.min(600, R * 0.45)),
      lakeDepth: range(rng, 32, 70),
      ringH: range(rng, 260, 520),
      bodyH: range(rng, 55, 115),
      rimW: range(rng, 150, 260),
      detail: range(rng, 16, 30),
      seaDepth: range(rng, 45, 90),
      warp: range(rng, 25, 60),
      gullies,
      ...makeSeeds(rng),
    };
  },

  height(u, v, p) {
    const r = Math.hypot(u - p.cx, v - p.cy);
    const craterR = p.craterR;
    const rPeak = craterR + p.rimW * 0.55;

    const rise = smoothstep(craterR * 0.98, rPeak, r);
    const fall = 1 - smoothstep(rPeak, p.R * 0.98, r);
    const body = calderaBody(r, p);
    // Pick the ring amplitude so the crest lands near ringH above sea level.
    const ringAmp = Math.max(0, p.ringH - calderaBody(rPeak, p));
    const ring = ringAmp * rise * fall;

    // Crater lake floor stays below sea level and keeps the rim steep.
    const bowl = -p.lakeDepth * (1 - smoothstep(craterR * 0.55, craterR, r));

    // Sea beyond the island; the radial profile dominates the noise.
    const offshore = smoothstep(p.R * 0.985, p.R * 1.22, r);
    const sea = -offshore * (p.seaDepth + Math.max(0, r - p.R) * 0.02);

    const n1 = fbm2(u / 520, v / 520, 4, p.s1);
    const n2 = ridged2(u / 380, v / 380, 3, p.s2);
    const detailMask = smoothstep(craterR * 1.0, craterR * 1.2, r)
      * (1 - smoothstep(p.R * 0.78, p.R * 0.97, r));
    const detail = p.detail * (0.6 * n1 + 0.4 * (n2 * 2 - 1)) * detailMask;

    let h = body + ring + bowl + sea + detail;

    // Radial barrancas guide runoff down the outer cone without changing the
    // island silhouette. They start just outside the crater rim.
    const ang = Math.atan2(v - p.cy, u - p.cx);
    let gully = 0;
    for (const g of p.gullies) {
      let da = Math.abs(ang - g.angle);
      if (da > Math.PI) da = Math.PI * 2 - da;
      gully += g.depth * Math.exp(-Math.pow(da / g.width, 2));
    }
    const gullyMask = smoothstep(craterR * 1.02, craterR * 1.18, r)
      * (1 - smoothstep(p.R * 0.80, p.R * 0.97, r));
    h -= gully * gullyMask;

    // Never let detail noise open a breach through the crater rim or coast.
    if (r > craterR * 1.05 && r < p.R * 0.9) h = Math.max(h, 1.5);
    if (r <= craterR * 0.62) h = Math.min(h, -6);
    return h;
  },
};

export const TERRAINS = { river, slope, onsen, fjord, caldera };
export const TERRAIN_IDS = Object.keys(TERRAINS);

/**
 * Build an n x n height field. Coordinates are centred at (0, 0), in metres.
 */
export function generateHeightField(type, seed, size, res) {
  const terrain = TERRAINS[type] || TERRAINS.river;
  const designRng = rngFor(seed, `design:${terrain.id}`);
  const params = terrain.params(designRng);

  const n = res;
  const cell = size / (n - 1);
  const x0 = -size / 2;
  const y0 = -size / 2;
  const cos = Math.cos(params.rotate);
  const sin = Math.sin(params.rotate);

  const height = new Float32Array(n * n);

  for (let j = 0; j < n; j++) {
    const y = y0 + j * cell;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * cell;

      // Rotate the design so coastlines / valleys can point in any direction.
      const u0 = x * cos + y * sin;
      const v0 = -x * sin + y * cos;

      // Low-frequency domain warp keeps the analytic shapes from looking too clean.
      const wx = params.warp * fbm2(u0 / 1500, v0 / 1500, 3, params.s4);
      const wy = params.warp * fbm2(u0 / 1500 + 31.7, v0 / 1500 - 12.3, 3, params.s4 + 7);

      height[j * n + i] = terrain.height(u0 + wx, v0 + wy, params);
    }
  }

  return {
    n,
    cell,
    size,
    x0,
    y0,
    height,
    params,
    terrain,
  };
}

/**
 * Closed mountain valleys need an open downstream edge, otherwise the
 * depression filler would flood the whole valley. Carve a narrow notch at
 * the downstream boundary and return those cells as hydrology outlets.
 */
export function carveValleyOutlet(field) {
  const { n, height, params, x0, y0, cell, terrain } = field;
  if (terrain.hasSea) return null;

  const u = params.riverAmp * Math.sin(y0 * params.riverFreq + params.riverPhase);
  const center = Math.min(n - 4, Math.max(3, Math.round((u - x0) / cell)));
  const level = params.floor0 + params.floorG * y0 - 12;

  const outlets = [];
  for (let j = 0; j < 4; j++) {
    for (let di = -3; di <= 3; di++) {
      const i = Math.min(n - 1, Math.max(0, center + di));
      const idx = j * n + i;
      height[idx] = Math.min(height[idx], level);
      if (j === 0) outlets.push(idx);
    }
  }

  return outlets;
}
