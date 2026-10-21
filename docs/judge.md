# 裁判（Judge）：规则生成的评估回路

规则生长的内容没法逐个看图验收，所以用一组**可计算的不变量**给每次生成打分。改规则（无论是人还是 AI 改）之后跑一遍裁判，看分数变好还是变坏，而不是靠肉眼。

```bash
node test/judge.mjs --quick      # 5 地形 × 3 seed + 256/512 一致性，约 15 秒
node test/judge.mjs              # 5 地形 × 6 seed + 512/1024 一致性，约 1–2 分钟
node test/judge.mjs --update-baseline   # 接受当前分数为新基线（quick/full 各自独立）
node test/judge.mjs --json       # 输出完整 JSON
```

每次运行都会把含每个世界全部指标的报告写到 `$TMPDIR/terrain-judge-report.json`（可用 `--out=` 指定），不进工作区。

> 生成序列目前在 `test/judge/world.mjs` 里复刻 `src/main.js`；T09 落地 `src/pipeline.js` 后改为直接调用 `generateWorld()` 并删除该文件。

## 规则的两种类型

- **gate**：现在成立、以后必须一直成立。失败 → 退出码 1。
- **target**：生成器应该达到的目标。未达到只显示 `TODO`；只有相对基线**变差**（超过 5% 容差）才退出码 1。

所以裁判同时是护栏（gate + 不回退）和路线图（target）。一个 target 达成后，可以把它升级为 gate。

## 当前规则

| 规则 | 类型 | 含义 |
|---|---|---|
| determinism | gate | 同输入生成两次，高度场和城镇哈希一致 |
| hydro_sinks | gate | 陆地内部没有无去向的格子 |
| hydro_mass | gate | 汇流守恒：终点格的累积量之和 = 总格数 |
| hydro_uphill | gate | 河道格不会流向更高的格子 |
| island_rail_dry | target | 海岛地形铁路点不落在水面 |
| bld_on_road | target | 建筑矩形与任何道路（按路宽）相交的比例 |
| bld_overlap | target | 建筑矩形互相重叠（SAT 检测）的比例 |
| bld_on_rail | target | 建筑压在铁路（半宽 5 m）上的比例 |
| bld_bad_site | target | 建筑中心落在水面/无分区/坡度 > 20° |
| bld_in_river | target | 建筑中心或角点落在河网格子上（分区图把河当陆地，需单独检查） |
| station_rate | target | 生成了站房的世界比例 |
| road_connected | target | 最大连通分量占道路总长 |
| road_dead_ends | target | 非地图边缘的断头端点比例 |
| town_min_size | target | 任一世界的最少建筑数 |
| town_stability | target | 同一地形跨 seed 的建筑数变异系数 |
| res_buildings / res_rivers / res_core | target | 同一世界在两种分辨率下的建筑数、河网面积、中心区面积之比 |

## 加一条新规则

1. 在 `test/judge/metrics.mjs` 的 `townMetrics` / `hydrologyMetrics` 里算出每个世界的一个数。
2. 在 `test/judge.mjs` 的 `RULES` 里把它归约成一个值（max/min/mean），给出阈值、方向和类型。
3. 跑 `node test/judge.mjs --quick --update-baseline` 记录基线。

## 浏览器视觉核对

```bash
node scripts/visual-check.mjs [--out=DIR] [--types=river,caldera] [--seed=N] [--res=512]
```

用系统 Chrome（无头，DevTools 协议，无 npm 依赖）打开真实页面，逐个地形点击生成，记录：

- 页面自己的分阶段耗时、3D 首帧耗时，对照「512 生成 + 3D 首帧 < 2 s」；
- 所有 console error / 页面异常（favicon 404 除外）；
- 彩色、城镇、3D 城镇特写、3D 全图截图；
- **裁判叠加图**：用与裁判相同的几何把压路建筑描红，再出一张城镇中心 2× 特写。

输出 `summary.json` 与截图（默认在 `$TMPDIR/terrain-visual-<时间戳>/`）。退出码 1 表示页面有错误。

## 和 AI 协作的建议回路

```
读 judge 报告中最差的 target
  → 定位到负责的生成函数
  → 改规则
  → npm test && node test/judge.mjs --quick
  → 没有 gate 失败、没有回退、目标值变好 → 提交并更新基线
```
