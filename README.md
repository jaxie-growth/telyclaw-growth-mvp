# TelyClaw Growth Engine

> **Real-time Social Trend → Content Growth Engine**
> TelyClaw Growth Lead · Vibe Coding Challenge 交付物

一个可运行的 MVP：持续监控 X（Twitter）上的财经类账号 → 自动识别正在加速的热点话题 → 用可解释的 **Opportunity Score** 排出"最值得 TelyClaw 跟进"的机会 → 生成 3 个角度的内容草稿（含至少 1 条可直接发布的推文）→ 人工审核后发布，并把每一次动作沉淀成增长指标。

核心工作流：`Monitor → Detect → Rank → Ideate → Craft → Review → Publish`

---

## 1. 快速开始

```bash
# 需要 Node.js 18+（本项目零第三方依赖，不需要 npm install）
node server.js
# 打开 http://localhost:5173
```

首次打开后，点概览页的 **▶ 运行完整流水线**，一次跑通"抓取 → 热点识别 → 机会排序 → Top1 热点内容生成"，然后去 **内容工厂** 做人工审核与发布。

```bash
node scripts/smoke.js 24   # 后端链路冒烟测试（24H 窗口，可传 4 / 24 / 168）
node scripts/ui-smoke.js   # 前端渲染冒烟测试（需先启动服务）
```

打开 **演示模式**（右上角按钮）会有 8 步引导，按顺序点即可完成一次完整演示，适合录屏。

---

## 2. 产品逻辑（Product Logic）

**要解决的问题**：TelyClaw 的产品是"AI-native 的社交增长引擎"。作为增长负责人，最大的浪费不是不会写内容，而是**热点窗口期太短**——一个话题从起量到被所有人写完通常只有几小时，而人工"看盘 → 判断 → 找角度 → 写草稿 → 审核"的链路根本跟不上。

**这个 MVP 的解法**：把"热点捕捉"变成一条有 SLA 的流水线，并让机器只做机器擅长的事（监控、聚类、打分、起稿），把判断权完整留给人（编辑、批准、发布）。

| 环节 | 机器做什么 | 人做什么 |
|---|---|---|
| Monitor | 拉取配置账号在指定时间窗口内的帖子 | 决定盯谁、盯多久 |
| Detect | 聚类成话题、自动命名、生成摘要、判断是否在加速 | 判断这个热点是否可信 |
| Rank | 按 6 个因子算 Opportunity Score 并给出理由 | 调整权重（=定义什么算"值得"） |
| Ideate / Craft | 生成 3 个角度 + 至少 1 条可直接发布推文 | 编辑、改写 |
| Review / Publish | 原创度校验、状态流转 | 批准 / 驳回 / 发布 |

**一句话**：这不是一个 Twitter 监控工具，而是一套把实时趋势转成内容增长机会的闭环系统。

---

## 3. 系统架构（System Architecture）

零依赖 Node HTTP 服务 + 原生前端，`node server.js` 即可运行（面试场景"跑起来"优先于"工程完备"）。

```
                 ┌──────────────────────────── public/ ────────────────────────────┐
                 │  index.html + app.js + styles.css（原生 JS，无构建步骤）           │
                 │  概览 / 账号 / 热点 / 排序 / 内容工厂 / 发布 / 看板 / 设置         │
                 └───────────────────────────────┬─────────────────────────────────┘
                                                 │ fetch JSON
┌────────────────────────────────────────────────┴────────────────────────────────┐
│ server.js（node:http 路由层，/api/*）                                            │
│   /api/accounts  /api/ingest  /api/analyze  /api/generate  /api/draft/*  ...     │
└───────┬───────────────┬───────────────┬───────────────┬───────────────┬─────────┘
        │               │               │               │               │
   src/ingest.js   src/topics.js   src/ranking.js   src/content.js   src/metrics.js
   数据源适配层     热点识别         机会打分          内容生成+质检     指标口径
        │               │               │               │
   simulated /      sklearn 式        6 因子加权       mock / LLM      北星+支撑指标
   x_api (官方 v2)   规则聚类         min-max 归一     + 原创度校验       + 漏斗
        └───────────────┴───────────────┴───────────────┴── src/store.js（JSON 持久化）
                                                              data/state.json
```

