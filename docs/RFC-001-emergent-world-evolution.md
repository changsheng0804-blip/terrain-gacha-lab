# RFC-001: Emergent World Evolution (从规则中自然涌现的世界演化系统)

> **状态**：Draft v0.3 — 已评审并经原型验证，待集成者裁决（见 §0 评审结论、§8 起的修订方案与任务卡）  
> **分支**：`rfc/emergent-world-evolution`  
> **核心哲学**：不以暴力数据堆砌资产，而是以因果律（Causality）为驱动，通过精简的规则链条让物理地质与人类聚落自底向上、连续演化地“长出来”。
> **相关**：[DECISIONS.md](DECISIONS.md) ADR-001 ~ ADR-003 · [CONTRACTS.md](CONTRACTS.md)「演化管线（计划）」· ROADMAP T09 / T15

---

## 0. 评审结论（v0.2，Hark，2026-10-22）

**方向认可，Phase 1 需要收窄。** 在 Mac mini M4 / Node 24 上对 5 种地形 × 512 × 6000 m 实测后，§7 附录里的几条关键判断成立，几条性能数字偏乐观 3~5 倍，还有三处与现有代码/任务板冲突。修订要点：

1. **成立（已实测）**：同一 RNG 闭包连续消费时，把 `erodeDroplets` 分 48 批跑与一次跑完 **SHA-256 逐位一致**（5/5 地形，Node 22 与 Node 24 均通过）。坚持 CPU + TypedArray、不用 GPGPU 的结论成立。
2. **偏乐观（已实测，见 §7.0 表）**：单批 ~4k 滴水 2.2~6.9 ms（中位数），最坏 27 ms，不是 1~2 ms；`priorityFlood` 30~61 ms、`buildHydrology` 82~106 ms，不是 12~18 ms；`generateTown` 257~346 ms 且是单一 RNG 流的整体函数，**无法按帧/按年步进**。
3. **架构改动**：从“每帧现算（compute-per-frame）”改为 **“后台先算 + 关键帧录制 + 前台回放（compute-ahead + keyframes + playback）”**。整条管线 512 本来就 < 1 s 算完，动画只是呈现层；生成器无法倒退，拖拽进度条必须靠关键帧（ADR-001）。
4. **Phase 1 = 回放，不是模拟**：城镇在 Phase 1 用“建造日志回放”（由已生成的城镇推导出的出现顺序）呈现，`town.js` 一行不改，`classic` 终态哈希自然不变。真正逐年涌现的聚落是 Phase 3 的 `townMode: 'evolve'`，独立 RNG 域、独立基线。
5. **冲突需先解决**：
   - `src/pipeline.js` 是 **T09** 的文件——本 RFC 的 Phase 1 吸收 T09，拆为 T09a/T09b（ADR-003）。
   - **T15**（分辨率无关侵蚀，`erodeField` 固定在 512 侵蚀网格上跑）尚在 review，会改变步进对象和非 512 分辨率的哈希——本 RFC 的实现任务排在 T15 合入之后。
   - Epoch 2 “先生态后聚落”与现状相反：`buildEcology(field, hydro, town)` 用城镇分区压低森林。拆为“自然生态（`town=null`）→ 聚落 → 最终生态”两次调用。
6. **Epoch 0 “板块构造”在代码中不存在**：现有地形是解析式“设计”（`design:<id>` RNG 流）。Phase 1 只做“抬升揭示”的呈现动画；真正的构造/抬升-侵蚀模拟列为远期研究，作为新地形类型，不替换现有 5 种地形。
7. **新增**：状态与帧的可变性规则、确定性规则（ADR-002）、Judge 扩展指标、16 张可领取任务卡与文件所有权/波次（§12~§13）。

8. **v0.3 已用可运行原型验证（§16）**：步进内核与现有管线 512 下 10/10 世界逐位一致；Mac Chrome 中关键帧回放稳定 60 fps（每帧更新 p95 4.5 ms，任意拖拽平均 ~3 ms）；欲望之径在 5 种地形上把路网缩短 13~28%、平行冗余下降 16~44%，结果与遍历顺序无关、耗时 0.23~0.77 s。同时证伪了两点：欲望之径**不能**“彻底杜绝平行冗余”（残余 19~32%，T27 拓扑松弛必不可少）；交叉场能改善顺应地形（偏差降低 10~22%），但对平行冗余时好时坏，权重需调。

> 阅读顺序建议：实现 agent 只需读 §0、§8~§13、§16 和自己的任务卡；§1~§7 保留为原始提案与评审批注。

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
[Epoch 0: 地壳板块与造山构造 (Tectonics)]   ← 【评审 v0.2】现状无此模拟，Phase 1 仅做“设计地形抬升揭示”动画，见 §8.1
      │
      ▼
[Epoch 1: 水文动力学与气候侵蚀 (Erosion & Hydrology)]
      │  - 降雨在山脉迎风坡富集
      │  - 水流按物理坡度切出沟壑、汇入湖泊
      ▼
[Epoch 2: 生态演替与先民拓荒 (Ecology & Genesis)]   ← 【评审 v0.2】此处只能算“自然生态”(town=null)，带城镇衰减的生态在 Epoch 3 之后再算
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

> 【评审 v0.2】此草图有四处需修正，修订后的契约见 §9：
> 1. 现有管线顺序是 `侵蚀 → thermal → smooth → carveValleyOutlet（会改写 height）→ buildHydrology → generateTown`，草图漏了 `thermal/smooth/carveValleyOutlet`，按草图实现将无法与现状逐位一致。
> 2. `yield { field }` 交出的是**活引用**，下一次 `next()` 会继续改写它；消费者必须拷贝（由 timeline 统一负责），契约要写明“帧内引用仅在下一次 next() 前有效”。
> 3. `evolveTownStep` 逐年推进与 `generateTown` 的单一 RNG 流不兼容；Phase 1 用建造日志回放，逐年模拟进 Phase 3 的 `evolve` 模式。
> 4. 生成器只能前进，不能支持拖拽回退；需要关键帧（ADR-001）。

### 3.2 欲望之径（Desire Paths）与有机路网生成

