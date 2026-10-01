# 事件溯源 + 读写分离（CQRS）记账后端框架

以**事件溯源（Event Sourcing）**为写模型、**读写分离（CQRS）**为查询模型的小型框架，配一个朴素的 React 管理后台。所有对聚合（账户）的变更都以不可变事件按序追加进事件流，绝不原地修改、绝不删除历史；任意时刻的状态由事件回放重建。

## 快速开始

### Docker Compose（一键起全栈）

```bash
docker compose up --build
```

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| 前端管理后台 | http://localhost:8080 | nginx 托管 SPA，`/api` 反代到后端 |
| 后端 API | http://localhost:3000/api | Fastify |
| PostgreSQL 16 | localhost:5432 | 用户/密码 `es`/`es`，库 `event_sourcing` |

后端启动时自动等待数据库就绪并执行幂等迁移（建表、约束、不可变触发器）。

### 本地开发

```bash
# 1. 起数据库
docker compose up -d db

# 2. 后端（自动迁移，监听 3000）
cd backend && npm install && npm run dev

# 3. 前端（监听 5173，/api 代理到 3000）
cd frontend && npm install && npm run dev
```

### 跑测试

测试需要真实 PostgreSQL（并发行锁、不可变触发器、唯一约束都是数据库级行为）：

```bash
docker compose up -d db          # 测试库 event_sourcing_test 会自动创建
cd backend && npm test
```

## 核心概念与硬规则

### 事件溯源

- **事件即事实**：对聚合的所有变更都是一条条不可变事件，按序追加进该聚合的事件流。
- **不可变**：事件落库后不可更改、不可删除。应用层不提供任何更新/删除接口，数据库层还有触发器兜底，拒绝 `UPDATE` / `DELETE` / `TRUNCATE`。
- **连续版本号**：每条事件在所属聚合内有从 1 开始、严格递增且连续的版本号。追加在事务内完成：先 `SELECT ... FOR UPDATE` 锁住聚合登记行，再逐条分配版本写入，`UNIQUE(aggregate_id, version)` 作为最后防线。
- **状态 = 事件的重放**：聚合当前状态 = 从初始状态出发，依次应用它的全部事件。

### 乐观并发控制

追加时必须携带调用方认为的当前版本 `expectedVersion`：

- 与服务端实际最新版本一致 → 追加成功，版本 +1；
- 不一致（中间有人先写了）→ **409 VERSION_CONFLICT**，不写入任何事件，调用方拿最新状态重试；
- 同一聚合上 N 个并发提交同一版本：只有 1 个成功，其余全部冲突（测试锁定）。

### 对"不存在的聚合"的追加策略（二选一，本框架的选择）

**隐式创建**：`expectedVersion = 0` 的追加视为创建该聚合，首条事件版本为 1；`expectedVersion > 0` 而聚合不存在时明确拒绝（**404 AGGREGATE_NOT_FOUND**）——调用方声称基于一个从未存在过的历史版本，请求必有误。领域层再叠加一层规则：账户的第一条命令必须是 `CreateAccount`，存款/取款不会"顺手"创建账户。

### 快照

- 快照记录"到某个版本为止重建出的状态"，是纯粹的派生数据，唯一用途是加速重建。
- 重建时取不超过目标版本的最近快照作为起点，再回放剩余事件。
- **不变量：无论走不走快照、快照打在哪个版本，重建结果必须与全量重放逐字段相等**（测试锁定：快照打在每个可能的版本上逐一验证）。
- 快照版本必须落在 `1..当前版本` 内，否则 **400 SNAPSHOT_VERSION_OUT_OF_RANGE**。

### 读写分离（CQRS）

- **写侧**：命令 → 业务校验 → 事件 → 追加进事件流。
- **读侧**：投影（projection）把事件流消费成便于查询的视图（账户列表 + 余额汇总），存于独立的读模型表。
- 命令提交成功后，后端自动让投影**增量消费**新事件；读模型是派生物，滞后时可随时修复。
- **全量重放**：清空读模型，从头消费整条事件流重新计算。**框架最要命的不变量：重放结果与增量消费结果完全一致**（测试锁定，并与用领域折叠函数独立算出的模型三方对账）。