**模块边界是刻意设计的**：`ingest` 只负责"把外部世界变成统一的 Post 结构"，`topics/ranking/content` 只吃 Post 列表、吐结构化结果。因此换数据源、换 LLM、换存储都不需要动业务逻辑。

---

## 4. 数据获取方案（现实约束与生产化路径）

题目允许"如果无法直接获取完整实时数据，可以使用合理的替代方案完成 MVP"，并要求在 README 中说明真实生产会怎么解决。

**当前 MVP：`DATA_SOURCE=simulated`**

- 内置一份**确定性仿真数据集**（`src/dataset.js`）：14 个财经类账号、最近 7 天约 700 条帖子，由 11 个"话题种子"驱动生成，带真实趋势形状：
  - `phase[7]`：话题 7 天活跃度曲线（有的升温、有的衰减）；
  - `burst`：新闻爆发窗口（比如 CPI 公布后 6–11 小时集中刷屏）；
  - 同话题帖子共享锚点实体与主标的，因此**聚类、打分、排序的每一步都能被验证**，而不是对着随机噪声调参。
- 优点：无需任何 key、离线可跑、结果可复现（同一分钟内多次抓取结果一致），面试演示不会因为额度/限流翻车。

**生产环境（已预埋适配层 `src/ingest.js`）**

1. **官方 X API v2**：`DATA_SOURCE=x_api` + `X_BEARER_TOKEN`，走 `GET /2/users/by/username` + `GET /2/users/:id/tweets`，已实现字段映射（含 `public_metrics` → 互动量加权）。限制：免费档几乎不可用，Basic/Pro 档有月读量与 QPS 限制，因此需要配额管理。
2. **配额与成本控制**（真正上生产必须做的三件事）：
   - **账号分层**：核心账号（10–20 个）走官方 API 高频拉取；长尾账号走批量端点/日更，降低成本；
   - **增量游标**：本地保存 `since_id` / `last_seen_at`，只拉新内容，避免重复计费；
   - **降级链**：官方 API 限流 → 第三方聚合源（RSS/授权数据商）→ 最近一次快照（标记 stale 并在 UI 提示"数据可能滞后"）。
3. **实时性**：需要近实时时用 X 的 filtered stream（付费档）+ 本地队列削峰；否则 5–15 分钟轮询足够捕捉"小时级窗口"。
4. **合规**：只读公开数据、遵守平台 ToS 与 robots 规则；发布动作必须走官方 API 且有人的审批，不做自动发帖（本 MVP 的发布也是模拟的，见 §10）。

---

## 5. 热点识别逻辑（Trend Detection Logic）

回答的问题是：**"我监控的这群人，现在主要在讨论什么？哪些话题在快速升温？"**