不再直接用全局辐射状射线强制铺路，而是模拟微观主体往返行为：
1. **拓荒源点与目的点**：城镇中心（商业/集市）与关键资源点（农田水源、码头、矿区、山口）。
2. **势能寻路**：Agent 根据当前地形坡度成本行走，留下“信息素/通达频次（Traffic Pheromone）”。
3. **阈值硬化**：通行频次越高的连线自然硬化为干道（Arterial），分支硬化为支路（Local），无人行走的路径自然消亡。

> 【评审 v0.2】缺少可实现的细节：OD 对如何确定性采样、更新是同步还是逐个 agent（逐个更新会产生“先来者偏置”且依赖遍历顺序）、信息素衰减率、硬化/消亡的滞回阈值、收敛判据和预算。补充见 §8.4。

### 3.3 物理扰动的“蝴蝶效应”响应

通过保留中间态场（Heightfield, Hydrology Field, Cost Field），实现交互式微调而不必重算整个世界：
- **微调降水**：局部提升降雨密度，直接在已有地貌上触发冲刷，甚至造成局部滑坡，迫使受灾地块的建筑被标记废弃或搬迁。
- **抬升海平面**：沿海低洼建筑被淹没，居民点向高地二次聚集。

> 【评审 v0.2】“不必重算整个世界”需要重新定义：水滴侵蚀是全局、顺序相关的过程，局部改降雨后只重跑局部会破坏可复现性。可行做法是**事件日志 + 检查点重放**：世界 = f(config, events)，事件绑定在确定的步号上，从最近检查点重放到终点（§8.5）。海平面目前写死在契约里（`seaMask` = `height <= 0`），抬升海平面是契约变更，需 ADR。滑坡、建筑废弃/搬迁依赖 `evolve` 城镇模式，排在 Phase 3 之后。

---

## 4. 前端交互与 3D 渲染适配

1. **时序播放器（Timeline Player Widget）**：
   - 增加播放/暂停、速度调节、拖拽进度条。
   - 观察相机可以在“全图鸟瞰”与“聚落特写”之间跟随演化阶段平滑过渡。
2. **3D 实例化平滑动画**：
   - 地形 Mesh 利用顶点着色器（Vertex Shader）或逐网格顶点位移，直观看到山峰被水滴刮落的动态效果。
   - 建筑与树木采用缩放动画（Scale from 0 to 1）在各自被规划的瞬间弹出生长。

> 【评审 v0.2】最省的做法：把 `InstancedMesh` 的实例按“出现时间”排序后写入，回放时只改 `mesh.count`（加上最近 N 个实例的缩放过渡），不需要重建几何。当前 `view3d.update()` 每次都 `disposeWorld()` 全量重建，回放期间必须走新的增量接口（T18）。

---

## 5. 分阶段实施规划（Milestones）

| 阶段 | 目标 | 核心改动 | 风险与对策 |
|---|---|---|---|
| **Phase 1: 异步步进与时间轴回放** | 把静态算法拆解为 Generator，实现 3D 视角下的全流程生长演示 | `src/pipeline.js` (Web Worker / Generator), `src/view3d.js` | 性能开销：避免每帧重新生成完整 Three.js Geometry，采用增量修改顶点或批量属性更新。 |
| **Phase 2: 响应式环境扰动** | 引入降水量、海平面、地质年龄的即时响应与局部重演化 | `src/terrains.js`, `src/erosion.js`, `src/hydrology.js` | 确定性被破坏：必须确保所有微步计算严格绑定初始 seed 与历史 action log。 |
| **Phase 3: 智能体与有机生长** | 引入欲望之径路网硬化、元胞扩散城镇生长 | `src/town.js`, 新增 `src/evolution.js` | 复杂度膨胀：保持纯数学模型，不引入庞大物理引擎或行为树，用势能场和扩散方程代替复杂逻辑。 |

> 【评审 v0.2】分期保留，但每期内容已重排：Phase 0（前置：T15 合入、金标快照、T09 拆分）→ Phase 1（只做回放，不改生成算法）→ Phase 2（事件日志 + 降雨/海平面）→ Phase 3（`evolve` 聚落）。任务卡见 §12。

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

### 7.0 【评审 v0.2】附录论断核验表

实测环境：Mac mini M4（10 核）/ Node v24.18.0；`seed=20261019, size=6000, res=512`；分批 = 48 批。沙箱 Node v22（2 核 ARM）上相对结论一致、绝对值约慢 1.8 倍。

| 地形 | 水滴数 | 一次跑完 | 每批中位 / 最坏 | 分批逐位一致 | thermal | priorityFlood | buildHydrology | generateTown | buildEcology |
|---|---|---|---|---|---|---|---|---|---|
| river | 209,715 | 337 ms | 6.9 / 27.4 ms | ✅ | 23 ms | 43 ms | 91 ms | 346 ms | 36 ms |
| slope | 170,393 | 211 ms | 4.5 / 4.8 ms | ✅ | 18 ms | 30 ms | 106 ms | 257 ms | 28 ms |
| onsen | 196,608 | 327 ms | 6.8 / 21.2 ms | ✅ | 18 ms | 38 ms | 87 ms | 305 ms | 42 ms |
| fjord | 188,743 | 293 ms | 6.3 / 6.8 ms | ✅ | 18 ms | 61 ms | 83 ms | 318 ms | 31 ms |
| caldera | 183,500 | 106 ms | 2.2 / 2.8 ms | ✅ | 16 ms | 44 ms | 82 ms | 326 ms | 28 ms |

