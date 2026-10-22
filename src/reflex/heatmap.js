/**
 * src/reflex/heatmap.js
 * 
 * 局部反射层全图网格扫描与诊断热力图生成器
 * 以固定步长 (如 120m) 扫描世界，利用 Micro-Tile Extractor 与原型余弦投影，
 * 输出网格化的健康/违和分数矩阵，供 2D/3D 画布做 X-Ray 诊断透视。
 */

import { extractTileFeature } from './extractor.js';

// 理想宜居自洽原型
const PROTO_HEALTHY = [
  0.1, 0.1, 0.12, 0.15, 0.0, 0.1, 0.5, 0.5, 0.0, 0.0, 0.4, 0.35, 0.4
];

// 悬崖/积水/断崖病理原型
const PROTO_PATHOLOGY = [
  0.6, 0.8, 0.8, 0.9, 0.6, 0.0, 0.0, 0.0, 0.0, 0.0, 0.6, 0.1, 0.05
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

      const sH = cosineSim(feat.numericVector, PROTO_HEALTHY);
      const sP = cosineSim(feat.numericVector, PROTO_PATHOLOGY);
      const score = sH - sP; // [-1, +1] 区间，>0 偏健康，<0 偏异常违和

      const idx = j * cols + i;
      scores[idx] = score;

      if (score < minScore) minScore = score;
      if (score > maxScore) maxScore = score;

      if (score >= 0.2) healthyCount++;
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
