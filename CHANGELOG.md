# CHANGELOG

## 2026-11-21

- 将首页首屏加载、手动刷新和自动刷新统一为只读 PostgreSQL 查询；不再通过 Dashboard 刷新入口提交 `pull_now` 采集命令。`/records` 刷新也直接重新查询数据库中的请求事件。
- 首页时间范围新增「全部」，统计与按日趋势覆盖全部历史请求；为控制小时级图表数据量，「全部」模式下小时趋势展示最近 367 天。
- 侧边栏与登录页的 GitHub 项目链接统一指向 `ITSGJY/CLIProxyAPI-Monitor` Fork，并加入浏览器验收。
- 首页与调用记录页的刷新结果统一通过自动消失的 Toast 展示数据变化：仅显示新增数量或「暂无新增数据」，不显示负数差值、刷新来源或完成状态前缀；首页 Toast 上移并与 Records 页面统一定位。
- 修复首页自动刷新：启用时立即执行一次只读数据库刷新，随后由真实 Web Worker 按所选间隔持续轮询；将不含敏感信息的计时器脚本加入静态资源放行，并以真实 Worker 验收首次刷新、周期刷新和关闭后停止。

## 2026-11-20

- 完成 Phase 5.5 凭据错误事件：对照 CPA v8.0.56 / OMC v0.4.2 固定源码契约，新增独立 `SUBSCRIBE errors` 连接、进程和可选 Compose 服务；保持既有 Usage、Inbox、Pricing、Records 列表及四标签详情结构不变。
- 新增 PostgreSQL 迁移 `0011`、Drizzle 错误事实/采集状态/订阅会话/历史导入审计与成员表，支持实例范围幂等、lease epoch fencing、独立心跳、限流背压、指数退避重连、健康检查和显式覆盖缺口。
- 错误事件仅保留白名单与脱敏正文/状态；不保存原始 payload 或明文 auth_id，不在日志/API/UI 中输出敏感错误内容；完整保存凭据和模型配额、冷却、重试、恢复及退避证据。
- Records 诊断增加凭据关联错误：同实例、非空 auth_index、前后 120 秒闭区间、按绝对时间差稳定排序并限制 20 条；展示有符号时间差、Provider/模型匹配和覆盖状态，明确不构成因果证明。事件与覆盖使用同一数据库快照，防止读竞争误报完整空结果。
- 扩展只读 OMC SQLite 导出与 Node `--errors-only` 导入，兼容模型冷却迁移前后的可选列；保留 auth_index/原始时间、固定 legacy 实例、验证快照 SHA256 和最终计数、拒绝变更的源行身份、支持重复导入与中断审计；缺少 error_events 明确记为 unavailable。
- 新增单元、PostgreSQL 17、旧/新 SQLite 导入、边界与隐私回归测试及 CI 架构 guard；扩展浏览器验收覆盖错误正文转义，补充 Phase 5.5 架构与运维手册。
- Phase 5.5 已部署到 Oracle：初始镜像 sha-4a7d173，后续健康检查修复镜像 sha-7f871e9；GitHub Actions runs 44750179409、44759282422 均成功。迁移 0011 应用，Web/Usage Collector/Error Collector 健康，Production 分支白名单已恢复。
- 修复 Usage Collector 健康检查把 RESP SUBSCRIBE 累计广播事件误判为 FIFO 满批次的问题；现在 recentFullBatchCount 只统计 resp/http Pull，生产验收 capacityWarning=false，Inbox 无积压。
- 完成 OMC v0.4.8 历史导入：17,170 条 Usage 源行经 42 条与实时 Usage 完全匹配的重复项校正后保留 17,128 条；112 个价格版本、156 条错误事件全部完成数量核对。5 条 OMC 独有断线间隙记录保留；120 天 Rollup 已回填，Records API 历史关联烟测通过。实时 Error Collector 已健康订阅，等待首条自然错误事件完成实时写入验收。

## 2026-11-19

