/**
 * src/reflex/extractor.js
 * 
 * 微观局部切片特征提取器 (Micro-Scale Tile Feature Extractor)
 * 将世界中任意关注点 (x, z) 周围固定半径 (默认 120m) 的物理地貌与人类聚落肌理，
 * 提炼为紧凑的结构化特征向量与 Micro-Context 描述，供反射层 (Reflex Layer) 快速打分与向量化。
 */

const ZONE_NAMES = ['NONE', 'CORE', 'RES', 'PADDY', 'IND', 'HAMLET', 'WATER'];

/**
 * 提取局部切片特征
 * @param {object} world - 包含 field, hydro, town, ecology
 * @param {number} cx - 中心点 X 坐标 (米)
 * @param {number} cz - 中心点 Z 坐标 (米)
 * @param {number} radius - 感受野半径 (米，默认 120m)
 */
export function extractTileFeature(world, cx, cz, radius = 120) {
  const { field, hydro, town, ecology } = world;
  const { n, cell, x0, y0, height } = field;

  // 1. 栅格范围采样
  const rCells = Math.ceil(radius / cell);
  const gx0 = Math.max(0, Math.min(n - 1, Math.floor((cx - radius - x0) / cell)));
  const gx1 = Math.max(0, Math.min(n - 1, Math.ceil((cx + radius - x0) / cell)));
  const gz0 = Math.max(0, Math.min(n - 1, Math.floor((cz - radius - y0) / cell)));
  const gz1 = Math.max(0, Math.min(n - 1, Math.ceil((cz + radius - y0) / cell)));

  let hSum = 0;
  let hMin = Infinity;
  let hMax = -Infinity;
  let slopeSum = 0;
  let slopeMax = 0;
  let waterCells = 0;
  let riverCells = 0;
  let gridCount = 0;
  const zoneCounts = new Array(ZONE_NAMES.length).fill(0);

  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const px = x0 + gx * cell;
      const pz = y0 + gz * cell;
      if (Math.hypot(px - cx, pz - cz) > radius) continue;

      const idx = gz * n + gx;
      const h = height[idx];
      hSum += h;
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;

      // 坡度
      const gxp = gx < n - 1 ? gx + 1 : gx;
      const gxm = gx > 0 ? gx - 1 : gx;
      const gzp = gz < n - 1 ? gz + 1 : gz;
      const gzm = gz > 0 ? gz - 1 : gz;
      const dx = (height[gz * n + gxp] - height[gz * n + gxm]) / ((gxp - gxm) * cell || 1);
      const dz = (height[gzp * n + gx] - height[gzm * n + gx]) / ((gzp - gzm) * cell || 1);
      const deg = Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
      slopeSum += deg;
      if (deg > slopeMax) slopeMax = deg;

      if (hydro.seaMask[idx] || (hydro.lakeMask && hydro.lakeMask[idx])) waterCells++;
      if (hydro.riverMask[idx]) riverCells++;

      if (town && town.zones) {
        const z = town.zones[idx] || 0;
        zoneCounts[z] = (zoneCounts[z] || 0) + 1;
      }
      gridCount++;
    }
  }

  const hMean = gridCount ? hSum / gridCount : 0;
  const slopeMean = gridCount ? slopeSum / gridCount : 0;
  const waterPct = gridCount ? (waterCells / gridCount) : 0;
  const riverPct = gridCount ? (riverCells / gridCount) : 0;

  // 主导分区
  let maxZoneIdx = 0;
  let maxZoneCount = -1;
  for (let z = 1; z < zoneCounts.length; z++) {
    if (zoneCounts[z] > maxZoneCount) {
      maxZoneCount = zoneCounts[z];
      maxZoneIdx = z;
    }
  }
  const dominantZone = ZONE_NAMES[maxZoneIdx] || 'NONE';

  // 2. 聚落与建筑统计
  let buildingCount = 0;
  let totalFloors = 0;
  let minBuildingDistToWater = Infinity;
  let buildingTypes = {};

  if (town && town.buildings) {
    for (const b of town.buildings) {
      const d = Math.hypot(b.x - cx, b.z - cz);
      if (d <= radius) {
        buildingCount++;
        totalFloors += b.floors || 1;
        buildingTypes[b.type] = (buildingTypes[b.type] || 0) + 1;
        
        // 建筑与水系距离
        const bgx = Math.max(0, Math.min(n - 1, Math.round((b.x - x0) / cell)));
        const bgz = Math.max(0, Math.min(n - 1, Math.round((b.z - y0) / cell)));
        const bIdx = bgz * n + bgx;
        const dR = (hydro.dRiver ? hydro.dRiver[bIdx] : 999) * cell;
        const dS = (hydro.dSea ? hydro.dSea[bIdx] : 999) * cell;
        const dW = Math.min(dR, dS);
        if (dW < minBuildingDistToWater) minBuildingDistToWater = dW;
      }
    }
  }

  // 3. 道路密度
  let roadMeters = 0;
  if (town && town.roads) {
    for (const r of town.roads) {
      const pts = r.pts;
      for (let i = 1; i < pts.length; i++) {
        const mx = (pts[i - 1][0] + pts[i][0]) / 2;
        const mz = (pts[i - 1][1] + pts[i][1]) / 2;
        if (Math.hypot(mx - cx, mz - cz) <= radius) {
          roadMeters += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        }
      }
    }
  }

  const avgFloors = buildingCount ? (totalFloors / buildingCount) : 0;
  const roadDensityKm2 = (roadMeters / 1000) / (Math.PI * (radius / 1000) ** 2);

  // 4. 生成适合 EmbeddingGemma 2 / 轻量反射模型的密集语义描述
  const description = [
    `Tile at (${Math.round(cx)}, ${Math.round(cz)}):`,
    `Slope avg ${slopeMean.toFixed(1)}° max ${slopeMax.toFixed(1)}°, elevation ${hMean.toFixed(0)}m (span ${(hMax - hMin).toFixed(0)}m).`,
    `Water coverage ${(waterPct * 100).toFixed(0)}%, river ${(riverPct * 100).toFixed(0)}%.`,
    `Dominant zone ${dominantZone}.`,
    `Settlement: ${buildingCount} buildings, avg floors ${avgFloors.toFixed(1)}, road density ${roadDensityKm2.toFixed(1)} km/km².`,
    minBuildingDistToWater < 999 ? `Nearest building to water: ${minBuildingDistToWater.toFixed(0)}m.` : 'No water nearby.',
  ].join(' ');

  // 5. 紧凑数值向量 (用于本地轻量快速点积反射)
  const numericVector = [
    hMean / 500,                    // 归一化高程
    (hMax - hMin) / 100,            // 局部落差
    slopeMean / 30,                 // 平均坡度
    slopeMax / 45,                  // 最大坡度
    waterPct,                       // 水体占比
    riverPct,                       // 河网占比
    dominantZone === 'CORE' ? 1 : 0,// 是否核心区
    dominantZone === 'RES' ? 1 : 0, // 是否住宅区
    dominantZone === 'IND' ? 1 : 0, // 是否工业区
    dominantZone === 'PADDY' ? 1 : 0,// 是否农田
    Math.min(1, buildingCount / 20),// 建筑密度
    Math.min(1, avgFloors / 6),     // 建筑层数
    Math.min(1, roadDensityKm2 / 15)// 道路密度
  ];

  return {
    cx,
    cz,
    radius,
    hMean,
    hSpan: hMax - hMin,
    slopeMean,
    slopeMax,
    waterPct,
    dominantZone,
    buildingCount,
    avgFloors,
    roadDensityKm2,
    description,
    numericVector,
  };
}
