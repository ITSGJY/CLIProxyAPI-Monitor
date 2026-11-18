> [!IMPORTANT]
> This is the personal **CLIProxyAPI-Monitor Plus** fork. It keeps the upstream Overview, Explore and Records experience while replacing the legacy `/usage` adapter with a CPA v8 request-level pipeline.
>
> The production Collector uses native RESP `AUTH` + `SUBSCRIBE usage`. Each event is committed to the PostgreSQL 17 durable Inbox before processing. The Processor and Rollup workers are independent services. Production explicitly uses `COLLECTOR_MODE=subscribe` and disables FIFO fallback. OMC and CPA Usage Keeper can remain subscribed to the same broadcast; do not use destructive FIFO pull while any other subscriber is active.
>
> CPA Pub/Sub is at-most-once and has no ACK or replay cursor. Disconnects and uncertain windows are recorded as ingestion gaps. PostgreSQL `usage_inbox` is the durable journal; the final architecture intentionally does not add a local SQLite spool (see [ADR-001](docs/decisions/ADR-001-postgres-durable-inbox.md)).

# CLIProxyAPI Monitor Plus

面向 CLIProxyAPI v8 的独立使用量监控与统计中台。它不管理 CPA 配置、OAuth 账号或 Provider，也不依赖 OMC / Keeper API 作为运行时数据来源。

## 主要功能

- **Overview**：请求量、失败率、Token、缓存、延迟、API 等价成本、成本覆盖率及排行。
- **Explore**：请求级 Token、模型 / Provider / Credential / Service Tier 分布、缓存趋势、Latency 和 TTFT。
- **Records**：完整请求记录、筛选、排序、稳定游标分页及计费状态。
- **Collector**：CPA v8 原生 RESP Subscription、连接恢复、事件审计、Gap Tracking 和 PostgreSQL Durable Inbox。
- **Processor / Rollup**：幂等事件归一化、版本化价格、历史成本快照、小时及每日聚合。
- **Historical import**：可审计的 OMC SQLite 历史记录导入，不修改 OMC 原始数据库。

## 部署与运行

- Node.js 24、pnpm 10、PostgreSQL 17；生产通过 GitHub Actions 发布的不可变 ARM64 Docker 镜像部署。
- Web、Processor、Rollup 运行在 Docker bridge 网络；Collector 使用独立 host-network 容器访问 CPA 的 loopback RESP 端口，不对外暴露 8317。
- 首次部署前单独执行 SQL migration runner；`pnpm build` 不会修改数据库。禁止对生产环境使用 `drizzle-kit push`。
- Collector 默认关闭。生产配置使用 `COLLECTOR_ENABLED=true`、`COLLECTOR_MODE=subscribe`、`COLLECTOR_ALLOW_PULL_FALLBACK=false`，并显式启用两个生产目标开关。
- FIFO `pull` 仅用于经过协调的单消费者兼容场景；不得与 OMC、Keeper 等订阅者同时使用。

查看 [架构决策](docs/architecture.md)、[Phase 3 Collector](docs/phase3-collector.md)、[Phase 4 Processor / Pricing](docs/phase4-processor.md)、[Phase 6 历史导入](docs/phase6-legacy-import.md) 和 [Phase 7 部署验收](docs/phase7-runbook.md)。

## 预览

|   |   |
| --- | --- |
| <img width="2186" height="1114" alt="image" src="https://github.com/user-attachments/assets/939424fb-1caa-4e80-a9a8-921d1770eb9f" /> | <img width="2112" height="1117" alt="image" src="https://github.com/user-attachments/assets/e5338679-7808-4f37-9753-41b559a3cee6" /> |
<img width="2133" height="1098" alt="image" src="https://github.com/user-attachments/assets/99858753-f80f-4cd6-9331-087af35b21b3" />
<img width="2166" height="973" alt="image" src="https://github.com/user-attachments/assets/6097da38-9dcc-46c0-a515-5904b81203d6" />

## 数据库高级配置