- 启动 Pricing Center V1：完成现有价格链路审计，明确 models.dev 主价格源、OpenRouter 只读参考、Auto/Linked/Custom 模式及请求级不可变成本证据。
- 新增 PostgreSQL 价格目录、同步状态、模型映射、渠道倍率版本及四桶价格扩展迁移（Phase 1）；保留 OMC 历史价格快照，不触碰历史 Usage 记录。
- 完成 Phase 2：接入 models.dev 主价格目录和 OpenRouter 只读参考，保存 SHA256 / ETag / Last-Modified / 同步快照；仅允许精确 ID、唯一 Offering 或计价字段完全一致的 Offering 自动匹配，歧义项要求人工 Linked。
- 完成 Phase 3：新增 BigInt 定点十进制 Quote Engine，按普通输入、输出、缓存读取、缓存写入四桶计价；加入模型 / 渠道倍率、Service Tier / Prompt 阈值 / IANA 时区 Tier 选择，并在 Inbox 事务内保存价格版本、渠道版本、成本及计算明细。
- 完成 Phase 4：新增独立 \`/pricing\` 页面与价格、同步、关联、渠道倍率、试算 API；支持 Auto / Linked / Custom、四桶编辑、Tier JSON、自动同步间隔、源目录状态及价格 / 渠道历史。
- 价格版本与已计价请求证据改为不可变追加式记录；缺失费率不再按零计费，超出 PostgreSQL bigint 范围或 Token 桶不一致时拒绝生成金额。
- 新增 Pricing 单元与 PostgreSQL 17 回归覆盖；未执行 Phase 5 历史回算，未切换或停止生产 CPA Collector / RESP Subscription。
- 修复 PostgreSQL 17 集成测试对 `numeric(30,12)` 渠道倍率的字符串比较问题，改为数值断言，避免数据库固定小数位格式造成误报。
- 参考 OMC v0.4.2 的详情信息层级重构 `/records` 抽屉，拆分为“概览 / 用量与计价 / 诊断 / 原始字段”四个视图；首屏突出请求状态、耗时、TTFT、输出速率、Token 和费用。
- 详情概览新增调用链路、模型路由、性能阶段与 Token 构成；用量页展示 Token Accounting、Structured Usage、四桶费率及价格/渠道版本证据；诊断页将响应头改为表格并增加网络信息。
- 新增按事件 ID 安全代理下载 CPA 请求日志的接口；详情查询补充渠道版本、Tier、计价策略、成本明细及 Resource ID/Name。
- 保留 Monitor 原有 Slate 深色面板、Indigo 强调色与现有 Tailwind 组件风格，不引入 OMC 的独立主题系统。

- 完成 `/records` 请求事件分析工作台改造：支持自定义列、详情抽屉、高级筛选和 CSV/JSON 导出；新增 CPA 请求上下文专用字段及 PostgreSQL 迁移。
- 修复迁移预检误将其他 schema 中的 `model_prices` 当作当前目标 schema 已迁移的问题，并增加 PostgreSQL 回归断言。

## 2026-11-17

- 推进 Phase 4 Processor 与计费处理流水线：
  - 将 Inbox Processor 从 Collector 中独立出来，新增可单独启停的 Processor Worker。
  - Inbox 改为逐条领取并续租，避免批次后部记录在排队期间 Lease 过期而被其他 Worker 重复领取。
  - 保留全局事件身份账本、重复事件识别、失败指数退避及 Dead Letter 机制。
  - 按事件发生时间匹配历史价格版本，分别计算普通输入、缓存输入和输出成本，避免将已包含在输出 Token 中的 reasoning tokens 重复计费。
  - 新增独立 Rollup Worker，按时区重建近期小时/日聚合；小时与日聚合采用独立刷新周期，同一聚合维度使用 PostgreSQL Advisory Lock 防止多实例并发覆盖。
  - Processor 与 Rollup Worker 均默认关闭，不影响 Phase 3 Collector 或生产 CPA。

- 建立 Phase 1 PostgreSQL 采集基础：
  - 新增 CPA v8 RESP LPOP 主采集与 HTTP Usage Queue 回退模块。
  - 新增 PostgreSQL Durable Inbox、单 Worker Processor、全局事件身份账本和月度分区事件表。
  - 新增价格版本、导入批次、采集缺口及可重建聚合的基础表。
  - Collector 默认关闭，未配置明确测试目标时不会连接 CPA；生产端口 8317 默认受保护。
- 将数据库迁移从构建流程中拆分，改为显式执行 `pnpm db:migrate`。
- 增加 RESP、HTTP、规范化、身份去重和 PostgreSQL 事务集成测试。
- 调整 [adapter.js](adapter.js) 的 route 字段映射：
  - 聚合写库前，`route`（适配器内部沿用 `endpoint` 字段）改为优先取 `api_key`，其次取 `auth_type`，最后才回退到原始 `endpoint`。
  - 修复上游队列中 `endpoint` 为 `POST /v1/chat/completions` 时被原样入库，导致 route 异常的问题。
  - 调试摘要日志中新增 `auth_type`，并对 `api_key` 做脱敏显示，便于排查字段来源且避免泄露敏感值。

## 2026-05-10

- 为 `adapter.js` 增加 Redis 连接错误后的定时无限重连：
  - 新增 `REDIS_RECONNECT_INTERVAL`，默认每 5 秒重试一次连接。
  - 当出现 `Connection error` 时自动启动重连循环，恢复后自动停止，避免适配器因上游 Redis/Management 短暂不可用而长期失联。

- 为 `adapter.js` 增加 Redis 用量队列诊断日志开关：
  - 新增 `DEBUG_USAGE_RECORDS=true` 输出每条队列记录的安全摘要，便于判断流式请求是否在上游队列中已经是 0 token。
  - 新增 `DEBUG_RAW_USAGE_RECORDS=true` 输出脱敏后的原始队列记录，默认关闭，避免日志暴露 `api_key`。
  - 启动日志会显示两个诊断开关状态，方便确认排查配置是否生效。

## 2026-05-02

- 为 `adapter.js` 的 usage 授权补充基础防爆破限制：
  - `/usage`、`/v0/management/usage` 继续校验 `Authorization: Bearer <CPA_SECRET_KEY>`。
  - 同一来源 IP 连续鉴权失败达到阈值后会临时锁定，并返回 `429` 与 `Retry-After`，降低口令被爆破的风险。
  - 新增可调环境变量：`USAGE_AUTH_MAX_ATTEMPTS`、`USAGE_AUTH_LOCKOUT_MS`、`USAGE_AUTH_CLEANUP_MS`。

- 修复 `adapter.js` 连接 CPA 管理端口时可能被 `ioredis` Ready Check 提前断开的兼容性问题：
  - 在 Redis 客户端配置中禁用 `enableReadyCheck`，避免连接建立后自动发送 `INFO` 命令。
  - 兼容仅实现 `AUTH`、`LPOP`、`PING` 等基础命令的极简 Redis 模拟端，减少启动阶段 `Connection is closed` 错误。

- 新增独立 `usage` 来源环境变量切换：
  - 看板新增 `USAGE_API_BASE_URL`，`/api/sync` 拉取 usage 时优先走该地址；未设置时回退到 `CLIPROXY_API_BASE_URL`。
  - 适配 CPA adapter 场景：可继续用 `CLIPROXY_API_BASE_URL` 访问原管理接口，同时仅将 usage 请求切到 `adapter.js` 暴露的 `/usage`。
  - 同步更新 `.env.example` 与 `README.md` 的环境变量说明，便于部署时直接配置。

## 2026-04-15

- 兼容 TypeScript 6.0.2 编译配置：
  - 在 `tsconfig.json` 中新增 `ignoreDeprecations: "6.0"`，消除 TS6 对 `baseUrl` 的弃用阻断报错（TS5101）。
  - 确保依赖升级到 `typescript@6.0.2` 后，项目 `lint / type-check / build` 可继续通过。

## 2026-04-02

- 修复 models.dev 价格同步中的“假更新”问题：
  - 价格同步路由新增价格归一逻辑，按数据库字段精度 `numeric(10,4)` 将输入/缓存/输出单价统一到 4 位小数后再做差异比较与写库。
  - 解决科学计数法（如 `7.5e-7`）及字符串格式差异（如 `1.23` vs `1.2300`）导致的重复误判更新。
  - 使同步结果中的 `updated/skipped` 更贴近真实价格变化，并减少无意义数据库写入。
  - 执行“更新价格”后，若存在实际变更（`updated > 0`），前端会自动刷新一次面板并跳过概览缓存，确保费用统计立即按最新价格生效。

- 优化 models.dev 同名模型价格选择策略：
  - 当同一 `model.id` 在多个 provider 中出现时，改为按“价格组合出现次数最高”选择价格信息。
  - 若最高次数并列，采用“首次出现优先”规则，避免受后续覆盖写入顺序影响导致结果漂移。
  - 次数统计基于数据库精度（4 位小数）归一后的价格签名，降低格式差异对选择结果的干扰。

- 增强价格同步详情可观测性（P4）：
  - 在价格同步 `details` 中补充选价依据（命中数/总样本数、是否发生并列及裁决方式、首来源 provider、来源集合、价格签名）。
  - `updated / skipped(未变化) / failed` 三种状态均保留选价依据，便于回溯“为什么选到这个价格”。

- 优化价格同步详情文案可读性（人性化改造）：
  - 列表中 `reason` 改为短句（如“已更新 / 未变化 / 写库失败 + 命中摘要”），减少信息噪声。
  - 新增长说明字段用于悬停/展开查看完整选价上下文（并列裁决、来源集合、签名），实现“短信息默认可读，长信息按需查看”。
  - 短句中的“并列”信息改为按需显示：仅在确实发生并列裁决时展示该片段，常规场景不再出现。
  - 同步详情表新增末尾帮助列：用 `?` 按钮替代“悬停查看详情”文案，悬停按钮查看长说明，默认列表更简洁。

## 2026-03-08

- Explore 页模型图例排序方式现可在浏览器端记忆：
  - 图例排序（首字母 / Token用量 / 请求次数）改为持久化到 `localStorage` 的 `exploreLegendSort`。
  - 刷新页面或重新打开浏览器标签页后，会自动恢复上次选中的排序方式，避免每次都重新切换。

- 修复 Explore 页时间范围与主图末尾日期不一致的问题：
  - 后端探索明细查询移除默认 `limit(50000)` 截断，避免在高频数据下只返回时间范围前段记录、导致主图停在较早日期。
  - 保留 `maxPoints` 参数能力，仅在显式传入时才限制返回条数。
  - 前端在 Explore 明细点数超过 `20,000` 时默认关闭散点图开关，优先保证全量时间范围可见，同时降低大数据量下的 SVG 渲染压力。

## 2026-03-07

- 修复每小时负载分布堆叠图中"输入"与"缓存"重复计数的问题：
  - 原始数据中 `inputTokens` 包含缓存命中部分，与 `cachedTokens` 存在子集重叠，导致堆叠图双重计数。
  - 在 `hourlySeries` useMemo 输出前对每个数据点执行 `inputTokens = Math.max(0, inputTokens - cachedTokens)`，使两者在图中不重叠。
  - 调整普通图和全屏图的堆叠顺序为：输入 → 缓存 → 输出 → 思考，保持"输入"与"缓存"在视觉上相邻，语义更清晰。
  - 同步更新两个图的 tooltip 排序、图例排序，以及顶层圆角（`radius` 移至新顶层的思考柱）。

- Tokens 卡片"缓存"改为缓存命中率显示，"输入"增加 hover 展示未命中输入：
  - "缓存"行：默认标签"缓存命中率"及百分比，hover 切换为"缓存"及实际 token 数。
  - "输入"行：默认标签"输入"及总输入 token 数，hover 切换为"未命中输入"及 `totalInputTokens - totalCachedTokens`。
  - 两行均使用相同的 opacity 过渡动画（duration-200），`absolute` 覆盖层不影响布局。

## 2026-03-06

- 修复首页"无法加载实时用量："后内容为空的问题：
  - HTTP/2 协议不携带 status text，`res.statusText` 在现代部署中始终为空字符串。
  - 改为优先读取响应体 JSON 中的 `error` 字段，回退到 `res.statusText`，最终回退到 `HTTP ${res.status}`。
  - `catch` 分支的 `error.message` 同样增加 `|| "未知错误"` 兜底。

- Explore 页模型图例排序切换：
  - 点击"模型图例"右侧的排序标签可循环切换：首字母 → Token用量 → 次数 → 首字母。
  - 排序计算在 `ModelLegend` 组件内部维护（`legendSort` state + `sortedModels` useMemo），不影响外部状态。
  - 新增 `modelStats` prop（由 `ExplorePage` 从 `points` 汇总 tokens / requests），在切换时无需重复遍历。

- Explore 页模型图例颜色优化（方案B 系统整改）：
  - 原 `MODEL_COLORS` 中5处色相/色调高度相似的颜色（浅蓝≈天青、浅红≈玫红、重复黄≈橙黄、浅绿≈绿、浅紫≈品红紫）影响图例区分度。
  - 替换方案：
    - 位置6 `#99e6ff`（浅蓝 200°）→ `#c0ff30`（柠绿 82°）
    - 位置8 `#ffb3b3`（浅红   0°）→ `#40fff0`（青绿 177°）
    - 位置11 `#ffe66d`（重复黄55°）→ `#ff50a0`（玫粉 340°）
    - 位置16 `#b3f5b3`（浅绿 120°）→ `#40ffa0`（春绿 152°）
    - 位置17 `#d9b3ff`（浅紫 280°）→ `#f050e8`（品红洋红 305°）
  - 新颜色相邻最小色相差从 <5° 提升至 ≥15°，视觉区分度显著改善。

