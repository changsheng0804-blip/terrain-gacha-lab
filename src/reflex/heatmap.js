/**
 * src/reflex/heatmap.js
 * 
 * 局部反射层全图网格扫描与诊断热力图生成器
 * 以固定步长 (如 120m) 扫描世界，利用 Micro-Tile Extractor 与原型余弦投影，
 * 输出网格化的健康/违和分数矩阵，供 2D/3D 画布做 X-Ray 诊断透视。
 */

import { extractTileFeature } from './extractor.js';

// 1. 理想宜居平原/山地谷地城镇原型
const PROTO_TOWN = [
  0.3,  // 兼顾海平原与山地温泉谷 (0~400m)
  0.12, // 局部适度高差
  0.12, // 坡度缓和 (~4°)
  0.18, // 最大坡度
  0.05, // 允许适度临水
  0.15, // 临河
  0.5, 0.5, 0.0, 0.0, // CORE/RES 分区
  0.5,  // 建筑密度
  0.4,  // 建筑层数
  0.4   // 道路密度
];

// 2. 正常自然山野/森林原型 (无人造建筑的高山与谷地)
const PROTO_NATURE = [
  0.4,  // 中高海拔
  0.35, // 正常山势高差
  0.35, // 正常山坡 (~10°)
  0.45, // 正常山脊
  0.1,  // 局部小水体
  0.1,
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0
];

// 3. 正常开阔海洋/湖泊水体原型 (纯净水面，平坦无坡度，无建筑)
const PROTO_WATER = [
  0.0,  // 海平面/水面高度
  0.02, // 几乎无高差
  0.02, // 几乎零坡度
  0.05,
  1.0,  // 100% 水体覆盖
  0.0,
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0
];

// 4. 真正违和的病理原型 (核心矛盾：在极险陡壁悬崖上硬塞密集建筑，或深水落水建筑)
const PROTO_PATHOLOGY = [
  0.8,  // 极端海拔
  1.0,  // 断裂落差 (>100m)
  1.0,  // 极陡悬崖 (>30°)
  1.0,
  0.6,  // 水陆交织泥泞
  0.0,
  0.0, 0.0, 0.0, 0.0,
  0.9,  // 却硬塞了密集建筑！ (违和核心)
  0.6,
  0.3   // 悬崖/水中有道路
];

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1e-6);
}

/**
 * 计算全图反射诊断热力网格
 * @param {object} world - 包含 field, hydro, town, ecology
 * @param {number} stepMeters - 扫描步长 (米，默认 150m)
 */
export function computeReflexHeatmap(world, stepMeters = 150) {
  const { field } = world;
  const { size, x0, y0 } = field;

  const cols = Math.floor(size / stepMeters) + 1;
  const rows = cols;
  const scores = new Float32Array(cols * rows);
  const tiles = [];

  let minScore = Infinity;
  let maxScore = -Infinity;
  let healthyCount = 0;
  let warningCount = 0;
  let dangerCount = 0;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = x0 + i * stepMeters;
      const cz = y0 + j * stepMeters;
      const feat = extractTileFeature(world, cx, cz, stepMeters * 0.8);

      const sTown = cosineSim(feat.numericVector, PROTO_TOWN);
      const sNat = cosineSim(feat.numericVector, PROTO_NATURE);
      const sWater = cosineSim(feat.numericVector, PROTO_WATER);
      const sPath = cosineSim(feat.numericVector, PROTO_PATHOLOGY);

      // 正常的自然山野、正常纯净水体、健康的城镇，都是自洽的
      const naturalScore = Math.max(sTown, sNat * 0.95, sWater * 0.95);
      const score = naturalScore - sPath; // [-1, +1]

      const idx = j * cols + i;
      scores[idx] = score;

      if (score < minScore) minScore = score;
      if (score > maxScore) maxScore = score;

      if (score >= 0.1) healthyCount++;
      else if (score >= -0.15) warningCount++;
      else dangerCount++;

      tiles.push({
        i, j, cx, cz, score,
        desc: feat.description,
        feat
      });
    }
  }

  return {
    cols,
    rows,
    stepMeters,
    scores,
    tiles,
    minScore,
    maxScore,
    stats: {
      total: cols * rows,
      healthy: healthyCount,
      warning: warningCount,
      danger: dangerCount,
      healthyPct: (healthyCount / (cols * rows)) * 100,
    }
  };
}