| 附录论断 | 结论 | 说明 |
|---|---|---|
| CPU/Worker + TypedArray 优于 GPGPU | ✅ 成立 | 确定性与 Node 单测都依赖 CPU 路径。 |
| “跨平台 Bit-exact” | ⚠️ 需限定 | `erodeDroplets` 用 `Math.hypot`，地形/噪声用 `Math.sin/exp` 等；ECMAScript 不规定这些函数的逐位结果。V8（Chrome/Node）内部一致，Safari(JSC)/Firefox 不保证。契约应写“同一 JS 引擎内确定”（ADR-002）。 |
| 分批侵蚀与单次逐位一致 | ✅ 成立 | 实测 5/5。且**任意**切分都一致，所以驱动器可以按时间片切批，不必固定批大小。 |
| 不能在微步之间插 thermal/smooth | ✅ 成立 | 另需保留 `carveValleyOutlet` 在侵蚀后、水文前执行。 |
| 单批 4000~8000 滴 1~2 ms | ❌ 偏乐观 | 实测 ~4k 滴 2.2~6.9 ms，最坏 27 ms。帧内必须按时间预算（≤ 6 ms）切批，或放进 Worker。 |
| priorityFlood 12~18 ms | ❌ 偏乐观 | 实测 30~61 ms；整个 `buildHydrology` 82~106 ms。 |
| 侵蚀期每 6~8 步做“轻量”汇流预览 | ❌ 不轻量 | 汇流需先填洼，单次就 ~40 ms+。改为 128 网格未填洼 D8 预览或干脆不预览（T21）。 |
| 双缓冲 / Transferable 零拷贝 | ✅ 可行 | 但 transfer 会让发送方 buffer 失效，必须乒乓归还；本 RFC 改用关键帧录制后，主线程只收快照。 |
| 解析法线公式 | ⚠️ 需修正 | 3D 网格按 `step = ceil(n/512)` 降采样，Δ 应为 `step*cell`；颜色依赖 hydro/ecology，侵蚀期间只能用高度着色或沿用上一次。 |
| `classic` 模式终态 SHA-256 100% 一致 | ✅ 可达成，但需金标 | 现有 `npm test` 只校验**侵蚀前**高度场哈希；端到端确定性在 judge 里且不在 `npm test` 中。需先录制金标快照（T16）。 |
| 逐年 `evolveTownStep` 与 classic 一致 | ❌ 不可能 | `generateTown` 是单一 `town:<id>` RNG 流贯穿分区→道路→铁路→地块→建筑，任何拆分都会改变消费顺序。 |
| 4-RoSy 用“倍角向量 cos(4θ)” | ✅ 公式正确 | 措辞应为“四倍角”。需补奇点处理与权重定义（§8.4）。 |

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


---

# 第二部分：修订方案（v0.2）

## 8. 修订后的架构

### 8.1 三层分离：计算 / 录制 / 回放

```text
┌────────────── Worker（或主线程回退） ──────────────┐
│ createWorldEvolution(config)  —— 步进内核（生成器） │
│   design → erosion(微步) → thermal → smooth        │
│   → outlet → hydrology → ecology(自然)             │
│   → town(classic 一次算完 | evolve 逐年)           │
│   → ecology(最终)                                  │
│        │ 每步 next()；驱动器按时间片批量调用        │
│        ▼                                           │
│ TimelineRecorder —— 拷贝/量化关键帧 + 事件流        │
└────────┬───────────────────────────────────────────┘
         │ postMessage（关键帧、事件、进度）
         ▼
┌────────────── 主线程 ──────────────┐
│ Timeline（关键帧索引，按 t 查帧）   │
│ Player（播放/暂停/速度/拖拽）       │
│ view3d 增量接口（T18）              │
│   setHeights / setRevealTime        │
└────────────────────────────────────┘
```

- **计算与呈现解耦**：512 整条管线 < 1 s，后台尽快算完；动画速度由 Player 决定，与计算耗时无关。用户拖拽到任意时刻 = 查最近的关键帧 + 插值。
- **Epoch 0（抬升揭示）**：不模拟板块。呈现为 `h(t) = target · s(t)`（`s` 为 smoothstep，海面以下部分先出现），纯呈现层，不进入任何哈希。
- **Epoch 1（侵蚀）**：步进内核把水滴按微批（默认 1024 滴）推进；驱动器每帧最多花 6 ms（Worker 中可不限），每 `keyframeEvery` 滴录一帧高度场。T15 合入后，步进对象是 512 侵蚀网格 `H`，非 512 输出分辨率在侵蚀结束后统一重采样；回放期间直接显示 512 侵蚀网格。
- **Epoch 2（水文 + 自然生态）**：一次算完，各录一帧。自然生态 = `buildEcology(field, hydro, null)`。
- **Epoch 3（聚落）**：
  - `classic`（默认，Phase 1）：`generateTown` 一次算完，再由 `town-replay.js` 推导**建造日志**（中心 → 干道 → 铁路/车站 → 支路 → 地块 → 建筑，组内按到中心距离/道路序排序），回放时逐条出现。
  - `evolve`（Phase 3）：逐年模拟，每年产出增量事件。
- **最终生态**：`buildEcology(field, hydro, town)`，与现状一致。

### 8.2 关键帧与内存预算

| 项 | 512 | 1024 |
|---|---|---|
| Float32 高度场 | 1.0 MB | 4.0 MB |
| Int16 量化（0.1 m，±3276.7 m） | 0.5 MB | 2.0 MB |
| 默认关键帧数（侵蚀期） | 32 | 16 |
| 关键帧总内存上限 | ≤ 48 MB | ≤ 48 MB |

- 回放关键帧一律 Int16 量化（地形最高约 2 km，0.1 m 精度足够呈现），**非规范数据**，不参与哈希。
- 规范检查点（Phase 2 重放用）保留 Float32，只在固定步号处存，数量另计（默认 4 个）。

### 8.3 城镇回放（Phase 1，零算法改动）

`buildTownReplay(town) -> { events: [{ t, kind, ref }], duration }`，其中 `kind ∈ center|arterial|rail|station|street|parcel|building`，`ref` 指向 `town` 中数组下标。规则：

1. 同类按“到中心距离”升序，道路按路径起点距离；同距离按下标稳定排序。
2. 道路回放可按路径长度比例“画出来”（Player 截取 polyline 前缀）。
3. 建筑/树木的 `InstancedMesh` 按事件时间排序写入，回放只改 `count`。
4. 只读 `town`，纯函数，Node 可测。

### 8.4 Phase 3：涌现路网的可实现规格

**网格与图**：在 `cell_g = 20 m` 的粗网格上建 16 邻域图（含骑士步，减少 45° 锯齿）。边成本：