## 2026-03-05

- Records 页表头多列排序：
  - 点击**未激活**列 → 插入头部成为主排序键（desc）；点击**已激活**列第二次 → 切换为 asc；第三次 → 从排序列表移除（`occurredAt` 列不允许移除，第三次循环回 desc）。
  - 存在多个排序键时，表头箭头旁显示小数字标注优先级（₁₂₃...）；悬停显示操作提示。
  - URL 参数改为 `sort=field:order,field:order` 格式，兼容旧 `sortField`+`sortOrder` 参数。
  - 游标分页采用方案 A：以首个排序键（主键）+ id 作为游标，次级排序在每页内精确有序。
  - 改动文件：`lib/queries/records.ts`（添加 `SortKey` 类型和 `getSortExpr` 辅助函数，`getUsageRecords` 接受 `sortKeys[]`）、`app/api/records/route.ts`（解析 `sort` 参数）、`app/records/page.tsx`（多键排序状态与交互）。

- 首页饼图颜色分配方式优化：
  - 原逻辑按模型在原始数组中的位置分配颜色，导致颜色与排名无关联。
  - 改为按 tokens 降序排名为每个模型分配固定颜色索引（`pieColorIndexMap` useMemo），tokens最多的模型始终得到颜色表第一个颜色，依此类推；对饼图 `Cell` 和自定义图例均生效，普通视图和全屏视图保持一致。

