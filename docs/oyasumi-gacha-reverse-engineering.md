# おやすみゲーム開発部「ガチャ」系列：技术拆解（第一版）

> 分析对象：
> - Name Gacha — https://tools.oyasumi-gamedev.com/namegacha/
> - World Gacha — https://oyasumi-gamedev.com/tools/worldgacha/ （工具入口 https://tools.oyasumi-gamedev.com/worldgacha/）
> - Background Gacha — https://tools.oyasumi-gamedev.com/haikeigacha/
>
> 本地分析副本：`/tmp/oyasumi-re/`（页面 HTML 与美化后的 `world_worker.pretty.js`）。临时目录可能在重启后清理。
>
> 结论先行：**可以逆向，而且核心算法可读性高于一般商业前端。** 三个工具都是纯静态单页应用，生成逻辑完整下发到浏览器；没有服务端生成、没有 source map、没有重度混淆。WorldGacha 的 Worker 只做了 minify，Name Gacha 的核心函数名甚至保留了下来。

---

## 0. 证据边界与版权

### 证据类型

本文把结论分成三类：

- **观察**：直接来自页面 HTML、内联脚本、Worker 源码或作者公开说明。
- **推断**：根据压缩后的变量名、调用关系、数值结构推断，未做运行时验证。
- **未知**：尚未分析或无法从静态代码确认。

### 版权

三个工具页面头部均带有：

```text
© 2026 MIYADAIKU (oyasumi-gamedev.com). All rights reserved.
無断の複製・再配布・改変して配ることを禁じます。
```

这意味着：

- 阅读、研究、总结算法思路通常没有问题。
- **不要直接复制代码、字符串表、家具/地形参数表、美术资源到自己的产品再发布。**
- 更稳妥的复刻方式：把本文的伪代码和参数区间当作“设计规格”，用自己的命名、数据结构和实现重写。
- 通用算法（水滴侵蚀、fBm、BSP、网格放置、优先队列填洼）本身属于公知技术，可以独立实现。

---

## 1. 三个工具的共同架构

### 1.1 形态

| 项目 | 页面体积 | 脚本形态 | 生成位置 | 渲染 |
|---|---:|---|---|---|
| Name Gacha | 2.0 MB | 2 个内联脚本，约 1.73 MB | 主线程 | Canvas / SVG |
| World Gacha | 1.2 MB + 199 KB Worker | 1 个内联主逻辑 + `lib/world_worker.js` | Worker，失败时回退主线程 | three.js |
| Background Gacha | 3.9 MB | 546 个内联脚本块，约 3.44 MB | 主线程 | three.js + 2D 平面图 |

共同点：

1. **无后端生成**：页面不把 seed、参数或画布发到服务器。作者 FAQ 也明确说明“所有处理都在浏览器内完成”。
2. **单文件部署**：HTML 内联业务代码，只有 three.js 作为独立库；没有构建后的 chunk 图，也没有 source map。
3. **i18n 内联**：语言字典直接写在脚本里，支持 ja/en/zh-Hans/zh-Hant/ko/hi/th/es/fr。
4. **seeded RNG**：所有随机性由 seed 驱动，保证“同一个 seed → 同一个结果”。
5. **节点级 seed**：世界和房间都支持只重抽某一个阶段，而不影响其它阶段。
6. **状态可序列化**：recipe JSON / URL / localStorage 保存完整生成状态。
7. **多格式导出**：PNG、SVG、GLB，World Gacha 还支持 FBX/OBJ/heightmap/地图。

### 1.2 通用生成范式

```text
用户操作
  → 状态 state（type + seed + 参数 + 锁定项 + seed 覆盖）
  → 每个节点用独立 RNG 生成中间结构
  → 约束求解 / 降级校验
  → 几何或网格
  → 渲染
  → 导出 / 分享
```

三个项目的差别只在“中间结构”长什么样：

- World Gacha：参数化地形设计 → 高度场 → 侵蚀 → 水文 → 城镇图。
- Background Gacha：房间 recipe → 网格 → 开口/区域 → 家具放置 → 材质/小物。
- Name Gacha：分镜 genome → 几何 realize → 构图评分 / 人物 atari。

---

## 2. World Gacha：地形与城镇生成

### 2.1 模块划分（观察）

内联主线程里可以看到这些全局模块：

