# Pricing Center V1 — 审计与实施规范

## 1. 审计基线

- 代码基线：`d917d0c14dc10ec4292c10f68a9a10e655f47dec`。
- 数据库：PostgreSQL 17。
- 实时事件：CPA RESP Subscription → Durable Inbox → Processor → `usage_events`。
- 当前模型价格只有 Input / Cached Input / Output 三个价格字段；Processor 在 Inbox 事务中直接执行简化 SQL 计价。
- 现有 `model_price_versions` 已提供按请求发生时间查询的历史价格基础；`usage_import_source_price_versions` 保留 OMC 原始四桶、倍率和 Tier 价格证据。
- 历史 OMC 导入和 Monitor 历史补价不属于本阶段。

## 2. 价格身份与来源

### 2.1 CPA 与上游身份

- CPA `usage_events.provider` 是实际服务该请求的渠道标签，不等同于 models.dev Provider ID。
- 上游价格身份由 `source + upstream_provider_id + upstream_model_id` 唯一确定。
- 价格记录同时保留 CPA `model` 和可选渠道作用域；渠道特定价格优先于共享模型价格。
- 若 `response_model` 明确表明 CPA 替换了请求模型，则以响应模型计价；原始请求模型与替换证据仍保留在事件中。

### 2.2 数据来源

- models.dev 是自动价格来源；每个 Provider Offering 单独存储，不把同名模型不同 Provider 的价格取众数。
- OpenRouter 仅作为只读参考目录，绝不覆盖 models.dev 或人工价格。
- Custom 是人工权威价格；Linked 是人工指定的上游 Offering；Auto 仅接受安全、确定的匹配。
- 同步保留 ETag、Last-Modified、内容 SHA256、抓取时间和每次运行结果。

## 3. 匹配策略

按以下顺序执行：
1. 已保存的人工 Linked 映射。
2. CPA Provider 与上游 Provider ID 规范化后完全相同的精确模型 ID。
3. 模型 ID 在目录中唯一的精确 Offering。
4. 多个 Offering 仅在全部计价字段一致时允许共享价格；否则标记 ambiguous。

禁止根据后缀截断、前缀包含、编辑距离或 reasoning effort 后缀进行自动计价。候选建议与已确认匹配分离。Custom / Linked 不得被自动同步覆盖。

## 4. 计价语义

- 费率单位统一为 USD / 1M tokens。
- 四桶：普通输入、输出、缓存读取、缓存写入。
- CPA 的 reasoning tokens 是 output 子集时不得重复加总。
- 若只有总缓存 Token，则按缓存读取处理；显式 cache-write 优先单独分桶。
- 模型倍率与 CPA 渠道倍率分开保存，最终统一计算。
- 缺失价格不等于零；缺少必要费率时保持 unpriced / invalid_price。
- 明确的零价格是有效价格。
- 价格使用 BigInt 定点十进制计算，最终一次性 half-up 舍入到 USD nanos。
- 条件 Tier 要求所有条件同时成立；最多选择一个 Tier。优先级为 Service Tier、最高 Prompt 阈值、分时窗口、原始顺序。
- 分时规则按请求发生时间及 IANA 时区判定；无效时区不能回退为服务器本地时间。

## 5. 历史证据

- 价格版本、渠道倍率版本均为追加式历史。
- 新请求在 Processor 插入事务中锁定价格版本、渠道版本、Tier、服务档位、成本与结构化计算说明。
- 价格同步或人工编辑不得重写已经 priced 的事件。
- 本阶段不执行任何历史补价；已有 35 条未定价记录继续保持原状，留待 Phase 5 使用 OMC 历史价格快照或可证明的历史来源价格补齐。

## 6. Phase 0–4 交付边界

- Phase 0：审计与规范。
- Phase 1：PostgreSQL / Drizzle 模型和迁移。
- Phase 2：models.dev 主目录、OpenRouter 只读参考、可审计同步和安全匹配。
- Phase 3：统一 Quote Engine、实时 Processor 集成、请求级不可变价格快照。
- Phase 4：Pricing Center 页面、价格模式、渠道管理、Tier、同步状态、历史版本和同引擎试算。
- 不实施 Phase 5 历史回算，也不切换/停止 CPA Collector 或 RESP Subscription。
## 7. 已实现行为与接口

