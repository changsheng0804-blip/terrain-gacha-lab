# 模块契约

本文件是跨 agent / 跨模型协作时的接口基准。实现可以优化内部细节，但不得静默改变这里的字段语义。
新增字段优先；破坏性变更必须先写 ADR 并通知所有依赖任务。

## 通用规则

- 坐标：世界坐标 `(x, z)`，单位米；网格索引 `i = y * n + x`。
- 高度：米，海平面为 `y = 0`。
- 随机：所有随机流使用 `rngFor(seed, 'domain:...')`，禁止 `Math.random()`。
- 数组：大数组使用 typed array；返回后由调用方只读。
- 可选参数：新增参数放在末尾并给默认值，保持旧调用可用。
- 版号：修改模块后同步递增 `?v=`；集成者负责 `index.html` 的 `main.js?v=`。

## HeightField

`generateHeightField(type, seed, size, res)` 返回：

```js
{
  n,          // number，网格边长
  cell,       // number，格子边长（米）
  size,       // number，地图边长（米）
  x0, y0,     // number，网格左下/左上原点
  height,     // Float32Array(n*n)，米
  params,     // object，地形设计参数
  terrain,    // object，{ id, label, hasSea, tune, ... }
  seed,       // number（T00 新增；当前尚未加入）
}
```

不变式：

- `height` 长度 = `n*n`。
- `cell = size / (n - 1)`。
- 同一 `type + seed + size + res` 的高度场确定。
- `terrain.tune.minA` 的单位是平方米。

## Hydrology

`buildHydrology(field, { outlet })` 返回：

```js
{
  filled, order, orderLength, dir, drop, acc,
  maxAcc, minAcc,
  seaMask, riverMask, riverCells,
  dSea, dRiver, dLand,
}
```

计划新增（T06，保持旧字段）：

```js
{
  lakeMask,   // Uint8Array，内陆湖
  waterMask,  // Uint8Array，seaMask | lakeMask
  dLake,      // Int32Array，到湖的距离（格）
  riverWidth, // Float32Array，米
  falls,      // [{ x, z, drop }]
}
```

语义：

- `seaMask` 仍只表示 `height <= 0` 的海/外海。
- `lakeMask` 不包含 `seaMask`。
- `dSea` 单位是格；渲染转米时乘 `field.cell`。
- `dir` 是 D8 方向；`-1` 表示无下游。

## Town

`generateTown(field, hydro, seed)` 返回：

```js
{
  zones, zoneStats, center,
  roads, railway, station, parcels, buildings, stats,
}
```

计划新增（T04，保持旧字段）：

```js
{
  amenities: {
    plaza: { x, z, w, d, angle, kind: 'station' } | null,
    port: { x, z, angle, length, width } | null,
    bridges: [{ kind: 'road' | 'rail', x, z }],
  },
  parcels: [{
    index, x, z, angle, w, d, zone, road, built,
    kind: 'urban' | 'field',
    crop: 'rice' | 'vegetable' | null,
  }],
}
```

不变式：

- `parcels` 与 `buildings` 不重叠；`built` 表示是否有建筑。
- 车站存在时，站房类型为 `'station'`。
- 铁路路径点都在陆地上；海岛地形终点在外海岸。
- 同 `field + hydro + seed` 的城镇确定。

## Ecology（计划，T01）

`buildEcology(field, hydro, town = null)` 返回：

```js
{
  moisture, // Float32Array 0..1
  forest,   // Float32Array 0..1
  rock,     // Float32Array 0..1
  snow,     // Float32Array 0..1
  beach,    // Uint8Array 0/1
  biome,    // Uint8Array，BIOME.*
  stats: {
    forestPct, grassPct, rockPct, snowPct, beachPct, wetlandPct,
  },
}
```

`BIOME`：

```js
WATER: 0, BEACH: 1, GRASS: 2, FOREST: 3,
ROCK: 4, SNOW: 5, WETLAND: 6
```

不变式：

- 数组长度 = `n*n`。
- `forest` 在水面为 0；`snow` 在雪线以上显著。
- `biome` 优先级：水 > 沙滩 > 雪 > 岩 > 湿地 > 森林 > 草地。
- `stats.*Pct` 是整网格中对应 biome 的像元百分比；六项 + 水面百分比 = 100。
- 同 seed 的生态场确定。
- 不修改 `field` / `hydro` / `town` 输入。

## 渲染接口

### 2D

```js
renderTerrain(canvas, field, hydro, town, view, showTown, ecology = null)
```

- `view`: `'color' | 'height' | 'slope' | 'flow' | 'town'`。
- `ecology` 为空时由 render 内部构建，保持旧调用。
- 返回 `{ minH, maxH, riverPaths, riverSample, viewBounds, ... }`；新增字段只能追加。
- 渲染层只读输入。

### 3D

```js
const view = create3DView(canvas);
view.update(field, hydro, town, showTown, resetCamera);
```

计划新增可选生态参数（T03）：

```js
view.update(field, hydro, town, showTown, resetCamera, ecology = null)
```

- `view.capture()` 返回 PNG data URL。
- `view.debug()` 返回可观察计数；新增字段只能追加。
- 3D 最大地形网格 512；树/建筑的实例上限由任务卡规定。

## Worker 管线（计划，T09）

```js
generateWorld({ type, seed, size, res, erosion }) -> {
  field, hydro, town, droplets, timings,
}
```

- 纯函数式：不访问 DOM、canvas、window。
- 同一参数与主线程路径结果一致。
- Worker 消息：
  - `{ type: 'progress', phase, value }`
  - `{ type: 'done', result }`
  - `{ type: 'error', message, stack }`

## 变更流程

1. 在任务卡/ADR 中写明字段、语义、影响任务。
2. 更新本文件。
3. 实现新字段（优先追加，保留旧字段）。
4. 下游任务按新契约适配。
5. 集成者跑全量测试，递增版号，更新 README。