1. **清洗与分词**（`tokenize`）：cashtag（`$NVDA`）权重 ×2.5、2 字母术语白名单（ai/bp/etf…）、英文停用词过滤；同时抽数字事实（`+2.4%`、`$70bn`、`25bp`）。
2. **聚类**（`clusterPosts`）：帖子按互动量降序作为"簇心候选"，与已有簇做 **加权 Jaccard + 重叠系数的混合相似度**（`0.5 × Jaccard + 0.5 × 重叠系数`）——单一 Jaccard 对"长短帖差异"太敏感，混合口径同时看"整体有多像"和"较小的集合被包含多少"。相似度 ≥ 0.26 并入该簇，最后再做一轮簇间合并（≥ 0.30）。
3. **同类合并**（`mergeBySeed`）：词面聚类会把同一话题的不同侧面拆成多个小簇（Fed 的"dot plot 党"和"duration 党"）。用主题词典对齐后按主题 id 合并，避免排序里出现 5 个"Fed 热点"互相打架。
4. **自动命名**（`nameCluster`）：对簇内词做 **IDF 加权**（在整份语料里到处都出现的 `desk` / `chatter` 没有区分度，会被压下去），取 top 词生成名字；若与主题词典命中率高，则使用可读的主题名（`Fed / rate-cut repricing`）。
5. **趋势量化**：把窗口对半切，比较前后两半的**每小时发帖速率**得到 `growth`（环比），近 1/4 窗口的每小时互动量为 `velocity`，近 1/4 窗口发帖占比为 `freshness`；`growth > 5%` 记 `growing`、`> 20%` 记 `rising`（"加速中"）。同时输出逐时分布（前端画迷你走势图）与**峰值时间**（用于算检测时效）。
6. **AI 摘要**：给出"N 个账号讨论 M 条帖子、互动量、环比 +X%、市场共识、主要分歧、高频标的、多空结构"的一段中文摘要——即"核心讨论内容"的总结。
7. 每条话题都会带**证据链**：最相关的原始帖子 + 参与账号列表（题目要求的"展示相关 Posts 和 Accounts 作为依据"）。

> 生产版可把第 2 步换成 embedding 聚类（同一份接口），但对 MVP 而言，可解释的规则聚类更好——面试时每一步都能讲清楚"为什么它算热点"。

---

## 6. 机会排序逻辑（Opportunity Ranking Logic）

题目原话：**"讨论多"并不意味着"最值得 TelyClaw 跟进"**。所以分数不是热度，而是"机会值"。

```
Opportunity Score (0-100) = 100 × Σ ( 因子归一值ᵢ × 权重ᵢ / Σ权重 )
```

| 因子 | 默认权重 | 原始值 | 为什么它进公式 |
|---|---|---|---|
| `velocity` 热度增速 | 0.30 | 近 1/4 窗口每小时互动量 | 热点是**现在**快，不是过去多 |
| `engagement` 互动规模 | 0.20 | 窗口内总互动（赞+2×转+3×评+2×引） | 决定可能的曝光天花板 |
| `accounts` 参与账号数 | 0.15 | 独立账号数 | 单账号刷屏不是趋势；多来源共识才是 |
| `freshness` 时效性 | 0.10 | 近 1/4 窗口发帖占比 | 区分"正在发生"和"已经过去" |
| `relevance` TelyClaw 相关性 | 0.15 | 命中产品/受众关键词的帖子占比 | **是不是我们该说的**（否则接了也接不住） |
| `contentOpportunity` 内容可生产性 | 0.10 | 数字密度 42% + 账号多样性 28% + 多空分歧 30% | 有数据能拆解、有分歧能表态，才写得出有信息量且有点击的内容 |

设计说明：
- 因子先做 **min-max 归一**（同一批话题内相对比较），再加权求和，所以"满分 100"是相对概念，跨批次不可直接比较。
- 权重可在 **设置** 页实时调整并立刻重算 —— 这就是"自己定义机会分数"的落点：我把它做成可调参数，而不是藏在代码里的魔法数。
- 每个话题都输出 **逐因子拆解（因子分 / 权重 / 贡献分 / 原始值）** 和中文理由列表，以及 1 段 **Top1 结论**（领先第二名多少分、建议从哪个角度切入）。

---

## 7. 内容生成逻辑（Content Generation Logic)

**输入**：一个热点话题（含摘要、情绪结构、事实数字、标的、样本帖）
**输出**：3 个角度各 1 条，其中至少 1 条标记为"可直接发布"

| 角度 | 定位 | 结构 |
|---|---|---|
| Hot Take / Opinion | 表态、引发讨论 | 反共识断言 → 用数据支撑（帖子数/账号数/环比）→ 留一个观察点 |
| Educational / Insight | 给读者可带走的东西 | 3 个常见误解 / 4 行速览（发生了什么 → 为什么重要 → 看什么 → 忽略什么） |
| TelyClaw Product Angle | 自然接到产品叙事 | 从这次热点里"时间窗口有多短"过渡到"检测→发布的流程问题"，而不是硬广 |