| 模块 | 作用 |
|---|---|
| `EKE` | 基础数学：hash、seeded RNG、value noise、fBm、ridged noise、grid、blur、法线、采样 |
| `WGE` | 世界生成器：类型表、设计图、高度场、侵蚀、水文、城镇、统计 |
| `WGRUN` | 主线程/Worker 调度；`WGE.generate` 失败时回退主线程 |
| `WGOUT` | 导出、轮廓、采样、配方 |
| `WG3D` | three.js 场景、地形 mesh、建筑/树木/远景 |
| `WGMap` | 2D 俯视图与绘制工具 |
| `WGView` / `RKView` / `RKFAR` | 相机、近景/远景、线画/网点渲染 |

Worker 协议非常简单：

```js
// 主线程
worker.postMessage({ id, S: state })

// Worker
const result = WGE.generate(state)
postMessage({ id, R: result }, transferList)
```

`state` 的结构（观察）：

```js
{
  app: "worldgacha",
  v: 1,
  type: "river" | "slope" | "suburb" | "rural" | "onsen" |
        "castle" | "downtown" | "skyscraper" | "falls",
  seed: uint32,
  size: 2000 | 4000 | 6000 | 8000 | 10000,
  res: 256 | 512 | 1024,
  town: 0 | 1,
  nodeSeeds: { design, terrain, erosion, town, streets, buildings, outskirts },
  num: { [node]: { [param]: number } },
  paint: [ /* 地形/水/用途/道路笔刷 */ ],
  chaos: 0..100
}
```

### 2.2 七节点管线（观察）

作者公开的节点顺序与代码一致：

```text
design → terrain → erosion → town → streets → buildings → outskirts
```

- `design`：海岸、本流、山谷宽度、山脉布局。
- `terrain`：高度场。
- `erosion`：水滴侵蚀。
- `town`：用途分区、干线、铁路/车站、学校/寺庙位置。
- `streets`：街区与街道方向。
- `buildings`：建筑尺寸、类型、排列。
- `outskirts`：周边集落、农田、道路、远景房屋。

节点 seed 的计算：

```js
nodeSeed(state, node) =
  state.nodeSeeds[node] ?? hash3(state.seed, strSeed(node), 11)
```

因此每个节点可以独立重抽。缓存 key 还包含：

```text
type, seed, size, res, designSeed, terrainSeed, erosionSeed,
design 数值, terrain 数值, erosion 数值, chaos
```

### 2.3 地形设计：参数化解析高度场（观察 + 推断）

每种地形不是“随机噪声堆出来的”，而是**先由 RNG 生成一组设计参数，再用解析式高度函数组合 fBm/ridged noise**。

以 `river` 为例，设计参数包括：

```text
th          整体旋转角
coastV      海岸线基准位置
coastWig    海岸线摆动幅度
riverA      河流蜿蜒幅度
riverF      河流频率
r0          河流偏移
wCoast      海岸山体宽度
wIn         内陆山体宽度
floorG      谷底坡度
mtnH        山脉高度
plainW      平原宽度
warp        域扭曲强度
inflow      主河流量
s1..s4      四组噪声 seed
```

高度函数的结构可以概括为：

```text
p = rotate(x, z, th)
p = p + warp * fbm(p / scale, s4)

riverU(a) = r0 + riverA * sin(a * riverF + phase) + 低频摆动
coastAt(a) = coastV + coastWig * 曲线(a) + 小尺度摆动

dRiver = |u - riverU(v)|
dCoast = v - coastAt(u)

base = 谷底 + 河流下切 + 山体 * smoothstep(离海距离)
mountain = mtnH * smoothstep(...) * (0.5*fbm + 0.5*ridged²)
valley = smoothMin(mountain, riverBed, k)
plain = 平原混合权重
coast = 海岸悬崖/海平面处理
```

其它类型各有自己的“设计图”：

| 类型 | 关键设计元素 |
|---|---|
| `slope` | 海湾、海岸台地、坡道、冲沟（ravines）、小岛 |
| `suburb` | 丘陵 + 谷地河流 + 住宅台地 |
| `rural` | 平原 + 河流 + 里山 + 后方丘陵 |
| `onsen` | V 形深谷 + 溪流 + 陡壁 + 山体 |
| `castle` | 平地 + 河道 + 城堡台地（超椭圆距离） |
| `downtown` | 台地 + 下切谷地 + 支流 + 谷户（yato） |
| `skyscraper` | 岛屿/半岛 + 网格大道 + 中央公园 + 码头 + 悬崖 |
| `falls` | 约 1000m 高的湖面 + 悬崖边缘 + 瀑布 + 下方海面 |

这说明作者的核心方法是：**用少量有语义的参数控制大尺度形态，用噪声控制细节，用 smooth min/max 把不同地貌拼接起来**。

### 2.4 水滴侵蚀（观察）

`erodeDroplets` 是经典的 particle-based hydraulic erosion：

