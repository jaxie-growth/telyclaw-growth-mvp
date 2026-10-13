/**
 * src/dataset.js
 * ------------------------------------------------------------
 * 仿真数据集（Data Source: simulated）
 *
 * 目的：在没有 X API 付费额度的情况下，让整条流水线
 *      Monitor -> Detect -> Rank -> Ideate -> Craft -> Review -> Publish
 *      可以端到端跑通、且结果有真实的"趋势形状"（有加速的话题、有衰减的话题、
 *      有新闻爆发窗口），足以演示和评估排序逻辑。
 *
 * 数据不是"随机噪声"，而是由 11 个"话题种子(Topic Seed)"驱动生成的：
 *   - phase[7]  : 话题在最近 7 天（旧->新）的活跃度曲线，决定增速/衰减
 *   - burst     : 新闻爆发窗口（例如 CPI 公布后 6-10 小时集中刷屏）
 *   - frags     : 该话题的固定表达碎片，保证同一话题的帖子在词面上可被聚类
 *   - zh        : 中文共识/分歧描述，用于自动生成话题摘要
 *
 * 生成过程完全确定性（seed 固定），同一分钟内多次抓取结果一致，方便复现 demo。
 * ------------------------------------------------------------
 */

/** mulberry32：轻量确定性随机数 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length) % arr.length];
}

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

/**
 * 监控账号池（财经垂类）
 * affinity: 该账号偏好讨论的话题 id 及权重
 * scale:    账号体量系数，影响互动量级
 */
export const ACCOUNTS = [
  { handle: '@DeItaone', name: 'Walter Bloomberg', category: '财经快讯', scale: 3.4, affinity: { fed: 1.0, cpi: 1.0, oil: 0.7, china: 0.6 } },
  { handle: '@zerohedge', name: 'ZeroHedge', category: '宏观/怀疑派', scale: 3.0, affinity: { fed: 0.9, gold: 0.9, bitcoin: 0.9, yen: 0.8, stablecoin: 0.6 } },
  { handle: '@unusual_whales', name: 'Unusual Whales', category: '期权异动', scale: 2.6, affinity: { nvidia: 0.9, fed: 0.7, oil: 0.6, gold: 0.5 } },
  { handle: '@business', name: 'Bloomberg', category: '财经媒体', scale: 3.2, affinity: { fed: 0.8, china: 0.8, oil: 0.7, stablecoin: 0.7, aicapex: 0.7 } },
  { handle: '@WSJmarkets', name: 'WSJ Markets', category: '财经媒体', scale: 2.8, affinity: { fed: 0.8, cpi: 0.8, nvidia: 0.7, gold: 0.6 } },
  { handle: '@NickTimiraos', name: 'Nick Timiraos', category: 'Fed 条线记者', scale: 2.5, affinity: { fed: 1.0, cpi: 0.9 } },
  { handle: '@Sino_Market', name: 'Sinocism Market', category: '中国/港股', scale: 2.0, affinity: { china: 1.0, gold: 0.5, oil: 0.4 } },
  { handle: '@TheStalwart', name: 'Joe Weisenthal', category: '市场评论', scale: 2.4, affinity: { fed: 0.8, aicapex: 0.9, nvidia: 0.7, aiagents: 0.5, stablecoin: 0.6 } },
  { handle: '@FirstSquawk', name: 'First Squawk', category: '实时快讯', scale: 2.2, affinity: { cpi: 1.0, oil: 0.8, china: 0.7, fed: 0.7, aiagents: 0.3 } },
  { handle: '@macrocompass', name: 'Darius Dale', category: '宏观研究', scale: 2.1, affinity: { fed: 0.9, gold: 0.8, yen: 0.8, cpi: 0.7, aiagents: 0.3 } },
  { handle: '@LizAnnSonders', name: 'Liz Ann Sonders', category: '策略研究', scale: 2.3, affinity: { fed: 0.7, cpi: 0.8, aicapex: 0.8, aiagents: 0.4 } },
  { handle: '@financialtimes', name: 'Financial Times', category: '财经媒体', scale: 3.1, affinity: { china: 0.7, stablecoin: 0.8, oil: 0.6, aicapex: 0.6, aiagents: 0.4 } },
  // 以下两个是垂类 KOL 占位账号（demo 用，用于覆盖"AI×财经内容生产"这条主线）
  { handle: '@QuantEdgeLab', name: 'Quant Edge Lab', category: '量化研究 KOL', scale: 1.6, affinity: { aiagents: 1.0, nvidia: 0.7, gold: 0.4 } },
  { handle: '@AIContentOps', name: 'AI Content Ops', category: '内容增长 KOL', scale: 1.5, affinity: { aiagents: 1.0, aicapex: 0.8, stablecoin: 0.3 } },
];