| 环境变量 | 说明 | 默认值 | 备注 |
|---|---|---|---|
| `DATABASE_POOL_MAX` | 连接池最大连接数 | `3` | 低内存 PostgreSQL 主机建议保持较小 |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | 空闲连接超时时间 (毫秒) | `10000` | 超过此时间未使用的连接将被释放 |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | 获取连接超时时间 (毫秒) | `5000` | 等待连接空闲的最长时间 |
| `DATABASE_POOL_MAX_USES` | 连接最大使用次数 | `7500` | 单个连接在关闭前可执行的最大查询数 |
| `AUTH_FILES_INSERT_CHUNK_SIZE` | `auth_file_mappings` 批量插入块大小 | `500` | 大数据量时避免单条 SQL 过长 |
| `USAGE_INSERT_CHUNK_SIZE` | `usage_records` 批量插入块大小 | `1000` | 大数据量时避免单条 SQL 过长 |
| `NEXT_PUBLIC_SYNC_TIMEOUT_MS` | 数据同步超时时间 (毫秒) | `120000` | 前后端共享 |

## Local DEV
1. 安装依赖：`pnpm install`
2. 修改环境变量：`cp .env.example .env`
3. 创建表结构：`pnpm db:migrate`（先确认 `DATABASE_URL` 指向隔离的测试库）
4. 启动隔离的 CPA v8 Collector：`pnpm collector`（仅在配置好 loopback CPA 测试实例和 `cpa_monitor_test` 后）
5. 提交拉取任务：GET/POST `/api/sync`（可选）
6. 启动开发：`pnpm dev`

---

## Legacy CPA 适配器（仅兼容）

`adapter.js` 仅保留为历史兼容代码，默认拒绝启动。它面向旧版 `/usage` 适配流程，不适用于新的 CPA v8 采集链路。除非专门验证旧版兼容性，否则不要启用 `ENABLE_LEGACY_ADAPTER=true`；新版本应使用独立的 CPA v8 Collector。以下旧版反向代理与环境变量说明仅供历史部署排查，不属于 Monitor Plus v2.0 的推荐部署方式。

```
your.domain {
	reverse_proxy /usage localhost:36871
	reverse_proxy /v0/management/usage localhost:36871
	
	reverse_proxy * localhost:8317
}
```

或者在看板配置 `USAGE_API_BASE_URL=http://adapter-host:36871` ， `adapter-host` 一般为 CPA 部署服务器 IP 。

```
curl -L -o adapter.js https://github.com/sxjeru/CLIProxyAPI-Monitor/raw/refs/heads/main/adapter.js
npm install ioredis
# node adapter.js

# 推荐使用 PM2 
npm install -g pm2
pm2 start adapter.js --name cpa-adapter
```

### 环境变量

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `CPA_REDIS_HOST` | CPA Redis 主机 | `127.0.0.1` |
| `CPA_REDIS_PORT` | CPA Redis 端口 | `8317` |
| `CPA_SECRET_KEY` | CPA Redis 访问密钥，即前述 `CLIPROXY_SECRET_KEY` | 空 |
| `CPA_REDIS_KEY` | usage 队列 key | `queue` |
| `ADAPTER_PORT` | adapter 监听端口 | `36871` |
| `POLL_INTERVAL` | 从 Redis 拉取间隔（毫秒） | `15000` |
| `MAX_BUFFER_SIZE` | 内存缓冲上限 | `50000` |
| `BATCH_SIZE` | 每次拉取条数 | `500` |
| `CLEAR_BUFFER_ON_READ` | 读取 `/usage` 后是否清空缓冲 | `false` |
| `USAGE_AUTH_MAX_ATTEMPTS` | usage 鉴权最大连续失败次数 | `10` |
| `USAGE_AUTH_LOCKOUT_MS` | usage 鉴权失败后的锁定时长（毫秒） | `1800000` |
| `USAGE_AUTH_CLEANUP_MS` | 失败记录清理窗口（毫秒） | `3600000` |