```
C(i→j) = d_ij · (1 + k_s · max(0, slope_ij − s0)²)
            · (1 + λ_t · sin²(2(α_ij − θ*(i))) · w_field(i))
            · 1 / (1 + γ · ln(1 + τ_ij))
       + ∞  若 j 为水面（除非为指定桥位）或坡度 > s_max
```

- `θ*`：4-RoSy 交叉场主方向。`[c, s] = Σ_k w_k [cos 4θ_k, sin 4θ_k]`，`θ* = atan2(s, c) / 4`。三项来源：岸线切向（权重随 `dWater` 衰减）、等高线切向（权重随坡度增大）、中心径向/切向（权重随到中心距离衰减）。`|[c,s]|` 小于阈值处是奇点/无主方向区，令 `w_field = 0`（不施加方向约束），避免奇点附近路网扭曲。
- `τ`：通行量（信息素），存于边或格。

**确定性同步更新（每“年”）**（v0.3 按原型结果修订）：

1. 出行用**重力式流量**表示（每对 OD 带权重，单位“次/年”），而不是逐个采样 agent：住宅→所属聚落 1，聚落→中心 6，聚落→最近 2 个聚落 3（原型值）。新聚落/住宅的位置由 `rngFor(seed, 'evolve:sites:<id>')` 等新域决定。
2. **按目的地跑 Dijkstra**（冻结本年成本，所有出发点都出队即提前终止，tie-break：距离 → 格索引），比“每个 OD 跑一次 A*”少一个数量级的计算。
3. 全部路径回溯完后一次性沉积：`τ ← (1 − ρ) τ + Σ w·path`，默认 **`ρ = 0.25`**。16 邻域的骑士步要把经过的中间格一并沉积，否则路网是断续虚线。
4. **阈值以稳态流量表示**：某格每年承载 `f` 次出行时 `τ → f/ρ`。所以 `T_up = 2/ρ`（≥ 2 次/年才成路）、`T_art = 12/ρ`；消亡阈值 `0.4·T_up`。原型证实：用与 ρ 无关的绝对阈值会让每条单次小径最终都硬化，“收敛”是假象。
5. 收敛：`Σ τ` 与本年沉积量的稳态偏差 < 2%，且硬化长度年变化 < 1%，连续 2 年。所需年数约 `ln(50)/ρ`，`ρ = 0.25` 时约 15 年。

**拓扑松弛（road-graph）**（原型证实为**必需**，不是可选）：路径并集 → 中心线 → Douglas-Peucker 简化（容差 6 m）→ 平行近邻合并（间距 < 25 m 且夹角 < 15°）→ 盲肠修剪（< 45 m）→ 锐角路口（< 65°）吸附为 T 型 → 输出符合现有 `roads` 字段语义的 polyline（`pts`、`width`、`cls`）。

**地块与加密**：沿已硬化道路用现有 `occupancy.js` 放地块；每年按道路通行量给邻近地块升级层数（`floors = f(τ_local)`，上限按分区）。

**参考**：Helbing 等 *Active Walker Model*（1997，人行踩路）；Chen 等 *Interactive Procedural Street Modeling*（SIGGRAPH 2008，张量场街道）。只借鉴思想，不复制代码。

### 8.5 Phase 2：事件日志与重放

```js
config.events = [
  { atStage: 'erosion', atDroplet: 120000, type: 'rainfall', params: { map: 'orographic', windDeg: 240, gain: 1.6 } },
  { atStage: 'town',    atYear: 25,       type: 'seaLevel', params: { delta: 4 } },  // 需 ADR，见下
];
```

- 世界 = `f(config, events)`。修改事件后，从**事件之前最近的规范检查点**重放到终点；检查点之后的帧全部作废。
- 降雨：给 `erodeDroplets` 增加可选参数 `spawnWeights`（Float32Array，按权重做别名表采样）；缺省 `null` 时完全走旧路径，`classic` 哈希不变。地形性降雨图 = 迎风坡抬升分量 `max(0, ∇h · wind)` 平滑后归一化。
- 海平面：`seaMask` 现为 `height <= 0`，写在契约里。改为 `height <= seaLevel` 是契约变更，需 ADR，且影响 hydrology/ecology/town/render 四处，排在最后。

## 9. 契约草案（新增，不破坏旧契约）

完整文本已写入 `CONTRACTS.md`「演化管线（计划）」。要点：

```js
// src/pipeline.js（T09a）
export function* createWorldEvolution(config, opts = {}) -> Iterator<Frame>
export function generateWorld(config) -> { field, hydro, town, ecology, droplets, timings }

config = { type, seed, size, res, erosion = true, townMode = 'classic', events = [] }
opts   = { dropletBatch = 1024 }

Frame = {
  stage,          // 'design' | 'erosion' | 'thermal' | 'smooth' | 'outlet' | 'hydrology'
                  // | 'ecology-natural' | 'town' | 'ecology' | 'done'
  progress,       // 0..1，整条管线
  step, steps,    // 本阶段内
  droplets,       // 已模拟水滴数
  height,         // Float32Array 活引用：仅在下一次 next() 前有效；消费者必须拷贝
  grid,           // height 所在网格边长（侵蚀期为侵蚀网格，之后为输出网格）
  hydro, ecologyNatural, town, ecology,  // 算出后出现，之后只读
}
```

- `generateWorld` = 把生成器迭代到底；与现 `src/main.js` 路径（T15 合入后）结果逐位一致，以金标快照（T16）为准。
- Worker 消息在现有 `progress/done/error` 之外追加：`{ type: 'keyframe', stage, t, grid, height(Int16Array, transfer) }`、`{ type: 'events', events }`。

## 10. 确定性规则（ADR-002 摘要）

