# 多智能体协作规则

本文件定义多个 agent / 多个模型共同开发 Terrain Gacha Lab 时的管理方式。
目标是：并行但不互相覆盖，快但不丢质量，规划、实现、验证各自有明确责任。

## 1. 单一事实源

仓库内的文档是唯一事实源，聊天记录和 agent 上下文都不算契约：

- `docs/ROADMAP.md`：任务板、状态、依赖、文件所有权。
- `docs/AGENTS.md`：本文件，协作与领取规则。
- `docs/CONTRACTS.md`：跨模块数据契约与接口版本。
- `docs/DECISIONS.md`：架构决策记录 / ADR（后续建立）。
- `docs/QA.md`：验收清单与视觉检查矩阵（后续建立）。
- `README.md`、`docs/oyasumi-gacha-reverse-engineering.md`：面向使用者的说明。

任何接口变更先改 `docs/CONTRACTS.md` 或新增 ADR，再改代码。
不允许 agent 只在聊天里说“我改了接口”。

## 2. 角色

- **规划者 / 集成者（主 agent）**：维护任务板、拆分任务、审查 diff、解决冲突、运行总测试、递增 `?v=`、统一提交。
- **实现 agent**：只负责一个任务卡；只改任务卡列出的文件；提交自测报告。
- **审查 agent（不同模型）**：只读审查实现，检查契约、确定性、测试、截图和越界修改；不直接改代码。
- **QA agent（不同模型 / 多模态）**：在集成分支运行 `npm test`、浏览器冒烟、截图检查、性能检查。
- **探索 agent**：只做调研或算法试验，不写生产文件；结论写入任务卡或 ADR。

高风险任务（水文、Worker、3D 渲染、导出）必须“实现者 ≠ 审查者”。
低风险任务（文档、小型测试）可以只做一次实现 + 集成者检查。

## 3. 任务生命周期

```text
todo → claimed → in_progress → review → changes → qa → done
                  ↘ blocked
```

- **todo**：任务卡已写好，文件所有权明确。
- **claimed**：agent 已领取，记录 agent 名称、模型、分支/工作区。
- **in_progress**：正在实现；不得改任务卡外文件。
- **review**：实现完成，等待不同模型审查。
- **changes**：审查发现问题，退回实现者。
- **qa**：实现与审查通过，等待集成测试/视觉检查。
- **done**：已合入主分支，测试通过，文档同步。

只有集成者可以改任务板状态；agent 在报告中声明状态变化，避免多人同时写 `ROADMAP.md`。

## 4. 工作区与分支

默认使用 **独立 git worktree + task 分支**，避免多个 agent 在同一目录互相覆盖：

```bash
git worktree add ../wt-T01 -b task/T01-ecology main
```

- 分支命名：`task/Txx-short-name`。
- agent 在任务 worktree 内工作；报告路径、分支名、commit/diff。
- 集成者在主工作区按依赖顺序合并，不直接让 agent 改主分支。
- 视觉 QA 只在集成工作区进行，避免多个开发服务器/端口混乱。

### 4.1 认领锁

`docs/ROADMAP.md` 是任务状态的唯一展示源；实际认领用共享 git 目录里的原子锁：

```text
<git-common-dir>/agent-claims/Txx/
  agent  model  branch  worktree  status  claimed_at
```

命令：

```bash
scripts/claim-task.sh claim T01 <agent> <model> <branch> [worktree]
scripts/claim-task.sh status T01 review
scripts/claim-task.sh show T01
scripts/claim-task.sh release T01
scripts/claim-task.sh list
```

规则：

- `claim` 用 `mkdir` 原子创建目录；失败说明已被别人认领，直接换任务。
- 认领成功后，agent 才可以在自己的 worktree 里工作。
- agent 只更新锁里的 `status`（`claimed` / `in_progress` / `review` / `blocked`），不直接改 `ROADMAP.md`。
- 集成者审查后更新 `ROADMAP.md`，并在合入后 `release` 锁。
- 超过 24 小时没有更新的锁视为 stale，由集成者确认后释放。
- 锁目录在 `.git` 内，不进入工作区、不提交、不暴露到公开仓库。

**提交权限**：子 agent 可以在自己的 `task/*` 分支做本地 commit，便于审查和 cherry-pick；但不得 push、不得合并主分支。主分支只由集成者操作。若某个任务不建分支，则通过 `git diff` / patch 交接。

## 5. 文件所有权与并发

- 每个任务卡列出“主文件”；同一并行组内一个文件只能有一个写者。
- `render.js`、`view3d.js`、`main.js`、`index.html` 是高风险共享文件，任务必须串行：
  - `render/view3d`：T02/T03 → T05 → T07。
  - `main/index`：T02 → T09 → T10 → T11。
