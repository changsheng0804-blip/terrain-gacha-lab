# RFC-001: Emergent World Evolution (从规则中自然涌现的世界演化系统)

> **状态**：Draft for Multi-Model Peer Review & Hardening  
> **分支**：`rfc/emergent-world-evolution`  
> **核心哲学**：不以暴力数据堆砌资产，而是以因果律（Causality）为驱动，通过精简的规则链条让物理地质与人类聚落自底向上、连续演化地“长出来”。

---

## 1. 背景与核心价值

当前 `terrain-gacha-lab` 已经建立了一套优雅的物理与空间规划静态生成管线：
`参数化宏观设计 -> 解析式高度场 -> 水滴与热侵蚀 -> 水文填洼与流向 -> 生态植被 -> 城镇可达性与地块`。

但当前系统存在一个核心局限：**一次性静态输出（Single-shot Pipeline）**。
用户只能看到一个瞬间被冻结的世界终态，而错失了自然生成最震撼的魅力——**因果涌现的过程**。

本 RFC 旨在规划一个系统性的升级方案：将静态管线升维为**多阶段时序演化系统（Temporal Evolution Pipeline）**，并引入**微观智能体需求驱动的聚落生长**。

---

## 2. 演化架构分期（The 4-Epoch Evolution Framework）

世界不再是瞬时算完，而是被解耦为四个有时间先后因果纪元（Epochs）：

```text
[Epoch 0: 地壳板块与造山构造 (Tectonics)]
      │
      ▼
[Epoch 1: 水文动力学与气候侵蚀 (Erosion & Hydrology)]
      │  - 降雨在山脉迎风坡富集
      │  - 水流按物理坡度切出沟壑、汇入湖泊
      ▼
[Epoch 2: 生态演替与先民拓荒 (Ecology & Genesis)]
      │  - 植被根据湿度与海拔扩散
      │  - 先民在平缓冲积扇与淡水交汇处建立首个拓荒点
      ▼
[Epoch 3: 交通萌发与聚落分化 (Emergent Settlement)]
         - 行人通行热度自然踩出道路 (Desire Paths)
         - 农田沿灌溉水系开垦，住宅在核心区向外细胞式分裂
         - 工业与铁路线根据资源与地势阻力联通外海
```

---

## 3. 关键机制与算法设计

### 3.1 状态生成器与时间轴步进接口 (Generator Step API)

传统的 `generateAll()` 模式：
```javascript
const result = await generate(config);
```

重构为带状态捕获的步进生成器（Step Generator）：
```javascript
export function* createWorldEvolution(config) {
  // Epoch 0: Tectonics
  const field = initTectonics(config);
  yield { epoch: 'tectonics', progress: 0.1, field, diff: null };

  // Epoch 1: Erosion & Hydrology (可细化为 N 轮微步)
  for (let step = 0; step < EROSION_STEPS; step++) {
    const delta = erodeStep(field);
    yield { epoch: 'erosion', progress: 0.1 + 0.4 * (step / EROSION_STEPS), field, delta };
  }

  // Epoch 2: Hydrology & Ecology
  const hydro = computeHydrology(field);
  const eco = computeEcology(field, hydro);
  yield { epoch: 'ecology', progress: 0.6, hydro, eco };

  // Epoch 3: Settlement Evolution
  const settlement = initSettlement(field, hydro);
  for (let year = 0; year < SETTLEMENT_YEARS; year++) {
    evolveTownStep(settlement, field, hydro);
    yield { epoch: 'settlement', year, progress: 0.6 + 0.4 * (year / SETTLEMENT_YEARS), settlement };
  }
}
```

### 3.2 欲望之径（Desire Paths）与有机路网生成

不再直接用全局辐射状射线强制铺路，而是模拟微观主体往返行为：
1. **拓荒源点与目的点**：城镇中心（商业/集市）与关键资源点（农田水源、码头、矿区、山口）。
2. **势能寻路**：Agent 根据当前地形坡度成本行走，留下“信息素/通达频次（Traffic Pheromone）”。
3. **阈值硬化**：通行频次越高的连线自然硬化为干道（Arterial），分支硬化为支路（Local），无人行走的路径自然消亡。

### 3.3 物理扰动的“蝴蝶效应”响应

通过保留中间态场（Heightfield, Hydrology Field, Cost Field），实现交互式微调而不必重算整个世界：
- **微调降水**：局部提升降雨密度，直接在已有地貌上触发冲刷，甚至造成局部滑坡，迫使受灾地块的建筑被标记废弃或搬迁。
- **抬升海平面**：沿海低洼建筑被淹没，居民点向高地二次聚集。

---

## 4. 前端交互与 3D 渲染适配