- 首页新增自动刷新功能：
  - 在"刷新数据"按钮左侧新增"自动刷新"复选框及刷新频率下拉框（预设 30秒/1分钟/5分钟/10分钟/30分钟 + 自定义秒数输入）。
  - 使用 `public/auto-refresh-worker.js` Web Worker 计时，后台标签页也不会被浏览器降频/休眠，计时精度不受影响。
  - 刷新频率和自定义值持久化至 `localStorage`（`autoRefreshSettings`），页面刷新后自动恢复；自动刷新开关默认关闭，不自动恢复以避免意外刷新。

- 同步超时时限从 60s 调整为 120s，支持 env 调节：
  - 前后端统一使用 `NEXT_PUBLIC_SYNC_TIMEOUT_MS` 环境变量覆盖（毫秒，正整数），默认 120s。
  - 后端（`app/api/sync/route.ts`）`USAGE_TIMEOUT_MS` 读取该变量；前端（`app/page.tsx`）`doSync` 默认参数读取该变量（构建时注入）。

- `formatCompactNumber` 补充 B（十亿）级别支持：
  - 值 ≥ 1,000,000,000 时显示为 `x.xxB`（保留两位小数），避免 Tokens 等超大数值停留在 `1500M` 等不直观格式。

- 首页请求数卡片成功/失败数精简显示：
  - 当成功数或失败数 ≥ 10000（超过 4 位）时，自动转为紧凑格式（如 12.3k），减少卡片文字溢出。
  - 鼠标悬停时通过 `title` 属性展示完整整数，方便查看精确值。