**两种实现，同一套校验**：
- `LLM_MODE=mock`（默认）：内置确定性生成器，用"骨架 + 话题事实"填充（事实块来自 `extractFacts`：帖子数、账号数、环比、数字、标的、人话短语）。好处是不联网也能产出合格文案，demo 不会因为 API 失败而断。
- `LLM_MODE=openai`：走任意 OpenAI 兼容 `/chat/completions`，Prompt 里明确给出产品定位、受众、文风，并**硬性要求"禁止出现源帖中的完整句子"**，返回严格 JSON。失败自动回退到 mock（并在 UI 提示）。

**原创度校验（强制，不通过不许发布）** —— 直接回应题目"内容不能只是 Copy、Rewrite 或 Summary 原始 Tweet"：
1. 与所有样本源帖计算**加权 Jaccard 语义相似度**，≥ 0.45 判为涉嫌 Rewrite；
2. 计算**连续 5 词重叠率**，≥ 0.20 判为涉嫌 Copy；
3. 字符数 ≤ 280、长度下限 60 字符；
4. 输出 `原创度% = (1 - max(相似度, 2×重叠率)) × 100`，在 UI 上逐条展示；任一不通过 → 状态变 `needs_revision`，**批准按钮与发布接口都会拒绝**（服务端也会二次校验，不只靠前端）。

**预估表现（模拟）**：`曝光 = (velocity×1.6 + engagement/18 + 400) × 角度系数 × (1 + 分歧度×0.3)`，互动按 1.6%–3% 转化，再乘 ICP 匹配度得到"合格互动"。这是用于验证指标口径的启发式模型，UI 与本文档都明确标注为模拟值。

---

## 8. 人工审核闭环（Human-in-the-loop）

```
Trend → AI Draft → Human Edit → Approve → Publish
```

- 草稿状态机：`draft → (人工编辑) → approved → published`，另有 `rejected`（驳回）与 `needs_revision`（未过校验）。
- 每次编辑都重新跑原创度校验，并在 `history` 里留痕（谁在什么时候改了什么动作、原创度多少）。
- 发布要经过批准 + 服务端质量校验双闸门；发布后写入 `published` 列表并记录**发布时的话题快照**（用于事后计算"热点命中率"）。
- MVP 的发布是**模拟发布**（生成占位 URL）；真实 X 写入 API 属于 Bonus 项，未做（见 §10）。

---

## 9. 指标口径（Metrics）

**North Star Metric：Qualified Engagement Generated from Trends**
= Σ(由热点内容带来的互动 × ICP 匹配度)。用"合格互动"而不是"曝光/互动总量"，是因为增长岗真正要对齐的是**受众质量**：TelyClaw 的 ICP 是 AI-native 创业者/开发者/量化与研究者/财经与 AI 内容创作者。

| 支撑指标 | 口径 | 为什么重要 |
|---|---|---|
| 话题发现延迟 | 话题首帖 → 被系统首次检测到 | 监控能不能跟上新闻节奏 |
| 峰值提前发现率 | 首次检测时间早于话题峰值的话题占比 | 追热点的本质是抢时间窗 |
| 内容产出量 | 草稿总数（按状态拆分） | 产能 |
| 审核通过率 | 通过 / 已审核草稿 | AI 草稿的可用度（越高越省人力） |
| 热点命中率 | 发布后话题仍在升温的占比 | 避免追"已经死了的热点" |
| 互动提升 | 已发布内容预估互动 / 全量草稿均值 − 1 | 排序逻辑是否真的选得更好 |
| 闭环漏斗 | 热点 → 草稿 → 批准 → 发布 | 定位流失环节 |