```text
输入：高度场 H、网格 n、侵蚀参数、RNG
归一化高度到 [0,1]
预计算半径内的圆形权重核

for 每个水滴:
    pos = 随机位置（网格内缩）
    dir = (0,0)
    sediment = 0
    speed = 1
    water = 1

    for life 步:
        h = 双线性采样 H(pos)
        if h <= seaLevel: break

        gradient = 双线性采样高度梯度
        dir = dir * inertia - gradient * (1 - inertia)
        dir = normalize(dir)
        newPos = pos + dir

        deltaH = H(newPos) - h
        capacity = max(-deltaH * speed * water * capacityFactor, minCapacity)

        if sediment > capacity or deltaH > 0:
            deposit = ...
            H(pos) += deposit * bilinear weights
            sediment -= deposit
        else:
            erode = min((capacity - sediment) * erodeFactor, -deltaH)
            for 半径内每个格子:
                remove = min(H[cell], erode * weight[cell])
                H[cell] -= remove
                sediment += remove

        speed = sqrt(max(0, speed² - deltaH * gravity))
        water *= (1 - evaporation)
        pos = newPos
```

关键参数来自每种地形的 `TUNE` 表（观察）：

| 类型 | k | life | radius | talus | soft | minA |
|---|---:|---:|---:|---:|---:|---:|
| river | 0.9 | 34 | 3 | 36 | 0.30 | 180,000 |
| slope | 0.7 | 30 | 3 | 38 | 0.30 | 120,000 |
| suburb | 0.45 | 26 | 3 | 30 | 0.35 | 250,000 |
| rural | 0.45 | 26 | 3 | 30 | 0.35 | 250,000 |
| onsen | 0.8 | 30 | 2 | 42 | 0.25 | 150,000 |
| castle | 0.5 | 28 | 3 | 32 | 0.35 | 250,000 |
| downtown | 0 | 4 | 2 | 40 | 0.15 | 1,500,000 |
| skyscraper | 0 | 4 | 2 | 40 | 0.10 | 1,000,000,000 |
| falls | 0 | 4 | 2 | 89 | 0 | 1,000,000,000 |

含义（推断）：

- `k` 是水滴数量系数；城市类型接近 0，因为地形主要由解析设计决定，不需要强侵蚀。
- `life` 是每个水滴的步数。
- `radius` 是侵蚀核半径。
- `talus` 是滑坡松弛角。
- `soft` 是侵蚀后模糊混合比例。
- `minA` 是河流提取的汇流面积阈值。

侵蚀之后还有两步：

```text
slump(H, talus)       // 超过安息角的坡面物质下滑
blur(H, soft)         // 轻度平滑，形成谷底平地
```

### 2.5 水文（观察 + 推断）

```text
pfill(grid, H, seaLevel)
  → 填洼，得到可流出的高程与处理顺序

flow(grid, filledH, order)
  → 每个格子流向低处，累积汇流量 acc

rivers(grid, H, flowRec, acc, { minA, sea })
  → 汇流量超过阈值的格子连成河网
  → simplify + Chaikin 平滑
  → 主河从 design 的 riverU 采样得到
  → 手绘河流与自动河流合并
```

`pfill` 的返回值 `{F, order}` 和 `flow` 的 `{rec, acc}` 结构与 priority-flood + D8 流向累积一致，但具体流向规则未逐行确认。

海岸清理 `tidyCoast`：

```text
对海平面附近做 3×3 均值平滑
连通分量标记
  - 小湖 < minLake 填平
  - 小岛 < minIsland 削掉
返回 islands / lakes 计数
```

### 2.6 地表属性（观察）

生成高度/水文后，逐格计算：

```text
slopeAngle = acos(normal.y) * 180/π
dSea      = distance transform(sea mask)
dRiver    = distance transform(river mask)
wood      = (slope > 8° 或 高差 > 12m) 且 fbm > 阈值
beach     = dSea < 70m 且 H < 3.2m 且 slope < 7°
```

然后提取矢量轮廓：

```text
woods   → contour(wood, 0.5)   → simplify
beaches → contour(beach, 0.5)  → simplify
sea     → contour(seaLevel - H, 0) → simplify
lakes   → contour(lake mask)
```

### 2.7 城镇生成（观察）

城镇由 `town` 函数完成。核心步骤如下：

1. **分区**  
   枚举：`NONE / CORE / RES / PADDY / IND / HAMLET`。  
   用从中心出发的“可达性”（坡度、河流、距离加权）决定 CORE/RES/IND/PADDY/HAMLET。