1. **规范输出**只有：终态（`generateWorld` 结果）与固定步号的检查点。中间帧、回放关键帧、呈现动画都是非规范的，不进哈希。
2. 新随机流一律新域名：`evolve:od:<year>`、`evolve:growth:<year>`、`climate:rain` 等；**禁止**消费 `town:<id>`、`erosion:<id>` 已有流。
3. 智能体/元胞更新一律同步（读上一状态、写新状态）；所有遍历用索引升序，排序必须稳定且有确定 tie-break；不依赖 `Map`/`Set` 的插入顺序承载浮点键。
4. 规范数据的浮点归约顺序固定，禁止跨 Worker 并行归约。
5. 确定性范围是“同一 JS 引擎”。是否把 `Math.hypot` 换成 `Math.sqrt(x*x + y*y)` 以扩大到跨引擎，属于会改变所有哈希的变更，单独 ADR，不在本 RFC 内做。

## 11. 评估（Judge 扩展，T29）

`classic` 模式：现有 gate/target 不变，另加金标哈希 gate（T16）。

`evolve` 模式（新 target，首次跑出后记基线）：

| 指标 | 含义 | 期望方向 |
|---|---|---|
| `road_detour` | OD 对路网距离 / 直线距离的中位数 | ↓（目标 < 1.35） |
| `road_acute_pct` | 夹角 < 65° 的路口占比 | ↓（目标 < 5%） |
| `road_parallel_pct` | 间距 < 25 m 且夹角 < 15° 的平行冗余路段长度占比 | ↓（目标 < 3%） |
| `road_spur_pct` | 非边缘、< 45 m 的盲肠占比 | ↓ |
| `field_align` | 道路方向与 θ* 的平均偏差（四重对称） | ↓ |
| `growth_monotone` | 无事件时已建地块数逐年不减 | gate |
| `evolve_converge_years` | 收敛所需年数 | ↓，≤ `maxYears` |
| `evolve_time_ms` | 512 下 evolve 总耗时 | ≤ 1500 ms（M4） |
| 现有建筑/道路 target | 压路、重叠、压铁路、坏址、落河、连通性 | 不劣于 classic 基线 |

回放（Phase 1）验收：`visual-check.mjs` 增加 `--timeline` 模式，截 0%/25%/50%/75%/100% 五帧；100% 帧与非回放模式截图像素差 < 0.5%；回放期间 3D 平均帧时间 < 16.7 ms（M4 Chrome），无 console error。

## 12. 任务卡

> ID 从 T16 起（T15 已被“度量单位/分辨率无关侵蚀”占用，在 review）。每张卡自包含；领取方式与报告格式见 AGENTS.md §7。所有卡：`npm test` 全绿；不改卡外文件；不 push/merge。

### T16 — 金标快照（classic 终态哈希）
- **文件**：新 `test/golden.mjs`、新 `test/golden.json`、`package.json`（仅 `scripts.test` 追加一项）。
- **依赖**：T15 合入（金标在 T15 之后录制）。**风险**：低。**模型**：快速/低成本。
- **内容**：5 地形 × seed {123456, 20261019} × res {256, 512}，用现有 `test/judge/world.mjs` 跑完整管线，记录：侵蚀后高度、`filled`、`acc`、`riverMask`、`lakeMask`、城镇 JSON（roads/railway/parcels/buildings，数值保留 3 位）的 SHA-256 前 16 位，以及 `buildEcology(..., town)` 的 `biome` 哈希。`--update` 才允许重写 json。
- **验收**：两次运行一致；故意改一个常数时测试失败。

### T09a — 步进内核 + 折叠外观（吸收原 T09 的生成部分）
- **文件**：新 `src/pipeline.js`、新 `test/pipeline.test.mjs`、`test/judge/world.mjs`（改为 re-export `generateWorld`）、`test/judge.mjs`（如需改 import）。
- **依赖**：T15、T16。**风险**：高（实现者 ≠ 审查者）。**模型**：强推理。
- **内容**：按 §9 实现 `createWorldEvolution` 与 `generateWorld`；`townMode` 只实现 `'classic'`，其他值抛错；`events` 非空抛错（Phase 2 再开）。不碰 DOM。
- **验收**：`generateWorld` 与 T16 金标逐位一致；`dropletBatch ∈ {1, 997, 1024, 全量}` 终态一致；帧序列 `progress` 单调；judge `--quick` 无回退。

### T09b — Worker 驱动 + 主线程接入（原 T09 的 Worker 部分）
- **文件**：新 `src/generate.worker.js`、`src/main.js`。
- **依赖**：T09a。main/index 串行链：T02 → **T09b** → T20 → T10 → T11。**风险**：高。
- **内容**：Worker 内迭代生成器，按 §9 发 `progress/keyframe/done/error`；主线程优先 Worker，失败回退主线程（同样迭代生成器，每帧 ≤ 6 ms）；重新生成时取消在途任务（generation id）。本卡不做时间轴 UI，只把结果交给现有渲染。
- **验收**：1024 生成时页面可交互；回退路径可用（禁用 Worker 测）；与金标一致；无 console error。

### T17 — 关键帧录制与时间轴数据
- **文件**：新 `src/timeline.js`、新 `test/timeline.test.mjs`。
- **依赖**：§9 契约冻结即可开工（可用假生成器测试），不依赖 T09a 代码。**风险**：中。
- **内容**：`createRecorder({ budgetBytes, keyframeEvery })` 消费 Frame，拷贝并 Int16 量化高度；`createTimeline(recording)` 提供 `frameAt(t) -> { stage, heightA, heightB, mix, revealT }`；关键帧数受内存上限约束、自动降采样。
- **验收**：量化误差 ≤ 0.05 m；内存不超预算；`frameAt` 在边界处连续；纯函数 Node 可测。

### T18 — view3d 增量更新接口
- **文件**：`src/view3d.js`。view3d 串行链调整为：T03 → **T18** → T05 → T07（T05 目前被 T04 阻塞，T18 可先插入）。**风险**：高（多模态 QA）。
- **内容**：新增 `view.setHeights(height, grid)`（复用 position/normal/color 属性，`DynamicDrawUsage`，解析法线 Δ = `step*cell`，颜色用高度 + 水面阈值简化着色）；`view.setRevealTime(t, replay)`（实例按出现时间排序后只改 `count`，最近 N 个做缩放过渡；道路/铁路按 polyline 前缀显示）；`view.update()` 旧行为不变。
- **验收**：512 下 `setHeights` ≤ 4 ms（M4 Chrome）；100% 回放与 `update()` 截图像素差 < 0.5%；`debug()` 计数追加回放字段。