- 自动刷新 UI 精细优化：
  - 改为扁平一体化按钮样式：开启时整体 emerald 配色，关闭时 slate 配色；频率选项区通过 `max-width` 过渡动画展开/收起，无条件渲染避免动画失效。
  - 选择"自定义..."时频率下拉框收缩为仅显示箭头（选项文字颜色改透明），节省横向空间。
  - 下拉选项深色模式下使用近白绿配色（`#d1fae5` 文字 / `#022c22` 背景），防止深色环境下文字不可见。
  - 悬停自动刷新按钮时展示倒计时提示（如"30s 后刷新"），使用 `tickBaseTimeRef` + `tickIntervalMsRef` 精确计算剩余秒数；每次 tick 及开启时同步更新基准时间，确保倒计时始终准确。
  - 修复倒计时 tooltip 被 `overflow-hidden` 容器裁切无法显示的问题：将 tooltip 移至外层 `relative` wrapper 内但置于 `overflow-hidden` div 之外。
  - 频率展开区及自定义输入区动画改为纯 opacity 淡入淡出（`transition-opacity duration-200`），去除宽度滑动动画；隐藏时 `max-w-0` 即时折叠空间，opacity 为 0 时折叠不可见，视觉效果等同纯渐变。


## 2026-03-03

- Explore API 移除抽样采样逻辑：
  - 去掉 `row_number() % step` 分步跳过机制，改为直接按时间排序查询，最多返回 `maxPoints`（默认提升至 50,000）条记录，所有返回点均为连续真实数据，不再跳过任何有效点。
  - 零 tokens 过滤从前端 JS 下推至 SQL 层：始终并行统计无效点数量（`zeroTokensCount`）随接口返回；当 `filterInvalid=true` 时 points 查询加入 `total_tokens != 0` 条件。
  - 前端移除独立工具栏开关，改为在"渲染点数"统计行内联可点击文字：有无效点时默认显示"（过滤无效点？）"，点击后过滤并改为"（已过滤 N 无效点）"，再次点击取消过滤；开关状态存储在 `localStorage` 中（默认不过滤）。
  - `step` 字段保留但固定为 1，不影响现有接口契约。

