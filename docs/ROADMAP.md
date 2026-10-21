# Terrain Gacha Lab：任务路线图

这是下一阶段的可领取任务板。完整任务卡与算法细节见 [PLAN.md](PLAN.md)。

协作规则见 [AGENTS.md](AGENTS.md)，跨模块接口见 [CONTRACTS.md](CONTRACTS.md)。

## 原则

- 保持纯静态、无运行时依赖、seed 可复现。
- 新随机流一律使用 `rngFor(seed, 'domain:...')`。
- 生成层输出数据，渲染层只读；新参数保持向后兼容。
- 同一并行组内一个文件只允许一个 agent 写。
- agent 可在自己的 `task/*` 分支本地 commit，但不得 push/merge；主分支由集成者审查、跑测试、递增 `?v=` 后统一提交。
- 每个任务至少运行 `npm test`；渲染任务附截图或检查结论。

## 任务总表

| ID | 任务 | 主要文件 | 依赖 | 波次 | 优先级 | 状态 | 领取者 / 模型 |
|---|---|---|---|---|---|---|---|
| T00 | 把 seed 存回 field | `src/terrains.js` | 无 | 0 | P0 | 待领取 | — |
| T01 | 生态数据层 | 新 `src/ecology.js`、新 `test/ecology.test.mjs` | T00 | 0 | P0 | 待领取 | — |
| T02 | 2D 生态/植被渲染 | `src/render.js`、`index.html`、`styles.css` | T01 | 1 | P0 | 待领取 | — |
| T03 | 3D 植被实例化 | `src/view3d.js` | T01 | 1 | P0 | 待领取 | — |
| T04 | 城镇公共设施生成 | `src/town.js`、`test/town.test.mjs` | 无 | 1 | P0 | 待领取 | — |
| T05 | 城镇设施 2D/3D 渲染 | `src/render.js`、`src/view3d.js` | T02、T03、T04 | 2 | P1 | 待领取 | — |
| T06 | 水文升级：湖泊/河宽/瀑布 | `src/hydrology.js`、`test/smoke.test.mjs` | 无 | 1 | P1 | 待领取 | — |
| T07 | 水体 2D/3D 渲染 | `src/render.js`、`src/view3d.js` | T05、T06 | 3 | P1 | 待领取 | — |
| T08 | 地形包 II（castle/skyline/falls） | `src/terrains.js` | T00 | 1 | P1 | 待领取 | — |
| T09 | Web Worker 生成管线 | `src/main.js`、新 `src/pipeline.js`、新 `src/generate.worker.js` | T00 | 2 | P1 | 待领取 | — |
| T10 | 参数面板 + 分享链接 | `src/main.js`、`index.html`、`styles.css` | T02、T09 | 3 | P2 | 待领取 | — |
| T11 | 导出扩展：heightmap/SVG/GLB | 新 `src/exporters.js`、`src/main.js`、`index.html`、`vendor/` | T09、T10 | 4 | P2 | 待领取 | — |
| T12 | 测试/视觉检查/文档 | `test/*`、`scripts/*`、`README.md`、`docs/*` | 各任务 | 4 | P1 | 待领取 | — |

> T08 的 UI 选项由 T02 在同一个 `index.html` 里一并加入，避免两个 agent 同时改 index。

## 认领锁

任务板只做展示；实际认领使用共享 git 目录中的原子锁：

```bash
scripts/claim-task.sh claim T01 <agent> <model> <branch> [worktree]
scripts/claim-task.sh status T01 review
scripts/claim-task.sh show T01
scripts/claim-task.sh release T01
scripts/claim-task.sh list
```

- `claim` 用原子 `mkdir`；失败就换一个 `ready` 任务。
- agent 只更新锁里的状态，不直接改本文件。
- 集成者合入后更新本文件并 `release` 锁。
- 锁位于 `<git-common-dir>/agent-claims/`，不提交、不在工作区出现。

## 波次

### Wave 0

- T00（快速，集成者可直接做）
- T01（生态层；完成前 T02/T03 不启动）

### Wave 1（并行）

- T02 2D 生态/植被（独占 `index.html`，顺带加入 T08 的选项）
- T03 3D 植被（`view3d.js`）
- T04 城镇设施生成（`town.js` + `test/town.test.mjs`）
- T06 水文升级（`hydrology.js` + `test/smoke.test.mjs`）
- T08 新地形（`terrains.js`；不改 index/test/smoke）

### Wave 2（并行）

- T05 城镇设施渲染（等 T02/T03/T04）
- T09 Worker 管线（`main.js` + 新文件；与 T05 不重叠）

### Wave 3（并行）

- T07 水体渲染（等 T05/T06）
- T10 参数面板/分享（等 T02/T09）

### Wave 4

- T11 导出扩展
- T12 测试/视觉检查/文档

## 验收门槛

- `npm test` 全绿。
- 5（之后 8）种地形都能生成城镇、铁路、车站、地块。
- 同 seed 两次生成的关键数据哈希一致。
- 512 浏览器生成 + 3D 首帧 < 2 s（本机）。
- 页面无 console/page error。
- 视觉检查：森林不压城镇、树不落水、铁路可见、车站可定位、湖泊/河宽可读。

## 任务领取格式

```text
项目：<repo root>
任务板：docs/ROADMAP.md
完整规划：docs/PLAN.md
当前基线：<commit sha>

领取任务：Txx
工作区：<worktree path> / 分支 <branch>
只修改任务卡列出的文件；不要 push/merge。
先读规划和相关源码，再实现。
完成后报告：变更文件、测试命令与结果、截图/URL、遗留风险。
```