2. **道路网**  
   - 干线等级：motorway / trunk / primary / secondary / tertiary / minor / service / busway / raceway。
   - 铁路：`rail`，包含 tunnel/bridge/cut/loop。
   - 车站：位置、朝向、法线。
   - 道路交叉点做图结构，支持节点、路径、路口。

3. **街区与地块**  
   沿道路两侧按间距切地块。不同分区的地块尺寸/退界/间距不同（观察到的表）：

   | 分区 | 面宽 fw | 进深 dp | 退界 sb | 间距 gap | 二层概率 p2 |
   |---|---:|---:|---:|---:|---:|
   | CORE | 5.5–9 | 9–14 | 0–0.4 | 0.1–0.5 | 0.60 |
   | RES | 7–10 | 7–10 | 1.5–3.8 | 1.2–2.4 | 0.75 |
   | IND | 18–40 | 14–28 | 4–9 | 4–9 | 0.30 |
   | HAMLET | 10–14 | 9–12 | 4–9 | 8–20 | 0.20 |

4. **建筑标签**  
   根据分区、地块面积、离中心距离、随机数决定：
   - CORE：apartments / commercial / house / retail
   - IND：warehouse / industrial
   - HAMLET：house
   - RES：apartments / house / retail
   - 标签包括 `building`, `building:levels`, `roof:shape`, `height`。

5. **公共设施**  
   寺庙、神社、公园、超市、役场、学校（校舍 + 体育馆 + 围栏）、城堡、港口、堤防、温泉烟囱、自动售货机、公交站、旗竿地等。

6. **周边（outskirts）**  
   集落、农田道路、沿路房屋、田地、远景点缀。

7. **矢量化**  
   建筑轮廓、地块、水面、森林、海滩、围墙、道路都转成多边形/折线，供 2D 地图和 3D 生成使用。

### 2.8 特殊城镇

- `urbanTown`：downtown / skyscraper。网格大道、街区、公园、码头、高层建筑。
- `aquaTown`：falls。湖面、岛、运河、桥、广场、教堂、钟楼、瀑布“喉部”。

### 2.9 复刻要点

如果要自己实现一个简化版：

1. 先做 `river` 一种地形：解析高度 + fBm + 水滴侵蚀。
2. 用 Canvas 画高度/坡度/汇流，确认视觉合理。
3. 加 `pfill + flow + rivers`，得到河网。
4. 用距离场做森林/海滩。
5. 城镇先做“中心 + 主干道 + 两侧地块 + 建筑标签”，不要一开始做九种类型。
6. 最后接 three.js 和导出。

---

## 3. Background Gacha：房间与家具生成

### 3.1 规模（观察）

- 内联脚本约 3.44 MB，546 个 script 块。
- 家具/物件生成器键名约 **472 个**（`gen_*` / `HGE.registerGen` 注册表）。
- 房间定义（`HGE.registerRoom`）出现 62 次以上；i18n 中可见 70+ 个房间类型键。
- 当前 UI 主推：教室、自室、客厅、图书馆、理科室、体育馆。

这说明它不是一个“小工具”，而是一个**内容驱动的程序化室内生成框架**。

### 3.2 核心模块（观察）

| 模块 | 作用 |
|---|---|
| `HGE` | 房间生成引擎：RNG、网格、房间/区域/生成器/材质注册、放置约束 |
| `HGExt` | 房间列表、默认状态、状态规范化、生成入口 |
| `HGFZ` | “冻结”状态，用于分享/复现 |
| `HGView` | three.js 渲染、相机、光照、线画/网点 |
| `HGMap` | 2D 室内平面图 |
| `HGSchoolMap` | 学校多房间平面图 |

`HGE` 暴露的关键 API：

```text
newGrid, idx, inGrid, roomAt, edgeRooms, isWallEdge,
openingAt, fpOf, cellsOf, canPlace, addItem, itemCenter,
wallRuns, wallBand, wallSides, openSlots, openingInward,
placeBest, placeN, placeAt, placeGrid, placeLine, placeScatter,
registerGen, registerMat, registerCat, registerRoom, registerZone,
styleFor, mutateStyle, buildArgs, previewArgs
```

### 3.3 六个生成节点（观察）

UI 和代码都把房间拆成：

```text
shape → open → zone → place → dress → detail
```

含义：

| 节点 | 内容 |
|---|---|
| `shape` | 房间尺寸、天花板高度、柱子、收纳 |
| `open` | 门、窗的位置与尺寸 |
| `zone` | 地面每格的属性：座位、通路、讲台等 |
| `place` | 家具的放置点、类别、朝向 |
| `dress` | 墙面/天花板装饰、地板和墙面材质 |
| `detail` | 小物、书本、海报、粉笔等 |