- Explore 页数据过滤优化：
  - 当接口返回总点数（`total`）超过 3000 时，自动过滤掉 `tokens` 为 0 的数据点，减少无效噪点渲染，降低大数据量下散点图的视觉干扰和渲染压力；"渲染点数"旁同步显示已过滤的零 tokens 点数量。

- Explore 页散点图渲染性能优化：
  - 将每个数据点的双层 SVG circle（透明命中区 + 可见圆）合并为单个 circle，DOM 节点数量减少约 50%，万级点数下渲染压力显著降低。
  - 为工具栏新增"散点图"显示开关（默认开启），关闭后 `<Scatter data={[]}>` 跳过全部散点渲染，可在只需查看堆叠面积分布时大幅降低 SVG 节点数。
  - 引入 `deferredFilteredPoints = useDeferredValue(filteredPoints)`，Y 轴直方图、X 轴时间分布、堆叠面积图三个重计算 memo 使用延迟版本，新数据加载完毕时不阻塞主线程渲染。
  - 为两处 `tickFormatter` 的 `v` 参数补充 `: number` 类型注解，消除 TypeScript implicit any 报错。
  - 模型图例支持 Ctrl/⌘+点击独显：按住 Ctrl（Mac 为 ⌘）单击某图例，隐藏所有其他模型，仅保留该模型可见；若目标模型已处于独显状态则恢复全部；图例悬停提示更新为"点击隐藏，Ctrl/⌘+点击独显"。

- 首页统计卡片数值优化：
  - 平均 TPM、平均 RPM 均移除尾随零小数（`10.00` → `10`，`1.50` → `1.5`）。
  - 平均 RPM 同步引入万级以上压缩显示（`>= 1000` 时显示 `1k`、`10k` 等）。
- 完善数据库连接池配置说明：
  - 在 `README.md` 中新增“数据库连接池配置 (本地开发)”表格，详细列出 `DATABASE_POOL_MAX`、`DATABASE_POOL_IDLE_TIMEOUT_MS` 等环境变量的作用与默认值，便于开发者优化连接数占用。
- 重构数据库连接层，支持通用 PostgreSQL 与 Neon 无服务器 WebSocket 双驱动：
  - `lib/db/client.ts`：新增条件化驱动工厂，通过 URL 模式（含 `.neon.tech`）或环境变量 `DATABASE_DRIVER=neon|pg` 自动选择 `@neondatabase/serverless`（WebSocket）或 `pg.Pool`（标准 TCP）；Aiven、Supabase、RDS 等默认使用 `pg`。
  - 新增 `DATABASE_CA` 环境变量支持：`pg` 驱动下可传入 CA 证书 PEM 内容（原始或 Base64 编码），用于 Aiven、自建 PostgreSQL 等需要 `sslmode=verify-full` 的场景。
  - `scripts/migrate.mjs`：同步更新为动态驱动加载，支持 `DATABASE_CA`，迁移脚本与运行时保持策略一致。
  - 新增依赖：`@neondatabase/serverless`、`ws`、`@types/ws`、`pg`、`@types/pg`，移除对 `@vercel/postgres` 的直接依赖。
  - 修复根本原因：`@vercel/postgres` `createPool` 强制要求池化连接串，不兼容直连 URL；构建时模块顶层初始化导致 `invalid_connection_string` 错误；`pg` 不支持 Neon serverless WebSocket 端点（`wss://host:443`）。
- 修复 `pg` 驱动在小规格数据库下易触发 `53300`（连接槽耗尽）的问题：
  - 为运行时 `pg.Pool` 增加可配置连接池参数：`DATABASE_POOL_MAX`、`DATABASE_POOL_IDLE_TIMEOUT_MS`、`DATABASE_POOL_CONNECTION_TIMEOUT_MS`、`DATABASE_POOL_MAX_USES`。
  - 默认将池大小收敛为 `5`，降低 Vercel 多实例并发下打满数据库连接槽的风险。


