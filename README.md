> [!IMPORTANT]
> This is the personal **Monitor Plus v2.0** fork. The original `/usage` adapter and Vercel polling flow are legacy compatibility code, not the new ingestion path.
>
> Phase 1 establishes the PostgreSQL 17 event-store foundation. Phase 3 completes the disabled-by-default CPA v8 Pull-first Collector: RESP AUTH/LPOP, safe HTTP fallback, durable bulk Inbox writes, audited gaps, lease recovery and a standalone health check. The Collector and Phase 4 Processor are separate workers. See [architecture](docs/architecture.md), [Phase 1 runbook](docs/phase1-runbook.md) and [Phase 3 Collector runbook](docs/phase3-collector.md).
>
> Do not run the new Collector beside OMC, CPA Usage Keeper or CPA Manager Plus on the production CPA instance. CPA queue pulls are destructive; a separate single-consumer cutover is required.


# CLIProxyAPI 数据看板

基于 Next.js App Router + Drizzle + Postgres 的数据看板，用于自动拉取上游 CLIProxyAPI 使用数据，**持久化到数据库**，并进行数据可视化。

## 功能
- `/api/sync` 将拉取命令交给健康状态的 CPA v8 Collector（支持 GET/POST，有鉴权）
- 前端表单可配置模型单价，亦支持从 models.dev 自动拉取价格信息（ [#17 @ZIC143](https://github.com/sxjeru/CLIProxyAPI-Monitor/pull/17) ）
- 前端图表：日粒度折线图、小时粒度柱状图、模型费用列表等，支持时间范围、模型、Key、凭证筛选；新事件表的 UI 读取切换将在后续阶段完成
- 访问密码保护

## 部署与运行

### Dashboard

- Node.js 24、pnpm 10 和 PostgreSQL 17。
- 设置 `DATABASE_URL`、`PASSWORD`、`CRON_SECRET`；如需调用 CPA 管理接口，再设置 `CLIPROXY_API_BASE_URL` 和 `CLIPROXY_SECRET_KEY`。
- 首次部署前，单独执行 `pnpm db:migrate`。`pnpm build` 只构建应用，不会隐式修改数据库。
- Dashboard 可部署在 Vercel 或自有主机；当前 `vercel.json` 不启用自动 Cron。

### CPA v8 Collector

Collector 是独立 Node 进程，运行 `pnpm collector`；健康检查运行 `pnpm collector:health`。它默认关闭，Phase 3 验证只允许 loopback CPA 测试端点和名称包含 `test` 的 loopback PostgreSQL 数据库。配置方式见 [Phase 3 Collector Runbook](docs/phase3-collector.md)。

`/api/sync` 只向持有有效 Lease 且心跳新鲜的 Collector 提交一次拉取命令，不直接读取 CPA 队列。不要把 Collector 与 OMC、CPA Usage Keeper 或 CPA Manager Plus 同时连接到同一个生产 CPA 队列。Phase 3 只负责把原始使用事件可靠落入 Durable Inbox；独立 Processor 属于 Phase 4。

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