每个节点有独立 RNG：

```js
rngFor(state, node) = rngOf(hash(state.seed, node, state.type))
```

因此“只重抽家具摆放”不会改变房间形状。

### 3.4 房间生成流程（观察 + 推断）

```text
generate(state):
  room = roomDef[state.type].shape(rng("shape"), ctx)
  for cellEdit in state.cellEdits:
      修改对应格子的房间/外部属性

  if state.locks.open:
      只应用锁定的开口
  else:
      roomDef.open(room, rng("open"), ctx)

  roomDef.zone(room, rng("zone"), ctx)
  roomDef.place(room, rng("place"), ctx)
  roomDef.dress(room, rng("dress"), ctx)
  roomDef.detail(room, rng("detail"), ctx)
  return room
```

每个房间 recipe 是一个「分阶段函数包」，而不是一个大函数：

```js
HGE.registerRoom("classroom", {
  group: "school",
  recipe: {
    shape(room, rng, ctx) { ... },
    open(room, rng, ctx) { ... },
    zone(room, rng, ctx) { ... },
    place(room, rng, ctx) { ... },
    dress(room, rng, ctx) { ... },
    detail(room, rng, ctx) { ... }
  },
  gens: [...],
  countable: [...],
  cams(room) { ... }
})
```

### 3.5 网格与放置约束（观察）

房间是一个离散网格：

```text
CS = 单元格尺寸（例如 0.5m）
room[] = 每格 0/1（室内/室外）
room.fill(1) 初始化
edgeRooms / isWallEdge 找边界
openings[] 记录门窗
items[] 记录家具
```

放置流程：

```text
placeBest(cat, count, opts):
  for 每个候选位置:
      检查 canPlace（边界、重叠、朝向、靠墙、通路）
      评分（靠墙、面向、留空、对称）
  选最优位置
  标记占用
```

`canPlace` 还处理：

- 靠墙/离墙
- 门的开启空间
- 座位前方需要桌面
- 家具之间不能重叠
- 讲台/黑板/屏幕的朝向
- 体育馆/泳池等大件尺寸上限

### 3.6 样式与变异（观察）

每种家具不是固定模型，而是**生成器 + 样式参数**：

```text
style = {
  size, proportions, colors, materials,
  legs, back, seat, drawer, door, ...
}
```

同一类别可以有多个生成器：

```text
chair → school_chair / shell_chair / wood_chair / office_chair
desk  → class_desk / school_desk / wood_desk / office_desk
shelf → bookshelf / stack_shelf / steel_rack ...
```

`styleFor(type, cat, seed, key)` 生成一个样式；`mutateStyle` 在当前样式上做小变异。UI 的“🧬”就是批量生成变体并排展示。

材质也是独立注册表：地板、墙面、天花板、木纹、金属、布料等。颜色/粗糙度/图案参数化。

### 3.7 渲染与导出

- three.js 场景，`HGView` 负责相机、光照、阴影。
- 支持线画、网点、贝塔、白模、光照方向、镜头、纵线校正、隐藏前墙。
- PNG 导出当前视图；GLB 导出房间模型。
- 2D 平面图 `HGMap` 支持选区、涂格子、拖家具、门窗编辑。

### 3.8 复刻要点

最小可行版本：

1. 做 4m × 8m 的教室网格。
2. 实现 `shape`：矩形房间 + 墙。
3. 实现 `open`：前后门 + 一侧窗。
4. 实现 `zone`：座位区/讲台区/通路。
5. 实现 5 个生成器：课桌、椅子、讲台、黑板、门。
6. 实现 `place`：按行列摆放课桌，留出通路。
7. 用 three.js 画方块 + 简单材质。
8. 最后再加 `dress/detail`、变异、GLB 导出。

---

## 4. Name Gacha：分镜与人物 atari

### 4.1 功能范围（观察）

页面不只是“分镜格生成器”，而是七个标签页：

```text
コマ割り（分镜格） / 背景 / ポーズ（人物姿势） / フキダシ（对话气泡）
効果線（效果线） / 擬音（拟声词） / ネーム（分镜脚本/角色）
```

核心是可复现的程序化漫画页面布局。

### 4.2 技术栈（观察）

- 页面约 2.0 MB，2 个内联脚本。
- 可见 `mulberry32`、`strHash`、`value noise`、`fbm`。
- 2D 几何：多边形、凸包、四边形检查、布尔/裁剪。
- 人物部分有骨骼/关节/头部绘制（CSS 类 `pe-bones`、`pe-hd`）。
- 角色素材通过同源 `fetch` 按需加载（`CAST_IDS` / `CP_DIR`），不是服务端生成。
- 有 SVG 输出（分镜框、气泡、效果线都是矢量）。