**⚠️ 诚实声明（重要，也是题目"说明当前 MVP 局限"的一部分）**：
- 数据源是仿真数据时，上述指标是**基于仿真数据的估算**，用于验证口径与闭环是否成立，不代表真实 X 表现（UI 上也常驻提示）。
- 时效类指标在当前环境里天然为负/为 0：仿真数据是"上线那一刻回填过去 7 天"，系统首次检测时间 = 你点按钮的时间，所以「峰值提前发现」必然显示为负。它衡量的是**持续监控时能提前多久发现话题**，切到真实 API 连续采集后才有正数意义。

---

## 10. MVP 局限与下一步（含 Bonus 项对照）

| 题目 Bonus 项 | 状态 | 说明 / 下一步 |
|---|---|---|
| Trend Velocity / Momentum Detection | ✅ 已做 | `growth`（前后半窗口速率对比）+ `velocity`（近 1/4 窗口互动/小时）+ 逐时分布 |
| Engagement-based Ranking | ✅ 已做 | Engagement 作为独立因子（权重可调），且是 North Star 的输入 |
| Account Scoring | ⚠️ 部分 | 目前用**独立账号数**衡量"共识强度"；下一步给每个账号算历史命中率（它先说的热点后来涨了没），做"信号源加权" |
| Multi-candidate Trend Detection | ✅ 已做 | 聚类产出多候选并由分数机制排序，不是取 Top1 关键词 |
| Emoji / Slang / Sentiment Detection | ⚠️ 部分 | 已做多空情绪结构（`tone`）；emoji/黑话词典未接入 |
| Human-approved Workflow | ✅ 已做 | 状态机 + 服务端二次校验 + 操作留痕 |
| X Publishing Integration | ❌ 未做 | MVP 为模拟发布；接入需要 OAuth2 用户上下文写权限，属生产化阶段 |
| Scheduled Monitoring | ⚠️ 部分 | 前端可手动/按窗口触发；下一步加 cron（`setInterval` 或系统定时任务）做无人值守轮询 + 只在"发现新高分机会"时推提醒 |
| Historical Trend Tracking | ⚠️ 部分 | `scoreHistory` 已记录每次 Top1 分数；下一步把话题分数落成时间序列，做趋势回顾与归因 |
| Proxied Control Performance Tracking | ⚠️ 部分 | 已用预估互动做前馈评估；真实归因需要拿到发布后的真实指标回写 |
| Agentic Content Performance Loop | ⚠️ 部分 | 已有"发布→命中率/互动提升"的闭环数据基础；下一步把表现反馈到权重与角度选择（自动调参） |

**其他已知局限**：
- 持久化是 `data/state.json`（便于面试复现），并发写入未做锁；生产换 Postgres/Supabase，`src/store.js` 接口不变。
- 聚类是规则+词面级别，跨语言/谐音梗/极度口语化的帖子会漏；生产建议 embedding + LLM 二次判定。
- 模拟发布的"预估互动"不是真实数据，不能作为增长承诺。
- 搜索/相关性目前是关键词级，未做向量召回。

---

## 11. 使用的 AI / Vibe Coding 工具

- **WorkBuddy（本次实现的主力工具）**：从 0 到 1 完成项目骨架、仿真数据集、聚类与排序引擎、内容生成与质检、前端 UI、指标口径与本文档。人（我）负责的是**判断**：定义 Opportunity Score 的因子、设计原创度校验的阈值口径、决定"机器做哪些、人留哪些"。
- **LLM 接入层**：预留 OpenAI 兼容接口（`LLM_MODE=openai`），Prompt 中固化了产品定位/受众/文风约束与"禁止照抄"的硬性规则。
- 题目允许在 Cursor / Claude Code / Codex / Replit / Lovable / Bolt 等工具中任选；本项目在 WorkBuddy 下完成，零第三方依赖，`node server.js` 即可复现。

---

## 12. 验收标准对照（Minimum Acceptance Criteria）

