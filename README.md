# 舞台监督工作台

两个相互独立的 Web 入口共用一套服务：

1. **演出场次控制台**：舞台监督创建场次（`待演`），开演后进入 `运行中`，
   可在运行与暂停间切换，运行时逐条登记整数 cue，结束后查看**封存的只读时间线**。
   所有变更携带 `expectedVersion`（乐观并发）与 `requestId`（请求去重），
   经两级串行裁决——进程级全局准入（`requestId` 全局唯一）与单场次串行
   裁决——后一次提交；被拒绝时数据与版本保持不变。
2. **Cue 序列偏差校验**：在开演间隙核对**计划 cue 序列**与**现场触发序列**
   的偏差是否在容许阈值内。序列为 32 位有符号整数数组（各 ≤ 50000 项），
   阈值 K 为 0–500 的整数。

## 距离定义与算法

- 元素仅按**整数相等**比较；插入、删除各计 1，**替换计 2**（等价于删除+插入）。
- 真实距离 ≤ K 时返回**精确整数**；超过 K 时只返回 `exceeded` 信号。
- 核心实现（`server/src/distance.ts`）是**对角带有界动态规划**：任何满足
  |i − j| > K 的格子距离必然大于 K，不可能出现在预算内的最优路径上，
  因此只计算 |i − j| ≤ K 的带状区域。
  - 时间 O((n + m) · K)：50000 项、K = 500 时约 5×10⁷ 次基本操作；
  - 内存 O(m)：两行滚动数组（约 400 KB），**不构造 O(nm) 矩阵**；
  - 长度差 |n − m| > K 时直接判定超限；
  - 不调用任何差异比较库。

## 服务组成

| 服务     | 说明 |
| -------- | ---- |
| `server` | Fastify API（容器内 3000 端口）：距离校验 + 场次命令裁决（内存存储） |
| `web`    | React 静态页 + nginx `/api` 反向代理，宿主端口由 `WEB_PORT` 覆盖（默认 8080） |
| `verify` | 一次性验收服务：参考值、5 万项样本、越界结论、场次全生命周期（经 Web 代理）、宿主端口覆盖 |

## 运行（Docker Compose）

```bash
# 启动 Web 与 API（宿主端口默认 8080，可用 WEB_PORT 覆盖）
WEB_PORT=9000 docker compose up --build web

# 跑一次性验收（自动拉起依赖，退出码即验收结果）
docker compose up --build --exit-code-from verify verify
```

浏览器访问 `http://localhost:${WEB_PORT:-8080}`，默认进入「演出场次控制台」页签：
填写名称即可创建场次，随后开演 / 暂停 / 继续 / 结束，运行中逐条登记整数 cue，
结束后时间线封存为只读；也可以粘贴场次 ID 重新载入快照（等价于刷新页面）。
另一页签保留原有的「Cue 序列偏差校验」：两个 JSON 数组编辑区 + 阈值 K，
点击「比较」后显示精确偏差距离或超限信号。

## API

### `POST /api/distance`

请求体（标准 JSON 基础类型，不解释文本格式）：

```json
{ "a": [101, 102, 103], "b": [101, 103], "k": 3 }
```

- `a` / `b`：32 位有符号整数数组，长度各 ≤ 50000；
- `k`：整数，0 ≤ k ≤ 500。

响应（200）：

```json
{ "status": "ok", "distance": 1, "k": 3, "lengths": { "a": 3, "b": 2 } }
{ "status": "exceeded", "k": 3, "lengths": { "a": 3, "b": 2 } }
```

错误响应（稳定错误码，4xx）：

```json
{ "error": { "code": "INVALID_ELEMENT", "message": "..." } }
```

| 状态码 | code | 含义 |
| ------ | ---- | ---- |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 400 | `INVALID_BODY` | 顶层不是对象或字段缺失/类型不符 |
| 400 | `INVALID_ELEMENT` | 元素非 32 位有符号整数 |
| 400 | `ARRAY_TOO_LONG` | 数组超过 50000 项 |
| 400 | `INVALID_K` | K 非 0–500 整数 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体过大 |

另有 `GET /api/health` 返回 `{ "status": "ok" }`。

## 演出场次 API

会话保存在服务端内存中（单实例）。场次字段：`id`、`name`、`status`、
`version`、`requestId`（最近一次已提交命令的请求标识）、有序 `cues`。
请求标识的全局归属（标识 → 首次提交的场次）由独立的进程级登记表维护，
不随场次快照暴露。

状态机（非法迁移一律拒绝）：