/**
 * 话题种子
 * phase: 最近 7 天活跃度（旧 -> 新），>1 代表升温
 * burst: 新闻爆发窗口 { fromH, toH, mult }，fromH/toH 为"距今小时数"区间
 */
export const TOPIC_SEEDS = [
  {
    id: 'fed',
    autoLabel: 'Fed / rate-cut repricing',
    zh: '美联储降息路径与点阵图',
    keywords: ['fed', 'fomc', 'powell', 'rate', 'cut', 'cuts', 'dot', 'plot', 'hawkish', 'dovish', 'duration'],
    cashtags: ['$TLT', '$SPY', '$ZN'],
    entities: ['Fed', 'FOMC', 'Powell'],
    tone: 'macro',
    phase: [0.35, 0.5, 0.6, 0.8, 1.0, 1.25, 1.5],
    burst: { fromH: 14, toH: 20, mult: 2.6 },
    debate: '降息节奏是 2 次还是 3 次、以及"通胀最后一公里"会不会让 Fed 再度转鹰',
    consensus: '劳动力数据转弱、进一步降息是大方向',
    frags: {
      subj: ['Fed', 'The FOMC', 'Powell', 'Rate traders', 'The front end'],
      verb: ['is repricing', 'keeps pushing back', 'looks split', 'is out of sync with the curve', 'is getting tested'],
      driver: ['the cooling labor data', 'a soft CPI print', 'hawkish rhetoric from the board', 'the sell-side 2026 outlook'],
      note: ['Two more cuts are priced by March.', 'Desk chatter points to a dovish tilt.', 'Nobody wants to be short duration into the print.', 'The bar for a hike is now very high.'],
      move: ['bid', 'ripping', 'offered', 'grinding higher'],
      amt: ['the 2s10s steepens', 'front end leads the move', 'term premium is back', 'the belly is cheap'],
      num: ['25bp', '2 more cuts', '+18bp on the 2y', '$3bn duration'],
    },
  },
  {
    id: 'cpi',
    autoLabel: 'US CPI print / inflation surprise',
    zh: '美国 CPI 通胀数据',
    keywords: ['cpi', 'inflation', 'core', 'print', 'surprise', 'mom', 'yoy', 'deflation'],
    cashtags: ['$TIP', '$SPY'],
    entities: ['BLS', 'CPI', 'core CPI'],
    tone: 'event',
    phase: [0.9, 0.8, 0.7, 1.2, 1.6, 1.4, 0.9],
    burst: { fromH: 6, toH: 11, mult: 4.2 },
    debate: '住房分项粘性是否被低估、以及"超级核心"服务通胀是否真的在降温',
    consensus: '整体通胀回落但服务项仍偏粘',
    frags: {
      subj: ['Core CPI', 'The inflation print', 'Shelter costs', 'Supercore'],
      verb: ['came in hot', 'surprised to the downside', 'is finally rolling over', 'refuses to cooperate'],
      driver: ['the shelter lag', 'sticky services inflation', 'the base effect', 'used-car deflation'],
      note: ['Bond market took it in stride.', 'Equities shrugged it off.', 'This is the last thing the Fed wanted.', 'Futures now price a coin flip.'],
      move: ['kneejerk lower', 'sold off', 'rallied', 'chopped'],
      amt: ['the 10y is 4bp higher', 'breakevens widened', 'the dollar index jumped', 'real yields rose'],
      num: ['+0.3% m/m', '2.8% y/y', '0.1 ppt above consensus', '+11bp'],
    },
  },
  {
    id: 'nvidia',
    autoLabel: 'Nvidia earnings / AI datacenter demand',
    zh: '英伟达财报与 AI 数据中心需求',
    keywords: ['nvidia', 'nvda', 'earnings', 'guidance', 'datacenter', 'blackwell', 'margin', 'backlog'],
    cashtags: ['$NVDA', '$SMH', '$AMD'],
    entities: ['Nvidia', 'Blackwell', 'hyperscalers'],
    tone: 'equity',
    phase: [0.5, 0.6, 0.8, 1.1, 1.3, 1.2, 1.1],
    burst: { fromH: 20, toH: 27, mult: 3.0 },
    debate: 'ASIC 自研芯片会不会分流 GPU 需求、以及毛利率能否守住',
    consensus: '数据中心订单能见度仍在，资本开支未减速',
    frags: {
      subj: ['Nvidia', 'The datacenter segment', 'Management', 'Sell-side'],
      verb: ['beat and raised', 'guided above the street', 'is the whole ballgame', 'flagged supply constraints'],
      driver: ['Blackwell ramp', 'hyperscaler capex guidance', 'ASIC competition', 'gross-margin mix'],
      note: ['Whisper number was way higher.', 'The stock is priced for perfection.', 'Backlog is the number to watch.', 'Options market pricing an 8% move.'],
      move: ['gapped up', 'faded the open', 'ripped into the close', 'is range-bound'],
      amt: ['implied move 7.8%', 'revisions went higher', 'multiple compressed', 'short interest is low'],
      num: ['$40bn guide', '75% gross margin', '+9% after hours', '3.2x forward sales'],
    },
  },
  {
    id: 'gold',
    autoLabel: 'Gold record high / central-bank buying',
    zh: '黄金创新高与央行购金',
    keywords: ['gold', 'bullion', 'record', 'central', 'bank', 'buying', 'gld', 'haven'],
    cashtags: ['$GLD', '$GC', '$GDX'],
    entities: ['gold', 'central banks', 'LBMA'],
    tone: 'commodity',
    phase: [0.7, 0.9, 1.0, 1.1, 1.3, 1.4, 1.35],
    burst: { fromH: 30, toH: 38, mult: 2.4 },
    debate: '这波是"央行购金的结构性行情"还是"降息预期的短期抢跑"',
    consensus: '央行持续增持、去美元化叙事仍在',
    frags: {
      subj: ['Gold', '$GLD', 'Bullion', 'Central banks'],
      verb: ['printed another record', 'is melting up', 'keeps absorbing every dip', 'is the cleanest momentum trade'],
      driver: ['official-sector buying', 'de-dollarization flows', 'real-yield compression', 'haven demand'],
      note: ['Nothing about this looks toppy.', 'ETF inflows finally turned positive.', 'Retail is still under-positioned.', 'Watch $4k psychological level.'],
      move: ['at record', 'bid all day', 'breaking out', 'grinding higher'],
      amt: ['open interest rising', 'ETF holdings up 3 weeks', 'silver lagging', 'miners outperforming'],
      num: ['+1.4%', 'record close', '$2,900/oz', '22 tonnes bought'],
    },
  },
  {
    id: 'china',
    autoLabel: 'China stimulus / A-shares & HK rally',
    zh: '中国刺激政策与 A 股/港股行情',
    keywords: ['china', 'stimulus', 'pboc', 'a-shares', 'shanghai', 'hang', 'seng', 'property', 'policy'],
    cashtags: ['$FXI', '$KWEB', '$MCHI'],
    entities: ['PBoC', 'NDRC', 'Hang Seng'],
    tone: 'policy',
    phase: [0.4, 0.5, 0.7, 0.9, 1.2, 1.5, 1.7],
    burst: { fromH: 9, toH: 16, mult: 3.2 },
    debate: '政策是"托底"还是"再通胀目标"，以及盈利端何时跟上估值修复',
    consensus: '政策转向明确、港股弹性大于 A 股',
    frags: {
      subj: ['Beijing', 'The PBoC', 'A-shares', 'Hang Seng'],
      verb: ['delivered a bigger-than-expected package', 'is stabilizing the property chain', 'is ripping higher', 'got another policy tailwind'],
      driver: ['fiscal impulse', 'property support', 'southbound flows', 'consumer confidence'],
      note: ['Foreign flows are still light.', 'This is a liquidity trade for now.', 'Earnings revisions have not turned yet.', 'Watch the CNY fix for a signal.'],
      move: ['+2.1%', 'jumped', 'outperformed', 'is back above the 200d'],
      amt: ['turnover hit 1.2tn', 'northbound inflow $3bn', 'breadth improved', 'HK tech led'],
      num: ['+2.1%', 'RMB 1.2tn turnover', '3.6% weekly gain', '$3bn inflow'],
    },
  },
  {
    id: 'stablecoin',
    autoLabel: 'Stablecoin rules / payment rails',
    zh: '稳定币监管与支付清算',
    keywords: ['stablecoin', 'regulation', 'circle', 'crcl', 'treasury', 'payment', 'rails', 'genius'],
    cashtags: ['$CRCL', '$COIN'],
    entities: ['Treasury', 'Circle', 'issuers'],
    tone: 'policy',
    phase: [0.5, 0.7, 0.8, 1.0, 1.2, 1.35, 1.45],
    burst: { fromH: 26, toH: 32, mult: 2.2 },
    debate: '稳定币是国债需求的新增买盘，还是银行体系外的影子负债',
    consensus: '合规框架落地会带来机构增量资金',
    frags: {
      subj: ['Stablecoin issuers', 'The Treasury', 'Circle', 'Regulators'],
      verb: ['now hold more T-bills than most sovereigns', 'cleared a key rule', 'is the new payment rail', 'pushed back on reserve rules'],
      driver: ['reserve requirements', 'bank-deposit displacement', 'cross-border settlement demand', 'yield-sharing'],
      note: ['This is monetary policy by other means.', 'Banks will fight this.', 'Fees collapse if this scales.', 'Watch the reserve mix disclosures.'],
      move: ['is repricing', 'traded higher', 'sold off', 'was volatile'],
      amt: ['supply up 8% m/m', 'yields compressed', 'spreads tightened', 'volumes record'],
      num: ['$180bn supply', '+8% m/m', 'T-bill holdings 4x', '$1.1bn fees'],
    },
  },
  {
    id: 'bitcoin',
    autoLabel: 'Bitcoin ETF flows / crypto drawdown',
    zh: '比特币 ETF 资金流出与回调',
    keywords: ['bitcoin', 'btc', 'etf', 'outflow', 'grayscale', 'spot', 'leverage', 'liquidation'],
    cashtags: ['$BTC', '$IBIT', '$MSTR'],
    entities: ['spot ETFs', 'Grayscale', 'BTC'],
    tone: 'crypto',
    phase: [1.4, 1.3, 1.1, 0.9, 0.7, 0.6, 0.55],
    burst: { fromH: 40, toH: 46, mult: 2.0 },
    debate: 'ETF 流出是"仓位再平衡"还是"叙事破裂"，杠杆是否已清算干净',
    consensus: '短期资金面走弱、但链上供给仍紧',
    frags: {
      subj: ['Spot BTC ETFs', 'Leverage', 'Grayscale', 'Bitcoin'],
      verb: ['bled for a fifth session', 'saw a $400m outflow', 'is deleveraging', 'is still range-bound'],
      driver: ['basis trade unwinds', 'funding rates', 'ETF creations stalling', 'macro liquidity'],
      note: ['Funding is now neutral.', 'Open interest reset is healthy.', 'Retail is quiet.', 'Watch the 200d for support.'],
      move: ['slipped', 'sold off', 'bounced', 'drifted lower'],
      amt: ['funding flat', 'OI down 12%', 'basis compressed', 'spot volume thin'],
      num: ['-$400m', 'OI -12%', '$92k support', '3 days red'],
    },
  },
  {
    id: 'aiagents',
    autoLabel: 'AI agents taking over analyst & content workflows',
    zh: 'AI Agent 接管研究与内容生产工作流',
    keywords: ['agent', 'agents', 'ai', 'llm', 'automation', 'workflow', 'research', 'analysis', 'copilot', 'content'],
    cashtags: ['$MSFT', '$CRM'],
    entities: ['AI agents', 'LLMs', 'research desks'],
    tone: 'tech',
    phase: [0.3, 0.4, 0.6, 0.9, 1.3, 1.7, 2.0],
    burst: { fromH: 2, toH: 9, mult: 3.4 },
    debate: 'Agent 会取代初级研究与内容岗，还是把人的产出放大 10 倍',
    consensus: '重复性数据搬运与初稿生产正在被快速自动化',
    frags: {
      subj: ['AI agents', 'LLM copilots', 'Research desks', 'Small teams'],
      verb: ['are eating the first 60% of the workflow', 'now draft the morning note', 'replaced three vendor subscriptions', 'are shipping faster than any hire could'],
      driver: ['tool-calling reliability', 'cheaper inference', 'MCP-style integrations', 'evals that actually work'],
      note: ['The bottleneck moved to judgement, not production.', 'One person + agents is the new desk.', 'Distribution, not drafting, is the moat.', 'This is a growth story, not a cost story.'],
      move: ['is compounding', 'is the new baseline', 'is getting cheap fast', 'is being repriced'],
      amt: ['cost per draft collapsed', 'cycle time down 80%', 'output per head 4x', 'headcount flat'],
      num: ['10x output', '-80% cycle time', '$0.02 per draft', '60% automated'],
    },
  },
  {
    id: 'yen',
    autoLabel: 'Yen weakness / BOJ & carry trade unwind',
    zh: '日元与套息交易平仓',
    keywords: ['yen', 'boj', 'carry', 'trade', 'japan', 'usdjpy', 'intervention', 'jgb'],
    cashtags: ['$JPY', '$FXY', '$EWJ'],
    entities: ['BOJ', 'MoF', 'USDJPY'],
    tone: 'macro',
    phase: [1.3, 1.2, 1.0, 0.9, 0.8, 0.7, 0.6],
    burst: { fromH: 52, toH: 58, mult: 1.8 },
    debate: 'BOJ 是否会被迫提前加息、干预阈值在哪里',
    consensus: '利差仍主导汇率、但拥挤度已经很高',
    frags: {
      subj: ['USDJPY', 'The BOJ', 'Carry traders', 'The MoF'],
      verb: ['is testing the intervention zone', 'stayed on hold', 'is unwinding', 'warned on "excessive moves"'],
      driver: ['rate differentials', 'hedging costs', 'JGB yield control', 'retail flow reversal'],
      note: ['Verbally intervened at least.', 'This trade is crowded.', 'Watch the weekly options expiries.', 'Cross-asset spillover is real.'],
      move: ['is stretched', 'drifted', 'reversed', 'stabilised'],
      amt: ['vol picked up', 'risk reversals skewed', 'hedging cost up', 'spec positioning extreme'],
      num: ['158 handle', 'vol +2 pts', 'intervention zone', '-1.2%'],
    },
  },
  {
    id: 'oil',
    autoLabel: 'Oil supply / OPEC+ and Brent range',
    zh: '原油供给与 OPEC+ 政策',
    keywords: ['oil', 'opec', 'brent', 'crude', 'supply', 'inventory', 'refining', 'shipping'],
    cashtags: ['$USO', '$XLE', '$BNO'],
    entities: ['OPEC+', 'Brent', 'EIA'],
    tone: 'commodity',
    phase: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    burst: { fromH: 44, toH: 49, mult: 1.6 },
    debate: '供给过剩还是地缘溢价、以及需求端是否被高估',
    consensus: '区间震荡、OPEC+ 有托底意愿',
    frags: {
      subj: ['Brent', 'OPEC+', 'Crude inventories', 'The curve'],
      verb: ['is stuck in a $8 range', 'deferred the output hike', 'drew more than expected', 'flattened'],
      driver: ['spare capacity', 'China demand', 'shipping risk', 'refining margins'],
      note: ['Backwardation is fading.', 'Producers need $70+ to balance budgets.', 'Product cracks are the tell.', 'Nobody is chasing this tape.'],
      move: ['is range-bound', 'ticked up', 'slid', 'held'],
      amt: ['curve flattening', 'cracks compressed', 'positioning light', 'vol low'],
      num: ['$74/bbl', '-3.2m bbl draw', '$8 range', '2.1m b/d spare'],
    },
  },
  {
    id: 'aicapex',
    autoLabel: 'AI capex / hyperscaler datacenter spend',
    zh: 'AI 资本开支与超大规模数据中心投入',
    keywords: ['capex', 'datacenter', 'hyperscaler', 'spend', 'gpu', 'power', 'cloud', 'depreciation'],
    cashtags: ['$MSFT', '$GOOGL', '$AMZN', '$VRT'],
    entities: ['hyperscalers', 'capex', 'datacenters'],
    tone: 'equity',
    phase: [0.6, 0.7, 0.9, 1.0, 1.2, 1.35, 1.5],
    burst: { fromH: 11, toH: 17, mult: 2.4 },
    debate: '资本开支是在建护城河还是在制造折旧悬崖',
    consensus: '算力投入继续上修、电力成为新瓶颈',
    frags: {
      subj: ['Hyperscaler capex', 'Datacenter buildouts', 'Power demand', 'Cloud margins'],
      verb: ['is being revised higher again', 'is the new oil', 'is constrained by grids', 'is the only line item that matters'],
      driver: ['power availability', 'depreciation schedules', 'revenue attach rates', 'custom silicon'],
      note: ['Depreciation is the quiet risk.', 'Utilities are the derivative play.', 'Free cash flow math is getting ugly.', 'Every quarter the number goes up.'],
      move: ['is accelerating', 'is being repriced', 'is the consensus trade', 'is melting up'],
      amt: ['capex guide +12%', 'backlog multi-year', 'power deals signed', 'ROIC unclear'],
      num: ['$70bn annualised', '+12% guide', '4GW pipeline', '3-year backlog'],
    },
  },
];