## 2026-02-15

- 调整 `records` 页提供商染色策略：覆盖 `GeminiCLI`、`Vertex`、`AIStudio`、`Antigravity`、`Claude`、`Codex`、`Qwen`、`Kimi`、`iFlow`（大小写不敏感），提升来源识别度与颜色区分度。

## 2026-02-14

- 新增凭证映射与 `source` 相关能力，统一凭证展示/筛选口径，减少跨页面筛选不一致。
- `records` 页面升级列管理（显隐、排序、宽度、自适应、持久化）与交互样式，提升可读性和可操作性。
- 新增/完善提供商字段展示与相关查询，便于按来源识别调用记录。
- `explore` 增加按 Key/凭证过滤与下拉候选，提升探索效率。
- `/api/sync` 为 `/auth-files`（15s）和 `/usage`（60s）增加超时控制，并区分超时/普通错误，避免上游阻塞拖垮同步请求。
- `records` 同步失败/超时改为悬浮窗报错（含错误样式），让超时信息更直观可见。
- `records` 同步反馈新增 warning 态：当前端收到 `/api/sync` 的 `authFilesWarning` 时以黄色提示展示“部分成功”，并在有入库时附带同步条数，减少用户误判。

## 2026-02-13

- 修复时区配置与 SQL 分组问题，避免统计在不同时区下出现偏差。

## 2026-02-12

- 仪表盘图表改进（组合图/错误指标/线条样式）并补充记录页路由显示控制，增强可视化表达。

## 2026-02-10

- 升级开发依赖（`@types/node`、`drizzle-kit`），保持工具链稳定。

## 2026-02-07

- 升级 `recharts`，改进图表兼容性与表现。

## 2026-02-04

- 概览 API 增加 `skipCache` 控制，便于在需要时获取最新统计。

## 2026-02-03

- 修复 `/api/sync` 在大数据量下可能失败的问题：
  - `auth_file_mappings` 与 `usage_records` 的批量写入改为分块执行，避免单条 SQL 过长或绑定参数过多。
  - 新增分块配置：`AUTH_FILES_INSERT_CHUNK_SIZE`（默认 `500`）、`USAGE_INSERT_CHUNK_SIZE`（默认 `1000`）。

- 升级开发依赖（`eslint-config-next`、`@types/node`），提升开发体验。

## 2026-01-31

- 升级 `lucide-react`，更新图标依赖。

## 2026-01-29

- 升级 React 及类型依赖，保持框架版本一致。

## 2026-01-28

- 升级 `next` 与 `zod`，提升框架与校验库兼容性。

## 2026-01-27

- 模型价格同步链路集中优化（搜索、按钮交互、并发锁、304 处理、鉴权、免费模型/批量更新），提升同步稳定性与可用性。
- 调整状态提示与日期选择器样式，降低界面干扰并提升可读性。

## 2026-01-26

- 新增模型价格同步功能，为费用估算提供自动化数据来源。

## 2026-01-24

- 修复成本计算表达式引用，确保费用统计正确。

## 2026-01-23

- 完善同步与成本计费逻辑（含思考 token 计费），提高记录与费用准确性。

## 2026-01-22

- 仪表盘增加成功/失败原始计数展示，并调整迁移与请求统计字段逻辑，提升数据可解释性。

## 2026-01-21

- 上线调用记录页面与后端查询/API，并完善表格与日历样式，形成完整的记录管理能力。

## 2026-01-20

- 升级 `next` 与相关开发依赖，保持版本一致性。

## 2026-01-13

- 升级 `@types/node`，保持类型定义更新。

## 2026-01-11

- 优化筛选组件交互（动画、清除、状态切换）与小时维度图表能力（72h、柱状/面积切换）。
- 加入同步超时与状态修复，降低首屏阻塞风险。

## 2026-01-06

- 增加自定义时间范围、Modal 与探索页交互优化，并推进 Next.js 版本迁移，提升整体交互流畅度。

## 2026-01-05

- 调整请求数与 token 展示细节，提升数值展示直观性。

## 2026-01-03

- 引入并优化 Toast 状态提示机制，增强同步过程反馈。

## 2026-01-02

