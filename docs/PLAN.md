# Terrain Gacha Lab：下一阶段细化与多智能体任务规划

## 0. 目标与边界

### 目标

在不破坏现有“纯静态、无运行时依赖、seed 可复现”的前提下，把 MVP 从“地形 + 城镇 + 铁路”推进到：

1. **有生态层**：湿度、森林、草地、岩石、雪线、沙滩，以及 2D/3D 植被。
2. **城镇更完整**：站前广场、港口、桥梁、田地纹理等公共设施。
3. **水体更自然**：湖泊、河宽、瀑布/急流，而不只是单像素河网。
4. **地形可扩展**：再增加 3 种有明确设计语义的地形。
5. **交互与性能**：Web Worker、参数面板、分享链接、更多导出。
6. **可持续验证**：单元测试、确定性检查、视觉检查清单和文档同步。

### 不在范围

- 不复刻原项目的完整产品、参数表、字符串表或美术资源。
- 不做后端、账号、多人协作、付费资产或在线地图。
- 不引入运行时 npm 依赖；three.js 继续 vendored。
- 不为了视觉效果牺牲 seed 确定性。

## 1. 当前基线（事实）

- 5 种地形：`river` / `slope` / `onsen` / `fjord` / `caldera`。
- 6 种视图：彩色、高度、坡度、汇流、城镇、3D。
- 城镇已有：可达性分区、放射/环路/支路、单线铁路、车站、前后排地块、建筑。
- 水文已有：填洼、D8、汇流、`seaMask`、`dSea`、`dRiver`、`dLand`。
- 2D 只有“坡度暗色”近似森林，没有独立生态层或树冠。
- 3D 有实例化建筑、道路、铁路叠加层、车站标识，没有树。
- 生成在主线程；512 约 0.7–0.8 s。
- 导出只有 PNG 与 JSON。
- 测试：`test/smoke.test.mjs`、`test/town.test.mjs`；`npm test` 通过。
- 版本控制约定：改 JS 后必须同步递增相应 `?v=` 查询参数和 `index.html` 的 `main.js?v=`。

## 2. 全局工程约束

1. **确定性**：所有新随机流使用 `rngFor(seed, 'domain:...')`，禁止 `Math.random()`。
2. **数据与渲染分离**：生成层只输出 typed array / 普通对象；渲染层不得反向修改生成数据。
3. **兼容性**：现有 `generateTown(field, hydro, seed)`、`renderTerrain(...)`、`create3DView(...)` 的调用方式保持可用；新参数一律可选。
4. **无运行时依赖**：新增库必须 vendored，或只作为 devDependency。
5. **文件所有权**：同一并行组内，一个文件只能有一个 agent 写；跨组共享文件必须等上游完成。
6. **测试门槛**：每个任务至少运行 `npm test`；涉及浏览器渲染的任务附截图/URL 与检查结论。
7. **提交策略**：agent 可在自己的 `task/*` 分支本地 commit，但不得 push/merge；主分支由集成者审查后统一提交。
8. **版号策略**：每个改动模块递增 `?v=`；`index.html` 的 `main.js?v=` 同步递增。

## 3. 任务总表