| 题目要求 | 实现情况 |
|---|---|
| 可配置至少 5 个 X Accounts | ✅ 内置 14 个财经类账号，支持增删/启停 |
| 至少 2 种不同时间窗口 | ✅ 1H / 4H / 24H / 7D（抓取与识别均按窗口） |
| 可获取或导入指定时间窗口内的 Posts | ✅ `/api/ingest`，落盘 `data/posts.json` 作为快照 |
| AI 可自动识别多个 Topics / Trends 并输出 Summary | ✅ 7–11 个话题 + 自动命名 + 中文摘要（含共识/分歧/标的） |
| 可对 Trends 进行 Ranking 并解释 Ranking 原因 | ✅ 6 因子拆解 + 中文理由列表 + Top1 结论 |
| 可选出最值得 TelyClaw 跟进的 Top Trends | ✅ 机会排序页 Top 8，Top1 高亮 |
| 每个重点 Trend 可生成至少 3 个 Content Angles | ✅ Hot Take / Educational / Product Angle |
| 可生成至少 1 条能直接发布的 X Post | ✅ 自动标记"可直接发布"，≤280 字符校验 |
| 有基本可操作的 UI | ✅ 8 个页签 + 一键流水线 + 8 步演示引导 |
| 整个 Workflow 可端到端 Demo | ✅ `node server.js` → 概览页"运行完整流水线" → 内容工厂审核发布 → 数据看板 |

---

## 13. 目录结构

```
telyclaw-growth-engine/
├─ server.js                 # 零依赖 HTTP 服务 + /api 路由
├─ src/
│  ├─ config.js              # 配置（.env 手写解析）+ 评分权重 + 相关性词典
│  ├─ dataset.js             # 仿真数据集：账号池 / 11 个话题种子 / 生成器
│  ├─ ingest.js              # 数据源适配层：simulated | X API v2
│  ├─ topics.js              # 分词 / 聚类 / 自动命名 / 摘要 / 趋势指标
│  ├─ ranking.js             # Opportunity Score 与可解释理由
│  ├─ content.js             # 内容生成（mock / LLM）+ 原创度质检 + 预估表现
│  ├─ metrics.js             # 北星指标与支撑指标口径
│  └─ store.js               # JSON 持久化（可替换为数据库）
├─ public/                   # 前端（原生 JS，无构建）
├─ scripts/
│  ├─ smoke.js               # 后端链路冒烟测试
│  └─ ui-smoke.js            # 前端渲染冒烟测试（jsdom）
├─ .env.example              # 数据源 / LLM / 端口配置示例
├─ DEMO_SCRIPT.md            # 3-5 分钟 Demo 视频分镜脚本
└─ GROWTH_PLAN.md            # 90 天增长问题答稿
```

---

## 14. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全量状态（账号/帖子数/分析结果/草稿/发布） |
| GET | `/api/posts` | 当前窗口帖子快照（按互动排序） |
| POST | `/api/accounts` `/api/accounts/toggle` `/api/accounts/remove` | 账号增删启停 |
| POST | `/api/ingest` | 按窗口抓取帖子 |
| POST | `/api/analyze` | 热点识别 + 机会排序 |
| POST | `/api/generate` | 为指定话题生成 3 个角度草稿 |
| POST | `/api/draft/update` `/regenerate` `/status` `/publish` | 人工编辑 / 重新生成 / 批准驳回 / 发布 |
| GET | `/api/metrics` | 北星指标与支撑指标 |
| POST | `/api/config` | 切换数据源 / 生成模式 / 调整评分权重 |
| POST | `/api/reset` | 重置分析结果（保留账号配置） |

---

## 15. 环境变量

见 `.env.example`：`DATA_SOURCE`（simulated/x_api）、`X_BEARER_TOKEN`、`LLM_MODE`（mock/openai）、`LLM_API_KEY`、`LLM_MODEL`、`PORT`。
`.env` 与 `data/state.json` 已在 `.gitignore` 中，**密钥不会进仓库**。