### T19 — 城镇建造日志（classic 回放）
- **文件**：新 `src/town-replay.js`、新 `test/town-replay.test.mjs`。
- **依赖**：无（只读现有 Town 契约）。**风险**：低。
- **内容**：按 §8.3 实现 `buildTownReplay(town)`。
- **验收**：事件覆盖每条道路/地块/建筑恰好一次；时间单调；确定；不修改输入。

### T20 — 时间轴播放器 UI
- **文件**：`src/main.js`、`index.html`、`styles.css`。
- **依赖**：T09b、T17、T18、T19。**风险**：中。
- **内容**：播放/暂停、0.5×/1×/2×/4×、拖拽进度条、阶段标签；生成完成后默认自动播放一次（可在设置里关闭，存 URL hash 时与 T10 协调字段名）；相机在侵蚀期全图、聚落期向中心缓推。
- **验收**：visual-check `--timeline` 五帧截图；回放平均帧时间 < 16.7 ms；拖拽任意位置 < 50 ms 响应；无 console error。

### T21 — 侵蚀期河道预览（可选）
- **文件**：新 `src/hydro-preview.js`、新测试。
- **依赖**：无。**风险**：低。
- **内容**：128 网格未填洼 D8 汇流（坑点就地终止），≤ 5 ms（M4）；仅用于回放着色，非规范。
- **验收**：耗时达标；与终态 `riverMask` 的 IoU 报告（只记录，不设门槛）。

### T22 — 事件日志与检查点重放（Phase 2）
- **文件**：`src/pipeline.js`（T09a 之后的同一写者链）、`test/pipeline.test.mjs`、ADR。
- **依赖**：T09a。**风险**：高。
- **内容**：§8.5 的 `events` 语义与规范检查点；修改事件后从最近检查点重放。
- **验收**：空事件 = 金标；同事件两次 = 同哈希；检查点重放 = 从头重放（逐位）。

### T23 — 地形性降雨与加权落点（Phase 2）
- **文件**：新 `src/climate.js`、`src/erosion.js`（仅追加可选参数 `spawnWeights`）、测试。
- **依赖**：T15（erosion.js 写者链：T15 → T23）。**风险**：中。
- **验收**：`spawnWeights = null` 时金标不变；开启时迎风坡侵蚀量显著高于背风坡（judge 新增 `rain_windward_ratio` target）。

### T24 — 可变海平面（Phase 2，需 ADR）
- **文件**：`src/hydrology.js`、`docs/CONTRACTS.md`、ADR；下游 render/view3d/town 的适配另拆卡。
- **依赖**：T22。**风险**：高。暂缓，等 Phase 3 有搬迁语义后再排。

### T25 — 4-RoSy 交叉场
- **文件**：新 `src/cross-field.js`、新测试。
- **依赖**：无。**风险**：中。**模型**：强推理。
- **内容**：§8.4 的 `θ*(x, z)` 与置信度场，粗网格（20 m）输出 `Float32Array angle, strength`；只读 field/hydro。
- **验收**：直线海岸处 θ* 与岸线夹角 < 5°；四重对称下无 π/2 跳变；奇点处 strength < 阈值；确定。

### T26 — 欲望之径通行模拟
- **文件**：新 `src/desire-paths.js`、新测试。
- **依赖**：无（成本函数以回调注入 θ*，可与 T25 并行）。**风险**：高。
- **内容**：§8.4 同步更新、衰减、滞回、收敛判据；输出每年 `{ tau, hardened, stats }`。
- **验收**：合成地形（平地 + 一条河 + 一座山）上路径避开陡坡与水面；5 种地形上平行冗余较“纯最短路”基线下降 ≥ 15%、路网总长下降 ≥ 10%、绕行指数不升高超过 3%；遍历顺序打乱后逐位一致；512 地图到收敛 ≤ 1000 ms（M4）。起点可直接用 `poc/desire-paths.mjs`。

### T27 — 路网图提取与拓扑松弛
- **文件**：新 `src/road-graph.js`、新测试。
- **依赖**：无（输入为格点路径集合）。**风险**：中。
- **内容**：§8.4 的简化、合并、修剪、T 型吸附；输出符合现有 `roads` 字段语义。
- **验收**：构造用例覆盖 4 种松弛规则；输出满足 judge 的 `road_acute_pct`、`road_parallel_pct`、`road_spur_pct` 门槛。

### T28 — `evolve` 聚落集成
- **文件**：新 `src/settlement-evolve.js`、`src/pipeline.js`（`townMode: 'evolve'` 分支；pipeline 写者链 T09a → T22 → T28）。
- **依赖**：T09a、T25、T26、T27。**风险**：高。
- **内容**：拓荒点（复用 `town.js` 中心选址逻辑的结果作为输入，不改 town.js）→ 逐年通行模拟 → 硬化 → 地块/建筑生长与加密；输出满足 Town 契约，追加 `history: [{ year, events }]`。
- **验收**：§11 evolve 指标首次基线；现有建筑/道路 target 不劣于 classic；确定。

### T29 — Judge 扩展（evolve 指标 + 金标 gate）
- **文件**：`test/judge.mjs`、`test/judge/metrics.mjs`、`docs/judge.md`。
- **依赖**：T16（金标 gate）；evolve 指标在 T28 可用时启用。**风险**：低。
- **验收**：§11 指标全部可计算；`--update-baseline` 分模式记录。

### E1 — 探索：路网涌现方案比较（不写生产文件）
- **产出**：`docs/` 外的临时目录中的原型与一页结论，结论写回本 RFC §8.4 的默认参数。
- **内容**：在 3 种地形上比较“仅交叉场流线”“仅欲望之径”“混合”三种方案的 §11 指标与耗时，给出 `λ_t, γ, ρ, T_up, T_art, N_od` 默认值。
- **依赖**：无，可立即开始。

## 13. 波次与文件所有权