> **消费依据是「聚合流」而不是全局序号**：`events.global_seq` 在 INSERT 时取号、在 COMMIT
> 后才对其它事务可见，跨聚合并发下取号顺序 ≠ 提交可见顺序，按全局序号前缀推进会永久跳过
> 晚提交的事件。增量消费按 `(aggregate_id, version)` 逐流推进，每个流内部版本严格连续、
> 永无空洞。完整事故复盘、方案对比与正确性论证见 [`docs/projection-consistency.md`](docs/projection-consistency.md)。
>
> **落后可见**：读模型接口新增 `eventTotal / processedEvents / lagEvents / caughtUp`，
> 跟进失败、写入在途或重放进行中都会如实显示落后，绝不再用"已处理序号"谎报追平。
> 除写后同步跟进外，后端启动时先补一次增量，并带一个可关闭的兜底轮询
> （`PROJECTION_CATCH_UP_POLL_MS`，默认 1000ms，设为 0 关闭）。

### 业务校验

所有业务约束（账户必须存在、金额必须为正整数、**余额不能被取成负数**……）都在**生成事件之前**于领域层校验；不合法直接报错，**不产生任何事件**（测试逐条锁定：失败命令后事件流长度不变）。

## 模块划分

```
backend/
├── src/
│   ├── index.ts                    # 启动入口：连库 → 迁移 → 起 HTTP
│   ├── config.ts                   # 环境配置
│   ├── errors.ts                   # 统一错误类型（code + HTTP 状态码）
│   ├── db/
│   │   ├── pool.ts                 # pg 连接池
│   │   ├── schema.ts               # 幂等 DDL（含事件不可变触发器）
│   │   └── migrate.ts              # 迁移与数据库就绪等待
│   ├── events/
│   │   ├── types.ts                # StoredEvent / NewEvent / Snapshot
│   │   ├── eventStore.ts           # 事件存储：追加（乐观并发）、区间读取、全局流
│   │   └── snapshotStore.ts        # 快照读写
│   ├── domain/
│   │   └── account.ts              # 账户聚合：evolve（应用事件）+ decide（校验并生成事件）
│   ├── aggregates/
│   │   ├── rebuilder.ts            # 通用重建器：最近快照 + 剩余事件回放
│   │   └── accountService.ts       # 命令编排：重建 → 校验 → 追加 → 投影跟进
│   ├── projections/
│   │   └── accountProjection.ts    # 读模型投影：按聚合流增量消费 + 全量重放
│   └── http/
│       ├── server.ts               # Fastify 实例、统一错误映射
│       ├── validate.ts             # 请求入参形状校验
│       └── routes/
│           ├── aggregateRoutes.ts  # 聚合 / 事件 / 快照接口
│           └── projectionRoutes.ts # 读模型接口
├── scripts/                        # 手工压测脚本（并发写入 / 重放与写入并发）
└── test/                           # 不变量测试（真实 PostgreSQL）
    ├── eventStore.test.ts          #   追加语义、版本连续、区间读取、不存在聚合策略
    ├── concurrency.test.ts         #   同版本并发提交只有一条成功
    ├── snapshot.test.ts            #   快照重建 ≡ 全量重放（逐字段）
    ├── projection.test.ts          #   投影全量重放 ≡ 增量消费
    ├── projectionConcurrency.test.ts # 多账户并发写入后增量读模型 ≡ 独立回放（漏事件回归）
    ├── immutability.test.ts        #   事件不可改、不可删、顺序不变
    ├── domain.test.ts              #   余额不为负等业务校验，不产生事件
    └── http.test.ts                #   API 流程与错误码

frontend/
└── src/
    ├── api.ts                      # API 客户端（前端不自己算业务）
    ├── types.ts                    # 与后端对应的类型
    ├── pages/
    │   ├── AccountListPage.tsx     #   账户列表（读模型）+ 创建账户
    │   ├── AccountDetailPage.tsx   #   状态 / 追加事件 / 快照 / 事件时间线 / 历史状态
    │   └── ProjectionPage.tsx      #   读模型视图 + 全量重放
    └── ...
```