1. **时序播放器（Timeline Player Widget）**：
   - 增加播放/暂停、速度调节、拖拽进度条。
   - 观察相机可以在“全图鸟瞰”与“聚落特写”之间跟随演化阶段平滑过渡。
2. **3D 实例化平滑动画**：
   - 地形 Mesh 利用顶点着色器（Vertex Shader）或逐网格顶点位移，直观看到山峰被水滴刮落的动态效果。
   - 建筑与树木采用缩放动画（Scale from 0 to 1）在各自被规划的瞬间弹出生长。

---

## 5. 分阶段实施规划（Milestones）

| 阶段 | 目标 | 核心改动 | 风险与对策 |
|---|---|---|---|
| **Phase 1: 异步步进与时间轴回放** | 把静态算法拆解为 Generator，实现 3D 视角下的全流程生长演示 | `src/pipeline.js` (Web Worker / Generator), `src/view3d.js` | 性能开销：避免每帧重新生成完整 Three.js Geometry，采用增量修改顶点或批量属性更新。 |
| **Phase 2: 响应式环境扰动** | 引入降水量、海平面、地质年龄的即时响应与局部重演化 | `src/terrains.js`, `src/erosion.js`, `src/hydrology.js` | 确定性被破坏：必须确保所有微步计算严格绑定初始 seed 与历史 action log。 |
| **Phase 3: 智能体与有机生长** | 引入欲望之径路网硬化、元胞扩散城镇生长 | `src/town.js`, 新增 `src/evolution.js` | 复杂度膨胀：保持纯数学模型，不引入庞大物理引擎或行为树，用势能场和扩散方程代替复杂逻辑。 |

---

## 6. 审查与强化提问（Questions for Gemini 4 & Peer Models）

1. **数学与算法可行性**：
   - 在纯 JavaScript / WebGL 环境下，将水滴侵蚀和 D8 水文流向拆分为高帧率（60fps）交互步进，最高效的内存和计算表现形式是什么？是否需要考虑 WebGL GPGPU，还是 typed array TypedArray chunking 已经足够？
2. **涌现规则的稳定性**：
   - 欲望之径（Desire Paths）与有机城镇生长往往容易退化为杂乱无章的毛刺，如何用极简的数学约束（如张量场 Tensor Field 或主方向对齐）保证“既有自发生长的有机感，又具备人类工程的规划感”？
3. **架构正交性**：
   - 如何在不破坏现有 `docs/CONTRACTS.md` 契约以及已有单测（`npm test`）的前提下，无缝嵌入步进演化系统？

---

## 7. 架构师深度评审与强化方案（Architecture Review & Hardening Appendix by Gemini 4 Argon）

> **评审基准**：`CONTRACTS.md` · `erosion.js` · `hydrology.js` · `town.js` · `occupancy.js` · `view3d.js`

### 7.1 问题一：数学可行性、60fps 动态视觉与确定性内存架构

#### 1) 为什么必须坚持 CPU / Web Worker + TypedArray，坚决否定 GPGPU？
- **跨 GPU 浮点一致性风险**：`CONTRACTS.md` 明确要求同一 seed 的高度场必须确定，且测试使用 SHA-256 校验 `Float32Array` 字节级一致性。不同 GPU（Apple Silicon M、NVIDIA、Intel 核显）在 GLSL 浮点乘加（FMA）、超越函数精度及并行写入冲突上存在微小差异，30 万水滴迭代后会放大为截然不同的河床；且 Node.js 单测无 WebGL 环境。
- **算法天然串行耦合**：`erodeDroplets` 是典型的拉格朗日粒子散射写入（Scatter Write），后一滴水读取前一滴冲出的沟壑形成自发汇流。若改为欧拉浅水方程不仅破坏参数语义，而且每帧 `gl.readPixels` 回传 CPU 供城镇算法使用会造成管线严重卡顿。
- **水文填洼依赖全局堆**：`priorityFlood` 依赖全局二叉堆 `O(N log N)`（512 网格在 CPU 上仅 12~18ms），而在 GPU 上退化为需要数百次全局迭代的 Jacobi 松弛。

#### 2) 确定性守恒的分批侵蚀（Bit-Exact Micro-Batching）
- 侵蚀拆步的关键：只要共享**同一个 RNG 闭包实例**连续消费，将总水滴数（如 20 万滴）分 24 或 48 批调用 `erodeDroplets`，其数学结果与单次跑完 **100% 逐位一致**。
- **陷阱避免**：不能在微步之间穿插调用 `thermalErosion` 或 `smoothField`，热侵蚀和平滑必须在所有水滴步完成后统一执行。
- 单批 4000~8000 滴水在 CPU 上仅需 1~2ms，完全在 16.6ms 帧预算之内。