- 新模块（如 `ecology.js`、`exporters.js`）可以并行创建。
- 如果必须跨文件改动，先拆任务或让集成者做小补丁，不允许 agent 私自扩大范围。
- 任务卡没列出的文件，默认禁止修改；确需修改时先在报告中说明，由集成者批准。

## 6. 模型分工

不同模型按任务类型选择，而不是“所有任务都上最强模型”：

| 任务类型 | 建议模型 | 原因 |
|---|---|---|
| 生态/水文/地形算法 | 强推理模型 | 需要空间推理、数值稳定性和确定性 |
| 2D/3D 渲染 | 强代码模型；审查用多模态模型 | 需要 three.js/Canvas 经验与截图判断 |
| Worker/架构重构 | 强推理模型 + 独立审查 | 跨线程、数据克隆、回退路径风险高 |
| 测试/文档/小模块 | 快速、低成本模型 | 边界清晰、可验证 |
| 视觉 QA | 多模态模型 | 需要看截图判断遮挡、颜色、可读性 |
| 独立审查 | 与实现者不同的模型 | 降低同模型盲区 |

原则：

- 每个 agent 的提示词自包含：项目路径、当前 commit、任务卡、文件、验收、命令；不依赖完整聊天记录。
- 不让多个 agent 同时“自由发挥”同一文件。
- 成本敏感：小任务用便宜模型；只有高风险/高复杂度任务用更强模型。
- 外部 agent 适合独立审查、算法试验、测试生成；直接写生产代码前仍走同一任务卡与文件所有权。

## 7. 任务领取提示词模板

```text
项目：<repo root>
任务板：docs/ROADMAP.md
完整规划：docs/PLAN.md
当前基线：<commit sha>

领取任务：Txx <name>
工作区：<worktree path> / 分支 <branch>
先运行 scripts/claim-task.sh claim ...；认领失败就换任务。
只修改任务卡列出的文件；不要改其他文件；不要 push/merge。
先读任务卡、CONTRACTS 和相关源码，再实现。
完成后报告：
1. 变更文件与关键 diff
2. 测试命令与结果
3. 截图/URL（渲染任务）
4. 是否触碰契约；是否需要下游任务调整
5. 遗留风险
```

## 8. 契约与变更管理

跨模块契约示例：

- `field.seed`
- `EcologyField`（`src/ecology.js` 的返回值）
- `TownAmenities`（`town.amenities`）
- 水文新增字段（`lakeMask`、`riverWidth`、`falls`）
- `generateWorld()`（Worker 管线）

规则：

1. 契约定稿前，下游任务不得开工。
2. 契约变更必须更新 `docs/CONTRACTS.md`，并记录影响的任务 ID。
3. 破坏性变更优先加新字段/新函数，不删除旧字段；确需删除时由集成者统一迁移。
4. 共享文件改动由集成者递增 `?v=`；agent 在报告中注明“需要 bump”。
5. 任何“为了通过测试而改测试预期”的行为都要审查，不能静默降低验收标准。

## 9. 质量门禁

任务完成必须通过：

- `npm test`。
- 同 seed 两次生成的关键数据哈希一致。
- 页面无 console/page error。
- 渲染任务：全图 + 城镇特写截图；树不落水、不穿建筑、铁路/车站可见。
- 性能：512 浏览器生成 + 3D 首帧 < 2 s（本机）；1024 走 Worker 时 UI 可交互。
- 代码审查：无越界修改、无硬编码 secret、无复制第三方资源。
- 文档：README / ROADMAP / 契约与实现一致。

## 10. 冲突与阻塞处理

- **文件冲突**：立即停止并报告；由集成者按文件所有权重新排期，不允许强制覆盖。
- **契约冲突**：先写 ADR，冻结下游，统一接口后再继续。
- **测试持续失败**：实现者修两轮仍失败，交给不同模型审查或集成者接管。
- **性能回退**：记录基准；超过预算 30% 必须解释或回退。
- **视觉回退**：保留改动前截图；由多模态审查者对比，不以“看起来差不多”通过。
- **范围膨胀**：任务超过任务卡文件/验收范围时拆分，不在原任务里继续加功能。

## 11. 版权与安全

- 不复制原项目代码、参数表、字符串表或素材；只借鉴公开设计思想。
- 不把 secret、token、私有 URL 写入代码、文档、截图或 agent 提示词。
- 外部资源必须确认许可证；three.js 继续保留 `vendor/THREE-LICENSE`。
- 不引入会削弱现有输入校验/安全边界的改动。

## 12. 当前启动建议

1. 先完成 Wave 0：T00（`field.seed`）+ T01（生态层）。
2. T01 契约冻结后，启动 Wave 1 的 T02/T03/T04/T06/T08。
3. 每个实现任务配一个不同模型的审查者；渲染任务再配多模态 QA。
4. 每波结束由集成者统一跑测试、看截图、递增 `?v=`，再进入下一波。