- 完善迁移脚本与构建流程，支持首次部署可用。
- 引入 `vercel/analytics` 并优化散点图 Y 轴动画。

## 2026-01-01

- 优化趋势图与探索图性能（仅渲染可视范围），并修复日志页与 tooltip 相关体验问题。

## 2025-12-31

- 优化探索图与仪表盘布局，补充 Modal 能力并调整 README/构建配置，提升整体可维护性。

## 2025-12-30

- 上线数据探索页与相关 API，补充缓存、同步、登录与错误处理等基础能力。
- 增加 CI/依赖管理与项目基础文件（如许可证、Dependabot），完善工程化。

## 2025-12-29

- 初始化鉴权中间件、同步接口结构与基础文档，形成项目最初可用版本。

## 2026-11-17

- 实施 Phase 5 Dashboard Read Path：Overview、Explore、Records 切换至规范事件表；增加统一筛选、货币安全成本、价格覆盖率、稳定游标分页及 PII 安全的确定性散点抽样。
- 通过增量迁移 0006 扩展 Rollup 的 API Key、Service Tier、Cache Creation 和定价覆盖维度；新增采集状态与缺口页面及 API。

## 2026-11-18

- Phase 6：发现并只读快照 Oh My CPA SQLite 历史库；新增可恢复、按源快照 SHA-256 绑定、幂等的 PostgreSQL 导入工具及运行审计表，完整保留 105 个历史模型价格版本。
- 保留 17,132 条请求级历史事件、历史成本与定价状态；源价格版本 ID 与原始 event_key 单独留存，避免误关联目标价格外键或丢失重复键审计；排除 IP、转发地址、User-Agent、原始请求体、失败正文和响应头。
- 在隔离 PostgreSQL 17 中完成全量导入、Token/费用/时间/定价对账及 Rollup/API 验证；未写入生产数据库，Phase 7 部署与切换仍未执行。


## 2026-11-18 — Phase 7 preparation

- 增加 Next.js standalone Docker 镜像、GHCR immutable SHA 标签发布、Compose 部署模板、浏览器验收和 PostgreSQL 17 重启持久性 CI；移除只适用于 Vercel 部署的 Analytics 注入，避免自托管环境请求不存在的 `/_vercel/insights/script.js`。
- 增加 Collector 进程重启、PostgreSQL backend 断连恢复、过期 Processor Lease 回收等故障验证。
- 生产预检发现 OMC 与 Keeper 使用 CPA `SUBSCRIBE usage`；CPA 在有订阅者时不写 FIFO 队列。保持现有服务不动，明确切换前必须停止/禁用旧订阅者。
- 将 CPA Usage Queue retention 从 300 秒通过 Management API v8 热更新至上限 3,600 秒，并备份修改前配置；尚未启用 Monitor 生产 Collector。


## 2026-11-18 — Native CPA RESP Subscription

- 实现 CPA 原生 RESP `SUBSCRIBE usage` 长连接与 Pub/Sub 消息解析，支持 AUTH、订阅确认、消息帧分发、UNSUBSCRIBE、连接关闭与异步持久化错误处理。
- Collector 默认改为 `COLLECTOR_MODE=auto`：优先加入 CPA 广播订阅；仅当服务端明确拒绝 `SUBSCRIBE` 时才切换 FIFO Pull。订阅断线不会盲目执行 LPOP。
- 每个订阅事件先事务写入 PostgreSQL Inbox；订阅会话记录 received/persisted 计数。断线、进程异常或持久化失败会写入 `usage_ingest_gaps`，missing count 明确标为 unknown（CPA Pub/Sub 无 ACK/replay）。
- 新增 `0008_resp_subscription.sql`，扩展 collector mode、pull attempt、Inbox 和 usage event transport 约束。
- 增加 RESP fake-server 测试、PostgreSQL Inbox/Processor 集成测试、断线 gap 测试；44 项 Collector 测试、PostgreSQL、OMC 导入、typecheck、lint 和 Next.js build 全部通过。
- 通过真实 Collector 进程 + 隔离 RESP fake CPA + PostgreSQL 17 完成端到端订阅验证：收到 1 条事件、Inbox 持久化 1 条、SIGTERM 后正常 UNSUBSCRIBE 并结束会话。

## 2026-11-21

- 精简首页仪表盘：移除价格覆盖率统计条和 Pricing Center 推广区块，并清理仅由该入口触发的旧版模型价格同步弹窗；独立 `/pricing` 页面的同步、价格管理、模型关联与成本试算功能保持不变。