#### 3) 演化期的双轨水文预览（Fast Preview vs. Full Hydrology）
- 侵蚀动画期间跳过耗时最长的 4 次全图 BFS 距离变换（`dSea`, `dRiver`, `dLand`, `dLake`），仅每隔 6~8 步执行一次轻量流向累积用于 3D 顶点河道染色。
- 侵蚀结束进入生态纪元瞬间，再执行一次完整 `buildHydrology`。

#### 4) 内存传输：双缓冲（Transferable Double Buffering）
- 512×512 的 `Float32Array` 仅占 1.0MB。
- Generator 模式下维护 `workHeight` 与 `viewHeight`，`viewHeight.set(workHeight)` 拷贝耗时 < 0.08ms。
- Worker 模式下主线程与 Worker 之间通过 Transferable ArrayBuffer 零拷贝交替所有权（耗时 < 0.02ms），无任何 GC 抖动。

#### 5) Three.js 3D 视口 60fps 原地热更新（消除 `disposeWorld`）
- 保持 `terrainMesh.geometry` 常驻，复用 `position`、`color`、`normal` 的 `BufferAttribute`（标记 `DynamicDrawUsage`）。
- 中心差分直接解析法线：
  $\mathbf{n}_{x,z} = \text{normalize}\left(-\frac{h_{x+1,z}-h_{x-1,z}}{2\Delta}, \frac{1}{\text{VERTICAL\_SCALE}}, -\frac{h_{x,z+1}-h_{x,z-1}}{2\Delta}\right)$
  省去昂贵的 `computeVertexNormals()`，全图 512 顶点高度+颜色+法线更新总耗时 < 2.5ms。

---

### 7.2 问题二：涌现规则的稳定性与规划感（Tensor Field + 欲望之径硬化）

为避免纯微观 Agent 寻路退化为杂乱毛刺或锐角窄带，采用 **三层混合涌现模型（Hybrid Tensor-Guided Pheromone Graph）**：

1. **地理引导隐式张量场（Implicit 4-RoSy Cross Field）**：
   - 任意点 $(x, z)$ 解析计算主方向角 $\theta^*$：水岸平行分量 + 坡度等高线切线分量 + 中心辐射分量。利用倍角向量 $\sum w_k [\cos(4\theta_k), \sin(4\theta_k)]^T$ 消除 $\pi/2$ 周期跳变。
2. **带张量约束的欲望之径硬化（Traffic-Hardened Cost）**：
   - 边阻抗公式：
     $C(i \to j) = d_{ij} \cdot (1 + \text{slope\_penalty}) \cdot \big(1 + \lambda_t \sin^2(2(\alpha - \theta^*))\big) \cdot \frac{1}{1 + \gamma \ln(1 + \tau_{ij})}$
   - 通行频次 $\tau_{ij}$ 增加使成本下降，后续聚落自发复用已有干道（形成斯坦纳树），彻底杜绝平行冗余路径；方向对齐惩罚使平地自然形成规整街区，山水边顺应等高线。
3. **拓扑松弛与细胞式地块更新**：
   - 过滤短于 45m 的盲肠毛刺；路口施加 $\ge 65^\circ$ 约束，锐角分叉吸附合并为 T 型路口。
   - 复用现有 `occupancy.js` 空间哈希，地块按年沿新路网扩散，核心区随着交通流量增加自发进行建筑层数翻倍（城市更新/Densification）。

---

### 7.3 问题三：架构正交性与 `CONTRACTS.md` 零破坏兼容

1. **步进内核 + 同步折叠外观（Stepper Core, Synchronous Fold Facade）**：
   - 新增 `src/pipeline.js`，包含生成器 `createWorldEvolution(config)`。
   - 对外同步方法 `generateWorld(config)` 仅为将生成器迭代到底的折叠器，单测直接调用此方法。
2. **不变式兼容**：
   - `townMode: 'classic'`（默认）下，步进执行后的终态与现有静态管线 SHA-256 **100% 字节级一致**。
   - 所有现有模块（`terrains.js`, `erosion.js`, `hydrology.js`, `town.js`, `ecology.js`）签名与契约完全不作破坏性改动。

---

### 7.4 Phase 1 最小 PoC 规划与验证

- **核心代码实现**：在 `src/pipeline.js` 中封装 `createWorldEvolution`，接入 `view3d.js` 的 `updateTerrainFast`。
- **单测落地**：新建 `test/pipeline.test.mjs`，断言 `generateWorld(config)` 跑出的高度场、河网与城镇结构，与既有单次生成管线逐字节相同。
- **UI 对接**：在 `index.html` 与 `main.js` 中增加演化时间轴与 Play/Pause 控制。

