# Phase 5.5 — CPA Credential Error Events

实施日期：2026-11-20。独立采集 CPA 凭据错误通知，并在 Records 详情的“诊断”页展示调查证据。既有 Usage、Inbox、Processor、Pricing、Rollup、Records 列表及四个详情标签不变。

## 固定来源契约

已读取以下公开标签源码，并对线上 OMC 数据库使用 SQLite Backup API 创建一致性只读快照；未输出任何密钥或原始错误正文：

- CPA **v8.0.56**，提交 `585f97deac9aa57c700301221fb1a7085e1827cc`：[error_events.go](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.56/sdk/cliproxy/auth/error_events.go)、[redis_queue_protocol.go](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.56/internal/api/redis_queue_protocol.go)。`AUTH` 后单独 `SUBSCRIBE errors`，确认帧为 `subscribe/errors/1`。订阅期间支持 `PING` / `UNSUBSCRIBE`。
- OMC **v0.4.2**，提交 `0a06f85a186cf44480b3e18f8fc425a5dfd90035`：[decode.go](https://github.com/WizisCool/oh-my-cpa/blob/v0.4.2/internal/usage/decode.go)、[002_usage_ingest.sql](https://github.com/WizisCool/oh-my-cpa/blob/v0.4.2/migrations/002_usage_ingest.sql)、[059_model_cooldowns.sql](https://github.com/WizisCool/oh-my-cpa/blob/v0.4.2/migrations/059_model_cooldowns.sql)。错误行没有可用于精确请求归因的 Request ID。
- 生产源实际来自 OMC v0.4.8（commit a920ac22），SQLite schema_migrations 版本 71。生产交接快照为 /var/backups/cliproxyapi-monitor/omc-phase55-handover-20261120.sqlite，SHA256 cc3a0de8160fa60248893fd9993e65697a3fffe4d96e6db00b6d41776d1e3083；包含按 Usage 订阅边界过滤后的 17,170 条 usage_events、112 个价格版本和完整的 156 条 error_events。
CPA 的 `timestamp/provider/model/auth_index/status_code/body/code/retryable` 和 `auth_status` 白名单被规范化；凭据及模型的 status/status_message/unavailable/next_retry_after/quota 均保留，凭据另含 disabled。quota 保存 exceeded/reason/next_recover_at/backoff_level。`auth_id` 仅在内存中用于移除正文中的精确匹配，随后丢弃。

与 OMC 一致：存在模型状态且凭据 quota.reason 为 `quota` 时，`auth_quota_aggregate=true`；reason 为 `credential_quota`、两级 exceeded 且模型重试/恢复时间均不晚于凭据最大重试/恢复时间时，`model_quota_inherited=true`。缺失字段保留 unknown/null，不伪造零配额或恢复时间；OMC migration 059 缺列时新增布尔值默认 false、model_backoff_level 默认 0，其余可选字段为 null。旧 OMC `auth_status` 只有状态消息，无法补造 CPA 原始状态枚举或模型消息。

## 运行架构与数据边界

```mermaid
flowchart LR
  CPA[CPA RESP] -->|connection A: SUBSCRIBE usage| Usage[Existing usage collector]
  Usage --> Inbox[usage_inbox]
  Inbox --> Pipeline[Existing processor / pricing / rollups]
  CPA -->|connection B: SUBSCRIBE errors| Errors[Independent error collector]
  Errors --> Sanitize[Allowlist / redact / normalize]
  Sanitize --> Events[cpa_error_events]
  Errors --> Sessions[Error lease / subscription sessions]
  Snapshot[Read-only OMC snapshot] --> Import[errors-only importer]
  Import --> Events
  Import --> Audit[Import runs / membership]
  Events --> Detail[Records Diagnostics]
  Sessions --> Detail
  Audit --> Detail
```

`subscribeUsageViaResp` 仍只接受 usage。`subscribeErrorsViaResp` 始终建立新连接，只接受 errors；绝不 LPOP errors，也不写 usage_inbox。新的进程、连接池、lease 表、session 表、Compose profile 和 health script 均独立于 usage collector。生产部署 helper 已扩展为识别独立 error-collector profile、保留 Usage Collector 原有启停状态，并对错误 Collector 增加单独的启停与健康门禁；错误采集失败不会停止 Usage Collector。

错误进程连接池上限为 1，计入既有 9 条常驻应用连接预算；独立健康检查额外短暂使用 1 条连接。上线前应计入两个健康探针和一次性导入的瞬时连接，不调整现有 Usage/Pricing 的池默认值。

迁移 `0011_cpa_error_events.sql` 创建：

| 表 | 用途 |
| --- | --- |
| `cpa_error_events` | 独立错误事实；`(source_instance_id,event_key)` 唯一；凭据/时间关联索引；来源、原始发生时间、接收时间、脱敏状态、配额/重试/恢复/退避 |
| `cpa_error_collector_state` | 独立 enablement、worker、递增 lease epoch、过期时间、心跳、固定错误码 |
| `cpa_error_subscription_sessions` | 连接尝试、服务端订阅确认、已确认覆盖水位、结束原因及收到/新增/重复/无效计数 |
| `cpa_error_import_runs` | 每次导入尝试的源 SHA256、schema 版本、状态、expected/processed/inserted/skipped/failed/reconciled 计数及时间范围 |
| `cpa_error_import_items` | 每个导入 run 的事件成员；用于重叠快照、重复导入的最终目标计数核对 |

实时 event key 为带版本的规范化白名单内容 SHA256，保留源时间的小数精度用于区分同毫秒通知；不存原始 payload 或原始 payload 摘要。同一安全投影的通知可能合并；此键是幂等身份，不是请求身份。历史 event key 使用 OMC 实例和行 ID，不使用易变的导入批次/文件哈希。来源包括 origin_system、source_transport、source_native_id、snapshot hash、import run 或 subscription session。

正文最多 4096 字符，状态/原因最多 512 字符；先脱敏后截断，避免边界泄漏。移除已知 auth_id、management key、Bearer/Basic、密钥/令牌/密码/敏感 header、邮箱、IP、电话号码、带标签的人名/地址及 URL。未知 JSON 键不进入数据库；API 对状态 JSON 再做字段/类型白名单。正文通过 React 文本节点/`pre` 展示，不使用 HTML 注入。采集和导入失败只输出固定事件名/原因码或汇总计数，不输出原始错误、服务器错误消息、数据库异常内容或子进程 stderr。

## Lease、重连和覆盖

- 每次抢占递增 epoch，所有写入与续租在同一事务内锁定并校验 owner/epoch/未过期 lease。失去租约的旧 worker 无法写事件、更新 session 或释放新 worker。
- 默认 lease 45 秒，5 秒续租。RESP 重连使用 500ms、1s、2s…最大 30s 指数退避；有效 PONG/数据库水位确认后重置。认证/协议/持久化/畸形消息/背压错误均终止该 error session。数据库故障会结束该进程，Compose 的独立 restart 策略负责恢复；不影响 usage 进程。
- 默认最多 256 个待持久化消息、1MiB 待处理正文；半满暂停 socket，四分之一以下恢复，硬上限断开并产生未覆盖区间。底层单 RESP bulk 上限 64KiB。接受的消息串行持久化；不会无限缓存，也不把原始错误放进日志或 dead letter。
- `subscribed_at` 仅在校验 SUBSCRIBE 确认后写入；PONG 后的水位更新串行排在该 socket 先前收到的消息提交之后，并统一使用 PostgreSQL `clock_timestamp()`，不依赖应用时钟。只有成功探测、成功持久化且仍持有 lease 的时间段才进入覆盖计算。PONG 是连接探测，**不是消息 ACK**，不能证明 CPA 内部没有丢弃/延迟消息。
- 异常关闭和进程崩溃只保留最后确认水位，重启关闭未结束 session。两段水位之间、启动前、停机后都属于未覆盖时间；不靠“最后一条错误的时间”猜测覆盖。
- SIGINT/SIGTERM 取消重连、发送 UNSUBSCRIBE，最多等待 10 秒排空已经接受的消息，再关闭 session/释放 lease。进程额外有 25 秒强制退出上限，Compose grace 为 30 秒；超时/崩溃依赖 lease 失效，历史尾部仍保持未知。

Records 以同一 `source_instance_id` + 非空 `auth_index` 查询闭区间 `[occurred_at−120s, occurred_at+120s]`，最多 20 条；按绝对时间差、错误发生时间、错误 ID 排序。`time_delta_ms=error_time−usage_time`，同时返回 provider_match/model_match；始终返回 `attribution: credential_time_window`。不要求 provider/model 相同，不据此声称请求失败原因。

事件和覆盖读取使用 PostgreSQL REPEATABLE READ、只读事务与 2.5 秒单语句超时，避免读取到旧事件集和新覆盖水位。错误表不可用时仅该证据区返回 query_failed，原请求详情继续可用。

| 覆盖状态 | 含义 |
| --- | --- |
| `disabled` / `not_configured` | 明确关闭 / 没有已注册错误采集器 |
| `connecting` | 启用但尚未建立有效订阅 |
| `disconnected` / `degraded` | 断连、lease/心跳过期、无效消息或覆盖水位停滞 |
| `collecting` | 未来的 +120 秒窗口尚未关闭；已观测部分没有已知缺口，健康流的短暂尾部在等待水位 |
| `complete` | 窗口已关闭，session 覆盖区间并集完整覆盖该窗口 |
| `partial` | 含 gap 或未采集区间；不会因为当前连接恢复就隐藏历史缺口 |
| `historical_import` | 有已完成、已核对的 OMC 快照覆盖相关时间；不证明 OMC 连续采集 |
| `not_correlatable` | 缺少实例、非空安全 auth_index 或有效事件时间 |
| `query_failed` | 错误证据查询失败；不等价于零错误 |

完整覆盖也仅表示观察到的连接/提交区间，不是 Pub/Sub 无损保证。CPA/Monitor/PostgreSQL 时钟应同步；源端静默丢弃、延迟以及钟差仍限制时间窗证据。历史窗口完整时即使当前已停机，仍可报告完整；所有其他空结果都显示“当前可用证据中未查到关联记录”，并保留缺口/未结束警告。

## 历史导入操作

生产历史导入已于 2026-11-20 完成。快照由 SQLite Backup API 创建，源数据库只读。Usage 快照截止点使用 Monitor 最新一次 CPA SUBSCRIBE usage 服务端确认时间 2026-11-19T22:30:43.759338Z（Unix 毫秒 1795127443759），原始快照包含 17,170 条 Usage、112 个价格版本及全部 156 条错误事件。随后按全部 Usage Subscription 会话核对实时重叠：首次成功确认时间为 2026-11-18T13:58:47.939374Z，42 条与 oracle-primary 在时间、Provider、Model、状态码、auth_index 和 Token 分桶上完全一致的历史行被删除，5 条没有实时对应项的 OMC 独有行保留。最终保留 17,128 条历史 Usage。删除的 42 条均为成功请求，成本 1,424,386,000 nanos、Token 1,146,953；精确 event_id 列表及匹配字段已写入 usage_import_runs.manifest.live_overlap_reconciliation。Error Collector 在快照后才启动，因此 156 条错误事件全部保留并映射到 legacy-oh-my-cpa-default；实时 CPA 保持 oracle-primary。快照 SHA256 为 cc3a0de8160fa60248893fd9993e65697a3fffe4d96e6db00b6d41776d1e3083。

```bash
# 所有示例路径和 URL 均须指向隔离测试目标。
python3 scripts/snapshot-omc-sqlite.py \
  --source /tmp/omc-test/source.sqlite --destination /tmp/omc-test/snapshot.sqlite
python3 scripts/omc-sqlite-source.py errors-manifest --source /tmp/omc-test/snapshot.sqlite
python3 scripts/omc-sqlite-source.py errors --source /tmp/omc-test/snapshot.sqlite
DATABASE_URL=postgresql://test:test@127.0.0.1:55458/cpa_monitor_test \
  node scripts/import-omc-sqlite.mjs --errors-only \
  --source /tmp/omc-test/snapshot.sqlite --source-sha256 <verified-sha256> --batch-size 250
```

不带 `--errors-only` 的既有 Usage 导入行为不变；两个导入分别运行。Errors 固定映射到 `legacy-oh-my-cpa-default`，无需启动历史采集器，也不改 Usage pricing/records。

错误导出只接受无 WAL/SHM/journal sidecar 的独立快照，并以 immutable + read-only 模式打开；文件 SHA256 在预检和最终核对时验证。源行 ID、auth_index、timestamp_ms、created_at_ms 保留；可选列通过 PRAGMA 检查，源 schema 不存在的列显式投影为 NULL，保留 unknown 语义，不使用 SQLite 把缺列名当成字面字符串的隐式行为。

每次调用新增审计 run；事务提交一批事件、成员关系和计数。重复执行同一/重叠快照会增加 skipped、不增加事件；源行 ID 相同但规范化内容不同会失败，不能静默覆盖。最终要求 expected=processed=inserted+skipped=reconciled、failed=0，且成员关联的实际目标行数一致，文件 hash 未改变。失败保留已提交批次；重跑从头扫描并幂等跳过。持锁新 run 会把之前崩溃遗留的 running run 标记 interrupted/failed。

若没有 error_events，run 状态为 `unavailable`、expected_count 为 null，原因 `source_error_table_unavailable`；有表但零行则可完成 expected=0 的快照审计，仍不声称任意时间窗完整。不要把源数据库表存在/零行视作连续覆盖证明。

## 生产部署与验收

- 生产部署于 2026-11-20 14:12 UTC 完成，GitHub Actions run 44750179409，代码提交 4a7d17395c645c479fdf9a8593fa171e43e6725e，镜像 ghcr.io/itsgjy/cliproxyapi-monitor:sha-4a7d173。完整测试、PostgreSQL 17 重启持久性、AMD64/ARM64 构建、多架构 Manifest、容器 Smoke Test 和 Oracle 部署 Job 均成功。
- 部署前数据库备份为 /var/backups/cliproxyapi-monitor/predeploy-sha-4a7d173-20261120T141215Z.dump；pg_restore 临时库恢复验证通过，恢复出 22 张 public 表。迁移 0011 已应用。
- Web、Processor、Rollup、Usage Collector、Error Collector 和 PostgreSQL 17 均运行正常；Web、Usage Collector、Error Collector Docker health 均为 healthy。公开入口 https://cpa-monitor.gjy666.eu.cc/login 返回 HTTP 200。
- 生产错误采集已启用独立 error-collector Compose profile，CPA 实例 ID 为 oracle-primary，关联窗口为前后 120 秒；两个生产目标保护开关已显式启用。GitHub Production 分支白名单曾临时加入本功能分支，部署完成后已恢复为 main 与 feat/phase6-legacy-import。
- Error Collector 健康 API 返回 healthy=true、status=collecting。当前订阅 session 已收到 SUBSCRIBE 确认并持续推进数据库覆盖水位；最终验收时 received_count=0，尚未有自然发生的实时错误通知，因此没有向生产 CPA 注入合成错误。真实 RESP AUTH/SUBSCRIBE/PONG/UNSUBSCRIBE 只读握手已通过。
- OMC 历史导入核对：原始快照 17,170 条 Usage，完成 42 条与实时数据完全匹配的成功请求去重后保留 17,128 条；价格版本 112/112，错误事件 156/156。最终历史 Usage 为 3,290 条 priced、13,838 条 unpriced、2,761 条 is_error，成本 74,385,946,498 nanos；错误导入 inserted=156、skipped=0、failed=0、reconciled=156。实时 Usage 另有 50 条，其中 3 条 is_error；身份表与 Usage 主表均为 17,178 条。
- 历史 Usage 与错误均映射到 legacy-oh-my-cpa-default；数据库内按同实例、同 auth_index、±120 秒窗口得到 703 组候选关联。Records API 对历史记录 eventId=16021 返回 1 条关联错误（HTTP 400、时间差 1ms），对 OMC 独有记录 eventId=17113 返回 1 条关联错误（HTTP 402、时间差 652ms）；两者 Provider/Model 均匹配、coverage=historical_import，响应未暴露 auth_index 或 auth_id。
- 三条 OMC 错误事件发生在首次 Usage 订阅之后：其中一条关联到保留的 OMC 独有记录，另两条仅与 oracle-primary 实时请求匹配。为保持 source_instance_id 严格隔离，历史 OMC 错误仍保留在 legacy 来源，不跨实例关联到实时记录。
- Rollup 日回填窗口调整为 120 天，重复项校正后刷新 444 个 daily groups；日汇总 request_count=17,178、error_count=2,764（历史 2,761 + 实时 3）、cost_nanos=74,385,946,498。48 小时小时汇总刷新 24 个 groups。
- 当前剩余观察项：等待第一条自然发生的 CPA errors 实时消息，确认其从 errors Pub/Sub 到 cpa_error_events 的生产写入；不通过制造生产错误来做验收。
