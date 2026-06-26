# 实施方案：保存 API 请求与响应的原始报文

> 目标：当用户通过 `/v1/*` 中转接口请求时，保存**原始请求报文**与**原始响应报文**（含流式 SSE），用于审计 / 分析 / 回放。
>
> 已确认的需求范围：
> - **内容形态**：原始报文（原始请求体 + 原始响应字节，含 SSE）
> - **捕获范围**：全量保存所有请求
> - **存储后端**：落盘文件 / 对象存储（DB 只存索引指针）
> - **隐私合规**：暂不做（脱敏 / 加密 / 保留期留作后续）

---

## 一、可行性结论

技术上完全可行。请求与响应内容在 relay 生命周期内都"经过"网关，可通过中间件拦截保存。

关键约束（已在代码中核实）：

- **请求内容容易拿到**：原始请求体被 `common/body_storage.go` 缓存（内存/磁盘自适应），通过 `common.GetBodyStorage(c)` 可在转发后**重复读取**，直到 `BodyStorageCleanup` 中间件清理前都可用。
- **响应内容是主要难点**：结算函数 `service/text_quota.go:322` 的 `PostTextConsumeQuota(ctx, relayInfo, usage, extraContent)` 中，`extraContent` 只是计费备注文本，**不携带响应内容**。各 provider handler（`OaiStreamHandler`、`OpenaiHandler`、`claude_handler`、`gemini_handler` 等）各自解析/聚合响应后**只返回 `*dto.Usage`**，完整响应文本用完即丢，没有传到结算点。
- **目前没有任何 ResponseWriter 包装器**，也没有保存对话内容的表/字段。
- **基础设施已就绪**：`model/log_batch.go` 提供成熟的「异步队列 + 双触发落盘 + 队列满降级 + 优雅退出」批量写入器；`model/log_partition.go` 提供 MySQL 分区。可直接复用。

### 中间件顺序（对实现有利）

`router/relay-router.go:16` 中 `BodyStorageCleanup()` 注册得很靠前（外层），其清理逻辑在 `c.Next()` 之后执行 → **整条链最后才清理请求体**。因此只要捕获中间件注册在它之后（内层），在捕获逻辑里**请求体仍然可读**。

---

## 二、整体架构

采用**包装 ResponseWriter** 的通用方案，与计费 / 各 provider 解耦，一处搞定全部 40+ 渠道：

```
请求进入 /v1/*
  → [现有] CORS / Decompress / BodyStorageCleanup(外层,最后清理) / TokenAuth / Distribute
  → [新增] MessageCaptureMiddleware
        ├─ 进入时：用带缓冲的 captureWriter 替换 c.Writer
        ├─ c.Next() 执行 relay，响应字节被同时「透传给客户端」+「tee 进缓冲」
        └─ 返回后：从 BodyStorage 读原始请求体 + 从缓冲读响应体
                  + 从 context 读 request_id/user_id/token_id/channel_id/model
                  → 打包快照，非阻塞投入异步队列
  → [新增] 异步写入器（照搬 log_batch 模式）
        ├─ 内容落盘：MessageStore 接口（LocalFS 实现，预留 S3）
        └─ 索引入库：message_logs 表（批量写入）
```

**核心原则**：捕获与计费完全解耦，不动任何 provider handler，不动 `PostTextConsumeQuota`；写入全程异步，不阻塞 relay 热路径。

---

## 三、新增 / 修改文件清单

### 新增

| 文件 | 职责 |
|------|------|
| `middleware/message_capture.go` | 捕获中间件 + `captureWriter`（实现 `gin.ResponseWriter`，tee 写入，带大小上限） |
| `common/messagestore/store.go` | `MessageStore` 接口定义 + 报文信封结构 |
| `common/messagestore/local.go` | 本地文件存储实现（路径 `messagelog/YYYY/MM/DD/<request_id>.json`） |
| `common/messagestore/s3.go` | （预留）对象存储实现，先留空骨架 |
| `model/message_log.go` | `MessageLog` 索引模型 + `RecordMessageLog` + 异步批量写入器（照搬 `log_batch.go`） |
| `setting/message_log.go` 或 `common/env.go` 增项 | 配置开关 |

### 修改

| 文件 | 改动 |
|------|------|
| `router/relay-router.go` | 在 `relayV1Router` 等组里注册捕获中间件（位置在 `BodyStorageCleanup` 之后） |
| `model/main.go` | `AutoMigrate` 增加 `MessageLog`；如需分区，挂接现有分区逻辑 |
| `main.go` 启动/退出钩子 | 初始化与优雅关闭内容写入器（对齐 `InitLogBatcher`/`StopLogBatcher`） |

