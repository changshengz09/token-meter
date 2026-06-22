# logs 表改造规划：批量异步写入 + 按月分区

> 状态：草稿 v2，待实施
> 适用阶段：开发阶段（可直接 DROP 重建 logs 表，无需考虑历史数据 / 历史表结构迁移）
> 背景：100 万用户量级下 `logs` 表预计 ~1000 万条/天（中等场景），峰值 350~600 INSERT/s。
> 目标：
> 1. **批量异步写入** —— 降低写入语句数与请求链路延迟；
> 2. **按月 RANGE 分区** —— 降低单表规模、让过期清理由 `DELETE` 变为 `DROP PARTITION`。
>
> 两项改造**相互正交、可独立上线**：批量写入解决"语句数"，分区解决"单表规模 + 清理成本"。批量 `INSERT` 写入分区表时，MySQL 会自动把每行路由到对应分区，二者无冲突。
>
> **v2 修订说明**（对照代码核对后修正的关键点）：
> - 批量写入器**在所有节点启动**，不是 master-only（日志由处理 relay 请求的每个节点写入）。
> - 项目当前**没有任何优雅退出机制**（`main.go` 是裸 `server.Run()`）。Flush-on-exit 需先建 graceful shutdown，本方案给出"建 shutdown"与"对齐现有 fire-and-forget 取舍"两条路线，二选一。
> - 项目当前**没有任何自动日志清理调度**（`DeleteOldLog` 只被手动管理 API 调用）。保留期清理调度是**全新代码**，非"复用现有"。
> - 手动删除 API 与自动保留期清理在分区表上**走不同路径**（手动仍行删，自动才 `DROP PARTITION`）。

---

## 全局约束（务必遵守）

- **跨库兼容（Rule 2）**：项目同时支持 SQLite / MySQL / PostgreSQL。分区是 **MySQL 专属**，所有分区相关逻辑必须用 `common.LogSqlType == common.DatabaseTypeMySQL` 守卫；SQLite/PG 保持现状（不分区、单列主键、沿用 `DeleteOldLog` 行删）。
- **结构体主键不改**：`Log.Id` 在结构体里仍是单列自增主键，保证 SQLite/PG 正常。MySQL 的复合主键改造通过 **MySQL-only 原生 DDL** 完成，不写进 GORM tag。
- **DDL / 分区维护只在 master 节点执行**：迁移入口 `InitLogDB()` 已有 `if !common.IsMasterNode { return nil }` 守卫**包住迁移段**。但注意：`LOG_DB` 连接在所有节点都会建立，因此**批量写入器属于"业务写入"而非"DDL"，必须在所有节点启动**（详见 A.3）。
- **JSON 统一走 `common/json.go`**（Rule 1），本次改造涉及的 `Other` 序列化沿用现有 `common.MapToJsonStr`。

---

# Part A — 批量异步写入

## A.1 现状

消费日志路径（`service/quota.go`、`text_quota.go`、`task_billing.go`、`relay/mjproxy_handler.go` 等）最终汇聚到 `model/log.go`：

```
RecordConsumeLog(c, userId, params)  →  LOG_DB.Create(&Log{...})   // 每请求一条 INSERT
```

关键事实：
1. **同步单条 INSERT**，跑在 relay 后置计费流程里（`model/log.go:302/239/350`）。
2. **计费一致性与日志无关**：扣费 `UpdateUserUsedQuota` / `SettleBilling` 在 `RecordConsumeLog` 之前完成，日志不在同一事务 → 日志异步化不影响扣费正确性。
3. **强依赖 `gin.Context`**：函数内从 `c` 读 `username`、`request_id`、`upstream_request_id`、`ClientIP()`，并查 `GetUserSetting(userId)`。请求结束后 `c` 不可用 → **入队前必须快照成 `*Log`**。
4. **多节点写入**：`RecordConsumeLog` 在处理该 relay 请求的节点上执行，**每个业务节点都会写日志**，不只是 master。

> 既有先例：`model/utils.go:33` 的 `InitBatchUpdater()` 已是"fire-and-forget goroutine + 周期 flush"模式，且**不做退出 flush**——即项目现状本就接受"进程退出丢失内存态批量数据"。本方案的取舍需与之对齐或显式超越（见 A.6）。

## A.2 目标架构

