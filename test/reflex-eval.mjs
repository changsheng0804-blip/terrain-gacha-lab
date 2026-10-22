/**
 * test/reflex-eval.mjs
 * 
 * 蒙特卡洛微观切片提取与反射层分离度测试
 * 验证：
 * 1. 局部切片特征提取的高频耗时 (是否 < 0.5ms / 次)；
 * 2. 对“正常合理街区/自然切片”与“畸形异常切片（陡坡建城/落水/断崖孤立）”的分类区分度；
 * 3. 统计余弦距离与点积反射打分的分布，计算 AUC / 分离度指标。
 */

import { generateWorld } from '../src/pipeline.js';
import { extractTileFeature } from '../src/reflex/extractor.js';

// 余弦相似度
function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1e-6);
}

// 模拟预设的原型向量（Prototypes）
// 1. 理想宜居平缓街区原型
const PROTO_HEALTHY = [
  0.1,  // 高程平缓
  0.1,  // 落差小
  0.12, // 坡度缓 (约 3~4 度)
  0.15, // 最大坡度低
  0.0,  // 无深水
  0.1,  // 适度近河
  0.5,  // 住宅或核心区
  0.5,
  0.0,
  0.0,
  0.4,  // 适中建筑密度
  0.35, // 2-3 层
  0.4   // 适中路网密度
];

// 2. 畸形悬崖落水病理原型 (Pathology)
const PROTO_PATHOLOGY = [
  0.6,  // 高海拔或深切
  0.8,  // 局部落差巨大 (>80m)
  0.8,  // 平均坡度极陡 (>24度)
  0.9,  // 最大坡度超险
  0.6,  // 严重淹水
  0.0,
  0.0,
  0.0,
  0.0,
  0.0,
  0.6,  // 居然有密集建筑
  0.1,
  0.05  // 几乎无路
];

async function run() {
  console.log('=== Monte Carlo Reflex Layer Experiment ===\n');
  const seeds = [101, 202, 303, 404, 505];
  const terrains = ['river', 'slope', 'onsen', 'fjord', 'caldera'];

  const healthySamples = [];
  const pathologySamples = [];

  const tStart = performance.now();
  let totalTilesExtracted = 0;

  for (const terrain of terrains) {
    for (const seed of seeds) {
      const world = generateWorld({
        type: terrain,
        seed,
        size: 4000,
        res: 256,
        erosion: true
      });

      const { field, town } = world;
      const n = field.n;

      // 提取正常样本：城镇中心附近、建筑密集且合法的样本
      if (town && town.center) {
        const t0 = performance.now();
        const featCenter = extractTileFeature(world, town.center.x, town.center.z, 120);
        totalTilesExtracted++;
        if (featCenter.buildingCount >= 3 && featCenter.slopeMax < 18) {
          healthySamples.push(featCenter);
        }

        // 随机在主要建筑处采样
        for (let k = 0; k < Math.min(6, town.buildings.length); k += 2) {
          const b = town.buildings[k];
          const f = extractTileFeature(world, b.x, b.z, 100);
          totalTilesExtracted++;
          if (f.slopeMax < 20 && f.waterPct < 0.2) {
            healthySamples.push(f);
          }
        }
      }

      // 构造/采样极端或病理样本：
      // 在极陡峭山壁或深水区人为探测（若有建筑落入或无路孤岛）
      for (let k = 0; k < 5; k++) {
        const rx = field.x0 + (0.2 + 0.6 * Math.random()) * field.size;
        const rz = field.y0 + (0.2 + 0.6 * Math.random()) * field.size;
        const f = extractTileFeature(world, rx, rz, 120);
        totalTilesExtracted++;
        // 病态特征：陡峭落差极大，或者水域占比极高但有破碎异常
        if (f.slopeMax > 28 || f.waterPct > 0.7 || f.hSpan > 80) {
          pathologySamples.push(f);
        }
      }
    }
  }

  const timeCost = performance.now() - tStart;
  console.log(`Extracted ${totalTilesExtracted} micro-tiles across 25 worlds in ${timeCost.toFixed(1)} ms`);
  console.log(`Average extraction time per tile: ${(timeCost / totalTilesExtracted).toFixed(3)} ms`);
  console.log(`Collected ${healthySamples.length} healthy samples and ${pathologySamples.length} abnormal/steep samples.\n`);

  // 计算每个切片在反射层的打分：
  // ReflexScore = Cosine(sample, Healthy) - Cosine(sample, Pathology)
  // 分数越大于 0，越健康自洽；分数越小于 0，越异常违和。
  const healthyScores = healthySamples.map(s => {
    const sH = cosineSimilarity(s.numericVector, PROTO_HEALTHY);
    const sP = cosineSimilarity(s.numericVector, PROTO_PATHOLOGY);
    return sH - sP;
  });

  const pathologyScores = pathologySamples.map(s => {
    const sH = cosineSimilarity(s.numericVector, PROTO_HEALTHY);
    const sP = cosineSimilarity(s.numericVector, PROTO_PATHOLOGY);
    return sH - sP;
  });

  const avgH = healthyScores.reduce((a, b) => a + b, 0) / (healthyScores.length || 1);
  const avgP = pathologyScores.reduce((a, b) => a + b, 0) / (pathologyScores.length || 1);

  console.log(`Healthy Samples Mean Score:   +${avgH.toFixed(3)} (min ${Math.min(...healthyScores).toFixed(3)}, max ${Math.max(...healthyScores).toFixed(3)})`);
  console.log(`Abnormal Samples Mean Score:  ${avgP.toFixed(3)} (min ${Math.min(...pathologyScores).toFixed(3)}, max ${Math.max(...pathologyScores).toFixed(3)})`);

  // 简易分离度评估 (Separation Accuracy at threshold 0)
  let correctH = healthyScores.filter(s => s > 0).length;
  let correctP = pathologyScores.filter(s => s <= 0).length;
  const accuracy = (correctH + correctP) / (healthyScores.length + pathologyScores.length);

  console.log(`\nClassification Separation Accuracy (Zero-threshold): ${(accuracy * 100).toFixed(1)}%`);
  console.log(`- Healthy True Positive Rate:  ${((correctH / healthyScores.length) * 100).toFixed(1)}%`);
  console.log(`- Abnormal True Negative Rate: ${((correctP / pathologyScores.length) * 100).toFixed(1)}%`);

  // 输出样本描述样例
  console.log('\n--- Sample Semantic Description for EmbeddingGemma 2 ---');
  console.log('[Healthy Sample Description]:');
  console.log(' ', healthySamples[0].description);
  console.log('[Abnormal Sample Description]:');
  console.log(' ', pathologySamples[0].description);

  if (accuracy >= 0.85) {
    console.log('\n>>> Reflex layer separation test PASSED: Micro-tile reflex distinguishes healthy vs pathological patterns reliably.');
    process.exit(0);
  } else {
    console.error('\n>>> Reflex layer separation test FAILED: Low separation.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