| 波次 | 任务（可并行） | 前置 |
|---|---|---|
| A（现在） | T15 审查合入（集成者）、E1、T19、T25、T26、T27、T21 | — |
| B | T16、T17 | T15 合入（T16）；§9 冻结（T17） |
| C | T09a、T18 | T16（T09a）；view3d 无在途写者（T18） |
| D | T09b、T28、T29 | T09a；T25–T27（T28） |
| E | T20、T22 | T09b+T17+T18+T19（T20）；T09a（T22） |
| F | T23、T24 | T15（T23）；T22（T24） |

单写者链（同一文件同一时间只有一个写者）：

- `src/pipeline.js`：T09a → T22 → T28
- `src/main.js` / `index.html` / `styles.css`：T02（已完成）→ T09b → T20 → T10 → T11
- `src/view3d.js`：T03（已完成）→ T18 → T05 → T07
- `src/erosion.js`：T15 → T23
- `src/hydrology.js`：T24（及其后）
- `src/town.js`：T04（阻塞中）独占；本 RFC 所有任务**都不改** `town.js`
- `test/judge*`：T16 只新增 `test/golden*`；T29 独占 judge 文件
- `docs/CONTRACTS.md`、`docs/ROADMAP.md`、`docs/DECISIONS.md`：仅集成者

建议追加到 ROADMAP 任务总表的行（由集成者粘贴）：

```text
| T16 | 金标快照（classic 终态哈希） | 新 `test/golden*`、`package.json` | T15 | B | P0 | 待领取 | — |
| T09a | 步进内核 + generateWorld 折叠 | 新 `src/pipeline.js`、新 `test/pipeline.test.mjs`、`test/judge/world.mjs` | T15、T16 | C | P0 | 待领取 | — |
| T09b | Worker 驱动 + 主线程接入 | 新 `src/generate.worker.js`、`src/main.js` | T09a | D | P1 | 待领取 | — |
| T17 | 关键帧录制与时间轴数据 | 新 `src/timeline.js`、新测试 | §9 契约 | B | P1 | 待领取 | — |
| T18 | view3d 增量更新/回放接口 | `src/view3d.js` | T03 | C | P1 | 待领取 | — |
| T19 | 城镇建造日志（classic 回放） | 新 `src/town-replay.js`、新测试 | 无 | A | P1 | 待领取 | — |
| T20 | 时间轴播放器 UI | `src/main.js`、`index.html`、`styles.css` | T09b、T17、T18、T19 | E | P1 | 待领取 | — |
| T21 | 侵蚀期河道预览（可选） | 新 `src/hydro-preview.js` | 无 | A | P3 | 待领取 | — |
| T22 | 事件日志与检查点重放 | `src/pipeline.js` | T09a | E | P2 | 待领取 | — |
| T23 | 地形性降雨与加权落点 | 新 `src/climate.js`、`src/erosion.js` | T15 | F | P2 | 待领取 | — |
| T24 | 可变海平面（需 ADR） | `src/hydrology.js` | T22 | F | P3 | 暂缓 | — |
| T25 | 4-RoSy 交叉场 | 新 `src/cross-field.js` | 无 | A | P1 | 待领取 | — |
| T26 | 欲望之径通行模拟 | 新 `src/desire-paths.js` | 无 | A | P1 | 待领取 | — |
| T27 | 路网图提取与拓扑松弛 | 新 `src/road-graph.js` | 无 | A | P1 | 待领取 | — |
| T28 | evolve 聚落集成 | 新 `src/settlement-evolve.js`、`src/pipeline.js` | T09a、T25–T27 | D | P1 | 待领取 | — |
| T29 | Judge 扩展（evolve 指标 + 金标 gate） | `test/judge*`、`docs/judge.md` | T16 | D | P1 | 待领取 | — |
```

原 T09 行改为“已拆分为 T09a/T09b（RFC-001）”。

## 14. 开放问题（需集成者裁决）

1. **Phase 1 是否接受“回放而非模拟”**？本评审强烈建议接受：零算法风险、金标不变、两周内可见效果；真正的涌现放到 Phase 3。
2. **evolve 是否最终取代 classic 成为默认**？建议在 evolve 的 §11 指标全面不劣于 classic 后再议，届时需要新的金标与 ADR。
3. **跨引擎确定性**（Safari/Firefox 与 Chrome 同 seed 同图）是否是产品要求？是的话需单独 ADR 替换 `Math.hypot` 等，并接受一次全量哈希变更。
4. **1024 分辨率是否支持回放**？关键帧内存按 16 帧计可行，但 3D 网格本身被降到 512，建议回放统一在 512 侵蚀网格上进行。
5. **“板块构造”是否作为新地形类型立项**？建议作为 E2 探索（stream-power 抬升-侵蚀），不进入当前路线图。

## 15. 变更记录

- v0.1（2026-10-22）：初稿 + Gemini 附录。
- v0.2（2026-10-22，Hark）：实测核验附录论断（§7.0）；架构改为 compute-ahead + keyframes + playback；Phase 1 收窄为回放；补齐契约（§9）、确定性规则（§10）、评估（§11）、任务卡与波次（§12~§13）；与 T09/T15/T04 的冲突处理。配套 `DECISIONS.md` ADR-001~003 与 `CONTRACTS.md` 计划条目。

## 16. 原型验证（v0.3，2026-10-22）

分支 `review/RFC-001` 上的原型（基于 main，尚未 rebase T15）：

| 文件 | 作用 | 对应任务卡 |
|---|---|---|
| `src/pipeline.js` | `createWorldEvolution` + `generateWorld` | T09a 的起点 |
| `src/timeline.js` | Int16 关键帧录制与查帧 | T17 的起点 |
| `src/town-replay.js` | classic 城镇建造日志 | T19 的起点 |
| `test/pipeline.test.mjs` | 逐位一致、帧序、回放覆盖、量化误差 | T09a/T17/T19 测试起点 |
| `poc/timeline.html` + `poc/worker.js` | Worker 计算 + 原地更新地形 + 实例 `count` 回放 | T18/T20 的参考实现 |
| `poc/run.mjs` | Chrome CDP 驱动：播放、拖拽、截图、统计 | visual-check `--timeline` 参考 |
| `poc/desire-paths.mjs` | 欲望之径 E1 简化版（三方案对比） | T25/T26/E1 起点 |