/**
 * 每个话题的"锚点短语"：无论生成哪条帖子，都会带上这两个锚点。
 * 现实中这就是同一话题里反复出现的实体名（Fed / CPI / Nvidia / 稳定币……），
 * 也是聚类算法能识别出"这堆帖子在说同一件事"的语言学基础。
 * 同一锚点的不同写法共享同一个核心词（Fed / the Fed / FOMC），保证 token 层面可重叠。
 */
const ANCHORS = {
  fed: { a1: ['Fed', 'The Fed', 'Fed officials', 'the Fed path'], a2: ['rate cut', 'the rate cut path', 'rate cut odds', 'another rate cut'] },
  cpi: { a1: ['CPI', 'The CPI print', 'Inflation', 'Core inflation'], a2: ['inflation print', 'the inflation print', 'inflation prints', 'the core inflation print'] },
  nvidia: { a1: ['Nvidia', 'NVDA', 'Nvidia earnings', 'The Nvidia print'], a2: ['datacenter demand', 'the datacenter guide', 'Nvidia datacenter', 'the datacenter number'] },
  gold: { a1: ['Gold', 'Gold prices', 'Bullion'], a2: ['central bank buying', 'central banks', 'central bank demand', 'central bank purchases'] },
  china: { a1: ['China', 'Beijing', 'Chinese equities'], a2: ['stimulus', 'the stimulus package', 'stimulus measures', 'policy stimulus'] },
  stablecoin: { a1: ['Stablecoins', 'Stablecoin issuers', 'Stablecoin regulation'], a2: ['regulation', 'the regulation', 'stablecoin regulation', 'these rules'] },
  bitcoin: { a1: ['Bitcoin', 'BTC', 'Spot bitcoin'], a2: ['ETF flows', 'ETF outflows', 'the ETF flow data', 'ETF flow'] },
  aiagents: { a1: ['AI agents', 'AI agent workflows', 'Agentic AI'], a2: ['content workflow', 'the content workflow', 'the research workflow', 'content workflows'] },
  yen: { a1: ['The yen', 'USDJPY', 'The BOJ'], a2: ['carry trade', 'the carry trade', 'carry trade unwind', 'carry positioning'] },
  oil: { a1: ['Oil', 'Brent', 'Crude'], a2: ['OPEC', 'OPEC supply', 'OPEC output', 'supply'] },
  aicapex: { a1: ['AI capex', 'Hyperscaler capex', 'Datacenter capex'], a2: ['datacenter spend', 'the datacenter buildout', 'datacenter capex', 'the datacenter budget'] },
};