| ID | 任务 | 主要文件 | 依赖 | 建议并行组 | 优先级 |
|---|---|---|---|---|---|
| T00 | 契约补丁：`field.seed` | `src/terrains.js` | 无 | Wave 0 | P0 |
| T01 | 生态数据层 | 新 `src/ecology.js`、新 `test/ecology.test.mjs` | T00 | Wave 0 | P0 |
| T02 | 2D 生态/植被渲染 | `src/render.js`、`index.html`、`styles.css` | T01 | Wave 1 | P0 |
| T03 | 3D 植被实例化 | `src/view3d.js` | T01 | Wave 1 | P0 |
| T04 | 城镇公共设施生成 | `src/town.js`、`test/town.test.mjs` | 无 | Wave 1 | P0 |
| T05 | 城镇设施 2D/3D 渲染 | `src/render.js`、`src/view3d.js` | T02、T03、T04 | Wave 2 | P1 |
| T06 | 水文升级：湖泊/河宽/瀑布 | `src/hydrology.js`、`test/smoke.test.mjs` | 无 | Wave 1 | P1 |
| T07 | 水体 2D/3D 渲染 | `src/render.js`、`src/view3d.js` | T05、T06 | Wave 3 | P1 |
| T08 | 地形包 II（3 种新地形） | `src/terrains.js` | T00 | Wave 1 | P1 |
| T09 | Web Worker 生成管线 | `src/main.js`、新 `src/pipeline.js`、新 `src/generate.worker.js` | T00 | Wave 2 | P1 |
| T10 | 参数面板 + 分享链接 | `src/main.js`、`index.html`、`styles.css` | T02、T09 | Wave 3 | P2 |
| T11 | 导出扩展：heightmap/SVG/GLB | 新 `src/exporters.js`、`src/main.js`、`index.html`、`vendor/` | T09、T10 | Wave 4 | P2 |
| T12 | 测试/视觉回归/文档 | `test/*`、`scripts/*`、`README.md`、`docs/*` | 各任务 | Wave 4 | P1 |

> 注：T08 的 UI 选项由 T02 在同一个 `index.html` 里一并加入，避免两个 agent 同时改 index。

## 4. 任务卡（可直接领取）

### T00 — 契约补丁：把 seed 存回 field

**目标**：让生态层、2D/3D 渲染都能拿到本次生成 seed，而不必层层透传。

- 修改 `generateHeightField` 的返回对象，增加 `seed` 字段。
- 不改高度函数、参数生成或 RNG 序列。
- 可补一条断言：同一 seed 的 `field.seed` 一致。

**验收**：`npm test` 通过；现有页面无变化。

---

### T01 — 生态数据层（基础，必须先做）

**目标**：新增纯数据模块，输出可被 2D/3D 共用的生态场。

**建议 API**

```js
export const BIOME = {
  WATER: 0, BEACH: 1, GRASS: 2, FOREST: 3,
  ROCK: 4, SNOW: 5, WETLAND: 6,
};

export function buildEcology(field, hydro, town = null) {
  return {
    moisture,   // Float32Array 0..1
    forest,     // Float32Array 0..1，树冠密度
    rock,       // Float32Array 0..1
    snow,       // Float32Array 0..1
    beach,      // Uint8Array 0/1
    biome,      // Uint8Array BIOME.*
    stats: { forestPct, grassPct, rockPct, snowPct, beachPct, wetlandPct },
  };
}
```

**建议算法**

- `nearWater = exp(-dRiver * cell / 140)`；`wet = log1p(acc) / log1p(maxAcc)`。
- `moisture = smoothstep(...)` 综合：近水、汇流、低坡、低海拔、海岸湿润。
- `rock`：坡度、海拔、山脊（可用高度二阶差分/曲率近似）。
- `snow`：相对雪线 `max - 0.18 * (max - min)`，按坡度做保留。
- `beach`：`dSea * cell < 35 && h < 4`，并给噪声抖动。
- `forest`：`moisture` 高、坡度适中、非雪/非岩/非水，并乘城镇排除（`town.zones` 非 NONE 时衰减）。
- `biome` 按优先级：水 > 沙滩 > 雪 > 岩 > 森林 > 湿地 > 草地。
- 使用 `rngFor(field.seed, 'ecology:' + field.terrain.id)` 产生低频抖动，保持确定性。

**测试**

- 同 seed 两次 `forest` 数组哈希一致。
- 所有值在 0..1 / 合法枚举内。
- 水面 forest=0；雪线以上 snow 显著；近水 forest 均值高于远离水的高坡。
- 五种地形都能生成，不抛异常。

**禁止**：不改 `render.js` / `view3d.js` / `main.js`。

---

### T02 — 2D 生态与植被渲染

**目标**：让彩色视图和城镇视图真正“长树”，并增加生态图例。