```
RecordConsumeLog/RecordErrorLog/...
   └─ 在请求线程内构造 *Log（快照 c 的字段 + GetUserSetting）
        └─ submitLog(*Log)   // 非阻塞入队
                                      │
            后台 worker  ◄────────────┘   （每个节点各一个）
            (条数阈值 ∥ 时间阈值 双触发)
                                      │
            LOG_DB.CreateInBatches(buf, batchSize)
```

## A.3 修改清单

| 文件 | 改动 |
|---|---|
| `model/log_batch.go`（**新增**，~120 行） | 批量写入器：channel + 后台 worker + `Submit/Flush/Start/Stop` |
| `model/log.go` | `RecordConsumeLog`(:260)、`RecordErrorLog`(:199)、`RecordTaskBillingLog`(:325) 末尾的 `LOG_DB.Create(log)` → `submitLog(log)`（开关关闭时回退同步 `Create`） |
| `model/main.go` | `InitLogDB()` 中**在 master 守卫（:238）之前**启动 batcher → **所有节点都启动**（master/非 master 都写日志） |
| `main.go` | 见 A.7：**先补 graceful shutdown**，再在退出钩子里 `batcher.Flush()` + 关闭。若选择不建 shutdown，则放弃 Flush 承诺（对齐 `InitBatchUpdater` 取舍） |
| `common/`（配置） | 新增 4 个环境变量（见下） |

**保持同步直写、不进队列**：`RecordTopupLog`、`RecordLogWithAdminInfo`、`RecordLog`（充值/管理，涉及钱、量级极小）。只异步化高频的 `Consume` / `Error` / `TaskBilling`。

> ⚠️ **修订点（v1 错误）**：旧版写"batcher 在 master 节点启动"是**错的**。`InitLogDB()` 的 master 守卫只包住迁移；日志写入发生在所有业务节点。batcher 若只在 master 启动，非 master 节点上 `submitLog` 无队列可用，批量优化对多节点集群完全失效。**batcher 启动必须放在 master 守卫之前。**

## A.4 批量写入器设计要点

```go
type logBatcher struct {
    ch        chan *Log     // 容量 = LOG_BATCH_QUEUE_SIZE
    batchSize int           // LOG_BATCH_SIZE，默认 500
    flushIntv time.Duration // LOG_BATCH_FLUSH_INTERVAL_MS，默认 1000ms
}
```

- `Submit`：`select { case ch <- log: default: /* 队列满 */ }`。**队列满降级策略 = 同步直写**（保证不丢，牺牲该条性能），并计数告警。
- worker：`ticker`（flushIntv）与 `len(buf) >= batchSize` 双触发 → `LOG_DB.CreateInBatches(buf, batchSize)`。
  - **事务选型**：`CreateInBatches` 默认包事务，batchSize=500 × ~18 列 ≈ 9000 占位符/语句。建议用 `LOG_DB.Session(&gorm.Session{SkipDefaultTransaction: true})` 执行，并确认 MySQL `max_allowed_packet` 足够；注释里写明选型理由。
- 写失败：重试 1 次，仍失败 `common.SysLog` 记错（**把每条的 `request_id` 拼进日志文本**，弥补脱离 `gin.Context` 后丢失的可追溯性），避免静默丢失。
- `Flush()`：排空 channel + 落盘剩余 buf，供优雅退出调用（仅在 A.7 选路线①时有意义）。

## A.5 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LOG_BATCH_ENABLED` | `false` | 总开关，灰度上线；关闭时走原同步 `Create`，零风险回退 |
| `LOG_BATCH_SIZE` | `500` | 单批最大条数 |
| `LOG_BATCH_FLUSH_INTERVAL_MS` | `1000` | 最大攒批时间（也是日志可见性延迟上限） |
| `LOG_BATCH_QUEUE_SIZE` | `10000` | 内存队列容量 |

## A.6 风险

| 风险 | 对策 |
|---|---|
| 进程崩溃丢队列 | 日志非账务（扣费已落库），可接受；正常退出靠 A.7 Flush；队列容量别设过大 |
| 日志可见性延迟 | 最多 `flushIntv`（~1s）。注意：任何"写完日志立即按 request_id 回查"的流程会受影响；现有路径未发现此类即读，但新增功能需留意 |
| 队列打满 | 降级同步直写 + 计数告警 |
| `gin.Context` 逃逸 | **入队的是快照后的 `*Log`，绝不能把 `c` 带进 worker** |
| 多节点 batcher 未启动 | 见 A.3，batcher 在 master 守卫前启动，所有节点生效 |