## HTTP API

统一错误响应：`{ "error": { "code", "message", "details" } }`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/aggregates` | 聚合登记表（写侧元数据） |
| GET | `/api/aggregates/:id/state?atVersion=` | 重建当前（或指定版本）状态，返回是否基于快照 |
| GET | `/api/aggregates/:id/events?fromVersion=&toVersion=` | 按版本区间取事件序列 |
| POST | `/api/aggregates/:id/commands` | 执行命令（校验后生成并追加事件）。Body: `{command, expectedVersion}` |
| POST | `/api/aggregates/:id/snapshots` | 手动打快照。Body: `{version?}`（缺省当前版本） |
| GET | `/api/aggregates/:id/snapshots` | 该聚合的全部快照 |
| GET | `/api/projection/accounts` | 读模型：账户列表 + 余额汇总 + 消费位点 + 落后情况（`caughtUp`/`lagEvents`） |
| POST | `/api/projection/accounts/replay` | 对读模型做全量重放并返回结果（可与写入并发；切点后的事件由增量消费补齐） |

命令类型：`CreateAccount {owner, initialBalanceCents?}`、`DepositMoney {amountCents}`、`WithdrawMoney {amountCents}`。金额一律以**分**为单位的整数。

### 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 入参不合法（金额非正整数、区间参数错误等） |
| `AGGREGATE_NOT_FOUND` | 404 | 聚合不存在（含 expectedVersion>0 追加到不存在的聚合） |
| `VERSION_CONFLICT` | 409 | 乐观并发冲突：expectedVersion 与服务端最新版本不符 |
| `AGGREGATE_ALREADY_EXISTS` | 409 | 重复创建同一聚合 |
| `VERSION_OUT_OF_RANGE` | 400 | 重建目标版本超出已有事件范围 |
| `SNAPSHOT_VERSION_OUT_OF_RANGE` | 400 | 快照版本超出已有事件范围 |
| `INSUFFICIENT_FUNDS` | 422 | 余额不足（业务规则，未产生任何事件） |

## 不变量与测试对照

| 不变量 | 测试 |
| --- | --- |
| 同一聚合并发提交同版本，只能成功一条，其余报冲突 | `test/concurrency.test.ts` |
| 带快照重建与不带快照全量重放，状态逐字段相等 | `test/snapshot.test.ts` |
| 投影全量重算与增量消费结果完全一致 | `test/projection.test.ts` |
| 多账户高并发写入后，增量读模型（不重放）与各账户事件流独立回放逐字段一致；重放与写入并发同样不丢事件；跟进失败时接口如实报落后 | `test/projectionConcurrency.test.ts` |
| 事件流一旦写入，内容与顺序不被后续操作改变 | `test/immutability.test.ts` |
| 版本号严格递增连续；版本不连续/范围错误有明确报错 | `test/eventStore.test.ts`、`test/snapshot.test.ts` |
| 余额不能为负等业务约束在生成事件前校验，不合法不产生事件 | `test/domain.test.ts` |
| API 层错误响应码正确 | `test/http.test.ts` |

## 技术栈与边界

- 后端：Node.js 20 + TypeScript（ESM）+ Fastify 5 + PostgreSQL 16（`pg` 直连，无 ORM）
- 前端：React 18 + Vite + React Router，无 UI 框架
- 测试：Vitest，打真实 PostgreSQL
- 编排：Docker Compose（db / backend / frontend）
- **范围之外**（按要求不做）：权限与登录、多聚合事务、事件升级（upcasting）。投影没有独立的
  持久化订阅守护进程：写后同步跟进 + 启动增量补齐 + 可关闭的兜底轮询（默认 1s）即可保持一致，
  且任何落后都能从读模型接口直接看出来。