---

## 四、数据模型

### 内容落盘（信封，用 `common.Marshal`）

```json
{
  "request_id": "...", "time": 1750000000, "model": "gpt-4o",
  "user_id": 1, "token_id": 9, "channel_id": 3, "is_stream": true,
  "request_path": "/v1/chat/completions",
  "request_headers": {},
  "request_body": "<原始JSON>",
  "response_status": 200,
  "response_body": "<原始JSON 或 拼接的SSE原文>"
}
```

### 索引表 `message_logs`

三库兼容：GORM 管理主键、用 `TEXT` 不用 JSONB、bigint 时间戳。

```
id, request_id(idx), user_id(idx), token_id, channel_id,
model_name(idx), created_at(idx, bigint), is_stream,
status_code, req_size, resp_size, storage_path, truncated(bool)
```

索引表只存指针和可检索字段，便于后台列表/查询；正文都在文件里。

---

## 五、关键技术细节与风险处理

1. **流式不能延迟**：`captureWriter.Write/WriteString` 必须**先透传再 tee**，并透传 `Flush()`，否则破坏 SSE 实时性。
2. **大小上限**：图片 base64、长上下文可能极大 → 缓冲设上限（默认 10MB，可配），超限**截断并标记 `truncated=true`**，避免打爆内存。可复用 `BodyStorage` 的磁盘溢出思路。
3. **WebSocket/realtime 跳过**：`/v1/realtime` 走 Hijack，无法用 writer 包装捕获 → 该路由跳过（先记为已知限制）。
4. **请求体可读性**：依赖中间件顺序（捕获在 `BodyStorageCleanup` 内层）；实现时确认 `request_id` 的 context key（`RelayInfo.RequestId` 来源）。
5. **进程崩溃丢队列**：与现有日志一致——内容非账务数据，可接受；正常退出 flush。
6. **全量存储增长**：保留**一个总开关**（默认关，开后全量）；"保留期清理"列为后续可加项（对齐现有日志分区 retention）。
7. **遵守项目规则**：JSON 统一走 `common.Marshal`/`Unmarshal`；DB 代码三库兼容；不碰受保护的品牌信息。

---

## 六、配置项（默认关，开后全量）

```
MESSAGE_LOG_ENABLED=false
MESSAGE_LOG_STORAGE_TYPE=local            # local | s3
MESSAGE_LOG_PATH=./data/message_logs
MESSAGE_LOG_MAX_BODY_BYTES=10485760       # 单条上限,超限截断
MESSAGE_LOG_SAVE_HEADERS=false            # 是否存请求/响应头
MESSAGE_LOG_QUEUE_SIZE=10000              # 异步队列(同 log_batch)
MESSAGE_LOG_BATCH_SIZE=200
```

---

## 七、分阶段实施

- **阶段 1（MVP）**：捕获中间件 + `captureWriter` + LocalFS 落盘 + 同步写索引；打通"开关开启后能在文件里看到完整 req/resp"。
- **阶段 2**：异步批量写入器（照搬 `log_batch`）+ 大小上限/截断 + 优雅退出。
- **阶段 3**：后台查询接口/页面（按 user/token/model/request_id 检索、查看正文）。
- **阶段 4（可选）**：S3 后端、保留期清理、脱敏/加密（暂不需要，留接口位）。

---

## 八、待拍板事项

1. **正文存储粒度**：按 `request_id` 存成单文件（方便定位、单条删除，倾向此项）vs 按天聚合成大文件（文件数少、利于归档）。
2. **是否需要阶段 3 的后台查看页面**，还是只要后端落盘、用脚本/SQL 自查即可。

---

## 附：关键代码位置参考

| 用途 | 位置 |
|------|------|
| 请求体缓存（内存/磁盘） | `common/body_storage.go` |
| 请求体读取助手 | `common/gin.go`（`GetRequestBody` / `GetBodyStorage`） |
| 请求体清理中间件 | `middleware/body_cleanup.go` |
| 中转路由与中间件链 | `router/relay-router.go` |
| 结算点（不携带响应内容） | `service/text_quota.go:322` `PostTextConsumeQuota` |
| 非流式响应处理 | `relay/channel/openai/relay-openai.go:192` `OpenaiHandler` |
| 流式响应聚合 | `relay/channel/openai/relay-openai.go:106` `OaiStreamHandler` |
| 现有日志模型 | `model/log.go:34` `Log` |
| 异步批量写入器（可照搬） | `model/log_batch.go` |
| MySQL 分区 | `model/log_partition.go` |