## A.7 优雅退出（前置依赖，必须先决策）

> ⚠️ **修订点（v1 隐含错误假设）**：旧版 A.3 直接写"`main.go`（程序入口 shutdown 钩子）退出前 Flush"，但**项目当前没有任何 shutdown 钩子**。`main.go:207` 是裸的阻塞调用：
> ```go
> err = server.Run(":" + port)   // 无 signal.Notify、无 http.Server.Shutdown、无 graceful 关闭
> ```
> 进程收到 SIGTERM 会被直接杀死，任何 `defer`/Flush 都不会执行。因此 "退出时 Flush 不丢日志" 这个承诺**当前不成立**，必须先决策走哪条路线：

**路线①：补建 graceful shutdown（完整保证，但额外 scope）**
- 把 `server.Run(...)` 改为显式 `&http.Server{...}` + `srv.ListenAndServe()`；
- `signal.Notify` 捕获 `SIGINT/SIGTERM` → `srv.Shutdown(ctx)` → 依次 `batcher.Flush()` + `batcher.Stop()`；
- 注意关闭顺序：先停止接收新请求，再 Flush 日志队列，最后关 DB 连接。
- 工作量：这是**本方案未包含的额外基础设施**，需计入阶段 1。

**路线②：对齐现有 fire-and-forget 取舍（最简，放弃正常退出 Flush）**
- 不建 shutdown，行为与 `InitBatchUpdater`（`model/utils.go:33`，同样不做退出 flush）一致；
- 明确承认"正常退出也可能丢失最多 1 个 flush 周期（~1s，≤batchSize 条）的日志"；
- 由于日志非账务，这个丢失在多数场景可接受。

**建议**：开发阶段先走路线②（最快验证批量收益），上线前若对日志完整性有要求再补路线①。文档需明确选定其一，不能停留在"假装钩子已存在"。

---

# Part B — 按月 RANGE 分区（MySQL）

## B.1 为什么按 `created_at` 按月分区

- **清理**：当前清理只有手动管理 API（`DeleteHistoryLogs` → `DeleteOldLog`，`WHERE created_at < ?` 循环删），在十亿行表上是灾难。分区后过期数据 = `DROP PARTITION`，毫秒级、不产生大事务/binlog 膨胀。**这是分区的首要收益**。
- **裁剪**：`GetAllLogs`（`ORDER BY created_at desc` + 范围）、`SumUsedQuota` 的 rpm/tpm（`created_at >= now-60s`）、各类带时间范围的统计，都只命中近月分区。
- **粒度**：~1000 万行/天 → 月分区 ~3 亿行/分区，留 6 月仅 6 个分区，管理最省心；查询一般只碰近月。

## B.2 硬约束与设计决策

### 决策 1：复合主键 `(id, created_at)`（仅 MySQL）
MySQL 规定**分区表的每个唯一键必须包含全部分区列**。当前 PK 是单列 `id`，不含 `created_at`，必须改成 `(id, created_at)`：
- `id` 仍是前导列 → **AUTO_INCREMENT 继续有效**（绝不能用 `(created_at, id)`，否则自增失效）。
- 现有索引（`idx_created_at_id`、`idx_user_id_id`、`idx_created_at_type`、`index_username_model_name` 及各单列 index）**全部非唯一**（已对照 `model/log.go:34-56` 逐一确认），不受"唯一键须含分区列"约束，**无需改动**（保留全部索引）。
- 副作用：InnoDB 二级索引以 PK 为行指针，PK 由 4B 变 12B，二级索引体积略增，可接受。

### 决策 2：`created_at` 改为 `NOT NULL`（全库安全）
分区列建议非空。`created_at` 本就由 `common.GetTimestamp()` 必填。
- 结构体 tag 加 `not null`：`CreatedAt int64 \`gorm:"bigint;not null;index:..."\`` —— 对 MySQL 新建表生效；SQLite 的 `AutoMigrate` 不改既有列约束（开发阶段重建表即可，且 SQLite 不分区，无影响）；PG 安全。

### 决策 3：分区改造走 MySQL-only 原生 DDL，结构体 PK 不动
`AutoMigrate` 不擅长管理分区与复合 PK。流程：先 `AutoMigrate(&Log{})` 建表（PK=id），随后 MySQL-only 步骤把 PK 改成复合并加分区。开发阶段表为空/可重建，DDL 干净执行。幂等：先查 `information_schema.PARTITIONS` 判断是否已分区，已分区则跳过。