**文件**：`src/render.js`、`index.html`、`styles.css`（本任务不改 `main.js`）。

- `renderTerrain` 增加可选参数 `ecology = null`；为空时内部调用 `buildEcology(field, hydro, town)`，保持旧调用可用。
- 彩色视图：
  - 用 `biome` 替换现有“坡度暗色”森林逻辑。
  - 森林区域画成**成簇树冠**：深绿底 + 2–3 种半径的圆点/小椭圆，避免整片纯色。
  - 树冠点必须避开水面、城镇建筑/道路（可用 `town.zones`、`town.buildings` 近似）。
  - 雪/岩/沙滩有明确颜色过渡。
- 城镇视图：只保留低强度森林底色，不画树冠，避免遮挡道路/地块。
- `index.html`：
  - 增加森林、草地、岩石、雪线图例。
  - **顺便加入 T08 的新地形 option**（本任务独占 index）。
- `styles.css`：图例图标样式。
- 性能：树冠标记上限约 4k–6k；用确定性采样，不要逐像素画树。

**验收**

- 五种地形彩色视图都能看到森林/裸岩/雪线差异。
- 城镇中心不被树冠覆盖；水面无树。
- 页面无 console/page error；附 2–3 张截图。

---

### T03 — 3D 植被实例化

**目标**：在 3D 场景中加入低多边形树，优先可读性，不做照片级。

**文件**：`src/view3d.js`。

- 在 `update` 中构建/替换一个 `treeGroup`，旧 group 必须 dispose。
- 树几何建议：
  - 针叶树：细圆柱树干 + 2 层圆锥。
  - 阔叶树：细圆柱 + 低多边形球/二十面体。
  - 灌木：小二十面体。
- 使用 `InstancedMesh`，一个物种一个 mesh；总树数 512 网格下建议 1500–3000，1024 下不超过 5000。
- 放置规则：
  - `ecology.forest > 0.45`；坡度 < 25°；`h > 1.5`；非水面。
  - 避开 `town.zones` 的有效分区、建筑 footprint、道路/铁路中心线附近。
  - 雪线以上不放置，或只放极少量。
- 随机抖动必须确定性：树位置由 `rngFor(field.seed, 'trees3d:' + terrain.id)` 生成。
- `debug()` 增加 `treeCount` 与 `treeMeshes`。
- 可选：城镇特写时提高树密度，全图时降低实例数；先保证不闪烁。

**验收**

- 3D 全图/城镇特写都能看到树，不穿建筑、不漂在水面。
- 512 分辨率生成后 3D 首帧 < 1.5 s（本机）。
- 附全图与城镇截图。

---

### T04 — 城镇公共设施生成

**目标**：让城镇从“道路 + 房子 + 铁路”升级为有站前广场、港口、桥梁、田地的聚落。

**文件**：`src/town.js`、`test/town.test.mjs`。

新增数据契约（保持已有字段不变）：

```js
town.amenities = {
  plaza: { x, z, w, d, angle, kind: 'station' } | null,
  port: { x, z, angle, length, width } | null,
  bridges: [{ kind: 'road'|'rail', x, z }],
};
town.parcels[i].kind = 'urban' | 'field';
town.parcels[i].crop = 'rice' | 'vegetable' | null;
```

- **站前广场**：车站确定后，在站房与道路之间放一个矩形广场；后续地块/建筑避让。
- **港口**：若城镇中心 900 m 内有可建海岸，放一个垂直海岸的栈桥/码头，并允许仓库地块；无海岸则 null。
- **桥梁**：把道路/铁路跨水的采样点写入 `amenities.bridges`，供渲染层画桥面。
- **田地**：PADDY 分区的地块标 `kind:'field'`，按 seed 分配 `crop`；不改变现有建筑概率太多。
- 所有设施都要参与地块重叠/铁路净空检查。

**验收**