export { ANCHORS };

/**
 * 内容生成用的话题"人话表达"：phrase 是主话题短语，nouns 是可切入的角度名词。
 * 放在数据集里而不是硬编码在生成器里，方便后续按行业替换。
 */
export const PHRASES = {
  fed: { phrase: "the Fed's rate-cut repricing", nouns: ['rate-cut odds', 'duration positioning', 'the dot plot'] },
  cpi: { phrase: 'the CPI print', nouns: ['shelter costs', 'services inflation', 'the base effect'] },
  nvidia: { phrase: "Nvidia's datacenter guide", nouns: ['datacenter demand', 'gross-margin mix', 'the backlog'] },
  gold: { phrase: "gold's record run", nouns: ['central-bank buying', 'real-yield compression', 'ETF inflows'] },
  china: { phrase: "China's stimulus package", nouns: ['the property chain', 'southbound flows', 'consumer confidence'] },
  stablecoin: { phrase: 'stablecoin regulation', nouns: ['reserve rules', 'bank-deposit displacement', 'the T-bill bid'] },
  bitcoin: { phrase: 'the spot-ETF flow reversal', nouns: ['basis unwinds', 'funding rates', 'open interest'] },
  aiagents: { phrase: 'AI agents eating the content workflow', nouns: ['tool-calling reliability', 'cheaper inference', 'human review'] },
  yen: { phrase: 'the yen carry trade', nouns: ['rate differentials', 'hedging costs', 'intervention risk'] },
  oil: { phrase: 'the oil supply story', nouns: ['spare capacity', 'refining margins', 'the curve'] },
  aicapex: { phrase: 'the AI capex cycle', nouns: ['power availability', 'depreciation schedules', 'revenue attach rates'] },
};