### 4.3 分镜基因组（观察）

`randomGenome(rng, params)` 生成：

```js
{
  rowW: number[],        // 每行高度权重
  rowTilt: number[],     // 行间倾斜
  rows: [{
    colW: number[],      // 每列宽度权重
    colTilt: number[],   // 列间倾斜
    panels: [{
      nest: { u } | null, // 格内嵌套分格
      bT, bB, bR, bL      // 上/下/右/左是否“出血”越过边界
    }]
  }]
}
```

生成逻辑：

```text
rowCount = rand(rowMin, rowMax)
rowW = [0.65..1.65] 权重
以概率 big 选一行放大 1.8 + big*1.5
rowTilt = [-tiltH, tiltH]
对每行:
  colCount = weightedPick([...]) + 1
  colW = [0.7..1.7]
  colTilt = [-tiltV, tiltV]
  每个格子:
    nest = 概率 nest，嵌套一个 0.38..0.62 的子格
    bT/bB/bR/bL = 概率 bleed
```

### 4.4 几何实现（观察）

`realize(genome, params, tiltScale)` 把权重变成像素：

```text
画布高 1000，宽 = 1000 * ratio
边距：MY=56, MX=50, OUT=14
行间距 GRW=12，列间距 GCW=5
最小格高 MINH=60，最小格宽 MINW=50

fitMin(rowW, 可用高度, MINH)  // 按权重分配，保证最小高度
累积行边界、列边界
应用 rowTilt / colTilt
  倾斜会导致四角超出边界 → 计算每行/列的收缩系数
  必要时整体降低 tiltScale
生成每个格子的四边形
处理 nest（子格）
处理 bleed（出血边）
```

`realizeSafe` 是关键的鲁棒性设计：

```js
for (const scale of [1, 0.7, 0.45, 0.2, 0]) {
  layout = realize(genome, params, scale)
  if (layout.panels.every(quadOK)) return layout
}
layout.invalid = true
```

也就是说：**先生成，再验证；如果倾斜导致四边形不自交/不合法，就逐级降低倾斜，最后退化为无倾斜。** 这是程序化布局里非常实用的“软失败”策略。

`generate(seed, params)`：

```text
rng = mulberry32(strHash(seed))
genome = randomGenome(rng, params)
layout = realizeSafe(genome, params)
return { seed, genome, ...layout }
```

`pcPick` 看起来是“生成多个候选，选评分最高的一个”（推断）。`mutate` 则在现有 genome 上做小幅扰动，用于“再抽一次但保持风格”。

### 4.5 构图评分（观察）

页面里有完整的评分项（i18n 键）：

```text
mod_balloon   气泡空间
mod_face      说话者脸部可见
mod_flow      阅读流
mod_grammar   分镜语法
mod_head      头部空间与裁切
mod_intent    镜头是否符合意图
mod_lead      视线引导空间
mod_main      主角是否最大
mod_overlap   脸是否重叠
mod_role      镜头是否符合角色
mod_thirds    三分法
mod_variety   镜头多样性
```

这说明 Name Gacha 的“自动放置人物 atari”不是纯随机，而是：

```text
候选镜头/人物位置
  → 规则评分（脸、视线、气泡、裁切、三分法、镜头多样性）
  → 选高分方案
  → 输出可编辑的 atari
```

这与 `pcPick` 的存在吻合。具体权重和评分函数未逐行还原。

### 4.6 人物姿势模块（观察 + 推断）

- 有骨骼/关节/头部图层（`pe-bones`、`pe-hd`）。
- 支持“写す人 / ショット / 向き / 高さ / レンズ / 傾き”等参数。
- 人物素材按 `CAST_IDS` 加载。
- 推断：姿势由关节角度/骨架参数生成，再根据镜头参数投影到 2D；脸部朝向、视线、气泡位置参与评分。

### 4.7 其它模块

- **フキダシ**：气泡轮廓 + 尾巴 + 文本布局；可能是参数化贝塞尔/多边形。
- **効果線**：集中线/速度线，通常是从焦点向外放射的线段 + 随机扰动。
- **擬音**：拟声词排版，字体/旋转/描边/渐变。
- **背景**：可能是程序化背景或素材组合，未深入。

### 4.8 复刻要点

最小分镜生成器：