- 五种地形都能生成；有海岸的地形至少部分出现 port，无海岸为 null。
- 车站存在时 plaza 存在，且建筑不压在 plaza 内。
- 同 seed 确定性；`npm test` 通过。

---

### T05 — 城镇设施 2D/3D 渲染

**依赖**：T02、T03、T04 完成后再开始（共享 render/view3d）。

- 2D：
  - 广场：浅色铺装 + 细边线。
  - 港口：栈桥木色 + 系船柱；避免画到深水外。
  - 桥梁：桥面高亮 + 两侧栏杆线。
  - 田地：按 crop 画细行线/田块纹理，不遮挡道路。
- 3D：
  - 广场：薄盒体平台。
  - 港口：栈桥盒体 + 简单桩柱；仓库已有建筑类型。
  - 桥梁：道路/铁路跨水段抬升或加桥面盒体；先做视觉，不做结构。
  - 田地：低矮条带/色块，避免每块地单独 mesh 过多。
- 保持全图/城镇视角可读；新增 `debug()` 统计。

**验收**：五种地形截图；无 z-fighting/悬浮；页面无错误。

---

### T06 — 水文升级：湖泊、河宽、瀑布

**文件**：`src/hydrology.js`、`test/smoke.test.mjs`。

新增契约（保持已有字段）：

```js
{
  lakeMask,   // Uint8Array
  waterMask,  // Uint8Array = seaMask | lakeMask
  dLake,      // Int32Array
  riverWidth, // Float32Array，米
  falls,      // [{ x, z, drop }]
}
```

- **湖泊**：在 `priorityFlood` 后，找 `filled - height > 1.5 m` 的洼地；用连通分量过滤小水坑（面积阈值按地图大小），只保留有实际蓄水面积的湖。
- **河宽**：`widthM = 2 + 18 * sqrt(acc / maxAcc)`，按 cell 面积归一；上限 24 m。
- **瀑布**：沿 D8 流向找 `drop > 8 m` 且 `acc >= minAcc` 的河段，限制数量。
- 保持 `seaMask` 语义不变；新增字段不破坏现有调用。
- 测试：湖泊不重叠海面；河宽随 acc 单调；瀑布数量有限且位置在河上；确定性。

**禁止**：不改 render/view3d；渲染在 T07。

---

### T07 — 水体 2D/3D 渲染

**依赖**：T05、T06。

- 2D：
  - 彩色/城镇视图：湖泊用与海不同的深浅蓝；河宽按 `riverWidth` 画，不再单像素。
  - 瀑布用短白线/白点，汇流视图可保留原样。
  - 海岸浅滩和湖泊岸线做 1–2 px 过渡。
- 3D：
  - 每个湖一个水平水面 mesh（y = 湖面高度），材质半透明；避免与海面 z-fighting。
  - 河宽用带状 mesh 或现有矢量线加宽；瀑布用竖直白色带/粒子感细条。
  - 控制 mesh 数量；小湖可合并或跳过。
- 验收：湖泊在 2D/3D 都可见；河流宽度在城镇附近明显；无大面积闪烁。

---

### T08 — 地形包 II：3 种新地形

**文件**：`src/terrains.js`（本任务不改 index；UI 由 T02 加）。

新增地形建议：

1. `castle` — 城下町：内陆盆地 + 中央台地/城山 + 蜿蜒河 + 两侧山。
2. `skyline` — 摩天楼海岸：海湾 + 平坦 downtown + 背后丘陵 + 小岛。
3. `falls` — 瀑布水都：高原 + 深峡 + 主河 + 瀑布坎 + 湖。

每种地形必须提供：

```js
{
  id, label, hasSea, island?, tune, params(rng), height(u, v, params)
}
```

要求：

- 参数由 `rngFor(seed, 'design:id')` 生成。
- 高度函数解析式；不要复制原项目参数表。
- `tune.minA` 与地形尺度匹配，确保能生成河流。
- `terrain` 上可加 `snowline`/`forestBias` 等可选字段，供生态层使用。
- 现有 `TERRAIN_IDS` 自动包含新地形，smoke/town 测试会自动循环。