```
pending ──▶ running ◀──▶ paused
               │            │
               └──▶ ended ◀──┘   （ended 为终态）
```

### `POST /api/performances/commands`

统一命令入口（React 端唯一的写入入口），每个命令都带 `requestId`；
除创建外都带 `expectedVersion`。

创建场次（服务端生成 ID，初始 `pending`、`version = 1`）：

```json
{ "command": "create", "name": "9 月 17 日晚场", "requestId": "uuid-1" }
```

状态推进（`status` ∈ `running` / `paused` / `ended`）：

```json
{ "command": "transition", "performanceId": "<id>", "status": "running",
  "expectedVersion": 1, "requestId": "uuid-2" }
```

登记 cue（`cue` 为 32 位有符号整数，仅 `running` 可写入，追加到有序时间线）：

```json
{ "command": "registerCue", "performanceId": "<id>", "cue": 101,
  "expectedVersion": 2, "requestId": "uuid-3" }
```

成功响应（200）返回提交后的快照：

```json
{ "status": "ok",
  "performance": { "id": "...", "name": "...", "status": "running",
    "version": 3, "requestId": "uuid-3", "cues": [101] } }
```

裁决采用两级串行：

1. **进程级全局准入闸（FIFO）**：`requestId` 在**整个服务生命周期内全局唯一**，
   不按场次划分。准入临界区内原子完成「查重/占用标识 + 进入该场次队列」；
   同标识跨场次并发（含创建与既有场次修改并发）时，只有先到的一条能占用标识，
   败方在准入阶段即以 `DUPLICATE_REQUEST` 被拒绝，**不触碰任一场次的状态、版本或
   cue**。已提交的标识登记其**首次归属场次**，后续无论重放到哪一场次（乃至不存在
   的场次）都稳定返回指向首次归属的 `DUPLICATE_REQUEST`，且重复判定优先于
   `SESSION_NOT_FOUND`。
2. **单场次串行链（读取—校验—写入原子完成）**：要么提交一次，要么拒绝且数据、
   版本不变；被拒绝命令的标识占用会随拒绝释放，因此可更正条件后用同一标识重试。

具体规则：

- `expectedVersion` 与当前版本不一致 → `VERSION_CONFLICT`；
- 状态不在合法迁移表内 → `ILLEGAL_TRANSITION`；
- 非 `running` 态登记 cue → `NOT_RUNNING`；
- `requestId` 已提交过（跨场次、含创建命令与并发重放；或同标识另有命令在途）
  → `DUPLICATE_REQUEST`，重复请求没有任何副作用，错误信息始终指明首次归属场次；
  重放目标不存在时仍为 `DUPLICATE_REQUEST`（不会先返回 `SESSION_NOT_FOUND`）。
- 全新 `requestId` 引用不存在的场次时仍为 404 `SESSION_NOT_FOUND`，且该拒绝
  不消耗标识，更正目标后可照常提交。

### `GET /api/performances/:id`

React 端唯一的读入口，按 ID 载入快照（刷新页面后据此恢复）：

```json
{ "status": "ok", "performance": { "...": "..." } }
```

### 场次相关错误码

| 状态码 | code | reason | 含义 |
| ------ | ---- | ------ | ---- |
| 404 | `SESSION_NOT_FOUND` | — | 查询或命令引用了不存在的场次（**已提交** requestId 的重放除外：恒为 409 `DUPLICATE_REQUEST` 并指向首次归属） |
| 409 | `COMMAND_REJECTED` | `ILLEGAL_TRANSITION` | 非法状态迁移 |
| 409 | `COMMAND_REJECTED` | `NOT_RUNNING` | 非运行态登记 cue |
| 409 | `COMMAND_REJECTED` | `DUPLICATE_REQUEST` | 请求标识重复 |
| 409 | `COMMAND_REJECTED` | `VERSION_CONFLICT` | `expectedVersion` 过期 |
| 400 | `INVALID_BODY` / `INVALID_CUE` / `INVALID_JSON` | — | 命令信封非法 |

错误体形如 `{ "error": { "code": "COMMAND_REJECTED", "reason": "VERSION_CONFLICT", "message": "..." } }`。

## 本地开发

```bash
# 服务端：类型检查 + Vitest（算法边界、随机对拍、5 万项样本、API 校验、
# 场次状态机、同版本并发仅一条提交、失败后同标识可重试，以及跨场次/创建与
# 修改/换目标重放三组屏障交错下的全局 requestId 唯一归属）
cd server && npm install && npm test

# 前端（开发服务器代理 /api 到 localhost:3000）
cd web && npm install && npm run dev
```