/**
 * 通用句式模板：{anchor1}/{anchor2} 保证同话题帖子的词面共性（聚类可用），
 * 其余槽位提供表达多样性，避免所有帖子长一个样。
 */
const TEMPLATES = [
  '{anchor1} {verb} on {driver}. {anchor2} {note}',
  'BREAKING: {anchor1} {verb} — {driver} in focus. {note}',
  '{anchor1} {verb}. {note} {hashtag}',
  '{cashtag} {move}, {amt}. {anchor1} {verb}. {note}',
  'Positioning check: {anchor1} {verb} as {driver}. {anchor2} {note}',
  'Not sure why people are surprised: {anchor1} {verb}. {note}',
  'Thread: {anchor1} {verb} — the read on {driver}. {note}',
  'Quiet tape, loud story: {anchor1} {verb}. {anchor2} {note}',
  'If {driver} holds, {anchor1} {verb}. {note}',
  '{anchor1} {verb} — {amt}. {anchor2} {note}',
  'New note: {anchor1} {verb} on {driver}. {note} {cashtag}',
  '{anchor1} {verb}. {num}. {anchor2} {note}',
  '{subj} {verb} — {anchor1} {move}. {note}',
  '{anchor1} {verb} and {subj} follows. {note} {cashtag}',
];