### 定时 sync 环境变量

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `ENABLE_PERIODIC_SYNC` | 是否启用内置定时 sync | `false` |
| `DASHBOARD_URL` | Vercel 部署看板地址，如 `https://your-domain.com` | 空 |
| `SYNC_TOKEN` | 远端看板 `/api/sync` 的 Bearer token，一般填前述 `CRON_SECRET` 或 `PASSWORD` | 空 |
| `SYNC_INTERVAL` | 定时触发 `/api/sync` 的间隔（毫秒） | `600000` |
| `SYNC_TIMEOUT_MS` | 单次 sync 超时（毫秒） | `300000` |
| `SYNC_ON_START` | 启动后是否立即触发一次 sync | `false` |

### 工作方式

1. `adapter.js` 定时从 CPA Redis 队列拉取 usage 记录
2. 聚合后通过本地 `/usage` 或 `/v0/management/usage` 暴露给外部
3. 若开启 `ENABLE_PERIODIC_SYNC=true`，adapter 会定时请求远端看板 `/api/sync`
4. 看板 `/api/sync` 再回拉 adapter 的 `/usage`，并写入数据库

----

### 鸣谢
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [Linux.DO](https://linux.do/)
- [Vercel](https://vercel.com/)


### Phase 5 Dashboard Read Path

- Overview, Explore and Records now read canonical `usage_events`; Overview uses fresh timezone-matched daily rollups for complete local-day trend ranges up to 90 days when selected filters are represented by the rollup dimensions; partial-day and unsupported filter combinations safely fall back to event aggregation.
- Costs use persisted `cost_nanos` and remain separated by currency; unpriced costs remain `null` in Records and pricing coverage is explicit.
- Explore applies SQL filters before deterministic time-stratified sampling (maximum 8,000 points) and returns a PII-safe projection.
- Records uses a versioned cursor with multi-sort lexicographic tie-breaking and event ID stability.
- `/collector` exposes Collector health, Inbox counts, recent pull attempts, ingestion gaps and price coverage.
- Migration `0006_phase5_dashboard_rollup_dimensions.sql` extends Rollup dimensions for API Key, Service Tier, cache creation and pricing coverage. Phase 6 historical imports and Phase 7 production cutover remain out of scope.


### Phase 6 Historical OMC Import

- `scripts/snapshot-omc-sqlite.py` creates a consistent read-only SQLite snapshot. `scripts/omc-sqlite-source.py` validates and exports an allowlisted source projection. `scripts/import-omc-sqlite.mjs` performs a resumable, SHA-256-bound, idempotent import into loopback PostgreSQL test databases by default. Production import requires a separate dual opt-in and is restricted to the dedicated Monitor database.
- Migration `0007_phase6_legacy_import.sql` adds import-run audit/progress, preserves source price-version IDs separately from target price-version foreign keys, and retains OMC's full historical price-version catalog in a separate audit table.
- The OMC source is request-level `usage_events`; duplicate `event_key` rows are retained using source row ID identity, with the original key retained as `source_event_key`. Sensitive raw request/network fields are excluded.
- See `docs/phase6-legacy-import.md` for source inventory, mapping, reconciliation and Phase 7 boundary.


### Phase 7 Deployment and Resilience

- `Dockerfile` builds a Next.js standalone runtime; GitHub Actions publishes immutable `sha-*` images to GHCR. The production host pulls the pinned image and does not run Node/pnpm builds.
- `deploy/compose/compose.yaml` runs Web, Processor and Rollup on the existing `personal-cloud-hub_default` Docker network. The CPA Collector runs in a separate opt-in Compose profile with `network_mode: host` because CPA binds its RESP/management listener to `127.0.0.1:8317`. Its default `auto` mode uses native RESP `SUBSCRIBE usage`; FIFO pull is an explicit compatibility mode.
- The production deployment requires a dedicated PostgreSQL database/role, separate from Cloudreve. The Collector remains disabled until a coordinated single-consumer cutover.
- See [Phase 7 runbook](docs/phase7-runbook.md) for fault recovery, queue retention, Docker deployment and cutover gates.