## B.3 修改清单

| 文件 | 改动 |
|---|---|
| `model/log.go` | `Log.CreatedAt` 加 `not null`（仅 tag）。其余结构体不变 |
| `model/log_partition.go`（**新增**） | MySQL-only：`ensureLogsPartitioned()`（首次分区化）+ `ensureLogPartitions()`（滚动维护）+ `dropExpiredLogPartitions()` |
| `model/main.go` | `migrateLOGDB()`(:370) 在 `AutoMigrate` 后调用 `ensureLogsPartitioned()` + `ensureLogPartitions()`（均 `LogSqlType==MySQL` 守卫；`migrateLOGDB` 已在 master 守卫内，天然 master-only） |
| `model/log.go` `DeleteOldLog`(:572) | **保持行删逻辑不变**（手动管理 API 仍走它，见 B.8 语义说明）。分区收益体现在新增的自动保留期清理路径，而非改写此函数 |
| **定时任务（全新）** | **新增** goroutine ticker：每月预建未来分区 + 删过期分区。**项目当前无任何日志清理调度可复用**，这是从零实现的新代码 |
| `common/`（配置） | 新增 3 个环境变量（见下） |

> ⚠️ **修订点（v1 错误）**：
> 1. 旧版写"复用现有清理调度"——**不存在**。`DeleteOldLog` 仅被 `controller/log.go:162` 的手动 API `DeleteHistoryLogs` 调用，全仓无周期性清理任务。分区维护调度是全新代码。
> 2. 旧版写"`DeleteOldLog` 改走 `dropExpiredLogPartitions()`"会**语义错配**（详见 B.8）。手动 API 传入任意 `target_timestamp`，与整月分区粒度不匹配，故保持行删，不改写。

## B.4 首次分区化 DDL（MySQL-only，幂等）

```sql
-- 1) created_at 已由 AutoMigrate 建为 NOT NULL（决策 2）

-- 2) 改复合主键（id 仍前导，保 AUTO_INCREMENT）
--    DROP + ADD 必须在同一条 ALTER 内完成（原子），
--    否则 DROP PRIMARY KEY 后 id(AUTO_INCREMENT) 短暂无索引覆盖会报错
ALTER TABLE logs
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (id, created_at);

-- 3) 建分区（边界为「下月 1 号 00:00:00」的 epoch 秒，由 Go 维护任务生成）
ALTER TABLE logs
PARTITION BY RANGE (created_at) (
  PARTITION p202606 VALUES LESS THAN (<epoch 2026-07-01>),
  PARTITION p202607 VALUES LESS THAN (<epoch 2026-08-01>),
  PARTITION p202608 VALUES LESS THAN (<epoch 2026-09-01>),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)   -- 兜底，防越界插入报错
);
```
- 分区名 `pYYYYMM` 对应「该月数据」，边界 = 次月起点 epoch。
- `created_at` 是 `bigint`（unix 秒），直接 `RANGE (created_at)`，无需 `TO_DAYS/FROM_UNIXTIME`。
- **边界时区**：边界整数用 `time.Date(y, m, 1, 0,0,0,0, time.UTC).Unix()` 计算（**统一用 UTC**，避免服务器时区变更/机房迁移导致月切点漂移；如需与本地展示口径一致，应显式配置固定时区并在此写死）。`time.Now()` 在应用层 Go 可用。

## B.5 分区维护（必做，MySQL 无原生自动建分区）

`ensureLogPartitions()`（启动时 + 每月调度，新增 goroutine ticker）：
- **预建未来分区**：保证当前月 + 未来 `LOG_PARTITION_LOOKAHEAD_MONTHS` 个月分区存在。新增时从 `pmax` 切分：
  ```sql
  ALTER TABLE logs REORGANIZE PARTITION pmax INTO (
    PARTITION pYYYYMM VALUES LESS THAN (<epoch 次月>),
    PARTITION pmax    VALUES LESS THAN (MAXVALUE)
  );
  ```
  > **监控**：`REORGANIZE pmax` 仅当 `pmax` 为空时是轻量操作；一旦预建滞后导致数据落进 `pmax`，REORGANIZE 会重写整段数据并持锁。应监控 `pmax` 行数，>0 即视为预建失效，需告警介入。