function dayIndexFromHoursAgo(hoursAgo) {
  // 0 = 最近 24h, 6 = 最旧一天
  return Math.min(6, Math.floor(hoursAgo / 24));
}

function topicWeightAtHoursAgo(seed, hoursAgo) {
  const base = seed.phase[6 - dayIndexFromHoursAgo(hoursAgo)];
  let mult = 1;
  if (seed.burst) {
    const { fromH, toH, mult: bm } = seed.burst;
    if (hoursAgo >= fromH && hoursAgo <= toH) mult = bm;
  }
  return base * mult;
}

/**
 * 生成仿真帖子流
 * @param {number} now 当前时间戳（ms）
 * @param {number} days 生成最近多少天
 */
export function generatePosts(now = Date.now(), days = 7) {
  const posts = [];
  let seq = 0;

  ACCOUNTS.forEach((acc, ai) => {
    const rnd = mulberry32(1000 + ai * 7919);
    for (let d = days - 1; d >= 0; d--) {
      const postsToday = 4 + Math.floor(rnd() * 6); // 4-9 条/天
      for (let k = 0; k < postsToday; k++) {
        // 在当天内随机取一个时刻（偏交易时段）
        const hourOffset = Math.floor(rnd() * 24);
        const hoursAgo = d * 24 + (23 - hourOffset) + rnd();
        if (hoursAgo > days * 24) continue;

        // 依 affinity * 话题当下热度 加权抽样
        const entries = Object.entries(acc.affinity);
        let total = 0;
        const weights = entries.map(([tid, aff]) => {
          const seed = TOPIC_SEEDS.find((t) => t.id === tid);
          const w = aff * (seed ? topicWeightAtHoursAgo(seed, hoursAgo) : 1);
          total += w;
          return { tid, w };
        });
        let r = rnd() * total;
        let chosen = weights[weights.length - 1].tid;
        for (const { tid, w } of weights) {
          r -= w;
          if (r <= 0) {
            chosen = tid;
            break;
          }
        }
        const seed = TOPIC_SEEDS.find((t) => t.id === chosen);
        if (!seed) continue;

        const frags = seed.frags;
        const anchors = ANCHORS[seed.id] || { a1: [seed.autoLabel], a2: [seed.zh] };
        // 主标的出现概率更高（现实中同一话题被反复引用的也是同一个 ticker）
        const cashtag = rnd() < 0.78 ? seed.cashtags[0] : pick(rnd, seed.cashtags);
        const text = pick(rnd, TEMPLATES)
          .replace('{anchor1}', pick(rnd, anchors.a1))
          .replace('{anchor2}', pick(rnd, anchors.a2))
          .replace('{subj}', pick(rnd, frags.subj))
          .replace('{verb}', pick(rnd, frags.verb))
          .replace('{driver}', pick(rnd, frags.driver))
          .replace('{note}', pick(rnd, frags.note))
          .replace('{move}', pick(rnd, frags.move))
          .replace('{amt}', pick(rnd, frags.amt))
          .replace('{num}', pick(rnd, frags.num))
          .replace('{cashtag}', cashtag)
          .replace('{hashtag}', '#' + seed.id.replace(/[^a-z]/g, ''))
          .replace(/\s+/g, ' ')
          .trim();

        const heat = topicWeightAtHoursAgo(seed, hoursAgo);
        const base = 40 * acc.scale * heat * (0.5 + rnd());
        const likes = Math.round(base * (2.5 + rnd() * 3));
        const replies = Math.round(base * (0.25 + rnd() * 0.6));
        const reposts = Math.round(base * (0.4 + rnd() * 1.2));
        const quotes = Math.round(base * (0.1 + rnd() * 0.4));

        posts.push({
          id: `sim-${String(++seq).padStart(5, '0')}`,
          account: acc.handle,
          accountName: acc.name,
          category: acc.category,
          text,
          topicSeed: seed.id,
          createdAt: Math.round(now - hoursAgo * HOUR),
          likes,
          replies,
          reposts,
          quotes,
          engagement: likes + 2 * reposts + 3 * replies + 2 * quotes,
          url: `https://x.com/${acc.handle.replace('@', '')}/status/1${String(seq).padStart(9, '0')}`,
        });
      }
    }
  });

  posts.sort((a, b) => b.createdAt - a.createdAt);
  return posts;
}

/** 抓取某时间窗口内的帖子（仿真模式） */
export function fetchSimulatedPosts(windowHours, now = Date.now()) {
  const all = generatePosts(now, 7);
  const from = now - windowHours * HOUR;
  return all.filter((p) => p.createdAt >= from && p.createdAt <= now);
}

export const WINDOWS = {
  '1H': 1,
  '4H': 4,
  '24H': 24,
  '7D': 24 * 7,
};

export function windowLabel(hours) {
  return Object.entries(WINDOWS).find(([, v]) => v === hours)?.[0] || `${hours}H`;
}