**验收**：`npm test` 五种旧地形不回归；新地形有合理高度范围、河流、城镇、铁路、车站；附 2D 截图。

---

### T09 — Web Worker 生成管线

**文件**：`src/main.js`、新 `src/pipeline.js`、新 `src/generate.worker.js`。

- 把 `generate()` 中的纯生成逻辑抽到 `generateWorld({ type, seed, size, res, erosion })`：
  - 返回 `{ field, hydro, town, droplets, timings }`。
  - 不碰 DOM、不碰 canvas。
- Worker 通过 `postMessage` 分阶段回报 `progress`，主线程更新状态文本。
- 主线程优先 Worker；Worker 创建/执行失败时回退到主线程，并在状态栏提示。
- typed array 通过 structured clone 传回；避免复制整份 height 多次。
- 1024 分辨率下 UI 不冻结；同一 seed 的结果与主线程路径一致（可比较 hash）。

**验收**：`npm test` 通过；浏览器 1024 生成时页面可交互；失败回退可用。

---

### T10 — 参数面板 + 分享链接

**依赖**：T02、T09。

- 增加“高级”折叠面板：
  - 侵蚀强度（0–100%）
  - 树木密度（0–150%）
  - 显示树木 / 地块 / 铁路开关
- 参数进入 URL hash（`#type=...&seed=...&size=...&res=...&erosion=...`），刷新可复现。
- “复制分享链接”按钮；解析失败时回退默认值并提示。
- 保持现有 UI 紧凑，不影响 3D 画布。

**验收**：复制链接后新标签页打开复现；非法参数有清晰回退；`npm test` 通过。

---

### T11 — 导出扩展

**文件**：新 `src/exporters.js`、`src/main.js`、`index.html`、`vendor/`（如需 GLTFExporter）。

优先级：

1. **Heightmap PNG**：16-bit 灰度（若实现成本高，先 8-bit + 明确说明）；带 scale metadata（JSON 或 PNG tEXt）。
2. **SVG 地图**：道路、铁路、河流、地块轮廓、建筑轮廓；适合矢量查看。
3. **GLB**：3D 地形 + 建筑 + 铁路/车站；树可先不导出。

要求：

- 不引入运行时依赖；GLTFExporter 必须 vendored。
- 导出文件名包含 type/seed。
- 导出前检查 `field/hydro/town` 存在；失败时状态栏提示。
- 单测：heightmap 尺寸/范围；SVG 可解析；GLB 至少检查 magic/长度。

**验收**：三种导出在浏览器实测；大文件不阻塞超过 2 s（或提示进度）。

---

### T12 — 测试、视觉检查与文档

- 新增 `test/ecology.test.mjs`、`test/hydrology.test.mjs`（若 T06 未覆盖）。
- 增加确定性哈希：每种地形输出 `field/hydro/town` 的稳定摘要。
- 增加性能门槛：512 生成 < 1.5 s（Node，无 DOM）；1024 < 5 s（Worker 路径，浏览器）。
- 视觉检查清单：5 种地形 × 彩色/城镇/3D；检查森林、湖泊、铁路、车站、广场、港口。
- 可选：`scripts/visual-check.mjs` + Playwright（devDependency）；不强制运行时安装。
- 更新 `README.md`、`docs/oyasumi-gacha-reverse-engineering.md`、本规划的状态表。

**验收**：`npm test`；清单逐项勾选；文档与实现一致。

## 5. 推荐执行波次

### Wave 0 — 契约与生态基础

- T00（快速，集成者可直接做）
- T01（生态层）

T01 完成前，T02/T03 不启动。

### Wave 1 — 第一批并行

同时启动 4 个 agent：

- **Agent A：T02 2D 生态/植被**（render + index + styles）
- **Agent B：T03 3D 植被**（view3d）
- **Agent C：T04 城镇设施生成**（town + town test）
- **Agent D：T06 水文升级**（hydrology + smoke test）
- **Agent E：T08 地形包 II**（terrains；不碰 index/test/smoke）