### 7.1 models.dev / OpenRouter

- models.dev 使用 Provider Offering 维度保存目录；CPA 模型可通过精确模型 ID、canonical_model_id、Provider 精确归一化或唯一 Offering 匹配。
- OpenRouter 的价格以只读参考方式保存；其每 Token 单价通过十进制定点运算精确换算为 USD / 1M，不参与自动计价。
- 缓存读写费率缺失时，目录会以普通输入费率作为保守继承值，并在 Offering metadata 中记录 cache_read_inferred / cache_write_inferred。
- 目录为空、响应异常或超过 15 MB 时拒绝替换当前目录；同步通过 PostgreSQL Advisory Lock 防止同一来源并发运行。
- Processor 每 5 分钟检查一次到期状态；默认 24 小时同步一次。间隔设置为 0 表示关闭自动同步。

### 7.2 Tier JSON

每个 Tier 至少需要一个条件；同一 Tier 的多个条件必须同时满足。支持：

    [
      {
        "service_tiers": ["priority"],
        "min_prompt_tokens": 200000,
        "prompt_price_per_1m": "2.5",
        "completion_price_per_1m": "12",
        "cache_read_price_per_1m": "0.25",
        "cache_write_price_per_1m": "2.5"
      },
      {
        "utc_start": 900,
        "utc_end": 1700,
        "time_zone": "Asia/Shanghai",
        "prompt_price_per_1m": "3"
      }
    ]

- service_tiers、min_prompt_tokens、utc_start + utc_end + time_zone 是条件字段；费率字段省略时继承基础费率。
- 分时窗口支持跨午夜；时间使用 IANA 时区解释，开始时刻包含、结束时刻不包含。
- 同时命中多个 Tier 时只选一个：Service Tier 条件优先，其次更高 Prompt 阈值，再次分时窗口，最后按配置顺序；不会叠加多个 Tier。

### 7.3 实时成本快照

usage_events 新增 channel_version_id、price_tier_index、resolved_service_tier、pricing_policy_version 和 cost_breakdown。Processor 在 Inbox 处理事务内按 occurred_at 查询价格版本及渠道倍率版本，计算结果和证据随事件一起提交。

价格版本和渠道倍率版本均不可 UPDATE / DELETE。版本采用追加式 valid_from 选择；旧版 valid_to 字段保留兼容，不再通过关闭旧版本来实现版本切换。删除当前价格或渠道会追加 available=false 的停用版本。

### 7.4 API

- GET /api/pricing：价格覆盖、观测模型、上游候选、同步快照、渠道倍率及版本历史。
- POST /api/pricing、DELETE /api/pricing：保存 Custom 价格或追加停用版本。
- POST /api/pricing/sync：手动同步 models.dev、OpenRouter 或两者。
- PATCH /api/pricing/sync：设置来源自动同步间隔（0–168 小时）。
- POST /api/pricing/link、DELETE /api/pricing/link：创建或解除明确的 models.dev Offering 关联。
- GET /api/pricing/channels、POST /api/pricing/channels、DELETE /api/pricing/channels：管理渠道倍率。
- POST /api/pricing/preview：使用 Collector 同一 Quote Engine 试算，不写入 Usage 账本。

所有页面与 API 受 Dashboard 登录保护；旧的 /api/sync-model-prices 兼容入口保留原有 Bearer / Cookie 鉴权。

## 8. Phase 0–4 验收边界

- Migration：0010_pricing_center.sql，仅追加列、索引、价格目录、映射、同步状态、渠道倍率历史和保护触发器。
- Unit：Collector + Pricing Node test 套件覆盖四桶计价、精确十进制、Reasoning 不重复计费、缓存桶不一致、Tier 优先级、IANA 时区、模型匹配及 OpenRouter 费率换算。
- PostgreSQL 17：覆盖迁移、价格版本追加、渠道倍率版本追加、请求级成本快照和证据不可变性。
- Playwright：覆盖登录后的模型关联、Custom 价格、渠道倍率、自动同步间隔和成本试算。
- 不执行历史事件成本回算；既有 OMC 价格证据保持只读；不切换生产 Collector / RESP Subscription。