1. 定义 `rowW/colW` 权重。
2. `fitMin` 分配行高/列宽。
3. 生成矩形格子。
4. 加入 `rowTilt/colTilt`，用四边形检查 + 逐级降级。
5. 加入 `nest` 和 `bleed`。
6. 导出 SVG。
7. 最后再加评分和人物 atari。

---

## 5. 三个项目的共同设计模式

这部分是最值得学习的，不是具体算法，而是工程方法。

### 5.1 用“设计图 + 噪声”而不是纯噪声

World Gacha 的地形不是 `fbm` 直接当高度，而是：

```text
语义参数（海岸在哪、河往哪流、山多高）
  + 低频噪声（自然感）
  + 高频噪声（细节）
  + 解析式约束（河床、谷底、海平面）
```

纯噪声只能得到“随机地形”；加入设计图才能得到“像某个地方的 terrain”。

### 5.2 分节点 seed

```text
总 seed
  ├─ design seed
  ├─ terrain seed
  ├─ erosion seed
  ├─ town seed
  ├─ streets seed
  ├─ buildings seed
  └─ outskirts seed
```

好处：

- 可以只重抽一个阶段。
- 可以锁定喜欢的阶段。
- 缓存粒度清晰。
- 分享链接可以只携带变化的节点 seed。

### 5.3 生成 + 校验 + 降级

- World Gacha：Worker 失败 → 主线程 `WGE.generate`。
- Name Gacha：`realizeSafe` 逐级降低倾斜，最后退化。
- Background Gacha：`canPlace` / `problems` 检查，放不下就换位置或跳过。

程序化生成不能假设“生成一定合法”，必须有可解释的降级路径。

### 5.4 内容注册表

Background Gacha 的 472 个生成器、70+ 房间类型，说明它把内容做成了注册表：

```js
registerGen("school_chair", (rng, style) => { ... })
registerRoom("classroom", { recipe: {...} })
registerMat("wood", {...})
```

新增内容不需要改主流程。这是能扩展到 4MB 内容库的关键。

### 5.5 状态可序列化

- World Gacha：recipe JSON + URL。
- Background Gacha：state + frozen 状态。
- Name Gacha：seed + genome + 参数。

所有随机结果都能由“状态 + seed”重建，而不是保存最终网格。这让分享链接很小。

### 5.6 多级细节（LOD）

World Gacha：

- 近景 300m/600m/1km 精细建模。
- 远景用简化体块/贴片。
- 树木远处用 billboard。

Background Gacha：

- 房间内精细家具。
- 平面图用简化符号。

这是浏览器里跑大场景的必要设计。

---

## 6. 如何继续逆向（可操作流程）

### 6.1 抓取与解包

```bash
mkdir -p /tmp/oyasumi-re && cd /tmp/oyasumi-re
for p in namegacha haikeigacha worldgacha; do
  curl -sL "https://tools.oyasumi-gamedev.com/$p/" -o "$p.html"
done
curl -sL "https://tools.oyasumi-gamedev.com/worldgacha/lib/world_worker.js" -o world_worker.js
```

### 6.2 美化

```bash
npx --yes terser@5 world_worker.js -b beautify=true,indent_level=1 -o world_worker.pretty.js
```

未压缩的 Name Gacha 可以直接用编辑器的格式化。

### 6.3 找入口

优先搜索这些模式：

- `const XXX = {}` / `Object.assign(XXX, {...})`：模块导出。
- `generate:` / `registerGen` / `registerRoom`：生成入口。
- `new Worker` / `postMessage`：Worker 协议。
- `mulberry32` / `hash3` / `strSeed`：RNG。
- `localStorage` / `URLSearchParams`：状态持久化。
- `GLTFExporter` / `toDataURL` / `Blob`：导出。

### 6.4 运行时探针

在浏览器 DevTools 里可以：

1. 给 `WGE.generate` / `HGE.generate` / `NG.generate` 打断点。
2. 包装 RNG，记录每次调用的参数和返回值。
3. 固定 seed，只改一个参数，做 A/B 对比。
4. 导出中间高度场/网格，和最终画面对照。

### 6.5 差分实验

最有效的手段：

```text
固定 seed
  → 生成基准
只改 size / res / chaos / 一个数值
  → 生成变体
比较高度场、河网、建筑数量、布局
```

这比逐行读压缩代码更快地建立参数直觉。

---

## 7. 复刻路线与工作量估计

### 7.1 推荐顺序