- **删过期分区**（`LOG_RETENTION_MONTHS > 0` 时）：
  ```sql
  ALTER TABLE logs DROP PARTITION pYYYYMM;   -- 早于保留期的分区
  ```
- 当前月分区缺失会导致写入落到 `pmax`，所以**预建必须先于跨月**——启动即跑一次 + 每月 1 号前调度。

## B.6 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LOG_PARTITION_ENABLED` | `true`（仅 MySQL 生效） | 分区总开关 |
| `LOG_PARTITION_LOOKAHEAD_MONTHS` | `3` | 预建未来几个月分区 |
| `LOG_RETENTION_MONTHS` | `6` | 自动 `DROP PARTITION` 保留月数，`0` = 永不自动 DROP |

## B.7 查询权衡（已知影响）

**统一结论：任何不带 `created_at` 谓词的查询都无法分区裁剪，需扫所有分区再归并。** 涉及：
- `GetUserLogs`（`model/log.go:445`，用户不选时间时仅 `WHERE user_id ORDER BY id desc`）。
- 按 `request_id` / `upstream_request_id` 的点查（有独立二级索引，但每分区各查一次再归并）。
- 复合 PK 后仅按 `id` 查（`WHERE id = ?`，走 PK 前缀，但无 `created_at` 谓词 → 全分区扫描）。

影响评估：
- 留 6 月 = 6 个分区，6 次索引定位 + 归并 LIMIT，仍快。
- 缓解：前端用户日志列表 / 点查接口默认带时间范围（如近 30 天）即可裁剪。

## B.8 手动删除 API 与自动保留期清理的路径区分（关键）

> ⚠️ **修订点（v1 语义错配）**：`DeleteHistoryLogs`（`controller/log.go:153`）把管理员前端传入的**任意 `target_timestamp`**（如"删除 15 天前"）交给 `DeleteOldLog`。而 `DROP PARTITION` 粒度是**整月**——若直接改走 `dropExpiredLogPartitions()`：管理员要求删"15 天前"但当月分区仍含近 15 天数据，会**整月删不掉（欠删）或误删整月**。

因此两条路径**分开处理**：

| 路径 | 触发 | 实现 | 粒度 |
|---|---|---|---|
| **手动删除** | 管理员 API `DeleteHistoryLogs` | **保持** `DeleteOldLog` 行删（分区表上 `WHERE created_at < ?` 一样能跑，只是不享受秒删收益） | 精确到秒，符合管理员预期 |
| **自动保留期清理** | 月度调度（B.5） | `dropExpiredLogPartitions()` 按 `LOG_RETENTION_MONTHS` 整月 DROP | 整月对齐，享受秒删收益 |

这样既保留管理员精确删除的语义，又在自动清理路径拿到 `DROP PARTITION` 的性能收益。

---

## 实施阶段与工作量

两部分独立，建议分两次提交：

| 阶段 | 内容 | 工作量 |
|---|---|---|
| 阶段 1 | Part A 批量异步写入（`log_batch.go` + 3 处写库改造 + 所有节点启动 + 配置 + 单测）。**若选 A.7 路线①还需 +graceful shutdown 基础设施** | ~1.5 人日（路线② / 不含 shutdown）；+0.5~1 人日（路线① graceful shutdown） |
| 阶段 2 | Part B 按月分区（`log_partition.go` + `created_at not null` + **全新月度维护调度** + 配置 + 单测）。注意维护调度是从零实现，非复用 | ~2~2.5 人日（含全新调度，较 v1 上调） |

单测覆盖：
- A：批量触发 / Flush / 队列满降级 / 多节点各自启动 batcher / 开关关闭回退同步。
- B：首次分区化幂等 / 预建分区 / DROP 过期分区 / 边界 epoch 计算（UTC）/ 非 MySQL 跳过分区走原逻辑 / 手动删除 API 仍行删。

## 协同关系小结

- 批量写入 → 把 ~600 INSERT/s 合并为每秒 1~2 条多值 INSERT（每个业务节点各自批量）；
- 月分区 → 单表拆为月级 B-Tree，**自动清理** `DROP PARTITION` 取代行删（手动删除仍走行删），时间范围查询裁剪；
- 二者叠加后，写入放大与清理成本同时根治。索引按你的决定**全部保留**，不在本次改造范围内删除。