文件不重叠。T02 独占 index，顺带加入 T08 的新地形 option。

### Wave 2 — 渲染整合与 Worker

- **Agent F：T05 城镇设施渲染**（render/view3d；等 T02/T03/T04 完成）
- **Agent G：T09 Worker 管线**（main + 新文件；与 T05 不重叠）

### Wave 3 — 水体与交互

- **Agent H：T07 水体渲染**（render/view3d；等 T05/T06）
- **Agent I：T10 参数面板/分享**（main/index/styles；等 T02/T09）

### Wave 4 — 导出与验收

- **Agent J：T11 导出扩展**（main/index/exporters）
- **Agent K：T12 测试/视觉/文档**（test/docs；可与 T11 并行，但 README 由 T12 独占）

## 6. 任务领取与交付协议

每个 agent 的提示词应包含：

```text
项目：<repo root>
规划：docs/PLAN.md
任务板：docs/ROADMAP.md
当前基线：<commit sha>

领取任务：Txx
工作区：<worktree path> / 分支 <branch>
只修改任务卡列出的文件；不要改其他文件；不要 push/merge。
可以在自己的 task/* 分支做本地 commit，但主分支只由集成者操作。
先读规划和相关源码，再实现。
完成后报告：变更文件、测试命令与结果、截图/URL、遗留风险。
```

集成者（主 agent）负责：

1. 审查 diff，解决跨任务接口冲突。
2. 运行 `npm test` 与浏览器检查。
3. 递增 `?v=` 并更新 `index.html`。
4. 统一 commit/push。

## 7. 验收门槛

### 必须通过

- `npm test` 全绿。
- 5（之后 8）种地形都能生成城镇、铁路、车站、地块。
- 同 seed 两次生成的关键数据哈希一致。
- 512 分辨率浏览器生成 + 3D 首帧 < 2 s（本机）。
- 页面无 console error / page error。
- 2D/3D 截图中：森林不压城镇、树不落水、铁路可见、车站可定位。

### 人工视觉检查

每种地形至少检查：

1. 彩色视图：森林/草地/岩石/雪线/沙滩分层。
2. 城镇视图：道路、地块、建筑、铁路、车站、广场/港口。
3. 3D 全图：地形轮廓、森林覆盖、铁路走向、水体。
4. 3D 城镇特写：树不穿建筑、站台/站房、铁路叠加层。

## 8. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 2D 树冠过密/过慢 | 彩色视图变糊、帧率下降 | 树冠上限、成簇采样、城镇排除 |
| 3D 树实例过多 | 首帧/显存压力 | 512 上限 3k、1024 上限 5k、按距离/密度抽样 |
| 湖泊检测误判 | 大片陆地变水 | 面积阈值 + 连通分量 + 只保留有溢流口的洼地 |
| Worker 结构化克隆大数组 | 传输抖动 | 只传必要 typed array；progress 分阶段 |
| 共享文件并发写 | 冲突/覆盖 | 波次 + 文件所有权；T02/T03/T05/T07 串行 render/view3d |
| 新地形导致城镇为空 | 测试/体验退化 | 每种地形单独跑 town 测试，调 `minA`/坡度/中心搜索 |
| 导出 GLB 依赖 | 破坏无依赖承诺 | vendored exporter；失败回退 |
| 视觉改动无回归 | 静默退化 | T12 检查清单 + 可选 Playwright |

## 9. 立即可做的第一条垂直切片

如果只想先验证“植被”价值，按最小路径：

1. T00 + T01（生态层）。
2. T02（2D 树冠 + 图例）。
3. T03（3D 树实例）。
4. 用五种地形截图对比，确认森林/雪线/城镇遮挡可接受，再进入 T04/T06。

这条切片只新增 `ecology.js` + 测试，修改 `render.js`、`view3d.js`、`index.html`、`styles.css`，不改生成算法和城镇数据。