| 阶段 | 目标 | 预估 |
|---|---|---|
| 1 | World Gacha：RNG + 一种地形 + 高度场 + 2D 可视化 | 1–2 天 |
| 2 | World Gacha：水滴侵蚀 + 填洼/流向 + 河网 | 2–3 天 |
| 3 | World Gacha：分区 + 道路 + 地块 + 建筑标签 | 3–5 天 |
| 4 | Background Gacha：网格 + 教室 shape/open/zone/place | 2–3 天 |
| 5 | Background Gacha：10 个家具生成器 + three.js | 2–4 天 |
| 6 | Name Gacha：genome + realize + 四边形校验 | 1–2 天 |
| 7 | Name Gacha：评分 + 人物 atari | 3–5 天 |
| 8 | 导出/分享/recipe | 2–3 天 |

这是“理解并重写”的工作量，不是复制粘贴。原项目的完整内容量（472 个家具生成器、9 种地形、7 个漫画模块）远大于此。

### 7.2 最小可运行 demo 的技术选型

- 语言：TypeScript。
- 构建：Vite。
- 渲染：Canvas 2D（地形/分镜）+ three.js（3D）。
- RNG：mulberry32 + FNV-1a hash。
- 噪声：value noise + fBm + ridged。
- 网格：`Float32Array`，索引 `y * n + x`。
- Worker：`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`。
- 导出：`canvas.toBlob`、`GLTFExporter`。

---

## 8. 难度与风险

### 8.1 难度评级

| 项目 | 算法难度 | 代码可读性 | 内容量 | 总体 |
|---|---|---|---|---|
| World Gacha | 高（地形/水文/城镇） | 中（Worker minified） | 中 | ★★★★☆ |
| Background Gacha | 中（约束放置） | 低（4MB、546 块） | 极高（472 生成器） | ★★★★★ |
| Name Gacha | 中（几何 + 规则评分） | 中（核心函数名保留） | 中 | ★★★☆☆ |

### 8.2 主要风险

1. **版权**：不能直接搬运代码/数据/美术资源。
2. **压缩变量名**：World Gacha Worker 的函数名被缩短，需要靠调用关系和字符串推断。
3. **内容量**：Background Gacha 的家具生成器数量巨大，完整复刻不现实。
4. **渲染管线**：线画/网点/贝塔的 shader 细节未分析，可能需要大量视觉调参。
5. **未运行验证**：本文的算法描述基于静态代码，未做像素级对比。

### 8.3 尚未分析

- World Gacha 的 three.js 材质、线画/网点 shader、LOD 细节。
- Background Gacha 的 472 个家具生成器的具体几何。
- Name Gacha 的 pose/fuki/kouka 具体几何与评分权重。
- 导出格式的完整字段。
- 移动端/触摸交互。

---

## 9. 一句话总结

这三个工具的核心不是“AI 生成”，而是**把领域知识写成参数化规则 + seeded RNG + 约束求解 + 多级降级**：

- World Gacha：把地形学写成设计图、侵蚀和水文。
- Background Gacha：把室内设计写成网格、区域、放置规则和内容注册表。
- Name Gacha：把漫画分镜写成基因组、几何求解和构图评分。

这类代码的逆向价值很高，因为它展示了一套可复用的“程序化内容生成（PCG）工程范式”，而不是某个黑盒模型。只要遵守版权边界，完全可以用自己的实现复现同样的设计思想。

---

## 10. 配套 MVP：Terrain Gacha Lab

为了验证第 2 章的管线，已在 [`本仓库`](../) 写了一个独立实现的教学用 MVP：

- 三种地形：河谷、海岸坡地、山间温泉谷。
- seeded RNG、参数化设计图、fBm/ridged 噪声、域扭曲。
- 水滴侵蚀 + 热侵蚀 + 平滑。
- priority-flood 填洼、D8 流向、汇流累积、距离场。
- 可达性分区：中心、住宅、农田、工业、集落。
- 放射主干道 + 不规则环路 + 支路，沿路地块与建筑 footprint。
- 彩色/高度/坡度/汇流/城镇/3D 六种视图；城镇视图自动缩放到城镇范围。
- three.js 3D：地形 mesh、水面、道路带、实例化建筑；拖动旋转、滚轮缩放、双击切换全图/城镇。
- 平滑矢量河网、海岸深度渐变、PNG/JSON 导出（含建筑数据）。
- Node 冒烟测试、城镇测试与浏览器实测。

运行：

```bash
cd worldgacha-mvp
npm run serve
# 打开 http://localhost:5173
npm test
```

这个 MVP **不包含原项目代码、参数表或素材**，只用来验证“设计图 → 高度场 → 侵蚀 → 水文 → 可达性分区 → 道路/建筑 → 可视化”这条链路。原项目更完整的铁路/车站、地块产权、3D LOD/材质/室内，以及 GLB/SVG/heightmap 导出仍未复刻，属于后续工作。
