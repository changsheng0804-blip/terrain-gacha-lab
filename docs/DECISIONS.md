# 架构决策记录（ADR）

格式：每条 ADR 一个小节，状态为 `提议 / 接受 / 废弃 / 取代`。只有集成者可以把状态改为“接受”。
接口变更先写 ADR，再改 `CONTRACTS.md`，再改代码（见 AGENTS.md §8）。

---

## ADR-001：演化系统采用“后台先算 + 关键帧录制 + 前台回放”

- **状态**：提议（RFC-001 v0.2）
- **影响任务**：T09a、T09b、T17、T18、T19、T20

**背景**：RFC-001 v0.1 设想每帧推进一步计算并直接渲染（compute-per-frame）。实测（M4 / Node 24 / 512）：整条管线 < 1 s，但单批 4k 滴水 2–7 ms（最坏 27 ms）、`buildHydrology` 80–110 ms、`generateTown` 250–350 ms 且不可拆分；生成器只能前进，无法支持拖拽回退。

**决定**：
1. 步进内核 `createWorldEvolution` 只负责“按确定顺序推进并交出帧”，不关心帧率。
2. Worker（或主线程回退）尽快迭代内核，由 `TimelineRecorder` 拷贝并量化关键帧。
3. 主线程 `Timeline + Player` 按用户控制的速度回放、支持任意拖拽；3D 走增量接口，不重建几何。
4. Phase 1 城镇采用“建造日志回放”（由已生成城镇推导出现顺序），不改 `town.js`。

**后果**：动画流畅度与计算耗时解耦；`classic` 终态与现状逐位一致；需要额外内存（≤ 48 MB 关键帧预算）；Phase 1 的城镇“生长”是呈现而非因果模拟，真正的涌现在 Phase 3（`townMode: 'evolve'`）。

---

## ADR-002：演化系统的确定性规则

- **状态**：提议（RFC-001 v0.2）
- **影响任务**：所有 RFC-001 任务

**决定**：
1. 规范输出只有终态与固定步号的检查点；中间帧、回放关键帧、呈现动画为非规范，不进入哈希。
2. 新随机流一律新域名（`evolve:*`、`climate:*`），禁止消费已有 `town:<id>`、`erosion:<id>`、`design:<id>` 流。
3. 智能体/元胞更新同步执行；遍历按索引升序；排序稳定且 tie-break 确定；不以 `Map/Set` 插入顺序承载浮点键。
4. 规范数据的浮点归约顺序固定，禁止跨 Worker 并行归约。
5. 确定性范围为“同一 JS 引擎”（V8：Chrome/Node）。扩大到跨引擎需单独 ADR（涉及 `Math.hypot` 等，会改变全部哈希）。
6. 侵蚀分批：任意切分与一次跑完逐位一致（已实测），驱动器可按时间片切批；`thermalErosion`、`smoothField`、`carveValleyOutlet` 只能在全部水滴结束后按原顺序执行。

---

## ADR-003：原 T09 并入 RFC-001 Phase 1，拆为 T09a / T09b

- **状态**：提议（RFC-001 v0.2）
- **影响任务**：T09、T10、T11、judge（`test/judge/world.mjs`）

**背景**：T09 计划新建 `src/pipeline.js` 并提供 `generateWorld`；RFC-001 也要在同一文件放步进内核。两张卡同时写一个文件违反单写者规则。

**决定**：
- **T09a**：`src/pipeline.js`（`createWorldEvolution` + `generateWorld` 折叠）+ `test/pipeline.test.mjs` + judge 改为调用 `generateWorld`（删除 `test/judge/world.mjs` 中的复刻逻辑）。
- **T09b**：`src/generate.worker.js` + `src/main.js` 接入（Worker 优先、主线程回退、可取消）。
- main/index 串行链变为：T02 → T09b → T20 → T10 → T11。
- 两者都在 T15 合入、T16 金标录制之后开工。