`poc/` 是原型，不进生产；`src/` 下三个文件可作为对应任务卡的初稿，由领取者按 T15 rebase 并补齐。

### 16.1 Phase 1：步进 + 回放（结论：可行，按 ADR-001 推进）

- **逐位一致**：`RES=512 node test/pipeline.test.mjs`，5 地形 × 2 seed，`generateWorld`（批 1024 与 997）与 `test/judge/world.mjs`（= 现 main.js 顺序）的高度、`filled`、`acc`、`riverMask`、`lakeMask`、城镇 JSON 哈希**全部一致**；256 同样通过。帧序固定，`progress` 单调，量化误差 0.05 m。
- **浏览器实测**（Mac mini M4，Chrome 无头，`node poc/run.mjs`，512，10 s 回放）：

| 地形 | Worker 计算 | 关键帧 | 每帧更新 均值 / p95（地形期） | 帧间隔 均值 / p95 | 拖拽 均值 / 最坏 |
|---|---|---|---|---|---|
| river | 975 ms | 39 帧 / 19.5 MB | 2.7 / 4.5 ms | 16.67 / 16.8 ms | 4.1 / 36.6 ms |
| slope | 698 ms | 32 / 16.0 MB | 3.0 / 4.4 ms | 16.67 / 16.8 ms | 3.4 / 29.6 ms |
| onsen | 879 ms | 36 / 18.0 MB | 3.2 / 4.6 ms | 16.67 / 16.8 ms | 2.9 / 15.7 ms |
| fjord | 881 ms | 35 / 17.5 MB | 2.7 / 4.5 ms | 16.67 / 16.7 ms | 2.9 / 12.2 ms |
| caldera | 726 ms | 34 / 17.0 MB | 3.2 / 4.6 ms | 16.69 / 16.8 ms | 2.9 / 12.5 ms |

  城镇期每帧更新 ≈ 0.03 ms（只改 `InstancedMesh.count` 与 `drawRange`）。0 个 console error。原型未开阴影；T18 需在开阴影的正式 view3d 上复测。
- 拖拽最坏 12~37 ms 出现在首次跨阶段（颜色切换到含水文着色时的全量写入），仍在 T20 的 50 ms 门槛内。

### 16.2 Phase 3：欲望之径（结论：主杠杆有效，但必须配拓扑松弛）

`node poc/desire-paths.mjs --res=512`（M4，粗网格 30 m = 201²，10 个聚落、149 组带权出行，ρ = 0.25）：

| 地形 | 路网 km A → B | 平行冗余 A → B → C | 干道 km A → B | 与地形主方向偏差 A → B → C | 绕行指数 A / B / C | 耗时 B / C |
|---|---|---|---|---|---|---|
| river | 21.8 → 15.6 | 37% → 21% → 32% | 1.2 → 2.1 | 0.60 → 0.61 → 0.50 | 1.02 / 1.02 / 1.04 | 506 / 645 ms |
| slope | 19.2 → 16.4 | 33% → 19% → 20% | 0.7 → 2.4 | 0.63 → 0.61 → 0.48 | 1.03 / 1.03 / 1.08 | 232 / 280 ms |
| onsen | 24.6 → 21.5 | 32% → 27% → 26% | 1.5 → 3.0 | 0.64 → 0.63 → 0.53 | 1.16 / 1.16 / 1.17 | 484 / 563 ms |
| fjord | 21.2 → 16.5 | 36% → 27% → 19% | 1.2 → 2.0 | 0.60 → 0.60 → 0.47 | 1.03 / 1.03 / 1.07 | 426 / 536 ms |
| caldera | 26.1 → 20.3 | 40% → 32% → 36% | 3.8 → 5.1 | 0.57 → 0.58 → 0.52 | 1.12 / 1.11 / 1.11 | 600 / 770 ms |

A = 纯最短路（γ = 0），B = 欲望之径（γ = 1.5），C = 欲望之径 + 交叉场（λ = 1.2）。全部 15 组：打乱出行顺序后 τ 场哈希一致；均在第 15 年收敛；无断连。

结论：
1. **欲望之径是有效的主杠杆**：路网缩短 13~28%，平行冗余相对下降 16~44%，干道自然出现，绕行不变。
2. **证伪“彻底杜绝平行冗余”**：残余 19~32%（指标偏粗，但肉眼可见双线）。T27 拓扑松弛是必需项，T26 验收改为相对基线的改进幅度。
3. **交叉场作用是“顺应地形”而非“去冗余”**：主方向偏差降低 10~22%（火山口路网沿环形山脊走），但在 river/caldera 上会重新引入并行支线、绕行 +0~5%。默认 λ 建议先取 0.6，由 E1 在三种组合上用 judge 指标调参。
4. **预算可达**：按目的地 Dijkstra + 提前终止 + 收敛即停，512 全流程 0.23~0.77 s（M4），满足 ≤ 1 s。最初“每 OD 一次 A*、固定 30 年”的写法在沙箱上要 6~9 s。
5. **阈值必须用稳态流量单位**（§8.4 第 4 条），否则收敛判据失效。

### 16.3 对 PR #1 的落地建议（按顺序）

1. 接受 ADR-001 / 002 / 003（提议状态 → 由集成者改为接受）。
2. 合入 T15 后，把 `src/pipeline.js`、`src/timeline.js`、`src/town-replay.js` 和 `test/pipeline.test.mjs` 作为 T09a / T17 / T19 的初稿领取；同时录制 T16 金标。
3. 并行开工：T25 / T26 / T27 / E1（全是新文件），以 `poc/desire-paths.mjs` 为起点。
4. T18 → T20 按 `poc/timeline.html` 的做法接进正式 view3d / UI，复测开阴影下的帧时间。
5. Phase 2（事件日志 / 降雨）等 T09a 合入后再排；海平面最后做。

## 17. 变更记录（续）

- v0.3（2026-10-22，Hark）：增加可运行原型与实测（§16）；按原型修订 §8.4（重力式流量、按目的地 Dijkstra、稳态阈值、ρ = 0.25、骑士步补格、拓扑松弛为必需）与 T26 验收。
