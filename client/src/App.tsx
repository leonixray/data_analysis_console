import { createContext, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { FreshLine, ScrollHint, SectionHead, fmt, signed, stageTimeText } from "./shared";
import { CloudView } from "./cloud/CloudView";
import { cloudBreadth } from "./cloud/utils";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Instrument = Dashboard["instruments"][number];
type WatchPe = ApiResponse<typeof api, "getWatchlistPe">["items"][number];
type WatchPeStatus = "loading" | "error" | "ready";
type Fib = Dashboard["fibs"][number];
type Indicator = Dashboard["derived"][number];
type Stats = NonNullable<Indicator["stats"]>;

type View = "overview" | "cloud" | "chronicle" | "bonds" | "us" | "ussec" | "usdiv" | "cn" | "cnsec" | "hk" | "gold" | "macro" | "wallst" | "portfolio" | "calendar" | "history" | "signals" | "bottomtop" | "methods";
type BondTab = "rate" | "credit" | "money";

// ---------------------------------------------------------------------------
// 统计窗口：图表与历史百分位共用同一个窗口（用户要求两者必须对得上）。
// 切换窗口时服务端按同一 windowDays 切图表数据和百分位样本，永远一致。
// 决策信号与历史回撤固定用全历史口径，不受此开关影响（卡片上会注明）。
// ---------------------------------------------------------------------------

const WINDOWS: { days: number; label: string }[] = [
  { days: 250, label: "近1年" },
  { days: 500, label: "近2年" },
  { days: 1250, label: "近5年" },
  { days: 100000, label: "全部历史" },
];

const WindowCtx = createContext<{ days: number; label: string }>({ days: 500, label: "近2年" });

// 没有统计窗口概念的页面：云图有自己的「时段」控件、编年史是静态
// 数据集、大事日历是事件表、方法库是固定讲解——这四页不显示统计
// 窗口切换器（在这些页上切换窗口对页面内容毫无作用，只会白白重拉
// 一遍 getDashboard）。其余页面（总览与各图表模块页）的图表与百分位
// 都由同一个 windowDays 驱动，切换器只在那些页出现。
const WINDOWLESS_VIEWS: View[] = ["cloud", "chronicle", "calendar", "methods"];

function useWindowLabel(): string {
  return useContext(WindowCtx).label;
}

// ---------------------------------------------------------------------------
// Entry performance (2026-11-20): stale-while-revalidate seed.
//
// The dashboard is a stored snapshot — it only changes when the user
// runs a refresh — so re-entering the console should render the last
// snapshot immediately instead of waiting on a full server round
// trip. The last fetched dashboard is kept in localStorage (this
// browser only) and seeds the query as initialData with its original
// fetch time: React Query renders it instantly and, because the seed
// is older than staleTime, refetches in the background and swaps the
// fresh payload in when it lands. Storage failures (sandboxed
// webview, quota) fall back silently to a plain network read.
// ---------------------------------------------------------------------------

const DASH_SEED_KEY = "dash-seed-v1";
type DashSeed = { windowDays: number; at: number; data: Dashboard };

function readDashSeed(): DashSeed | null {
  try {
    const raw = window.localStorage.getItem(DASH_SEED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; windowDays?: number; at?: number; data?: Dashboard };
    const d = parsed.data;
    if (parsed.v !== 1 || typeof parsed.windowDays !== "number" || typeof parsed.at !== "number" || !d) return null;
    if (typeof d.hasData !== "boolean" || !Array.isArray(d.instruments) || !Array.isArray(d.hero) || !Array.isArray(d.stages)) return null;
    return { windowDays: parsed.windowDays, at: parsed.at, data: d };
  } catch {
    return null;
  }
}

function writeDashSeed(seed: DashSeed): void {
  try {
    window.localStorage.setItem(DASH_SEED_KEY, JSON.stringify({ v: 1, ...seed }));
  } catch {
    // Storage unavailable or over quota: entry just uses the network.
  }
}

// Defers a card's chart fetch until the card is near the viewport:
// module pages hold a dozen-plus cards, and firing every chart
// request at once (for charts far below the fold) made module opens
// feel like a second page load. Numbers render immediately from the
// dashboard payload either way; only the chart waits.
function useNearViewport<T extends HTMLElement>(marginPx = 500) {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") {
      setNear(true);
      return;
    }
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          ob.disconnect();
        }
      },
      { rootMargin: `${marginPx}px 0px` },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [near, marginPx]);
  return { ref, near };
}

// ---------------------------------------------------------------------------
// 方法库：写给小白的白话解释（固定文案，刷新不消耗 token）
// ---------------------------------------------------------------------------

type Method = { id: string; group: string; name: string; plain: string; read: string };

const METHODS: Method[] = [
  {
    id: "percentile",
    group: "通用尺子",
    name: "历史百分位（先看位置，贵贱另看估值）",
    plain: "把统计窗口里的每一天都排成一队，看今天站在什么位置：百分位 90 = 比窗口里 90% 的日子都高，百分位 10 = 只比 10% 的日子高。先记住：百分位本身只回答“位置”，不直接回答“贵还是便宜”——标签上的「偏高 / 偏低 / 极端偏低」也只是位置词。分指标看：①价格类（股价、指数）：价格百分位只说当前价格在历史中的位置——位置高 = 离历史高点近、这段趋势涨得多，位置低 = 回撤深、离高点远，这是趋势与回撤的含义，不直接说贵贱（价格长期向上，拿价格位置当贵贱尺会系统性误判）；贵还是便宜看历史 PE 百分位，也就是当前市盈率在自身历史中的位置：个股有 5 年 PE 百分位管线可查；指数/ETF 里沪深 300 与 10 只 A 股板块 ETF 已有中证指数官网的 PE 管线（月末 TTM PE、近 5 年窗口），标普 500 已有 Multpl 月度 TTM PE 管线（1871 年至今、近 5 年窗口，点为月初点加最新值），恒生指数有 Siblis 年度点 + 当前值（无百分位），SPDR 板块与美股红利 ETF 自 2026-11-20 起每周积累 Yahoo 当期 TTM PE（满 8 点后出百分位），卡片上与价格百分位并列、口径分开标；其余指数/ETF（恒生国企/恒生科技等）暂无可用的权威免费历史 PE 来源，卡片如实标注「暂无历史 PE 数据」、不显示估值判断、不编造；纳指 100 仅有 Siblis 年度点与当前值、无 5 年百分位。②收益率与利差类（国债收益率、期限利差、信用利差）：方向正好反过来——收益率和债券价格是一枚硬币的两面，收益率跌到历史最低，恰恰是债券涨到历史最贵的时候，所以百分位低 = 对应债券贵，百分位高 = 对应债券便宜。举例：中国 10 年国债收益率约 1.59%、百分位接近 0 时，正确的读法是“利率在历史最低位、债券在历史最贵位”，绝不是“便宜”。这类反向指标的卡片已经单独处理：标签与百分位条的颜色反过来（低位显示红色、高位显示绿色），卡片下方带一行「反向口径」说明，收益率表里还会直接标注“对应债券偏贵 / 偏便宜”。③还有一类例外：资金面与政策利率（回购利率、SHIBOR、政策利率）读的是借钱的成本本身，低 = 钱便宜、资金松，按价格方向读即可，卡片的状态词（资金偏松 / 偏紧）就是这个口径。这是整个管控台最重要的一把尺：不看绝对数字，看相对位置——位置归位置，贵贱另按各自的尺子谈。窗口可以在图表页顶部切换（近1年/近2年/近5年/全部历史；云图、编年史、大事日历与方法库本身没有统计窗口，那几页不显示这个切换器），图表和百分位永远用同一个窗口——图上看得到的那段日子，就是百分位的全部样本，不会再出现“图是 2 年、百分位是 5 年”这种对不上的情况。",
    read: "每个指标卡都给出百分位、中位数、历史最高/最低和出现日期，样本天数就标在百分位旁边，和图表天数一致，可以逐个对。注意：百分位只说位置——价格百分位只说价格在历史中的位置（趋势与回撤含义），不说贵贱，贵贱看历史 PE 百分位（个股有 5 年 PE 百分位管线；指数/ETF 里沪深 300 与 A 股板块 ETF 有中证官网 PE 管线、标普 500 有 Multpl PE 管线，其余暂无 PE 数据的不显示估值判断）；收益率类百分位高只说“债券现在便宜”。位置走到极端都不等于马上反转，便宜也不等于马上抄底，要结合趋势一起看（决策信号页就是这么打分的：债券按收益率百分位高打高分，股票按回撤、年线趋势、RSI 与动量打分，沪深 300 与红利低波两条另加历史 PE 百分位因子，价格百分位只标位置、不进打分）。窗口越短，百分位越“近视”：近1年的百分位 90 只说明比过去一年高，放到 5 年里可能只是中位——长线决策建议切到近5年或全部历史再看一遍（决策信号页固定用全历史口径打分，不受窗口切换影响）。",
  },
  {
    id: "yieldcurve",
    group: "债券深钻",
    name: "收益率曲线",
    plain: "把不同期限的国债收益率连成一条线，就像一条“利息价目表”：借 1 年给多少利息、借 3 年给多少、借 10 年给多少、借 30 年给多少。本台画的是中债国债收益率曲线的六个标准期限（1/3/5/7/10/30 年）——短端和中段补齐之后，才能看出曲线到底是哪一段在动。正常情况下借得越久利息越高，曲线向右上方倾斜。曲线的形状，就是市场对未来经济和利率的集体投票。",
    read: "曲线整体上移 = 借钱变贵（债券价格跌）；整体下移 = 借钱变便宜（债券价格涨）。中国 10 年期是国内资产的定价锚，它的百分位告诉你现在利率在历史什么位置——注意方向：收益率百分位低，说明利率在历史低位、债券在历史高位（贵），不是债券便宜；百分位高才是债券便宜。这与决策信号页“收益率百分位越高、债券价格越便宜”是同一口径，收益率卡的颜色也按这个方向反向显示。",
  },
  {
    id: "termspread",
    group: "债券深钻",
    name: "期限利差（主口径 10年 − 1年）",
    plain: "长债利息减短债利息，多出来的部分就是“为时间付的钱”。本台的主口径是 10年 − 1年：1 年期最贴近资金面和政策利率预期，量出来的利差对“钱松不松、长端贵不贵”最敏感，课程里的锚点（约 43.5bp、近 5 年百分位约 20%）用的就是这个口径。新闻和研报里最常引用的 10年 − 2年 是国际惯例（美债衰退预警同款），本台保留它作对照卡——两个口径短端不同，数值和百分位都不一样，别混着看。利差变负叫倒挂：借长期的反而比短期便宜，说明市场觉得未来会降息、经济会转弱。",
    read: "看利差的百分位：越低说明长债相对短债给的补偿越薄，追长债的性价比越差；走阔则是长端在变便宜或短端在变松。倒挂不是衰退本身，而是预警灯——历史上预警到衰退真正发生，中间常隔 1 年以上。",
  },
  {
    id: "curvesegments",
    group: "债券深钻",
    name: "曲线分段利差（看哪一段在动）",
    plain: "把收益率曲线切成三段：短段（5年−2年）、中长段（10年−5年）、超长段（30年−10年）。每一段的“话事人”不一样：短段听央行的，中长段听经济预期的，超长段听保险、养老金这类超长钱的。曲线动的时候，先看是哪一段在动，就知道是谁在出手、为什么出手。",
    read: "短段走陡 = 资金面在放松；中长段走陡 = 市场在交易增长/通胀或长债供给；超长段被压平 = 超长钱在抢券（资产荒），突然走阔要警惕止盈和供给冲击。",
  },
  {
    id: "creditspread",
    group: "债券深钻",
    name: "信用债与信用利差",
    plain: "债券分两大类：利率债（国债、政策性金融债）背后是国家信用，基本不用担心不还钱，价格只随利率涨跌；信用债（企业债、公司债、城投债、中票）背后是企业或地方平台的信用，要多付一点利息作为“违约风险补偿”，这多出来的一截就叫信用利差。利差越宽，市场越怕出事；越窄，说明大家抢着买、风险偏好高。",
    read: "信用利差走阔 = 信用债被抛售（比如 2022 年底理财赎回潮）；收窄到历史极低 = 信用债被抢爆了，性价比反而差。本台用城投债、公司债、可转债三只可交易 ETF 的价格和它们相对国债 ETF 的强弱，来实时跟踪信用风险偏好。",
  },
  {
    id: "repo",
    group: "债券深钻",
    name: "回购定盘利率（FR007 / FDR007）与流动性分层",
    plain: "银行和机构之间互相借钱过桥，用的工具叫质押式回购：拿债券作抵押借现金，过几天连本带息赎回。借 7 天的价格就是 7 天回购利率。FR007 是全市场（银行+券商+基金）的定盘价，FDR007（常说的 DR007）只算银行等存款类机构。央行每个工作日做逆回购投放资金（2026 年 11 月起主要操作品种切换为隔夜逆回购、利率 1.25%，7 天期改为税期、月末等时点开展），所以 DR007 / DR001 是离政策利率最近的温度计。",
    read: "DR007 持续高于政策利率 = 资金紧；持续低于 = 资金松。FR007 − FDR007 叫流动性分层：差越大，说明钱卡在银行体系里、非银借钱越贵，是季末和信用事件时最先报警的指标。季末、缴税期、政府债发行高峰，资金利率常会脉冲式冲高。",
  },
  {
    id: "shibor",
    group: "债券深钻",
    name: "SHIBOR（上海银行间同业拆放利率）",
    plain: "18 家大银行每天早上报一个价：“我愿意以什么利率把钱借给同行”，去掉最高最低取平均，就是 SHIBOR。它分八个期限：隔夜、1 周、2 周、1 月、3 月、6 月、9 月、1 年，是很多浮息贷款、同业存单和利率互换的定价基准。可以把它理解为银行间资金的“挂牌价”，回购利率则是“成交价”。",
    read: "SHIBOR 3 个月是最常用的观察点：它稳步下行说明银行不缺钱、预期资金继续松；突然跳升且回购利率跟涨，往往是流动性真的收紧了。报价和成交价背离时，以成交价（回购）为准。",
  },
  {
    id: "cnusspread",
    group: "债券深钻",
    name: "中美利差",
    plain: "中国 10 年国债利息减美国 10 年国债利息。钱是逐利的：哪边利息高，资金就想往哪边跑。利差为负（美国利息更高）时，人民币会承受贬值压力，央行降息也要多掂量。",
    read: "利差越负，汇率压力越大；利差快速收窄时，往往伴随人民币走弱和外资减持中国债券。",
  },
  {
    id: "sectorrotation",
    group: "股票深钻",
    name: "板块轮动与相对强弱排名",
    plain: "大盘是一个平均数，平均数底下永远是冰火两重天：钱总是在板块之间轮动——这阵子追科技，过阵子躲到红利和银行里避险。判断轮动不看单个板块涨了多少，看它相对大盘“多涨了多少”（相对强弱）：持续跑赢 = 钱在流入，持续跑输 = 钱在撤离。",
    read: "轮动榜按近 3 月跑赢基准的幅度排名：榜首板块趋势最强；同时看价格历史位置——跑赢很多又处在历史高位的板块，说明这段涨势已经走了很远、离历史高点很近，追涨要留意回撤风险（位置只说趋势与回撤，不说贵便宜）；榜尾突然转正，常是风格切换的第一个信号。",
  },
  {
    id: "fibonacci",
    group: "股票深钻",
    name: "斐波那契回撤（52 周锚点）",
    plain: "把一段趋势的低点和高点连起来，从终点往回按固定比例量出一条价格梯子：上涨波段从高点往下量 23.6% / 38.2% / 50% / 61.8% / 78.6%，每一档都是潜在支撑；跌破低点之后，再往下看 127.2% / 161.8% 扩展位。它的道理不是魔法数字，而是这些位置恰好是「涨幅回吐了三分之一、一半、六成」的地方——很多人的止损、止盈和限价单都挂在附近，于是它们真的会起作用。本台的锚点窗口固定为近 52 周：高点和低点都必须带日期（比如 QQQ 高 $762.86 在 2026-10-06、低 $555.60 在 2026-03-30），每次刷新重新计算，并且用第二数据源（Nasdaq 官方历史数据 / 东方财富美股日线）逐项核对日期与数值，对不上就如实标注、绝不拿旧数字充数。短线和长线的锚点要分开看，不能混成一张图。",
    read: "现价离最近一档越近，这一档的表态越重要：守住（尤其 50% 与 61.8% 两档）说明回撤还在「正常喘气」范围；连续两根收盘跌破某一档（盘中扎破不算），才算这一档失守、要看下一档。挂限价单时把买单梯子放在回撤位附近、把失效线放在下一档之下，就是这张卡的标准用法。决策信号页的 QQQ / VOO 依据里会直接引用最近一档回撤位和它的价格。",
  },
  {
    id: "cloudmap",
    group: "股票深钻",
    name: "云图（板块热力图）",
    plain: "版式 1:1 照美股编年史 App 的市场热力图：深色墙面，板块视图里每个板块是一片区域，行业视图里每个行业是一片区域（标题条左是组名、右是 ↑涨几只 →平几只 ↓跌几只 加该组涨跌幅），里面的每只成分股是一块砖，砖与砖之间只留约 2px 深色缝、无圆角无阴影，整面墙严丝合缝、无空白空洞。颜色与全站一致：红涨绿跌，幅度越深颜色越深；涨跌幅在 ±0.2% 以内算没动，砖是灰色。砖的面积默认用「均匀浏览」：按市值（美股）或指数权重（A股）开方缩放——市值比例只体现一部分，大票仍比小票大，但小票和医疗、工业这类小板块也能分到够显示标签的面积，图里能放下更多带字的股票；想严格按市值/权重原值看，可在设置里切「真实比例」。砖面标签按砖块大小自适应分档，字体随砖块缩放：大砖四行全有——名称/代码与中文名、涨跌幅、价格、市值·权重（如苹果 $5.12万亿 · 7.27%）；中砖两行（名字+涨跌幅）；小砖一行（只留名字，名字太长放不下就改用代码，保证整行完整可读）。连一行名字/代码都放不下的尾部最小砖直接不画：图里没有纯色无字砖，每块可见砖都带字，也没有「其他」聚合砖、不列举尾部名单，板块面积按显示的股票重新归一化填满、无空白空洞。美股可点顶栏「盘前」：砖面涨跌、颜色与板块家数全部换成快照抓取时的盘前涨跌（价格仍是收盘价），与收盘口径不混用；没有盘前值的股票在盘前态是灰砖「—」，整张快照都没有盘前值时切换会明说并留在收盘口径。一眼扫过去，整面墙偏红还是偏绿、哪片区域最深，就是这个时段钱的流向全景。本台的云图收录标普 500、纳斯达克 100、道琼斯工业平均（全 30 只）与沪深 300 的全部成分股，不是抽样；罗素 2000 是唯一的例外：全指数约 2,000 只、没有免费官方成分文件，本台改用 iShares 官方 IWM 持仓文件取权重前 200 大成分并明确标注「非全量」，权重用持仓文件发布的真实指数权重、不按子集重归一化（该文件被源站拦截拉不到时，该指数就显示「待成分源」、空着，也不拿别的指数成分冒充）；指数菜单带的是官方指数当日涨跌（标普 500 = ^GSPC、纳斯达克 100 = ^NDX、道指 = ^DJI、罗素 2000 = ^RUT、沪深 300 = 510300 ETF 代理；标普/纳指/沪深与总览同源，道指/罗素由云图分块随成分一并拉取），菜单里本台没有成分数据的指数（美股、全球、加密、ETF、恒生、日经、KOSPI、台湾 50、斯托克 50、富时 100）照参考 App 列出、涨跌显示「—」、暂不可选，不拿别的数据冒充。注意别把「成分股按市值加权平均」当成指数涨跌：官方指数用的是流通股调整后的权重加除数、权重取自日初，而收盘市值加权平均用的是日终市值——涨得多的股票收盘时权重自动变大，这个估算会系统性偏高（2026-11-18 实测：估算 −0.11%/+0.54%，官方 −0.23%/+0.42%，两个指数同向同幅差 +0.12 个百分点）。所以页面把估算单列并注明「成分加权估算」，对不上时以官方值为准。",
    read: "顶栏左是时段 pill（1天/1周/1月/3月/6月/年初/1年），一点即换，整幅图的颜色与涨跌幅都跟着换：短时段看情绪，长时段看趋势；中间是指数 pill，点开是参考 App 那样的深色下拉菜单（顺序与分组照抄：标普、纳指、道指、罗素、美股，分隔线，全球、加密、ETF，分隔线，恒生、沪深 300、日经、KOSPI、台湾 50、斯托克 50、富时 100，底部一行休市状态）；右上角设置里切换板块/行业视图、真实比例/均匀浏览与缩放。美股多一个「盘前」pill：切过去后砖面与板块头全部是盘前口径，收盘数字不再出现。板块视图点标题条下钻一层按行业分组细看；行业视图一幅图看全市场所有行业，点行业标题条直接下钻到该行业的个股。砖右上角的小 ▽ 标的是该「板块·行业」组里体量最大的那只（可下钻组的领头砖），左上角 ★ 是自选与持仓里的名字（MU、GOOGL、AVGO、AAPL、TSLA、NVDA、BE）。点任意色块从底部弹出个股详情抽屉：代码加中文名、所属板块和板块内市值排名（第几/共几只）、特大号价格加当日涨跌额与涨跌幅、盘前价（有才显示）、公司简介段（价格下方、数据格上方：美股是 Yahoo 公司资料、A 股是东财 F10 公司简介，均为原文摘录，源里没有就不显示这一段；美股简介下方还有 Yahoo Finance 近期新闻标题 2–3 条，带日期与发布方，点开看原文，A 股该新闻源为空、只有简介）、日内分时图（白线、昨收虚线、右端现价 pill、下方成交量柱；图下方常驻 1 天→1 年各时段涨跌条，分时取不到时同一位置只显示这条涨跌条）、时段 pill 行、四列数据格（开盘价/日内最高/日内最低/成交量；市值/市盈率 TTM/市盈率 NTM/股息率；52 周区间条/净资产收益率/下次财报；52 周最高/52 周最低/每股收益 TTM/贝塔系数；平均成交量/市销率/市净率/指数权重——数据源没给的标「—」、不估算）、拉动指数百分点与领先/落后板块、距 52 周高点与均线位置、同板块相关股色块（点开切换详情）、「简介 · 行业 ›」（点它下钻到该股所在板块或行业）、股息块（近 12 个月每股股息与除息日，有才显示）。美股大票砖面用常见中文名（苹果、英伟达、亚马逊……），没有中文名的保留代码。小砖点不准时，在设置里选「放大/特大」把整面墙拉高，或先下钻再点。",
  },
  {
    id: "seedlib",
    group: "数据工程",
    name: "静态种子库 + 增量刷新（数据层架构）",
    plain: "历史数据是不变的数据：1928 年的年度回报、十年前的日线收盘价，拉过一次就不会再变。为这种数据每次刷新都全量重拉，既慢又浪费，还容易因为某个源临时抖动把好好的历史库刷坏。专业做法是分两层：静态种子库——历史序列（日线、年度回报、CAPE 与估值历史、回撤名册、编年史数据集）第一次一次性拉满入库（主指数 10–20 年、其余 5 年起），之后只读库；增量刷新——每次刷新只从库里每条序列的最后日期往前重叠一小段（约两周，季频序列放宽到一年多）取尾巴，追加新点、顺带修正源站的复权与修订，历史段一个点都不碰。全量重拉只保留为手动「全量重建」兜底（刷新面板里，二次确认）。编年史数据集走同一思路：来源站点的 manifest 给每个数据集发布了内容哈希，哈希没变就连文件都不下载。云图快照、大事日历这类「当期状态」不是历史序列，仍按原来的分块刷新整表替换。",
    read: "验证方式看刷新日志：每块都会写明本次「追加多少点 · 重叠复核多少点（其中数值变化多少点）· 历史跳过多少点」——重叠段每次都会重取复核，但只有数值真的变了才计入「数值变化」，原值重写不算修正；第二次刷新时追加应接近于零、跳过应接近全量——如果不是，就是增量没生效。总览底部的「数据覆盖」表列出每条序列的起止日期与点数，种子是否完整一眼可见。某个源失败时，该块旧数据完整保留、只标失败原因，静态库不会因为一次失败缩水。",
  },
  {
    id: "chronicle",
    group: "美股长史",
    name: "美股编年史的读法",
    plain: "编年史模块是把标普 500 一百年的结构拆开看：回报卷告诉你长期回报的分布形状（平均数附近几乎没有年份、五年滚动亏钱窗口不到一成）；估值卷把价格拆成「市盈率 × 每股盈利」两条腿，看现在贵在估值还是盈利已经透支；危机卷把每次大跌登记成名册，配上年内回撤与波动率的常态区间，判断当下是常态波动还是危机节奏；骨骼卷看指数内部的权重集中度——前十名占近四成时，指数的命运就是十家公司的财报；板块卷逐个看半导体、科技、金融、消费的脾气与历史极值。数据来自 historyofmarket.com 的开放数据集（CC BY 4.0），静态入库、哈希增量。",
    read: "编年史是「气候」不是「天气」：它不给买卖时点，只给赔率背景。今天的决策先看决策信号页的活数据，再回编年史对一眼：当前估值在百年分布的哪个位置、这次回撤在名册里排第几、集中度比 1999 年顶点如何——三眼对完，仓位和耐心自然有数。",
  },
  {
    id: "fear",
    group: "宏观",
    name: "VIX 恐慌指数",
    plain: "用期权价格反推出来的“市场心跳仪”：数字越大，投资者越愿意花高价买保险，说明越慌。20 以下算平静，30 以上是明显恐慌，40 以上通常对应大事件。",
    read: "VIX 冲到历史极高百分位，往往是恐慌最盛的时候——历史上几次大底都伴随 VIX 极端值，但它只测情绪、不测价值，别单靠它抄底。",
  },
  {
    id: "macrodata",
    group: "宏观",
    name: "宏观数据序列（CPI / 失业率 / 核心 PCE）",
    plain: "行情是每天跳动的“天气”，宏观数据是每月公布一次的“体检报告”：CPI 同比看物价涨多快，失业率看就业冷不冷，核心 PCE 同比是美联储真正盯的通胀（去掉食品能源，目标 2%）。三条都是月频、带发布滞后——卡片上的日期是数据所属的月份，不是公布日，所以它们永远比行情“慢半拍”，这是统计口径，不是数据坏了。",
    read: "CPI 看方向和加速度：同比在 3% 上方，美联储很难降息；核心 PCE 才是降息的“放行证”，它回到 2% 附近、且连续几个月不反弹，宽松才有空间。失业率看趋势不看单月：它低的时候不代表经济没事（它是滞后指标），关键是 3 个月均值有没有从低点回升 0.5 个百分点（萨姆规则，历史上衰退的可靠前兆）。三张卡的百分位都按页面顶部窗口算：通胀的百分位越高，离降息越远；失业率的百分位要反着读——低位徘徊是常态，快速脱离低位才是警报。",
  },
  {
    id: "goldratio",
    group: "宏观",
    name: "金银比",
    plain: "买 1 盎司黄金要花多少盎司白银的钱。黄金是纯避险资产，白银一半是工业金属。比值冲高 = 大家只想要避险、不看好工业需求；比值回落 = 风险偏好回来了。",
    read: "历史上金银比极端高位（如 2020 年 120 倍）之后，白银常有补涨行情；比值的中枢大约在 60–80 倍。",
  },
  {
    id: "correlation",
    group: "宏观",
    name: "相关性",
    plain: "两个东西是同涨同跌（正相关，接近 +1）、各走各的（接近 0），还是一涨一跌（负相关，接近 −1）。黄金和美债收益率教科书上是负相关：收益率涨，持黄金的机会成本变高，金价就该跌。",
    read: "当长期稳定的相关性突然反转，说明市场的主导逻辑变了（比如央行购金压过了利率逻辑），这是值得深挖的信号。",
  },
  {
    id: "trend",
    group: "微观 · 趋势",
    name: "均线与趋势（金叉/死叉）",
    plain: "均线就是过去 N 天的平均价，像一条“成本线”。价格在均线之上，说明最近买入的人大多赚钱，心态稳；跌破则相反。短期均线（20日）上穿长期均线（60日）叫金叉，下穿叫死叉，是趋势转折的经典信号。",
    read: "先看价格站上几条均线（多头/空头排列），再看金叉死叉。均线是慢变量，适合判断大方向，不适合抓最低点。",
  },
  {
    id: "rsi",
    group: "微观 · 动量",
    name: "RSI 强弱指标",
    plain: "最近 14 天里，涨的力量和跌的力量谁更强，打成 0–100 分。70 以上叫超买（涨太急），30 以下叫超卖（跌太狠）。就像跑步的心率：太高了得歇歇，但不代表比赛结束。",
    read: "超买后可以继续涨（强趋势里 RSI 会长期高位），所以 RSI 更适合提示“别追高”，而不是单独当卖出信号。",
  },
  {
    id: "macd",
    group: "微观 · 动量",
    name: "MACD",
    plain: "比较两条快慢均线的距离，看涨跌的“加速度”。柱子在零轴上方 = 短期趋势比长期强；柱子变短 = 劲儿在泄；柱子由负转正 = 动能翻多。",
    read: "MACD 对震荡市迟钝、对趋势市灵敏。看柱子方向 + 变长变短，比只看金叉死叉信息更多。",
  },
  {
    id: "bollinger",
    group: "微观 · 波动",
    name: "布林带",
    plain: "以 20 日均线为中轨，上下各画一条“两倍波动”的边界，像一条随水流宽窄变化的河道。%B 告诉你价格在河道里的位置：1 是上沿，0 是下沿，0.5 是河中央。",
    read: "价格贴着上沿走不一定是见顶（强趋势会沿轨上行）；河道突然收窄（带宽极小）往往预示大行情临近。",
  },
  {
    id: "volatility",
    group: "微观 · 波动",
    name: "波动率",
    plain: "最近价格晃得有多厉害，换算成年化百分比。波动率 15% 属于岁月静好，30% 以上就是惊涛骇浪。波动率有个脾气：涨得快、落得慢，恐慌时冲高，之后慢慢回落。",
    read: "波动率冲到历史高百分位，常和恐慌底同时出现；波动率长期低迷，则要小心市场对风险麻木。",
  },
  {
    id: "drawdown",
    group: "微观 · 风险",
    name: "回撤（距高点跌了多少）",
    plain: "从最高点跌下来的幅度。回撤 10% 是常规回调，20% 是技术性熊市分界线。看回撤的历史百分位，就知道这次下跌在历史上算小打小闹还是深水区。",
    read: "回撤越深、百分位越低，说明跌得越罕见。但深回撤里继续深跌的例子也很多（2008 年标普回撤 57%），跌得深和见底是两回事。",
  },
  {
    id: "drawdownepisode",
    group: "微观 · 风险",
    name: "回撤解剖（一次下跌的全过程）",
    plain: "把历史切成一段一段完整的下跌事件：从最高点（峰值）跌到最低点（低谷），再涨回最高点（收复）。每段事件记三件事：跌了多深、跌了多久、爬回来用了多久。这比只看“最大回撤一个数字”有用得多——它告诉你买这个东西，最坏要做好跌多少、等多久的心理准备。",
    read: "“历史回撤”页就是这么算的：股票、黄金等标的跌幅超过 8% 才算一段事件；债券 ETF 价格波动小得多（国债 ETF 全历史最大回撤不足 5%），门槛单独降为 2%，并保证至少列出全历史最大回撤一段，免得整只被 8% 门槛滤掉。看三点：①最深的一段有多深（你的极限压力测试）；②中位恢复时间（典型情况要等多久，不是最坏也不是最好）；③当前回撤在历史事件里排第几深。红利类资产的卖点就是事件更浅、恢复更快，数据会自己说话。",
  },
  {
    id: "policybond",
    group: "债券深钻",
    name: "国开债与政策性金融债",
    plain: "国开行、农发行、进出口银行发的债，统称政策性金融债（政金债），国开债是其中最大的一只。信用等级实际等同国债（国家兜底），但因为不能免税等原因，收益率通常比同期限国债高一截，这一截叫“政金-国债利差”。银行间市场里，政金债的成交比国债活跃得多，是机构做波段的主战场。",
    read: "利差宽（政金债相对便宜）时买政金债、利差收到历史极窄时换回国债，是经典的利差交易。本台用 7-10 年政金债 ETF（511520）的价格和它相对国债 ETF 的强弱跟踪这个利差的方向，决策信号页有专门一条。",
  },
  {
    id: "futuresbasis",
    group: "债券深钻",
    name: "国债期货基差（期货贵还是现券贵）",
    plain: "同一只国债有两个价格：现货市场里真金白银买卖的价格（现券价），和期货市场里约定几个月后交割的价格（期货价）。把期货价换算回现券口径（除以转换因子）再和现券价比，差出来的就是基差。打个比方：基差就是“期货预订价”和“现货柜台价”之间的差价。期货可以加杠杆、可以做空，所以基差里藏着市场情绪：大家抢着用期货做多时，期货被买贵、基差走阔；恐慌或逼仓时基差会快速收窄甚至变负。和基差配套看的还有 IRR（隐含回购利率）：假设现在买入现券、同时卖出期货锁定交割价，这笔无风险套利能赚多少年化收益——IRR 明显高于实际回购利率，就是市场在白送套利机会，通常活不久。",
    read: "基差的历史分位比绝对值重要：基差处在历史高位 = 期货相对现券贵，用期货做多不如直接买现券，或做“卖期货 + 买现券”的正套；基差极低甚至为负 = 期货被砸便宜了，做空期货的人容易被逼仓，长债多头反而常用期货抄底。基差突然大幅走阔/收窄，往往先于现券行情，是机构多空力量的前哨。本台需要期货与现券双边行情才能算，本机源不可达，资金面页先放占位卡如实缺位，源恢复后自动补上主力合约（2/5/10/30 年期）的基差与 IRR。",
  },
  {
    id: "dividend",
    group: "股票深钻",
    name: "红利策略（靠分红赚钱的股票）",
    plain: "有一类公司赚了钱愿意大方分给股东，股价不一定涨得快，但每年有现金分红落袋。红利 ETF 就专挑这类公司。它们的共同特点是：多为银行、能源、公用事业等成熟行业，波动小、回撤浅，熊市里相对抗跌；代价是牛市里跑不过科技成长股。美股红利还分流派：SCHD 先筛现金流和分红质量，VYM/SPYD 直接按股息率高低排队，VIG/DGRO 只买“年年加分红”的公司。",
    read: "判断红利贵不贵看股息率与股债性价比利差（A 股页有 ETF 口径的 ERP 代理卡），价格百分位只标价格位置（趋势 / 回撤含义），不当估值尺；还要看回撤史：红利的价值就是跌得少。如果一只“高股息”ETF 的历史回撤和大盘一样深（如 SPYD），说明它的高息是周期股跌出来的，不是真防御。股息率会被股价涨掉：股价涨得越多、股息率被摊得越薄，分红的安全垫也越薄——看股息率本身，别看价格位置下结论。",
  },
  {
    id: "signalrules",
    group: "通用尺子",
    name: "决策信号是怎么算出来的",
    plain: "“决策信号”页的每条结论都不是拍脑袋，是一套写死的规则在打分：距高点回撤（跌得够不够多）、年线趋势（大方向破没破）、RSI（短线情绪）、动量（最近的劲头），QQQ / VOO 另加斐波那契回撤位；债券不用价格打分，改用收益率百分位（利率在历史什么位置——百分位越高、债券越便宜）。股票的价格百分位只标价格位置（趋势 / 回撤），不进信号打分、更不当贵便宜尺：贵便宜要看历史 PE 百分位——沪深 300 与红利低波（512890）两条信号已接入中证指数官网口径的历史 PE 百分位因子（近 5 年月末 TTM PE），VOO（标普 500）已接入 Multpl 口径的历史 PE 百分位因子（近 5 年月度 TTM PE），其余股票信号暂无 PE 管线、不给估值判断。每个因子加分或减分，最后汇总成 −5 到 +5 分，对应“积极分批买入 / 逢低分批 / 持有观望 / 减仓暂缓 / 回避止盈”五档。每张卡都把每条因子的得分和数字摆出来，你可以逐条验算。",
    read: "信号是“规则参考”，不是预测：它只说按历史上反复出现的规律，现在这个位置的风险收益比怎么样。趋势因子是故意保守的——跌破年线时哪怕回撤已经很深也不会给“积极买入”，因为历史上接飞刀的胜率不高。最终买不买、买多少，决策权在你。",
  },
  {
    id: "realrate",
    group: "华尔街深钻",
    name: "实际利率与利率路径",
    plain: "名义利率是“标价”，实际利率是标价减去通胀——真正决定钱往哪流的是实际利率。美联储的利率路径有两种看法：点阵图是委员们每季度画一次的“官方预期”，2 年美债收益率是市场每天投票的“实时预期”。点阵图没有免费的程序化数据序列，所以本台用联邦基金有效利率（已经发生的路径）+ 2 年收益率（市场定价的未来路径）跟踪它，两者之差就是市场押注的降息/加息空间。",
    read: "2 年收益率明显低于政策利率 = 市场在押降息（历史上衰退前常见）；两者贴合 = 市场认同美联储“按兵不动”。实际利率（10 年 TIPS）冲高时，黄金和长久期成长股同时承压。",
  },
  {
    id: "breakeven",
    group: "华尔街深钻",
    name: "通胀预期（盈亏平衡通胀）",
    plain: "市场上有一对双胞胎债券：普通国债和通胀保值国债（TIPS）。两者收益率之差，就是投资者用真金白银押注的“未来平均通胀”。它不是调查问卷，是带钱投票的结果，美联储开会前必看。",
    read: "10 年盈亏平衡通胀在 2% 附近 = 预期被锚住；冲过 2.6% = 市场开始不信美联储能压住通胀，鹰派风险上升；跌破 1.8% = 市场在担心需求衰退。",
  },
  {
    id: "creditoas",
    group: "华尔街深钻",
    name: "信用利差 OAS（HY / IG）",
    plain: "公司发债要比国债多付利息，多出的部分就是信用利差。高收益（垃圾）债的利差（HY OAS）是华尔街最灵敏的风险胃口计：投资者一害怕，先卖垃圾债，利差立刻走阔，经常比股市早几天到几周反应。投资级（IG）利差更稳，它大动说明恐慌在蔓延到优质资产。",
    read: "HY 利差 <3% = 市场亢奋、补偿薄；3–5% 正常；5–8% 压力；>8% 危机（2008 年曾达 20%）。看百分位比看绝对值更准：利差从极低百分位开始走阔，往往是风险资产见顶的先兆。",
  },
  {
    id: "termpremium",
    group: "华尔街深钻",
    name: "期限溢价",
    plain: "把钱借出去 10 年，中途不能反悔，市场要求为此多付一点“后悔费”，这就是期限溢价。它藏在长债收益率里：长端收益率 = 未来短利率预期 + 期限溢价。前者听美联储的，后者听财政赤字和长债供给的。",
    read: "期限溢价转正并走高（近年趋势）= 长债收益率易上难下，TLT 这类长久期资产要留更厚的安全垫；期限溢价深负 = 长债被抢购，追长的性价比差。",
  },
  {
    id: "vixterm",
    group: "华尔街深钻",
    name: "VIX 期限结构",
    plain: "VIX 不止一个数：有 9 天的、1 个月的、3 个月的。平静时远期的更贵（为更远的不确定性付费），这叫正向结构；恐慌来临时大家只抢眼前的保险，近端冲得比远端还高，结构“倒挂”——这是市场压力的确认信号，比 VIX 绝对值更可靠。",
    read: "本台看 VIX − VIX3M：<0 正常；>0 倒挂（压力事件进行中）；从倒挂回到 0 以下，常是恐慌退潮、市场开始修复的早期信号。",
  },
  {
    id: "sentiment",
    group: "华尔街深钻",
    name: "情绪指标（信心与金融条件）",
    plain: "情绪是“大家觉得怎么样”，不是“经济实际怎么样”。密歇根消费者信心问的是感受，芝加哥联储金融条件指数（NFCI）量的是钱松钱紧的体感。情绪极端时往往反着看：信心跌到历史冰点，股市反而常在附近见底。",
    read: "NFCI >0 = 条件偏紧（逆风），<0 = 宽松（顺风）。情绪指标适合看极端百分位，不适合看日常波动。期权 put/call 比本质也是情绪指标，但 CBOE 的历史序列接口对程序抓取不开放，本台如实缺位，用 VIX 期限结构和 HY 利差替代观察同一件事。",
  },
  {
    id: "earnings",
    group: "华尔街深钻",
    name: "企业盈利与回购",
    plain: "股价长期 = 盈利 × 估值。盈利看 BEA 的全美企业利润（季频，最权威的总口径）和财报季里公司的指引；回购是美股过去十年最大的“买家”——公司自己回购股票推高每股收益。回购没有免费的程序化序列，本台用企业利润（能不能赚）+ 金融条件（借钱贵不贵）间接判断回购的持续性。",
    read: "企业利润创新高 + 金融条件宽松 = 盈利与回购双顺风；利润连续两季下滑 = 盈利衰退，估值再便宜也要防“越跌越贵”（分母在变小）。",
  },
  {
    id: "turnover",
    group: "A股深钻",
    name: "成交额、两融、南向与 A 股资金面",
    plain: "A 股是资金推动市，资金面就是天气预报。成交额是全场人气（一天买卖了多少钱），两融余额是杠杆温度（借了多少钱炒股），两者都带历史百分位才有意义：地量常在底部、天量常在高位、两融冲顶后市场容易踩踏。北向资金每日净买入已于 2024 年 8 月停止披露（改为季度持仓），任何声称有实时北向净买入的页面都是旧数据或估算，本台不假装有；ETF 申赎数据没有免费程序源，同样如实缺位。南向资金（内地经港股通买港股的每日净买入）是另一回事：港交所照常每日披露、从未停过，本台已接入做第三张卡——它量的是港股的边际买家，和北向停披不要混为一谈。",
    read: "组合着看：成交额百分位 + 两融百分位同时 >90 = 过热区；成交额跌到历史低位 + 两融趋势性回落 = 冰点区。单看一个容易被单日异动骗。南向再单看方向：连续净买入 = 内地资金在加仓港股（常与恒生科技走强同步），连续净卖出 = 在兑现离场。",
  },
  {
    id: "leverage",
    group: "A股深钻",
    name: "融资余额与保证金负债（杠杆温度）",
    plain: "融资余额是投资者向券商借钱买股、还没还的总额——借的钱越多，这个数越大。它是杠杆资金的「存量」；每天的融资买入额 − 偿还额 = 净买入，是杠杆资金的「流向」。美股没有日度两融，FINRA 每月公布一次全市场保证金负债（同一件事的月度版，滞后约一个月），外加客户账户里闲置的自由信用余额。两边都是交易所 / 监管机构的官方披露：A 股沪市取上交所官网、深市取深交所披露，两市合计只算沪 + 深、不含北交所（东方财富的三市合计口径含北交所，本节不用它拼 headline）。",
    read: "存量看分位、流向看连续天数：融资余额近 5 年分位 >90 且近 20 日还在涨 5% 以上 = 杠杆过热（决策信号 A1）；净买入连续 5 个交易日为负 = 杠杆资金在撤退（A2）。美股同理看全历史分位 + 同比（U1：分位 >90 且同比 >+20%）。杠杆指标的意义在极端：中段位置它什么都不说，分位冲到两头、或流向连续同向时，才值得调整仓位节奏。",
  },
  {
    id: "erp",
    group: "A股深钻",
    name: "股债性价比（ETF 口径代理）",
    plain: "同样一笔钱，放红利股每年拿股息，还是放 10 年国债每年拿利息，哪个更划算？把红利资产的股息率减去 10 年国债收益率，差就是股相对债的“性价比利差”：利差为正且越宽，说明光靠股息就跑赢国债利息，红利相对债越便宜。全市场股息率没有免费的程序化历史源，所以本台用两只红利 ETF 跟踪指数的官方股息率做代理：512890 跟踪的中证红利低波动指数、510880 跟踪的上证红利指数，股息率都取中证指数官网每日估值文件的股息率1（总股本口径），减同日 10 年国债收益率（东方财富数据中心）。这是红利这一类资产的口径，不是全市场口径，卡片名称里就写明“ETF 口径代理”。",
    read: "看三样：利差的正负（正 = 股息已高于国债利息）、利差的历史百分位（高 = 现在的补偿在历史上算厚，低 = 红利被买贵了）、两只 ETF 口径是否同向（同向才可信）。股息率历史由中证官网每日文件逐日积累，样本还短，百分位旁标注了样本天数，样本越长越可信。",
  },
  {
    id: "stylefactor",
    group: "A股深钻",
    name: "风格因子（红利/成长、大小盘、动量、低波、价值-成长）",
    plain: "市场里钱的口味一直在变：一阵抱红利和大盘蓝筹（防御），一阵追创业板和小盘题材（进攻）。风格因子就是量这股口味的尺子——用两类资产的相对强弱（近 3 月谁跑赢谁）来刻画，而不是听叙事。本台共六组对照：红利低波 vs 创业板、1000 vs 300（大小盘）、美股 SCHD vs QQQ，再加动量、低波、价值-成长三组 A股对照。新增三组都按「同一股票池里比因子」配对，免得把规模或板块差异误读成因子：动量用创业板动量成长 ETF（159967，动量+成长复合因子——A股没有纯动量单因子 ETF）对创业板宽基；低波用中证500行业中性低波 ETF（512260）对中证500宽基；价值-成长用同出沪深300池、同一套中证风格框架的沪深300价值 ETF（562320）对沪深300成长 ETF（159656），两只 2022 年底才上市，相对强弱样本从 2023 年 1 月起、比老组年轻，卡片上的样本数就是实际天数。六组口径完全一致：两只 ETF 近 63 个交易日对数收益之差的历史百分位。",
    read: "看两个东西：方向（谁占优）和百分位（占优到极端没有）。占优趋势 + 百分位没到极端 = 跟随；百分位 >90 = 这条风格已经很挤，反转风险在累积。动量组要多留个心眼：它测的是「强者恒强」在创业板内部还成不成立，涨幅榜换血快时这条线会先钝化；价值-成长组看的是大盘内部的估值风格切换，和红利低波那组同向时，说明防御是全市场级别的。",
  },
  {
    id: "portfoliomix",
    group: "组合视角",
    name: "相关性矩阵与组合回撤",
    plain: "分散投资的全部秘密在相关性里：两个资产相关性接近 +1，跌起来一起跌，等于没分散；接近 0 甚至负，才是真保险。本台用近 1 年日收益算股、债、金两两之间的相关性，再把几个经典配比（美股 60/40、A 股股债金等）做成模拟组合，算出它们的历史回撤和波动——让你看到“配了之后最坏要忍多久、多深”，而不是只看单资产的故事。模拟组合是按固定比例每月再平衡的回测，不是谁的实际持仓。",
    read: "重点看两个数：组合的最大回撤 vs 单买股票的最大回撤（分散省了多少疼），以及股债相关性现在是正还是负——2022 年那种股债双杀，就是股债相关性转正的年份，60/40 会暂时失效。",
  },
  {
    id: "seasonality",
    group: "华尔街深钻",
    name: "季节性（月份效应）",
    plain: "把每个日历月在历史上的平均涨跌和胜率排出来，就是季节性。美股有“5 月卖出”（Sell in May）的老说法，A 股有春季躁动。季节性是统计倾向不是规律：样本年份越少越不可信，本台每格都标注了样本年数。",
    read: "季节性只做辅助：当季节性顺风 + 价格位置偏低（回撤较深） + 趋势向上三者同向时，胜率才真的高一截；单靠“这个月历史上爱涨”下单，等于拿平均数赌运气。",
  },
  {
    id: "goldmacro",
    group: "黄金深钻",
    name: "黄金的宏观锚（实际利率/央行购金/持仓）",
    plain: "金价长期由三股力量定价：①实际利率（持有黄金的机会成本，负相关）；②央行购金（新兴市场央行近年持续大买，是慢变量，只看季度数据）；③投资需求（COMEX 期货持仓和黄金 ETF 持仓，反映投机与配置盘的温度）。②③没有免费的每日程序化序列（央行购金是季度披露、CFTC 持仓是周频付费墙外但接口不稳），本台如实标注：最新一期官方数值以「季度手工备注」形式挂在黄金页（带数据日期与来源，逐期历史序列仍缺位），日常用实际利率 + 金银比 + 金矿股相对强弱做可计算的替代跟踪。",
    read: "实际利率下行 + 金矿股跑赢金价（风险偏好在黄金链内部扩散）= 黄金行情健康；金价涨但金矿股不跟，往往是行情后段。央行购金的季度数据出来时（世界黄金协会发布），对照金价百分位看：央行在金价高位仍大买，说明是储备多元化的长逻辑，不是追涨。",
  },
  {
    id: "eventcalendar",
    group: "通用尺子",
    name: "大事日历（事件驱动交易）",
    plain: "市场平时是慢慢爬的，但一年里真正的大波动，大多集中在少数几天：议息决议、非农、CPI、巨头财报发布的那几个小时。专业交易员的日历不是装饰，是排班表——提前知道哪天几点出什么数，就能提前想好仓位和应对，而不是被数据打个措手不及。数据发布这件事，交易员盯的是三个数：预期（市场已经定价进去的水平）、前值（上次是多少）、实际（发布那一刻才知道）——真正让价格跳的不是实际值本身，是“实际 − 预期”这个差，交易员叫它“惊奇”。但本台日历只带前两个数：预期和前值。日历源（Faireconomy 经济日历）不提供实际值字段，所以已发布事件在本页看不到实际值、也就算不出“惊奇”——发布那一刻的实际值要去数据发布方（如 BLS、BEA 官网）或行情终端核对，再回头和这里的预期比。",
    read: "用法分三层：①提前一周扫一遍，把高影响事件（议息、非农、CPI、PCE、巨头财报）的日子圈出来，这些日子前后波动天然大，杠杆和仓位要留余地；②发布前看预期和前值，想好“超预期会怎样、低于预期会怎样”两个剧本；发布后把实际值（需到发布方官网或行情终端核对，本页不提供）和预期一比，差多少就是“惊奇”多大；③远期（两个月开外）的美国数据日期是按发布惯例推算的窗口、标了“日期为推算”，临近两周会被日历源的确切日期和预期值替换，别拿推算日排精确的班。",
  },
  {
    id: "momentum",
    group: "微观 · 动量",
    name: "动量（涨速）",
    plain: "过去一段时间涨了多少。大量研究发现：过去 3–12 个月涨得好的资产，接下来一段时间往往继续相对强——这叫动量效应，是“强者恒强”的数据版。",
    read: "动量为正且百分位靠前 = 趋势健康；动量突然由正转负，常是趋势反转的早期信号。动量最怕急转弯行情。",
  },
  {
    id: "volume",
    group: "微观 · 量价",
    name: "成交量与量比",
    plain: "成交量是市场的“投票人数”。量比 = 今天成交量 ÷ 过去 20 天平均。放量说明分歧大、有大事；缩量说明大家都在观望。价格涨跌是结果，成交量告诉你这个结果有多少人参与表决。",
    read: "放量上涨 = 认可的人多；放量下跌 = 夺路而逃；缩量下跌 = 抛压衰竭的可能信号。量价要结合着看。",
  },
  {
    id: "relstrength",
    group: "微观 · 量价",
    name: "相对强弱（跑赢基准）",
    plain: "不比绝对涨跌，比“比基准多涨了多少”。比如恒生科技近 3 月跑赢恒生指数 5%，说明资金更偏爱科技股。选板块、选基金时，这是比单看涨幅更靠谱的尺子。",
    read: "相对强弱持续为正 = 资金在往这里聚；由正转负 = 风格可能在切换。看百分位能知道现在的领先幅度在历史上算大还是小。",
  },
];

const METHOD_BY_ID = new Map(METHODS.map((m) => [m.id, m]));

// ---------------------------------------------------------------------------
// Formatting & small components
// ---------------------------------------------------------------------------


function moveColor(v: number): string {
  if (v > 0) return "text-[var(--up)]";
  if (v < 0) return "text-[var(--down)]";
  return "text-[var(--dim)]";
}

function PctBar({ percentile, height = "h-2", invert = false, ariaRound1 = false }: { percentile: number; height?: string; invert?: boolean; ariaRound1?: boolean }) {
  // ariaRound1 (r6 O2): the aria-label rounds to 1 decimal while the
  // bar geometry keeps the full-precision value — used by the two
  // call sites whose visible text is already rounded (52-week
  // position, market breadth). Other call sites keep the raw label.
  const ariaPct = ariaRound1 ? Math.round(percentile * 10) / 10 : percentile;
  return (
    <div className={`relative w-full overflow-hidden rounded-full bg-[var(--border)] ${height}`} role="img" aria-label={`历史百分位 ${ariaPct}`}>
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: `${Math.min(100, Math.max(0, percentile))}%`,
          // All percentile bars use the same coloured gradient
          // (user directive 2026-11-20; the old gray single-colour bar
          // for position-only readouts is retired). For price percentiles
          // the gradient is a POSITION scale only — green = the price
          // sits low in its own history, red = it sits high — and says
          // nothing about cheap vs expensive; valuation readings still
          // come from PE / yield percentiles only. invert (yields /
          // spreads): the gradient reverses with the valuation lens —
          // the low end is the expensive (red) end.
          background: invert
            ? "linear-gradient(90deg, var(--up), var(--gold) 50%, var(--down))"
            : "linear-gradient(90deg, var(--down), var(--gold) 50%, var(--up))",
        }}
      />
      <div
        className="absolute inset-y-0 w-[2px] bg-[var(--text)]"
        style={{ left: `calc(${Math.min(100, Math.max(0, percentile))}% - 1px)` }}
      />
    </div>
  );
}

// Position labels are pure position words （偏低/偏高 say where the value
// sits, nothing more). The chip COLOUR follows the lens, chosen per
// indicator by the server's `invert` flag:
//   · position lens (asset PRICE percentiles): the chip uses the same
//     green/red scale as the bar — 偏低 = green side, 偏高 = red side —
//     as a POSITION scale only: a price percentile says where the price
//     sits (trend / drawdown), not whether it is cheap or expensive.
//     Valuation needs the right scale: PE percentile for stocks,
//     yield / spread percentile for bonds. (The old gray chip for
//     price percentiles is retired — user directive 2026-11-20.)
//   · bond-valuation lens (invert = true: term yields & spreads): the
//     colours reverse — low percentile = red, because a yield at a
//     historic low means the corresponding bond is at a historic HIGH
//     price (expensive); high percentile = green (the bond is cheap).
//   · plain lens (invert = false): funding / policy rates read as the
//     cost of money itself (low rate = money cheap).
// Extremes are the stronger shade.
function LabelChip({ label, invert = false }: { label: string; invert?: boolean }) {
  const lowCls = label.includes("极端")
    ? "bg-[var(--down)]/20 font-semibold text-[var(--down)]"
    : "bg-[var(--down)]/10 text-[var(--down)]";
  const highCls = label.includes("极端")
    ? "bg-[var(--up)]/20 font-semibold text-[var(--up)]"
    : "bg-[var(--up)]/10 text-[var(--up)]";
  const cls = label.includes("偏低")
    ? invert
      ? highCls
      : lowCls
    : label.includes("偏高")
      ? invert
        ? lowCls
        : highCls
      : "bg-[var(--border)]/60 text-[var(--dim)]";
  // whitespace-nowrap + shrink-0 (M-P1-5a): on a ~375px phone the flex
  // row this chip sits in runs out of room and, without these, the label
  // wraps one character per line （中性 → 中 / 性）. The chip now keeps
  // its full width and the row wraps around it instead.
  return <span className={`inline-block shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

// Valuation gloss for text-only percentile readouts (the yield table has
// no chip to colour): for inverted stats it spells out what the position
// means for the corresponding bond, so "低" is never left to be misread
// as "cheap". Returns "" for the price lens and for the middle band.
function valuationGloss(stats: Stats): string {
  if (!stats.invert) return "";
  if (stats.percentile <= 25) return " · 对应债券偏贵";
  if (stats.percentile >= 75) return " · 对应债券偏便宜";
  return "";
}

function StatsGrid({ stats, unit, decimals, charted = false, positionOnly = false }: { stats: Stats; unit: string; decimals: number; charted?: boolean; positionOnly?: boolean }) {
  const winLabel = useWindowLabel();
  const cell = (label: string, value: string, sub?: string) => (
    <div className="min-w-0">
      <div className="text-[11px] text-[var(--dim)]">{label}</div>
      <div className="truncate text-sm font-medium text-[var(--text)]">{value}</div>
      {sub ? <div className="truncate text-[11px] text-[var(--dim)]">{sub}</div> : null}
    </div>
  );
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        {/* U-P2-1: 「与图表同窗口」 only when the card actually renders a
            chart above this grid (IndicatorCard shows its MiniChart only
            when it has ≥2 points); a chartless card says plainly that
            the percentile follows the current statistics window.
            positionOnly (ALL instrument price percentiles since the
            V-1 caliber switch; first applied to watchlist cards in
            V-2-2a): this percentile is a PRICE percentile — it only
            marks position (trend / drawdown), so the header says so;
            the chip / bar use the coloured position scale (green =
            position low, red = position high), never a cheap /
            expensive reading. */}
        <span className="text-xs text-[var(--dim)]">{positionOnly ? "价格历史百分位" : "历史百分位"}（{winLabel} · {stats.count} 个交易日{charted ? "，与图表同窗口" : "，百分位按当前统计窗口计算"}）{positionOnly ? " · 只标位置" : ""}</span>
        <span className="text-sm font-semibold text-[var(--text)]">{stats.percentile}</span>
        <LabelChip label={stats.label} invert={stats.invert} />
      </div>
      <PctBar percentile={stats.percentile} invert={stats.invert} />
      <div className="mt-2 grid grid-cols-3 gap-2">
        {cell("历史中位数", `${fmt(stats.median, decimals)}${unit}`)}
        {cell("历史最低", `${fmt(stats.min, decimals)}${unit}`, stats.minDate)}
        {cell("历史最高", `${fmt(stats.max, decimals)}${unit}`, stats.maxDate)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts: hand-rolled SVG line charts (Recharts removed, 2026-11-20).
//
// Every instrument / indicator card carries one of these, so a module
// page mounts dozens of charts at once. Recharts' per-chart machinery
// (responsive measurement, tooltip/scale contexts) plus its bundle
// weight were a large share of both entry cost and module-page render
// time. This component draws the same picture — dashed horizontal
// grid, y tick labels, sparse x date labels, monotone-smoothed line,
// pointer tooltip — as one plain <svg> sized in CSS pixels, which
// renders in well under a millisecond per chart.
// ---------------------------------------------------------------------------

function trimNum(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-12) return [min, max];
  const step0 = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.round(v * 1e10) / 1e10);
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Fritsch–Carlson monotone cubic path through the given points —
 *  the same smoothing family Recharts' type="monotone" draws. */
function monotonePath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  const first = pts[0] as { x: number; y: number };
  if (pts.length < 3) {
    return pts.map((p, i) => `${i === 0 ? "M" : "L"}${r2(p.x)},${r2(p.y)}`).join(" ");
  }
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as { x: number; y: number };
    const b = pts[i + 1] as { x: number; y: number };
    dx.push(b.x - a.x);
    m.push((b.y - a.y) / (b.x - a.x || 1));
  }
  const t: number[] = new Array<number>(n).fill(0);
  t[0] = m[0] ?? 0;
  t[n - 1] = m[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) t[i] = ((m[i - 1] ?? 0) + (m[i] ?? 0)) / 2;
  for (let i = 0; i < n - 1; i++) {
    const mi = m[i] ?? 0;
    if (mi === 0) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = (t[i] ?? 0) / mi;
      const b = (t[i + 1] ?? 0) / mi;
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        t[i] = tau * a * mi;
        t[i + 1] = tau * b * mi;
      }
    }
  }
  let d = `M${r2(first.x)},${r2(first.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as { x: number; y: number };
    const b = pts[i + 1] as { x: number; y: number };
    const h = dx[i] ?? 0;
    d += ` C${r2(a.x + h / 3)},${r2(a.y + ((t[i] ?? 0) * h) / 3)} ${r2(b.x - h / 3)},${r2(b.y - ((t[i + 1] ?? 0) * h) / 3)} ${r2(b.x)},${r2(b.y)}`;
  }
  return d;
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width ?? 0;
      if (cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

type SvgSeries = { name?: string; color: string; dot?: boolean; values: (number | null)[] };

function SvgLineChart({
  labels,
  series,
  height,
  yFormat,
  valueFormat,
  hLines,
  domain,
  bands,
}: {
  labels: string[];
  series: SvgSeries[];
  height: number;
  yFormat?: (v: number) => string;
  valueFormat?: (v: number) => string;
  /** Fixed horizontal reference lines (value + right-end label), drawn
   *  dashed above the grid. Used by the Fear & Greed history chart for
   *  the 25 / 75 extreme lines. */
  hLines?: { v: number; label: string; color?: string }[];
  /** Fixed y domain [lo, hi]; default is the data's own range. */
  domain?: [number, number];
  /** Background zone bands over the y domain, drawn behind the grid
   *  (used by the 抄底逃顶 history chart for its ≤−50 / ≥+30 zones). */
  bands?: { from: number; to: number; color: string; opacity?: number }[];
}) {
  const { ref, w } = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v != null && Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (n < 2 || !Number.isFinite(lo)) {
    return <div ref={ref} style={{ height }} />;
  }
  if (domain) {
    lo = domain[0];
    hi = domain[1];
  }
  if (hi - lo < 1e-12) {
    lo -= 1;
    hi += 1;
  }
  const fmtY = yFormat ?? trimNum;
  const fmtV = valueFormat ?? trimNum;
  const L = 52;
  const R = 6;
  const T = 4;
  const B = 16;
  const plotW = Math.max(10, w - L - R);
  const plotH = Math.max(10, height - T - B);
  const xAt = (i: number) => L + (plotW * i) / (n - 1);
  const yAt = (v: number) => T + plotH * (1 - (v - lo) / (hi - lo));
  const ticks = niceTicks(lo, hi);
  const labelStep = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 80))));
  const xIdx: number[] = [];
  for (let i = 0; i < n; i += labelStep) xIdx.push(i);
  if (xIdx[xIdx.length - 1] !== n - 1) xIdx.push(n - 1);
  const onPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(((px - L) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hoverRows =
    hover != null
      ? series
          .map((s) => ({ s, v: s.values[hover] ?? null }))
          .filter((r): r is { s: SvgSeries; v: number } => r.v != null)
      : [];
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {w > 0 ? (
        <>
          <svg
            width={w}
            height={height}
            className="block"
            style={{ touchAction: "pan-y" }}
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => setHover(null)}
          >
            {(bands ?? []).map((b, bi) => {
              const yTop = yAt(Math.min(hi, Math.max(b.from, b.to)));
              const yBot = yAt(Math.max(lo, Math.min(b.from, b.to)));
              return (
                <rect
                  key={bi}
                  x={L}
                  y={yTop}
                  width={plotW}
                  height={Math.max(0, yBot - yTop)}
                  fill={b.color}
                  opacity={b.opacity ?? 0.1}
                />
              );
            })}
            {ticks.map((tv) => (
              <g key={tv}>
                <line x1={L} x2={L + plotW} y1={yAt(tv)} y2={yAt(tv)} stroke="var(--border)" strokeDasharray="3 3" strokeWidth={1} />
                <text x={L - 6} y={yAt(tv) + 3} textAnchor="end" fontSize={10} fill="var(--dim)">
                  {fmtY(tv)}
                </text>
              </g>
            ))}
            {(hLines ?? [])
              .filter((hl) => hl.v > lo && hl.v < hi)
              .map((hl) => (
                <g key={hl.v}>
                  <line x1={L} x2={L + plotW} y1={yAt(hl.v)} y2={yAt(hl.v)} stroke={hl.color ?? "var(--gold)"} strokeDasharray="6 3" strokeWidth={1.2} strokeOpacity={0.85} />
                  <text x={L + plotW - 2} y={yAt(hl.v) - 4} textAnchor="end" fontSize={10} fill={hl.color ?? "var(--gold)"}>
                    {hl.label}
                  </text>
                </g>
              ))}
            {xIdx.map((i) => (
              <text
                key={i}
                x={xAt(i)}
                y={height - 3}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                fontSize={10}
                fill="var(--dim)"
              >
                {labels[i]}
              </text>
            ))}
            {series.map((s, si) => {
              const pts: { x: number; y: number }[] = [];
              s.values.forEach((v, i) => {
                if (v != null && Number.isFinite(v)) pts.push({ x: xAt(i), y: yAt(v) });
              });
              return (
                <g key={si}>
                  <path d={monotonePath(pts)} fill="none" stroke={s.color} strokeWidth={1.6} />
                  {s.dot
                    ? pts.map((p, pi) => <circle key={pi} cx={p.x} cy={p.y} r={2.5} fill={s.color} />)
                    : null}
                </g>
              );
            })}
            {hover != null ? (
              <g>
                <line x1={xAt(hover)} x2={xAt(hover)} y1={T} y2={T + plotH} stroke="var(--dim)" strokeWidth={1} strokeOpacity={0.5} />
                {hoverRows.map(({ s, v }, ri) => (
                  <circle key={ri} cx={xAt(hover)} cy={yAt(v)} r={3} fill={s.color} stroke="var(--surface)" strokeWidth={1.5} />
                ))}
              </g>
            ) : null}
          </svg>
          {hover != null && hoverRows.length > 0 ? (
            <div
              className="pointer-events-none absolute top-1 z-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs shadow-[var(--shadow-card)]"
              style={{ left: Math.max(0, Math.min(w - 150, xAt(hover) + 10)) }}
            >
              <div className="text-[var(--dim)]">{labels[hover]}</div>
              {hoverRows.map(({ s, v }, ri) => (
                <div key={ri} className="whitespace-nowrap text-[var(--text)]">
                  {s.name ? (
                    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  ) : null}
                  {s.name ? `${s.name} ` : ""}
                  {fmtV(v)}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function MiniChart({ data, color }: { data: { d: string; v: number }[]; color: string }) {
  if (data.length < 2) return null;
  return (
    <div className="h-[120px] w-full" aria-hidden>
      <SvgLineChart labels={data.map((p) => p.d)} series={[{ color, values: data.map((p) => p.v) }]} height={120} />
    </div>
  );
}

/** 收益率曲线形状（中国 vs 美国）：分类轴（期限）双线图，与 MiniChart
 *  同一套 SVG 渲染；美国缺失的期限断开（只连已有期限的点）。 */
function CurveChart({ curve }: { curve: { tenor: string; cn: number; us: number | null }[] }) {
  return (
    <div className="h-[160px] w-full" aria-hidden>
      <SvgLineChart
        labels={curve.map((c) => c.tenor)}
        series={[
          { name: "中国", color: "var(--up)", dot: true, values: curve.map((c) => c.cn) },
          { name: "美国", color: "var(--gold)", dot: true, values: curve.map((c) => c.us) },
        ]}
        height={160}
        yFormat={(v) => `${trimNum(v)}%`}
        valueFormat={(v) => `${fmt(v, 2)}%`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function IndicatorCard({ ind, goMethod }: { ind: Indicator; goMethod: (id: string) => void }) {
  const method = METHOD_BY_ID.get(ind.method);
  const winLabel = useWindowLabel();
  const chart = ind.chart ?? [];
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium text-[var(--text)]">{ind.name}</div>
        <div className="text-xs text-[var(--dim)]">{ind.date}</div>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <span className="font-serif-sc text-2xl font-bold text-[var(--text)]">
          {fmt(ind.value, ind.decimals)}
          <span className="ml-0.5 text-sm font-normal text-[var(--dim)]">{ind.unit}</span>
        </span>
        {ind.change != null && (
          <span className={`text-xs ${moveColor(ind.change)}`}>
            较昨日 {signed(ind.change, ind.decimals)}
            {ind.unit}
          </span>
        )}
        <span className="rounded-full bg-[var(--border)]/60 px-2 py-0.5 text-xs text-[var(--text)]">{ind.state}</span>
      </div>
      {chart.length >= 2 ? (
        <div className="mt-3">
          <MiniChart data={chart} color="var(--accent)" />
          <div className="mt-1 text-[11px] text-[var(--dim)]">
            {winLabel}走势 · {chart[0]?.d} 至 {chart[chart.length - 1]?.d} · {chart.length} 个数据点（与下方百分位同窗口）
          </div>
        </div>
      ) : null}
      {ind.stats ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <StatsGrid stats={ind.stats} unit={ind.unit} decimals={ind.decimals} charted={chart.length >= 2} />
        </div>
      ) : null}
      {method ? (
        <button type="button" onClick={() => goMethod(method.id)} className="mt-1 py-1 text-left text-xs text-[var(--accent)]">
          方法讲解：{method.name} →
        </button>
      ) : null}
    </div>
  );
}

/** 国开债−国债 10Y 利差卡（月末点）：与其它利差卡同一套视觉（大号现值、
 *  彩色百分位渐变条 + 反向口径、历史中位数/最低/最高），但样本是月末点、
 *  百分位按全部月末点算，不跟随日线统计窗口——文案按月度口径如实写明。 */
function CdbGovSpreadCard({ block, goMethod }: { block: NonNullable<Dashboard["cdbGov"]>; goMethod: (id: string) => void }) {
  const stats = block.stats;
  const chart = block.chart;
  const change = block.prevBp != null ? Math.round((block.valueBp - block.prevBp) * 10) / 10 : null;
  const cell = (label: string, value: string, sub?: string) => (
    <div className="min-w-0">
      <div className="text-[11px] text-[var(--dim)]">{label}</div>
      <div className="truncate text-sm font-medium text-[var(--text)]">{value}</div>
      {sub ? <div className="truncate text-[11px] text-[var(--dim)]">{sub}</div> : null}
    </div>
  );
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium text-[var(--text)]">国开债 − 国债 10Y 利差（月末）</div>
        <div className="text-xs text-[var(--dim)]">{block.date}</div>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <span className="font-serif-sc text-2xl font-bold text-[var(--text)]">
          {fmt(block.valueBp, 1)}
          <span className="ml-0.5 text-sm font-normal text-[var(--dim)]">bp</span>
        </span>
        {change != null ? (
          <span className={`text-xs ${moveColor(change)}`}>较上月 {signed(change, 1)}bp</span>
        ) : null}
        <span className="rounded-full bg-[var(--border)]/60 px-2 py-0.5 text-xs text-[var(--text)]">中债国开债 10Y − 中债国债 10Y</span>
      </div>
      {chart.length >= 2 ? (
        <div className="mt-3">
          <MiniChart data={chart} color="var(--accent)" />
          <div className="mt-1 text-[11px] text-[var(--dim)]">
            月度利差走势（月末值）· {chart[0]?.d} 至 {chart[chart.length - 1]?.d} · {chart.length} 个月末点（与下方百分位同一样本）
          </div>
        </div>
      ) : null}
      {stats ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--dim)]">历史百分位（月末点全样本 · {stats.count} 个月）</span>
            <span className="text-sm font-semibold text-[var(--text)]">{stats.percentile}</span>
            <LabelChip label={stats.label} invert={stats.invert} />
          </div>
          <PctBar percentile={stats.percentile} invert={stats.invert} />
          <div className="mt-2 grid grid-cols-3 gap-2">
            {cell("历史中位数", `${fmt(stats.median, 1)}bp`)}
            {cell("历史最低", `${fmt(stats.min, 1)}bp`, stats.minDate)}
            {cell("历史最高", `${fmt(stats.max, 1)}bp`, stats.maxDate)}
          </div>
        </div>
      ) : null}
      <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
        数据来源：中债收益率曲线（中央国债登记结算公司，yield.chinabond.com.cn）——中债国开债收益率曲线与中债国债收益率曲线的 10 年期，取每月最后一个发布日（当月为最新发布日）；随手动刷新（收益率分块）更新。
      </p>
      <button type="button" onClick={() => goMethod("policybond")} className="mt-1 py-1 text-left text-xs text-[var(--accent)]">
        方法讲解：国开债与政策性金融债 →
      </button>
    </div>
  );
}

/** Daily net-buy bars for the margin section: red = net buy (leverage
 *  flowing in), green = net sell, matching the site's 红涨绿跌 colour
 *  semantics. Plain SVG sized in CSS pixels, like SvgLineChart. */
function NetBars({ data, height = 110 }: { data: { d: string; v: number }[]; height?: number }) {
  const { ref, w } = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const maxAbs = Math.max(1, ...data.map((p) => Math.abs(p.v)));
  const L = 52;
  const R = 6;
  const T = 4;
  const B = 16;
  const plotW = Math.max(10, w - L - R);
  const plotH = Math.max(10, height - T - B);
  const midY = T + plotH / 2;
  const bw = plotW / Math.max(1, n);
  const onPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.floor((px - L) / bw);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hoverPt = hover != null ? data[hover] : undefined;
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {w > 0 && n >= 2 ? (
        <>
          <svg
            width={w}
            height={height}
            className="block"
            style={{ touchAction: "pan-y" }}
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => setHover(null)}
          >
            <text x={L - 6} y={T + 8} textAnchor="end" fontSize={10} fill="var(--dim)">
              {trimNum(maxAbs)}
            </text>
            <text x={L - 6} y={midY + 3} textAnchor="end" fontSize={10} fill="var(--dim)">
              0
            </text>
            <text x={L - 6} y={T + plotH} textAnchor="end" fontSize={10} fill="var(--dim)">
              {trimNum(-maxAbs)}
            </text>
            <line x1={L} x2={L + plotW} y1={midY} y2={midY} stroke="var(--border)" strokeWidth={1} />
            {data.map((p, i) => {
              const h = (Math.abs(p.v) / maxAbs) * (plotH / 2);
              return (
                <rect
                  key={p.d}
                  x={L + i * bw + 0.5}
                  y={p.v >= 0 ? midY - h : midY}
                  width={Math.max(1, bw - 1)}
                  height={Math.max(0.5, h)}
                  fill={p.v >= 0 ? "var(--up)" : "var(--down)"}
                  opacity={hover === i ? 1 : 0.75}
                />
              );
            })}
            <text x={L} y={height - 3} fontSize={10} fill="var(--dim)">
              {data[0]?.d}
            </text>
            <text x={L + plotW} y={height - 3} textAnchor="end" fontSize={10} fill="var(--dim)">
              {data[n - 1]?.d}
            </text>
          </svg>
          {hoverPt ? (
            <div
              className="pointer-events-none absolute top-1 z-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs shadow-[var(--shadow-card)]"
              style={{ left: Math.max(0, Math.min(w - 170, L + (hover ?? 0) * bw + 10)) }}
            >
              <div className="text-[var(--dim)]">{hoverPt.d}</div>
              <div className="whitespace-nowrap text-[var(--text)]">
                融资净买入{" "}
                <span className={moveColor(hoverPt.v)}>
                  {hoverPt.v >= 0 ? "+" : ""}
                  {fmt(hoverPt.v, 1)} 亿元
                </span>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** A股页「融资余额」小节 (v108): SH+SZ margin balances from the
 *  exchange disclosures (SSE official; SZSE via the labelled Eastmoney
 *  mirror while the exchange site is unreachable). Numbers render
 *  immediately from the dashboard payload; the two charts wait until
 *  the section scrolls near the viewport, like every other module. */
function MarginCnSection({ block, stages, goMethod }: { block: NonNullable<Dashboard["marginCn"]>; stages: Dashboard["stages"]; goMethod: (id: string) => void }) {
  const winLabel = useWindowLabel();
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const stats = block.stats;
  const full = block.statsFull;
  const cell = (label: string, value: string, sub?: string, cls = "text-[var(--text)]") => (
    <div className="min-w-0">
      <div className="text-[11px] text-[var(--dim)]">{label}</div>
      <div className={`truncate text-sm font-medium ${cls}`}>{value}</div>
      {sub ? <div className="truncate text-[11px] text-[var(--dim)]">{sub}</div> : null}
    </div>
  );
  return (
    <div className="mt-6">
      <h3 className="text-base font-bold text-[var(--text)]">融资余额 · 沪深两市的杠杆存量与流向</h3>
      <div className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-medium text-[var(--text)]">融资余额合计（沪 + 深）</div>
          <div className="text-xs text-[var(--dim)]">{block.date}</div>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-2">
          <span className="font-serif-sc text-2xl font-bold text-[var(--text)]">
            {fmt(block.totalYi, 0)}
            <span className="ml-0.5 text-sm font-normal text-[var(--dim)]">亿元</span>
          </span>
          <span className={`text-xs ${moveColor(block.netYi)}`}>
            当日融资净买入 {block.netYi >= 0 ? "+" : ""}
            {fmt(block.netYi, 1)} 亿元
          </span>
          <span className="rounded-full bg-[var(--border)]/60 px-2 py-0.5 text-xs text-[var(--text)]">
            距已存历史高点 {block.distHighPct.toFixed(1)}%（高点 {fmt(block.highYi, 0)} 亿元 · {block.highDate}）
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {cell("沪市融资余额", `${fmt(block.shYi, 0)} 亿元`, "上交所官网")}
          {cell("深市融资余额", `${fmt(block.szYi, 0)} 亿元`, block.szSource === "szse" ? "深交所官网" : "深交所披露 · 东财镜像")}
          {cell("融资买入额（当日）", `${fmt(block.buyYi, 0)} 亿元`, block.turnoverSharePct != null ? `占两市成交额 ${block.turnoverSharePct.toFixed(1)}%` : undefined)}
          {cell("融资偿还额（当日）", `${fmt(block.repayYi, 0)} 亿元`)}
          {cell("融券余额", `${fmt(block.rqyeYi, 1)} 亿元`, "借股做空未还的市值")}
          {cell("融券余量", `${fmt(block.rqylYiGu, 2)} 亿股`)}
          {cell("5 日变化", block.chg5Pct != null ? `${block.chg5Pct >= 0 ? "+" : ""}${block.chg5Pct.toFixed(2)}%` : "—", "融资余额 · 近 5 个交易日", block.chg5Pct != null ? moveColor(block.chg5Pct) : "text-[var(--text)]")}
          {cell("20 日变化", block.chg20Pct != null ? `${block.chg20Pct >= 0 ? "+" : ""}${block.chg20Pct.toFixed(2)}%` : "—", "融资余额 · 近 20 个交易日", block.chg20Pct != null ? moveColor(block.chg20Pct) : "text-[var(--text)]")}
        </div>
        <div ref={ref}>
          {near && block.chart.length >= 2 ? (
            <div className="mt-3">
              <SvgLineChart
                labels={block.chart.map((p) => p.d)}
                series={[{ name: "融资余额", color: "var(--accent)", values: block.chart.map((p) => p.v) }]}
                height={170}
                yFormat={(v) => trimNum(v)}
                valueFormat={(v) => `${fmt(v, 0)} 亿元`}
              />
              <div className="mt-1 text-[11px] text-[var(--dim)]">
                融资余额走势（{winLabel}）· {block.chart[0]?.d} 至 {block.chart[block.chart.length - 1]?.d} · {block.chart.length} 个交易日（与下方窗口百分位同窗口；全样本 {block.points} 个交易日）
              </div>
            </div>
          ) : (
            <div className="mt-3" style={{ height: 170 }} aria-hidden />
          )}
          {near && block.netChart.length >= 2 ? (
            <div className="mt-3">
              <NetBars data={block.netChart} />
              <div className="mt-1 text-[11px] text-[var(--dim)]">
                融资净买入（买入 − 偿还，{winLabel}）
              </div>
            </div>
          ) : null}
        </div>
        {full ? (
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--dim)]">近 5 年百分位（{full.count} 个交易日 · 与决策信号 A1 同口径）</span>
              <span className="text-sm font-semibold text-[var(--text)]">{full.percentile}</span>
              <LabelChip label={full.label} invert={full.invert} />
            </div>
            <PctBar percentile={full.percentile} invert={full.invert} />
            <div className="mt-2 grid grid-cols-3 gap-2">
              {cell("近 5 年中位数", `${fmt(full.median, 0)} 亿元`)}
              {cell("近 5 年最低", `${fmt(full.min, 0)} 亿元`, full.minDate)}
              {cell("近 5 年最高", `${fmt(full.max, 0)} 亿元`, full.maxDate)}
            </div>
          </div>
        ) : null}
        {stats ? (
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <StatsGrid stats={stats} unit="亿元" decimals={0} charted={block.chart.length >= 2} />
          </div>
        ) : null}
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
          数据来源：沪市——上交所官网融资融券汇总（queryMargin）；深市——
          {block.szSource === "szse"
            ? "深交所官网披露"
            : "深交所披露，经东方财富数据中心镜像转引（深交所官网接口本机不可达，数值已与深交所披露逐项交叉核对一致）"}
          。日度 · 已存 {block.points} 个交易日 · 本模块更新于 {stageTimeText(stages, "margin")}，随手动刷新（融资余额与保证金负债分块）更新。
        </p>
        <button type="button" onClick={() => goMethod("leverage")} className="mt-1 py-1 text-left text-xs text-[var(--accent)]">
          方法讲解：融资余额与保证金负债 →
        </button>
      </div>
    </div>
  );
}

/** 美股页「保证金负债」小节 (v108): FINRA monthly margin debt. The
 *  comparison chart normalises both lines to 100 at the window start —
 *  two raw series ($ millions vs index points) share no axis, and the
 *  caption says so; no ratio is computed or implied. */
function MarginUsSection({ block, stages, goMethod }: { block: NonNullable<Dashboard["marginUs"]>; stages: Dashboard["stages"]; goMethod: (id: string) => void }) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const stats = block.stats;
  const wan = (m: number) => `${fmt(m / 1e6, 3)} 万亿美元`;
  const cell = (label: string, value: string, sub?: string, cls = "text-[var(--text)]") => (
    <div className="min-w-0">
      <div className="text-[11px] text-[var(--dim)]">{label}</div>
      <div className={`truncate text-sm font-medium ${cls}`}>{value}</div>
      {sub ? <div className="truncate text-[11px] text-[var(--dim)]">{sub}</div> : null}
    </div>
  );
  const norm = (vals: (number | null)[]): (number | null)[] => {
    const first = vals.find((v) => v != null && v > 0);
    if (!first) return vals.map(() => null);
    return vals.map((v) => (v != null && v > 0 ? Math.round((v / first) * 10000) / 100 : null));
  };
  const debtNorm = norm(block.chart.map((p) => p.debt));
  const spxNorm = norm(block.chart.map((p) => p.spx));
  return (
    <div className="mt-6">
      <h3 className="font-serif-sc text-lg font-bold text-[var(--text)]">保证金负债 · 美股的杠杆存量（FINRA 月度）</h3>
      {!block.fullHistory ? (
        <p className="mt-2 rounded-[var(--radius)] border border-[var(--gold)]/50 bg-[var(--gold)]/10 p-3 text-sm leading-relaxed text-[var(--text)]">全历史待接入：当前仅最近 {block.points} 个月，百分位按此窗口计算（非全历史）。</p>
      ) : null}
      <div className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-medium text-[var(--text)]">保证金负债（Debit Balances）</div>
          <div className="text-xs text-[var(--dim)]">{block.month} · 月度</div>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-2">
          <span className="font-serif-sc text-2xl font-bold text-[var(--text)]">{wan(block.debtM)}</span>
          <span className="text-xs text-[var(--dim)]">{fmt(block.debtM, 0)} 百万美元（FINRA 原口径）</span>
          {block.yoyPct != null ? (
            <span className={`text-xs ${moveColor(block.yoyPct)}`}>
              同比 {block.yoyPct >= 0 ? "+" : ""}
              {block.yoyPct.toFixed(1)}%
            </span>
          ) : null}
          <span className="rounded-full bg-[var(--border)]/60 px-2 py-0.5 text-xs text-[var(--text)]">
            距历史高点 {block.distHighPct.toFixed(1)}%（高点 {wan(block.highM)} · {block.highMonth}）
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {cell("自由信用余额 · 现金账户", block.cashM != null ? wan(block.cashM) : "—", "客户没借钱账户里闲置的现金")}
          {cell("自由信用余额 · 保证金账户", block.marginCreditM != null ? wan(block.marginCreditM) : "—", "保证金账户里未动用的现金")}
          {cell("历史最高", wan(block.highM), block.highMonth)}
        </div>
        <div ref={ref}>
          {near && block.chart.length >= 2 ? (
            <div className="mt-3">
              <SvgLineChart
                labels={block.chart.map((p) => p.d.slice(0, 7))}
                series={[
                  { name: "保证金负债", color: "var(--accent)", values: debtNorm },
                  { name: "标普 500", color: "var(--gold)", values: spxNorm },
                ]}
                height={180}
                yFormat={(v) => trimNum(v)}
                valueFormat={(v) => `${fmt(v, 1)}（归一化）`}
              />
              <div className="mt-1 text-[11px] text-[var(--dim)]">
                保证金负债 vs 标普 500（月度，归一化为 100）· {block.chart[0]?.d.slice(0, 7)} 至 {block.month} · {block.chart.length} 个月
              </div>
            </div>
          ) : (
            <div className="mt-3" style={{ height: 180 }} aria-hidden />
          )}
        </div>
        {stats ? (
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--dim)]">
                {block.seedStats ? `百分位（仅最近 ${stats.count} 个月窗口，非全历史）` : `全历史百分位（${stats.count} 个月 · ${block.firstMonth} 至今）`}
              </span>
              <span className="text-sm font-semibold text-[var(--text)]">{stats.percentile}</span>
              <LabelChip label={stats.label} invert={stats.invert} />
            </div>
            <PctBar percentile={stats.percentile} invert={stats.invert} />
            <div className="mt-2 grid grid-cols-3 gap-2">
              {cell("历史中位数", wan(stats.median))}
              {cell("历史最低", wan(stats.min), stats.minDate.slice(0, 7))}
              {cell("历史最高", wan(stats.max), stats.maxDate.slice(0, 7))}
            </div>
          </div>
        ) : null}
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
          数据来源：FINRA Margin Statistics（finra.org 官方月度统计{block.fullHistory ? "，xlsx 全历史" : "，官网页面近月值"})。月度 · 滞后约一个月 · 已存 {block.points} 个月 · 本模块更新于 {stageTimeText(stages, "margin")}，随手动刷新（融资余额与保证金负债分块）更新。
        </p>
        <button type="button" onClick={() => goMethod("leverage")} className="mt-1 py-1 text-left text-xs text-[var(--accent)]">
          方法讲解：融资余额与保证金负债 →
        </button>
      </div>
    </div>
  );
}

/** CNN Fear & Greed rating bands (CNN's published scale, verified
 *  against the endpoint's own per-point ratings): ≤25 extreme fear,
 *  ≤45 fear, ≤55 neutral, ≤75 greed, above extreme greed. Colours run
 *  red → orange → grey → green like CNN's gauge; they are sentiment
 *  colours, NOT the page's up/down red/green. */
const FG_BANDS: { max: number; label: string; color: string; onColor: string }[] = [
  { max: 25, label: "极度恐惧", color: "#b03a2e", onColor: "#ffffff" },
  { max: 45, label: "恐惧", color: "#e8a15c", onColor: "#4a2e12" },
  { max: 55, label: "中性", color: "#b8b2a7", onColor: "#2e2a24" },
  { max: 75, label: "贪婪", color: "#7fb069", onColor: "#14301c" },
  { max: 100, label: "极度贪婪", color: "#1e7d4f", onColor: "#ffffff" },
];
function fgBand(score: number): (typeof FG_BANDS)[number] {
  return FG_BANDS.find((b) => score <= b.max) ?? FG_BANDS[FG_BANDS.length - 1]!;
}

/** The 7 CNN components: display name + one plain-language line on
 *  what each one measures (CNN's own methodology, plainly stated). */
const FG_COMPONENT_META: Record<string, { name: string }> = {
  market_momentum_sp500: {
    name: "市场动量",
  },
  stock_price_strength: {
    name: "股价强度",
  },
  stock_price_breadth: {
    name: "股价广度",
  },
  put_call_options: {
    name: "看跌/看涨期权比",
  },
  market_volatility_vix: {
    name: "市场波动率（VIX）",
  },
  junk_bond_demand: {
    name: "垃圾债需求",
  },
  safe_haven_demand: {
    name: "避险需求",
  },
};

/** Semicircular five-band gauge in CNN's style: coloured arcs for the
 *  five rating bands, tick labels at 0/25/50/75/100, a needle at the
 *  current score and the rounded score under the hub. Pure SVG. */
function FearGreedGauge({ score, labels = true }: { score: number; labels?: boolean }) {
  const cx = 100;
  const cy = 100;
  const rOut = 94;
  const rIn = 68;
  const pt = (r: number, v: number): [number, number] => {
    const th = Math.PI * (1 - v / 100);
    return [cx + r * Math.cos(th), cy - r * Math.sin(th)];
  };
  const seg = (a: number, b: number): string => {
    const [x1, y1] = pt(rOut, a);
    const [x2, y2] = pt(rOut, b);
    const [x3, y3] = pt(rIn, b);
    const [x4, y4] = pt(rIn, a);
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rOut} ${rOut} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${rIn} ${rIn} 0 0 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
  };
  const bounds = [0, 25, 45, 55, 75, 100];
  const [nx, ny] = pt(84, Math.max(0, Math.min(100, score)));
  const band = fgBand(score);
  return (
    <svg viewBox="0 0 200 126" className="block w-full" role="img" aria-label={`恐惧与贪婪指数 ${score.toFixed(1)}，${band.label}`}>
      {FG_BANDS.map((b, i) => {
        const a = bounds[i] ?? 0;
        const z = bounds[i + 1] ?? 100;
        const mid = (a + z) / 2;
        const [tx, ty] = pt((rOut + rIn) / 2, mid);
        const rot = 90 - (180 - mid * 1.8);
        return (
          <g key={b.label}>
            <path d={seg(a + 0.7, z - 0.7)} fill={b.color} />
            {labels ? (
              <text x={tx} y={ty} textAnchor="middle" dominantBaseline="central" fontSize={10.5} fontWeight={600} fill={b.onColor} transform={`rotate(${rot.toFixed(1)} ${tx.toFixed(2)} ${ty.toFixed(2)})`}>
                {b.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {labels
        ? [0, 25, 50, 75, 100].map((v) => {
            const [tx, ty] = pt(rIn - 11, v);
            return (
              <text key={v} x={tx} y={ty + 3} textAnchor="middle" fontSize={9} fill="var(--dim)">
                {v}
              </text>
            );
          })
        : null}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--text)" strokeWidth={3} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={5} fill="var(--text)" />
      <text x={cx} y={121} textAnchor="middle" fontSize={19} fontWeight={700} fill="var(--text)">
        {Math.round(score)}
      </text>
    </svg>
  );
}

/** 0–100 segmented track for one component score: the five bands as a
 *  background strip, a marker at the score. */
function FgBandTrack({ score }: { score: number }) {
  const widths = [25, 20, 10, 20, 25];
  return (
    <div className="relative mt-1.5 h-1.5 w-full overflow-visible rounded-full" aria-hidden>
      <div className="flex h-full w-full overflow-hidden rounded-full">
        {FG_BANDS.map((b, i) => (
          <div key={b.label} style={{ width: `${widths[i]}%`, background: b.color, opacity: 0.55 }} />
        ))}
      </div>
      <div
        className="absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded bg-[var(--text)]"
        style={{ left: `${Math.max(0, Math.min(100, score))}%` }}
      />
    </div>
  );
}

/** 美股页「恐惧与贪婪指数」小节 (v109): CNN's composite sentiment
 *  gauge — headline score + five-band gauge, the four comparison
 *  prints, the 7 components with plain-language explainers, the
 *  trailing-1-year history chart with the 25/75 extreme lines and a
 *  1-year-window percentile (the endpoint's history spans one year;
 *  it is labelled as such everywhere, never as a 5-year figure). */
function FearGreedSection({ block, stages }: { block: NonNullable<Dashboard["fearGreed"]>; stages: Dashboard["stages"] }) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  const band = fgBand(block.score);
  const stats = block.stats;
  // wrap=true drops the truncate on the value line: the 距极值 value
  // ("距高点 X 分 · 距低点 Y 分") is wider than a phone-width grid cell
  // and was being ellipsis-clipped, hiding the 距低点 figure entirely.
  const cell = (label: string, value: string, sub?: string, wrap = false) => (
    <div className="min-w-0">
      <div className="text-[11px] text-[var(--dim)]">{label}</div>
      <div className={`${wrap ? "" : "truncate "}text-sm font-medium text-[var(--text)]`}>{value}</div>
      {sub ? <div className="truncate text-[11px] text-[var(--dim)]">{sub}</div> : null}
    </div>
  );
  const cmpRow = (label: string, v: number) => {
    const b = fgBand(v);
    return (
      <div className="flex items-center justify-between gap-2 border-b border-dashed border-[var(--border)] py-1.5 last:border-b-0">
        <div className="min-w-0">
          <span className="text-xs text-[var(--dim)]">{label}</span>{" "}
          <span className="text-sm font-medium text-[var(--text)]">{b.label}</span>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-sm font-bold"
          style={{ background: b.color, color: b.onColor }}
        >
          {v.toFixed(1)}
        </span>
      </div>
    );
  };
  return (
    <div className="mt-6">
      <h3 className="font-serif-sc text-lg font-bold text-[var(--text)]">恐惧与贪婪指数 · 市场情绪温度计（CNN）</h3>
      <div className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="mx-auto w-full max-w-[300px] shrink-0 sm:mx-0">
            <FearGreedGauge score={block.score} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-serif-sc text-3xl font-bold text-[var(--text)]">{block.score.toFixed(1)}</span>
              <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: band.color, color: band.onColor }}>
                {band.label}
              </span>
              <span className="text-xs text-[var(--dim)]">更新于 {block.updatedBj}（北京时间，CNN 时间戳）</span>
            </div>
            <div className="mt-2">
              {cmpRow("前收", block.prevClose)}
              {cmpRow("1 周前", block.prevWeek)}
              {cmpRow("1 月前", block.prevMonth)}
              {cmpRow("1 年前", block.prevYear)}
            </div>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <div className="text-sm font-medium text-[var(--text)]">7 个分项（等权合成总分）</div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {block.components.map((c) => {
              const meta = FG_COMPONENT_META[c.key];
              const b = fgBand(c.score);
              return (
                <div key={c.key} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-[var(--text)]">{meta?.name ?? c.key}</span>
                    <span className="shrink-0 text-sm">
                      <span className="font-bold text-[var(--text)]">{c.score.toFixed(1)}</span>{" "}
                      <span className="text-xs" style={{ color: b.color }}>
                        {b.label}
                      </span>
                    </span>
                  </div>
                  <FgBandTrack score={c.score} />
                </div>
              );
            })}
          </div>
        </div>

        <div ref={ref}>
          {near && block.chart.length >= 2 ? (
            <div className="mt-4 border-t border-[var(--border)] pt-3">
              <SvgLineChart
                labels={block.chart.map((p) => p.d)}
                series={[{ name: "恐惧与贪婪指数", color: "var(--accent)", values: block.chart.map((p) => p.v) }]}
                height={180}
                domain={[0, 100]}
                hLines={[
                  { v: 75, label: "75 · 极度贪婪线", color: "#1e7d4f" },
                  { v: 25, label: "25 · 极度恐惧线", color: "#b03a2e" },
                ]}
                yFormat={(v) => trimNum(v)}
                valueFormat={(v) => fmt(v, 1)}
              />
              <div className="mt-1 text-[11px] text-[var(--dim)]">
                历史走势（日度）· {block.chart[0]?.d} 至 {block.chart[block.chart.length - 1]?.d} · 共 {block.points} 个交易日
              </div>
            </div>
          ) : (
            <div className="mt-4 border-t border-[var(--border)] pt-3" style={{ height: 180 }} aria-hidden />
          )}
        </div>

        {stats ? (
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--dim)]">
                近 1 年百分位（{stats.count} 个交易日 · {block.statsFrom} 至今）
              </span>
              <span className="text-sm font-semibold text-[var(--text)]">{stats.percentile}</span>
              <LabelChip label={stats.label} invert={stats.invert} />
            </div>
            <PctBar percentile={stats.percentile} invert={stats.invert} />
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {cell("近 1 年中位数", fmt(stats.median, 1))}
              {cell("近 1 年最低", fmt(stats.min, 1), stats.minDate)}
              {cell("近 1 年最高", fmt(stats.max, 1), stats.maxDate)}
              {cell("距极值", `距高点 ${Math.abs(block.distHigh).toFixed(1)} 分 · 距低点 ${Math.abs(block.distLow).toFixed(1)} 分`, "以分数点计", true)}
            </div>
          </div>
        ) : null}

        <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
          数据来源：CNN Business Fear &amp; Greed Index（production.dataviz.cnn.io 官方数据端点）。指数盘中更新，本卡为 CNN 时间戳 {block.updatedBj}（北京时间）的读数 · 已存 {block.points} 个交易日 · 本模块更新于 {stageTimeText(stages, "feargreed")}，随手动刷新（恐惧与贪婪指数分块）更新。
        </p>
      </div>
    </div>
  );
}

// A-P2-5: the A-share broad-index cards whose headline price is a listed
// ETF's price in 元 (3 decimals), not the index level in 点. They sit in
// the same list as 上证指数 / 深证成指 (real index points), so the price
// carries an explicit "ETF 代理 · 非指数点位" tag to stop a 4.060 元 ETF
// price being misread as index points.
const CN_ETF_PROXY_KEYS = new Set(["csi300", "chinext", "star50", "cs500", "cs1000"]);

// Position words for a PE percentile — same thresholds as the server's
// labelFor. On a PE percentile these words DO carry the valuation
// reading (low PE percentile = cheap relative to the stock's own
// history), which is exactly why the watchlist cards lead with this
// block and demote the price percentile to a coloured position readout
// (position scale only — it marks where the price sits, never cheap /
// expensive).
function pePositionLabel(p: number): string {
  if (p >= 95) return "极端偏高";
  if (p >= 75) return "偏高";
  if (p > 25) return "中性";
  if (p > 5) return "偏低";
  return "极端偏低";
}

// V-2-2a: the watchlist single-stock cards' headline valuation block —
// historical PE percentile from the SAME server pipeline as the cloud
// detail drawer (getWatchlistPe ↔ computePeValuation ↔ getStockDetail),
// so the percentile here and the drawer's 5-year PE percentile agree
// number for number. TTM + forward are shown as a pair （双口径）; when
// the quarter-end sample is under 8 points (or TTM earnings are
// negative) no percentile is shown and nothing is estimated.
function WatchPeBlock({ pe, peStatus }: { pe: WatchPe | null; peStatus: WatchPeStatus }) {
  const hist = pe?.peHist ?? null;
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-medium text-[var(--text)]">估值 · 历史 PE 百分位（主看）</div>
        <div className="text-[11px] text-[var(--dim)]">近 5 年 · 季度末 PE</div>
      </div>
      {peStatus === "loading" ? <p className="mt-2 text-sm text-[var(--dim)]">估值数据拉取中…</p> : null}
      {peStatus === "error" ? (
        <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">估值数据本次拉取失败，PE 百分位暂不显示、不估算；重新打开美股页会重试。</p>
      ) : null}
      {peStatus === "ready" && hist ? (
        <>
          <div className="mb-1.5 mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--dim)]">PE 历史百分位（近 5 年 · {hist.n} 个季末点）</span>
            <span className="text-sm font-semibold text-[var(--text)]">{hist.percentile}</span>
            <LabelChip label={pePositionLabel(hist.percentile)} />
          </div>
          <PctBar percentile={hist.percentile} />
          <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">
            当前 TTM 市盈率 {fmt(hist.current, 1)} 倍，高于近 5 年 {hist.percentile}% 的季末 PE（季末 PE 中位数 {fmt(hist.median, 1)} 倍）
          </p>
          <p className="mt-1 text-sm text-[var(--dim)]">
            双口径现值：TTM 市盈率 {pe?.peTtm != null ? `${fmt(pe.peTtm, 1)} 倍` : "本次未取到"} · 前瞻市盈率（NTM）{" "}
            {pe?.peFwd != null ? `${fmt(pe.peFwd, 1)} 倍` : "本次未取到"}
          </p>
        </>
      ) : null}
      {peStatus === "ready" && !hist ? (
        <>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">
            历史 PE 百分位不显示：季末 PE 样本不足 8 个。
          </p>
          <p className="mt-1 text-sm text-[var(--dim)]">
            双口径现值：TTM 市盈率 {pe?.peTtm != null ? `${fmt(pe.peTtm, 1)} 倍` : "本次未取到"} · 前瞻市盈率（NTM）{" "}
            {pe?.peFwd != null ? `${fmt(pe.peFwd, 1)} 倍` : "本次未取到"}
          </p>
        </>
      ) : null}
    </div>
  );
}

function InstrumentCard({ inst, goMethod, pe, peStatus }: { inst: Instrument; goMethod: (id: string) => void; pe?: WatchPe | null; peStatus?: WatchPeStatus }) {
  const winLabel = useWindowLabel();
  const { days: windowDays } = useContext(WindowCtx);
  const [open, setOpen] = useState(false);
  // Charts are lazy: the dashboard payload carries only numbers and
  // stats (it used to embed every instrument's full chart — ~85% of its
  // bytes). Opening a module fetches just that module's charts, cached
  // per instrument+window; the card's numbers render immediately from
  // the cached dashboard either way.
  // …and viewport-deferred: on a module page with a dozen-plus cards,
  // only cards near the viewport fetch their chart; the rest fetch as
  // the user scrolls toward them. The card's numbers never wait on it.
  const { ref: cardRef, near } = useNearViewport<HTMLElement>();
  const chartQ = useQuery({
    queryKey: ["chart", inst.key, windowDays],
    queryFn: () => api.getInstrumentChart({ key: inst.key, windowDays }),
    enabled: near,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const chart = chartQ.data?.chart ?? [];
  // V-2-2a + V-1 step 3/4: the US watchlist row (asset "uswatch")
  // leads with the PE percentile as its headline valuation. EVERY
  // instrument card now renders its price percentile on the coloured
  // position scale (positionOnly below — position only, never a cheap /
  // expensive reading), and bond ETFs additionally
  // carry a yield / spread percentile valuation block (yieldStats).
  const isWatch = inst.asset === "uswatch";
  const maCell = (label: string, v: number | null) => (
    <div>
      <div className="text-[11px] text-[var(--dim)]">{label}</div>
      <div className={`text-sm font-medium ${v == null ? "text-[var(--dim)]" : inst.price >= v ? "text-[var(--up)]" : "text-[var(--down)]"}`}>
        {v == null ? "—" : fmt(v, inst.decimals)}
      </div>
    </div>
  );
  return (
    <article ref={cardRef} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-serif-sc text-lg font-bold text-[var(--text)]">{inst.name}</h3>
          <div className="text-xs text-[var(--dim)]">{inst.sub}</div>
        </div>
        <div className="text-right">
          <div className="font-serif-sc text-2xl font-bold leading-none text-[var(--text)]">
            {fmt(inst.price, inst.decimals)}
            <span className="ml-1 text-xs font-normal text-[var(--dim)]">{inst.unit}</span>
          </div>
          {CN_ETF_PROXY_KEYS.has(inst.key) ? (
            <div className="mt-1 text-[11px] leading-snug text-[var(--dim)]">ETF 代理 · 非指数点位</div>
          ) : null}
          <div className={`mt-1 text-sm font-medium ${inst.changePct != null ? moveColor(inst.changePct) : "text-[var(--dim)]"}`}>
            {inst.changePct != null ? (
              <>
                {signed(inst.changePct, 2)}% <span className="font-normal text-[var(--dim)]">· {inst.date}</span>
              </>
            ) : (
              <>
                — <span className="font-normal text-[var(--dim)]">· {inst.date}</span>
              </>
            )}
          </div>
          {inst.changeNote ? <div className="mt-0.5 text-[11px] leading-snug text-[var(--gold)]">{inst.changeNote}</div> : null}
          {inst.partial ? (
            <div className="mt-1">
              <span className="inline-block rounded-full bg-[var(--gold)]/15 px-2 py-0.5 text-[11px] font-medium leading-tight text-[var(--gold)]">
                盘中快照，未收盘
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3">
        {chart.length >= 2 ? (
          <MiniChart data={chart} color="var(--accent)" />
        ) : (
          <div className="flex h-[120px] w-full items-center justify-center text-[11px] text-[var(--dim)]" aria-hidden>
            {chartQ.isError ? "走势图读取失败" : "走势图加载中…"}
          </div>
        )}
        <div className="mt-1 flex justify-between text-[11px] text-[var(--dim)]">
          <span>
            {winLabel}走势 · {inst.chartMeta.from} 至 {inst.chartMeta.to} · {inst.chartMeta.count} 个交易日（与下方百分位同窗口）
          </span>
          <span>
            52 周位置 {Math.round(inst.pos52)}%（0 = 年内最低，100 = 年内最高）
          </span>
        </div>
        <div className="mt-1">
          <PctBar percentile={inst.pos52} height="h-1.5" ariaRound1 />
        </div>
      </div>

      {isWatch && inst.key !== "uso" && peStatus ? <WatchPeBlock pe={pe ?? null} peStatus={peStatus} /> : null}
      {isWatch && inst.key === "uso" ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="text-xs font-medium text-[var(--text)]">估值 · 不适用市盈率</div>
        </div>
      ) : null}

      {inst.peCurrent ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="text-xs font-medium text-[var(--text)]">估值 · 当前 TTM PE（无百分位）</div>
          <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">
            当前 TTM PE {fmt(inst.peCurrent.value, 2)} 倍（{inst.key === "ndx" || inst.key === "qqq" ? "纳斯达克100指数" : "恒生指数"}，数据日期 {inst.peCurrent.date}）。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
            来源：{inst.peCurrent.source}
          </p>
        </div>
      ) : null}
      {inst.peAccumulating && !inst.peHist ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <span className="inline-block rounded-full bg-[var(--border)]/60 px-2 py-0.5 text-[11px] text-[var(--dim)]">
            {inst.peAccumulatingCount != null ? `积累中 ${inst.peAccumulatingCount}/8` : "积累中"}
          </span>
        </div>
      ) : null}
      {inst.fwdPe ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="text-xs font-medium text-[var(--text)]">估值 · 前瞻 PE（手工积累）</div>
          <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">
            前瞻 12 个月 PE {fmt(inst.fwdPe.value, 2)} 倍（数据日期 {inst.fwdPe.date}）
            {inst.fwdPe.avg5 != null ? `，${inst.fwdPe.value < inst.fwdPe.avg5 ? "低于" : inst.fwdPe.value > inst.fwdPe.avg5 ? "高于" : "等于"} 5 年均值 ${fmt(inst.fwdPe.avg5, 2)} 倍` : ""}
            {inst.fwdPe.avg10 != null ? `、10 年均值 ${fmt(inst.fwdPe.avg10, 2)} 倍` : ""}。
            {inst.fwdPe.percentile != null
              ? `处在近 5 年前瞻 PE 的百分位 ${inst.fwdPe.percentile}（样本 ${inst.fwdPe.n} 笔）。`
              : `近 5 年百分位积累中（已存 ${inst.fwdPe.n} 笔，满 8 笔后显示）。`}
          </p>
          {inst.fwdPe.points.length >= 3 ? (
            <>
              <div className="mt-2 h-[56px] w-full" aria-hidden>
                <SvgLineChart
                  labels={inst.fwdPe.points.map((p) => p.d)}
                  series={[{ color: "var(--accent)", dot: true, values: inst.fwdPe.points.map((p) => p.v) }]}
                  height={56}
                  yFormat={(v) => fmt(v, 1)}
                  valueFormat={(v) => `${fmt(v, 2)} 倍`}
                />
              </div>
              <div className="mt-1 text-[11px] text-[var(--dim)]">
                前瞻 PE 走势 · {inst.fwdPe.points[0]?.d} 至 {inst.fwdPe.points[inst.fwdPe.points.length - 1]?.d} · {inst.fwdPe.points.length} 笔
                {inst.fwdPe.avg5 != null || inst.fwdPe.avg10 != null
                  ? ` · 参考刻度：${inst.fwdPe.avg5 != null ? `5 年均值 ${fmt(inst.fwdPe.avg5, 2)} 倍` : ""}${inst.fwdPe.avg5 != null && inst.fwdPe.avg10 != null ? " / " : ""}${inst.fwdPe.avg10 != null ? `10 年均值 ${fmt(inst.fwdPe.avg10, 2)} 倍` : ""}`
                  : ""}
              </div>
            </>
          ) : null}
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
            来源：{inst.fwdPe.source}
            {inst.key === "ndx" || inst.key === "qqq" ? "纳指前瞻值另有 dollarliquidity 日度重建值 18.25×（2026-11-18）作交叉核对，未入库。" : ""}
            {inst.key.startsWith("sec_") ? "；S&P 500 板块指数口径（SPDR 板块 ETF 跟踪同一指数）；前瞻 PE 用分析师预期盈利、与 TTM 口径不同，不直接对比。" : ""}
          </p>
        </div>
      ) : null}

      {inst.peHist ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-xs font-medium text-[var(--text)]">估值 · 历史 PE 百分位（主看）</div>
            <div className="text-[11px] text-[var(--dim)]">TTM · 近 5 年 · {inst.peHist.cadence} PE</div>
          </div>
          <div className="mb-1.5 mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--dim)]">历史 PE 百分位（TTM，近 5 年，样本 {inst.peHist.n}）</span>
            <span className="text-sm font-semibold text-[var(--text)]">{inst.peHist.percentile}</span>
            <LabelChip label={pePositionLabel(inst.peHist.percentile)} />
          </div>
          <PctBar percentile={inst.peHist.percentile} />
          <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">
            当前 PE {fmt(inst.peHist.current, 2)} 倍（{inst.peHist.indexName}，数据日期 {inst.peHist.lastDate}），高于近 5 年 {inst.peHist.percentile}% 的{inst.peHist.cadence} PE（{inst.peHist.cadence} PE 中位数 {fmt(inst.peHist.median, 2)} 倍）
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
            来源：{inst.peHist.source}；窗口 {inst.peHist.firstDate} 至 {inst.peHist.lastDate}，共 {inst.peHist.n} 个{inst.peHist.cadence}点。
          </p>
        </div>
      ) : inst.peNoData ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="text-xs font-medium text-[var(--text)]">估值 · 历史 PE 百分位</div>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            暂无历史 PE 数据
          </p>
        </div>
      ) : null}

      {inst.yieldStats ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="mb-1 text-xs font-medium text-[var(--text)]">估值尺度 · 对应收益率 / 利差的历史百分位（主看）</div>
          <p className="mb-2 text-[11px] leading-relaxed text-[var(--dim)]">
            {inst.yieldLabel}。
          </p>
          <StatsGrid stats={inst.yieldStats} unit={inst.yieldUnit} decimals={2} charted />
        </div>
      ) : null}

      {inst.priceStats ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <div className="mb-1 text-xs font-medium text-[var(--text)]">
            价格的历史位置
          </div>
          <StatsGrid stats={inst.priceStats} unit="" decimals={inst.decimals} charted positionOnly />
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[var(--border)] pt-3">
        {maCell("MA20", inst.ma20)}
        {maCell("MA60", inst.ma60)}
        {maCell("MA120", inst.ma120)}
        {maCell("MA250", inst.ma250)}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <span className="rounded-full bg-[var(--border)]/60 px-2 py-1 text-[var(--text)]">{inst.trendState}</span>
        <span className="rounded-full bg-[var(--border)]/60 px-2 py-1 text-[var(--text)]">{inst.crossState}</span>
      </div>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-3 w-full rounded-lg border border-[var(--border)] py-2 text-sm font-medium text-[var(--text)]"
      >
        {open ? "收起全部指标" : `展开全部指标（${inst.indicators.length} 个）`}
      </button>
      {open ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {inst.indicators.map((ind) => (
            <IndicatorCard key={ind.key} ind={ind} goMethod={goMethod} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Shared section helpers
// ---------------------------------------------------------------------------


function InstrumentList({
  instruments,
  goMethod,
  peByKey,
  peStatus,
}: {
  instruments: Instrument[];
  goMethod: (id: string) => void;
  peByKey?: Map<string, WatchPe>;
  peStatus?: WatchPeStatus;
}) {
  return (
    <div className="mt-3 grid gap-3">
      {instruments.map((inst) => (
        <InstrumentCard
          key={inst.key}
          inst={inst}
          goMethod={goMethod}
          pe={peByKey && inst.asset === "uswatch" ? (peByKey.get(inst.key) ?? null) : undefined}
          peStatus={peByKey && inst.asset === "uswatch" ? peStatus : undefined}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fibonacci retracement card (52-week anchors, second-source verified)
// ---------------------------------------------------------------------------

function FibCard({ fib, goMethod }: { fib: Fib; goMethod: (id: string) => void }) {
  const money = (v: number) => `${fib.unit === "美元" ? "$" : ""}${fmt(v, fib.decimals)}`;
  const ladder = [...fib.levels].sort((a, b) => b.price - a.price);
  return (
    <article className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-serif-sc text-lg font-bold text-[var(--text)]">{fib.name} · 斐波那契回撤</h3>
          <div className="text-xs text-[var(--dim)]">
            {fib.direction === "up" ? (
              <>锚点：低 {money(fib.low)}（{fib.lowDate}）→ 高 {money(fib.high)}（{fib.highDate}）</>
            ) : (
              <>锚点：高 {money(fib.high)}（{fib.highDate}）→ 低 {money(fib.low)}（{fib.lowDate}）</>
            )}
            <span> · 近 52 周窗口 · 波段幅度 {money(fib.range)}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="font-serif-sc text-2xl font-bold leading-none text-[var(--text)]">
            {money(fib.close)}
            <span className="ml-1 text-xs font-normal text-[var(--dim)]">收盘 · {fib.closeDate}</span>
          </div>
          <div className="mt-1">
            {fib.verified ? (
              <span className="inline-block rounded-full bg-[var(--down)]/15 px-2 py-0.5 text-[11px] font-medium leading-tight text-[var(--down)]">
                锚点已由第二数据源验证（见下方注记）
              </span>
            ) : (
              <span className="inline-block rounded-full bg-[var(--gold)]/15 px-2 py-0.5 text-[11px] font-medium leading-tight text-[var(--gold)]">
                锚点第二源未确认，下单前请再核对
              </span>
            )}
          </div>
        </div>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-[var(--text)]">{fib.positionText}</p>

      <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--surface-2)] text-left text-xs text-[var(--dim)]">
              <th className="px-3 py-2 font-medium">档位</th>
              <th className="px-3 py-2 text-right font-medium">价格</th>
              <th className="px-3 py-2 text-right font-medium">距现价</th>
              <th className="px-3 py-2 text-right font-medium">角色</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((lv) => {
              const isNearest = lv.ratio === fib.nearest.ratio && lv.kind === fib.nearest.kind;
              const role = lv.side === "below" ? "支撑位" : lv.side === "above" ? "压力位" : "现价所在";
              return (
                <tr key={`${lv.kind}-${lv.ratio}`} className={`border-t border-[var(--border)] ${isNearest ? "bg-[var(--accent)]/10 font-medium" : ""}`}>
                  <td className="px-3 py-1.5 text-[var(--text)]">
                    {lv.label}
                    {isNearest ? <span className="ml-2 text-[11px] text-[var(--accent)]">← 最近一档</span> : null}
                  </td>
                  <td className="px-3 py-1.5 text-right text-[var(--text)]">{money(lv.price)}</td>
                  <td className="px-3 py-1.5 text-right text-[var(--dim)]">{signed(lv.distPct, 2)}%</td>
                  <td className={`px-3 py-1.5 text-right ${lv.side === "below" ? "text-[var(--down)]" : lv.side === "above" ? "text-[var(--up)]" : "text-[var(--accent)]"}`}>{role}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">{fib.verifyNote}</p>
      <button type="button" onClick={() => goMethod("fibonacci")} className="mt-1 py-1 text-left text-xs text-[var(--accent)]">
        斐波那契回撤的方法说明 →
      </button>
    </article>
  );
}

function indVal(inst: Instrument, key: string): number | null {
  const ind = inst.indicators.find((i) => i.key === key);
  return ind ? ind.value : null;
}

/** Sector rotation ranking table + full cards. */
function SectorView({
  title,
  instruments,
  benchmarkName,
  goMethod,
}: {
  title: string;
  instruments: Instrument[];
  benchmarkName: string;
  goMethod: (id: string) => void;
}) {
  const ranked = [...instruments].sort((a, b) => {
    const ra = indVal(a, "relstrength") ?? -Infinity;
    const rb = indVal(b, "relstrength") ?? -Infinity;
    return rb - ra;
  });
  return (
    <section>
      <SectionHead title={title} />
      <ScrollHint className="mt-3 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-[var(--text)]">板块轮动榜 · 近 3 月跑赢{benchmarkName}幅度排名</span>
          <button type="button" onClick={() => goMethod("sectorrotation")} className="shrink-0 py-1 text-xs text-[var(--accent)]">
            什么是板块轮动 →
          </button>
        </div>
        {/* M-P1-5c: no min-width below sm — the old min-w-[520px] pushed
            the last header （价格历史位置） past the phone's edge, half-cutting
            its final character. Tighter type/padding fits all six columns
            at ~375px; headers wrap whole rather than clip, and the last
            cell may break before its label but never inside it.
            sm+ keeps the original layout. */}
        <table className="w-full text-xs sm:min-w-[520px] sm:text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--dim)]">
              <th className="py-1 pr-1 font-normal sm:pr-2">板块</th>
              <th className="py-1 pr-1 text-right font-normal sm:pr-2">最新价</th>
              <th className="py-1 pr-1 text-right font-normal sm:pr-2">今日</th>
              <th className="py-1 pr-1 text-right font-normal sm:pr-2">近3月涨跌</th>
              <th className="py-1 pr-1 text-right font-normal sm:pr-2">跑赢基准</th>
              <th className="py-1 text-right font-normal">价格历史位置</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((inst, i) => {
              const mom = indVal(inst, "momentum");
              const rs = indVal(inst, "relstrength");
              return (
                <tr key={inst.key} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-2 pr-1 font-medium text-[var(--text)] sm:pr-2">
                    <span className="mr-1.5 text-[var(--dim)]">{i + 1}</span>
                    {inst.name}
                  </td>
                  <td className="py-2 pr-1 text-right text-[var(--text)] sm:pr-2">{fmt(inst.price, inst.decimals)}</td>
                  <td className={`py-2 pr-1 text-right sm:pr-2 ${inst.changePct != null ? moveColor(inst.changePct) : "text-[var(--dim)]"}`}>
                    {inst.changePct != null ? `${signed(inst.changePct, 2)}%` : "—"}
                  </td>
                  <td className={`py-2 pr-1 text-right sm:pr-2 ${mom != null ? moveColor(mom) : ""}`}>{mom != null ? `${signed(mom, 1)}%` : "—"}</td>
                  <td className={`py-2 pr-1 text-right font-medium sm:pr-2 ${rs != null ? moveColor(rs) : ""}`}>{rs != null ? `${signed(rs, 1)}%` : "—"}</td>
                  <td className="py-2 text-right text-[var(--dim)]">
                    {inst.priceStats ? (
                      <>
                        {inst.priceStats.percentile} · <span className="whitespace-nowrap">{inst.priceStats.label}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollHint>
      <InstrumentList instruments={instruments} goMethod={goMethod} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bonds module: 利率债 / 信用债 / 资金面
// ---------------------------------------------------------------------------

function RateBondsView({ data, goMethod }: { data: Dashboard; goMethod: (id: string) => void }) {
  const winLabel = useWindowLabel();
  const y = data.yields;
  if (!y) return <p className="py-10 text-center text-sm text-[var(--dim)]">收益率数据尚未拉取到，请点右上角刷新。</p>;
  const mainSpreads = data.derived.filter((d) => ["cnTermSpread1y", "cnTermSpread", "usTermSpread", "cnUsSpread"].includes(d.key));
  const segSpreads = data.derived.filter((d) => ["cnSeg5y2y", "cnSeg10y5y", "cnSeg30y10y", "usSeg30y10y"].includes(d.key));
  const bondEtfs = data.instruments.filter((i) => i.asset === "bondetf");
  const usByKey = new Map(y.us.map((t) => [t.key, t]));
  const tenorRow = (cnT: NonNullable<Dashboard["yields"]>["cn"][number]) => {
    const usT = usByKey.get(cnT.key.replace(/^cn/, "us"));
    return (
    <tr key={cnT.key} className="border-b border-[var(--border)] last:border-0">
      <td className="py-2 pr-2 font-medium text-[var(--text)]">{cnT.tenor}</td>
      <td className="py-2 pr-2 text-right">
        <span className="font-medium text-[var(--text)]">{fmt(cnT.yieldPct, 2)}%</span>{" "}
        <span className={`text-xs ${moveColor(cnT.changeBp)}`}>{signed(cnT.changeBp, 1)}bp</span>
      </td>
      <td className="py-2 pr-2 text-right text-[var(--dim)]">
        {cnT.stats ? (
          <>
            <div>{`百分位 ${cnT.stats.percentile} · ${cnT.stats.label}${valuationGloss(cnT.stats)}`}</div>
            <div className="ml-auto mt-1 w-24">
              <PctBar percentile={cnT.stats.percentile} height="h-1.5" invert={cnT.stats.invert} />
            </div>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="py-2 pr-2 text-right">
        {usT ? (
          <>
            <span className="font-medium text-[var(--text)]">{fmt(usT.yieldPct, 2)}%</span>{" "}
            <span className={`text-xs ${moveColor(usT.changeBp)}`}>{signed(usT.changeBp, 1)}bp</span>
          </>
        ) : (
          <span className="text-[var(--dim)]">—（数据未到）</span>
        )}
      </td>
      <td className="py-2 text-right text-[var(--dim)]">
        {usT?.stats ? (
          <>
            <div>{`百分位 ${usT.stats.percentile} · ${usT.stats.label}${valuationGloss(usT.stats)}`}</div>
            <div className="ml-auto mt-1 w-24">
              <PctBar percentile={usT.stats.percentile} height="h-1.5" invert={usT.stats.invert} />
            </div>
          </>
        ) : usT ? (
          "—"
        ) : (
          "—（数据未到）"
        )}
      </td>
    </tr>
    );
  };
  return (
    <div>
      <SectionHead
        title="利率债 · 收益率曲线与利差"

      />
      <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-medium text-[var(--text)]">中美各期限收益率（{y.date}）</span>
          <button type="button" onClick={() => goMethod("yieldcurve")} className="py-1 text-xs text-[var(--accent)]">什么是收益率曲线 →</button>
        </div>
        {/* 手机端：按期限分行卡片，中美两行上下排，全部列完整可见、无需横向滑动 */}
        <div className="sm:hidden">
          {y.cn.map((cnT) => {
            const usT = usByKey.get(cnT.key.replace(/^cn/, "us"));
            return (
              <div key={cnT.key} className="border-b border-[var(--border)] py-2.5 last:border-0">
                <div className="text-sm font-semibold text-[var(--text)]">{cnT.tenor}</div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-xs text-[var(--dim)]">中国国债</span>
                  <span className="text-sm">
                    <span className="font-medium text-[var(--text)]">{fmt(cnT.yieldPct, 2)}%</span>{" "}
                    <span className={`text-xs ${moveColor(cnT.changeBp)}`}>{signed(cnT.changeBp, 1)}bp</span>
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-2">
                  <span className="text-xs text-[var(--dim)]">中国 · 历史位置</span>
                  <span className="text-right text-xs text-[var(--dim)]">
                    {cnT.stats ? `百分位 ${cnT.stats.percentile} · ${cnT.stats.label}${valuationGloss(cnT.stats)}` : "—"}
                  </span>
                </div>
                {cnT.stats ? (
                  <div className="mt-1">
                    <PctBar percentile={cnT.stats.percentile} height="h-1.5" invert={cnT.stats.invert} />
                  </div>
                ) : null}
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-xs text-[var(--dim)]">美国国债</span>
                  <span className="text-sm">
                    {usT ? (
                      <>
                        <span className="font-medium text-[var(--text)]">{fmt(usT.yieldPct, 2)}%</span>{" "}
                        <span className={`text-xs ${moveColor(usT.changeBp)}`}>{signed(usT.changeBp, 1)}bp</span>
                      </>
                    ) : (
                      <span className="text-[var(--dim)]">—（数据未到）</span>
                    )}
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-2">
                  <span className="text-xs text-[var(--dim)]">美国 · 历史位置</span>
                  <span className="text-right text-xs text-[var(--dim)]">
                    {usT?.stats ? `百分位 ${usT.stats.percentile} · ${usT.stats.label}${valuationGloss(usT.stats)}` : usT ? "—" : "—（数据未到）"}
                  </span>
                </div>
                {usT?.stats ? (
                  <div className="mt-1">
                    <PctBar percentile={usT.stats.percentile} height="h-1.5" invert={usT.stats.invert} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--dim)]">
                <th className="py-1 pr-2 font-normal">期限</th>
                <th className="py-1 pr-2 text-right font-normal">中国国债</th>
                <th className="py-1 pr-2 text-right font-normal">中国 · 历史位置</th>
                <th className="py-1 pr-2 text-right font-normal">美国国债</th>
                <th className="py-1 text-right font-normal">美国 · 历史位置</th>
              </tr>
            </thead>
            <tbody>{y.cn.map((cnT) => tenorRow(cnT))}</tbody>
          </table>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">中国曲线：中债国债收益率曲线（1/3/7 年取自中债登，5/10/30 年与东财报表交叉核对）；美债仅 2/5/10/30 年四个期限。</p>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
          <div className="mb-1 text-sm font-medium text-[var(--text)]">收益率曲线形状（中国 vs 美国）</div>
          <div className="mb-1 flex gap-4 text-xs text-[var(--dim)]">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--up)]" />中国国债</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--gold)]" />美国国债</span>
          </div>
          <CurveChart curve={y.curve} />
          <div className="text-xs leading-relaxed text-[var(--dim)]">
            中国：{y.curve.map((c) => `${c.tenor} ${fmt(c.cn, 2)}%`).join(" · ")}
            <br />
            美国：{y.us.map((t) => `${t.tenor} ${fmt(t.yieldPct, 2)}%`).join(" · ")}
            <br />
            两条线离得越远，中美利差越大；线越平，说明长短期限的利息差越小。
          </div>
        </div>
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
          <div className="mb-1 text-sm font-medium text-[var(--text)]">中国 10 年期收益率 · {winLabel}</div>
          <MiniChart data={y.cn10yChart} color="var(--accent)" />
          <div className="mb-3 text-xs text-[var(--dim)]">美国 10 年期收益率 · {winLabel}</div>
          <MiniChart data={y.us10yChart} color="var(--gold)" />
        </div>
      </div>

      {mainSpreads.length > 0 ? (
        <>
          <h3 className="mt-6 text-base font-bold text-[var(--text)]">核心利差：期限利差与中美利差</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mainSpreads.map((s) => (
              <IndicatorCard key={s.key} ind={s} goMethod={goMethod} />
            ))}
          </div>
        </>
      ) : null}

      {segSpreads.length > 0 ? (
        <>
          <h3 className="mt-6 text-base font-bold text-[var(--text)]">分段利差：曲线的每一段在说什么</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {segSpreads.map((s) => (
              <IndicatorCard key={s.key} ind={s} goMethod={goMethod} />
            ))}
          </div>
        </>
      ) : null}

      {data.cdbGov ? (
        <>
          <h3 className="mt-6 text-base font-bold text-[var(--text)]">政金债利差：国开债 − 国债</h3>
          <div className="mt-2 max-w-3xl">
            <CdbGovSpreadCard block={data.cdbGov} goMethod={goMethod} />
          </div>
        </>
      ) : null}

      {bondEtfs.length > 0 ? (
        <>
          <h3 className="mt-6 text-base font-bold text-[var(--text)]">利率债的可交易影子：国债 ETF</h3>
          <InstrumentList instruments={bondEtfs} goMethod={goMethod} />
        </>
      ) : null}
    </div>
  );
}

function CreditBondsView({ data, goMethod }: { data: Dashboard; goMethod: (id: string) => void }) {
  const credit = data.instruments.filter((i) => i.asset === "credit");
  return (
    <div>
      <SectionHead
        title="信用债 · 城投 / 公司债 / 可转债"

      />
      {credit.length > 0 ? (
        <InstrumentList instruments={credit} goMethod={goMethod} />
      ) : (
        <p className="py-10 text-center text-sm text-[var(--dim)]">信用债 ETF 数据尚未拉取到，请点右上角刷新。</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 央行政策利率公告值：没有稳定的程序化数据源，人工按央行公告录入。
// 非程序拉取——不随刷新自动更新，央行发布新公告后需人工改这三行。
// 录入于 2026-11-19，依据见 PBOC_POLICY_SOURCE。
// ---------------------------------------------------------------------------

const PBOC_POLICY_RATES: { label: string; value: string; since: string; note: string }[] = [
  {
    label: "政策利率 · 逆回购",
    value: "隔夜 1.25%（现行）· 7 天 1.40%（原政策利率）",
    since: "2026-11-02 起切换",
    note: "央行 2026-10-30 公告：自 2026-11-02 起每个工作日开展隔夜逆回购（固定利率、数量招标，利率 1.25%），主要政策利率由 7 天期切换为隔夜。原 7 天期逆回购政策利率 1.40% 是 2025-05-08 由 1.50% 下调定的，自切换日起 7 天期改为固定数量、多重价位招标，主要在税期、月末开展，不再设单一政策利率。",
  },
  {
    label: "MLF · 1 年期中期借贷便利",
    value: "2.00%（最后公布的统一利率）",
    since: "2024-09-25 定",
    note: "2024-09-25 由 2.30% 下调至 2.00%，是央行最后一次公布的统一 MLF 利率。2025 年 3 月起 MLF 改为固定数量、多重价位招标，各家银行中标利率不再相同，央行不再公布单一利率——此后看 MLF 只看量（每月续作规模），不再看价。",
  },
  {
    label: "LPR · 贷款市场报价利率",
    value: "1 年期 3.00% · 5 年期以上 3.50%",
    since: "2025-05-20 定 · 2026-10-20 最新公布",
    note: "每月 20 日公布（遇节假日顺延）。2026-10-20 公布值与上月持平：自 2025 年 5 月随政策利率同步下调 10bp 后，两个期限已连续 17 个月未变。下一次公布约在 2026-11-20。",
  },
];

const PBOC_POLICY_SOURCE =
  "来源：中国人民银行 2026-10-30《关于进一步优化短端利率调控机制》公告与公开市场业务公告、全国银行间同业拆借中心 2026-10-20 LPR 公布。人工录入于 2026-11-19，非程序拉取，不随刷新自动更新——以央行官网最新公告为准。";

function PbocOpsCard() {
  return (
    <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-[var(--text)]">央行操作 · 政策利率公告值</span>
        <span className="rounded-full bg-[var(--gold)]/15 px-2 py-0.5 text-xs text-[var(--gold)]">公告值 · 非程序拉取</span>
      </div>
      <div className="mt-2 divide-y divide-[var(--border)]">
        {PBOC_POLICY_RATES.map((r) => (
          <div key={r.label} className="py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-[var(--text)]">{r.label}</span>
              <span className="text-xs text-[var(--dim)]">{r.since}</span>
            </div>
            <div className="mt-0.5 font-serif-sc text-lg font-bold text-[var(--text)]">{r.value}</div>
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">{PBOC_POLICY_SOURCE}</p>
    </div>
  );
}

/** 国债期货基差占位卡：需要期货 + 现券双边行情，本机源不可达——如实缺位，待源恢复。 */
function FuturesBasisPlaceholder({ goMethod }: { goMethod: (id: string) => void }) {
  return (
    <div className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-[var(--text)]">国债期货基差</span>
        <span className="rounded-full bg-[var(--border)]/60 px-2 py-0.5 text-xs text-[var(--dim)]">待源恢复 · 缺位</span>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">本机源不可达，暂无数据；源恢复后自动出现。</p>
      <button type="button" onClick={() => goMethod("futuresbasis")} className="mt-1 py-1 text-xs text-[var(--accent)]">
        方法讲解：国债期货基差 →
      </button>
    </div>
  );
}

function MoneyView({ data, goMethod }: { data: Dashboard; goMethod: (id: string) => void }) {
  const winLabel = useWindowLabel();
  const m = data.money;
  if (!m) return <p className="py-10 text-center text-sm text-[var(--dim)]">资金面数据尚未拉取到，请点右上角刷新。</p>;
  // 导语按 DR007 数据有无切换：FR007/FDR007 都在时才宣称含 DR007；缺失时
  // 页面只剩 GC007 回退块，导语必须如实说明当前覆盖口径与 DR007 缺位原因，
  // 不能再写“含 DR007 / 流动性分层利差”（分层利差也要靠这两条线才算得出）。
  return (
    <div>
      <SectionHead
        title="资金面 · 回购利率与 SHIBOR"

      />
      <PbocOpsCard />
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
          {m.fr007Chart.length > 1 ? (
            <>
              <div className="mb-1 text-sm font-medium text-[var(--text)]">FR007 · 7 天回购定盘利率（全市场）{winLabel}</div>
              <MiniChart data={m.fr007Chart} color="var(--accent)" />
              <div className="mb-3 text-xs text-[var(--dim)]">FDR007 / DR007（存款类机构）{winLabel}</div>
              <MiniChart data={m.fdr007Chart} color="var(--gold)" />
            </>
          ) : (
            <>
              <div className="mb-1 text-sm font-medium text-[var(--text)]">GC007 · 上交所 7 天质押式回购利率{winLabel}</div>
              <MiniChart data={m.gc007Chart} color="var(--accent)" />
              {m.gc001Chart.length > 1 ? (
                <>
                  <div className="mb-3 text-xs text-[var(--dim)]">GC001 · 上交所 1 天（隔夜）质押式回购利率{winLabel}</div>
                  <MiniChart data={m.gc001Chart} color="var(--gold)" />
                </>
              ) : null}
            </>
          )}
        </div>
        <ScrollHint className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-sm font-medium text-[var(--text)]">SHIBOR 各期限（{m.date}）</span>
            <button type="button" onClick={() => goMethod("shibor")} className="py-1 text-xs text-[var(--accent)]">什么是 SHIBOR →</button>
          </div>
          {/* M-P1-5b: no min-width below sm — the old min-w-[380px] pushed
              the last column past the phone's edge, clipping the position
              label to a single character （极）. Tighter type/padding lets
              all four columns fit ~375px; sm+ keeps the original layout. */}
          <table className="w-full text-xs sm:min-w-[380px] sm:text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--dim)]">
                <th className="py-1 pr-1 font-normal sm:pr-2">期限</th>
                <th className="py-1 pr-1 text-right font-normal sm:pr-2">利率</th>
                <th className="py-1 pr-1 text-right font-normal sm:pr-2">较昨日</th>
                <th className="py-1 text-right font-normal">历史位置（百分位）</th>
              </tr>
            </thead>
            <tbody>
              {m.shibor.map((s) => (
                <tr key={s.key} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-2 pr-1 font-medium text-[var(--text)] sm:pr-2">{s.tenor}</td>
                  <td className="py-2 pr-1 text-right font-medium text-[var(--text)] sm:pr-2">{fmt(s.value, 3)}%</td>
                  <td className={`py-2 pr-1 text-right text-xs sm:pr-2 ${moveColor(s.changeBp)}`}>{signed(s.changeBp, 1)}bp</td>
                  <td className="py-2 text-right text-[var(--dim)]">
                    {s.stats ? (
                      <>
                        <div className="whitespace-nowrap">{`百分位 ${s.stats.percentile} · ${s.stats.label}`}</div>
                        <div className="ml-auto mt-1 w-20 sm:w-24">
                          <PctBar percentile={s.stats.percentile} height="h-1.5" />
                        </div>
                        <div className="whitespace-nowrap text-[11px]">{`${winLabel} · ${s.stats.count} 个交易日`}</div>
                      </>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollHint>
      </div>
      {m.cards.length > 0 ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {m.cards.map((c) => (
            <IndicatorCard key={c.key} ind={c} goMethod={goMethod} />
          ))}
        </div>
      ) : null}
      <FuturesBasisPlaceholder goMethod={goMethod} />
      <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">缺位：央行 OMO 操作量与 MLF 续作规模、国债期货基差、国内通胀预期（无程序化序列）。</p>
    </div>
  );
}

/** 国债视角：利率债老手看盘的四张牌汇总——利率路径 / 信用利差 / 央行操作 /
 *  国债期货基差。有程序数据的用活数据，没有的如实标缺位，不估算。 */
function BondMasterView({ data, goMethod, goTab }: { data: Dashboard; goMethod: (id: string) => void; goTab: (t: BondTab) => void }) {
  const y = data.yields;
  const cn10 = y?.cn.find((t) => t.tenor === "10 年");
  const credit = data.instruments.filter((i) => i.asset === "credit");
  const cardCls = "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4";
  return (
    <div className="mb-5">
      <h3 className="text-base font-bold text-[var(--text)]">国债视角 · 利率债老手的四张牌</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className={cardCls}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-[var(--text)]">① 利率路径</span>
            <button type="button" onClick={() => goTab("rate")} className="py-1 text-xs text-[var(--accent)]">利率债页 →</button>
          </div>
          {cn10 ? (
            <>
              <div className="mt-1 font-serif-sc text-xl font-bold text-[var(--text)]">
                10 年国债 {fmt(cn10.yieldPct, 2)}%
                <span className={`ml-2 align-middle text-xs font-normal ${moveColor(cn10.changeBp)}`}>{signed(cn10.changeBp, 1)}bp</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                {y ? `数据日期 ${y.date}。` : ""}{cn10.stats ? `处在统计窗口的百分位 ${cn10.stats.percentile}（${cn10.stats.label}）。` : ""}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">收益率数据尚未拉取到——点右上角刷新后这里会出现 10 年国债的最新值与历史百分位。</p>
          )}
        </div>
        <div className={cardCls}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-[var(--text)]">② 信用利差</span>
            <button type="button" onClick={() => goTab("credit")} className="py-1 text-xs text-[var(--accent)]">信用债页 →</button>
          </div>
          {credit.length > 0 ? (
            <>
              <div className="mt-1 space-y-1">
                {credit.map((inst) => {
                  const rs = inst.indicators.find((x) => x.key === "relstrength");
                  return (
                    <div key={inst.key} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-[var(--text)]">{inst.name.split("（")[0]}</span>
                      <span className={rs ? (rs.value >= 0 ? "text-[var(--up)]" : "text-[var(--down)]") : "text-[var(--dim)]"}>
                        {rs ? `近3月${rs.value >= 0 ? "跑赢" : "跑输"}国债 ${signed(rs.value, 1)}%` : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">信用债 ETF 数据尚未拉取到——点右上角刷新后这里会出现三只信用 ETF 相对国债的强弱。</p>
          )}
        </div>
        <div className={cardCls}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-[var(--text)]">③ 央行操作</span>
            <span className="rounded-full bg-[var(--gold)]/15 px-2 py-0.5 text-xs text-[var(--gold)]">公告值 · 非程序拉取</span>
          </div>
          <div className="mt-1 space-y-1 text-xs leading-relaxed text-[var(--text)]">
            <div>政策利率：隔夜逆回购 <span className="font-bold">1.25%</span>（2026-11-02 起，原 7 天 1.40%）</div>
            <div>MLF 1 年期：<span className="font-bold">2.00%</span>（最后公布的统一利率，2024-09-25 定）</div>
            <div>LPR：1 年 <span className="font-bold">3.00%</span> · 5 年以上 <span className="font-bold">3.50%</span>（2026-10-20 公布）</div>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
            人工按央行公告录入于 2026-11-19，不随刷新更新。
          </p>
          <button type="button" onClick={() => goTab("money")} className="py-1 text-xs text-[var(--accent)]">资金面页看公告全文 →</button>
        </div>
        <div className="rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-[var(--text)]">④ 国债期货基差</span>
            <span className="rounded-full bg-[var(--border)]/60 px-2 py-0.5 text-xs text-[var(--dim)]">待源恢复 · 缺位</span>
          </div>
          <button type="button" onClick={() => goMethod("futuresbasis")} className="mt-1 py-1 text-xs text-[var(--accent)]">
            方法讲解：国债期货基差 →
          </button>
        </div>
      </div>
    </div>
  );
}

function BondsModule({ data, goMethod }: { data: Dashboard; goMethod: (id: string) => void }) {
  const [tab, setTab] = useState<BondTab>("rate");
  const tabs: { id: BondTab; label: string }[] = [
    { id: "rate", label: "利率债" },
    { id: "credit", label: "信用债" },
    { id: "money", label: "资金面" },
  ];
  return (
    <section>
      <p className="mb-2 text-[11px] text-[var(--dim)]">
        本模块数据更新于：收益率 {stageTimeText(data.stages, "yields")} · 资金面 {stageTimeText(data.stages, "money")} · 行情序列 {stageTimeText(data.stages, "prices")}
      </p>
      <BondMasterView data={data} goMethod={goMethod} goTab={setTab} />
      <div className="mb-4 flex gap-1.5" role="tablist" aria-label="债券子模块">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              tab === t.id
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--chip-bg)] text-[var(--chip-text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "rate" ? <RateBondsView data={data} goMethod={goMethod} /> : null}
      {tab === "credit" ? <CreditBondsView data={data} goMethod={goMethod} /> : null}
      {tab === "money" ? <MoneyView data={data} goMethod={goMethod} /> : null}
    </section>
  );
}


// ---------------------------------------------------------------------------
// History (drawdown archaeology) & Signals (rule-based decisions)
// ---------------------------------------------------------------------------

// One signal color scale everywhere (chips, score bars, overview strip):
// buy = solid red, add = light red, reduce = gold, hold = gray,
// avoid = solid green. Red/green follow the page-wide 红涨绿跌 convention:
// red = bullish/act, green = defensive/stop.
function toneChip(tone: string): string {
  switch (tone) {
    case "buy":
      return "bg-[var(--up)] text-white";
    case "add":
      return "bg-[var(--up)]/15 text-[var(--up)]";
    case "reduce":
      return "bg-[var(--gold)]/20 text-[var(--gold)]";
    case "avoid":
      return "bg-[var(--down)] text-white";
    default:
      return "bg-[var(--border)]/70 text-[var(--text)]";
  }
}

function toneBarColor(tone: string): string {
  switch (tone) {
    case "buy":
    case "add":
      return "var(--up)";
    case "reduce":
      return "var(--gold)";
    case "avoid":
      return "var(--down)";
    default:
      return "var(--dim)";
  }
}

function toneTextClass(tone: string): string {
  switch (tone) {
    case "buy":
    case "add":
      return "font-semibold text-[var(--up)]";
    case "reduce":
      return "font-semibold text-[var(--gold)]";
    case "avoid":
      return "font-semibold text-[var(--down)]";
    default:
      return "font-semibold";
  }
}

function SignalsView({ data }: { data: Dashboard }) {
  const groups: string[] = [];
  for (const s of data.signals) if (!groups.includes(s.group)) groups.push(s.group);
  return (
    <section>
      <SectionHead
        title="决策信号 · 规则打分，不是拍脑袋"

      />
      {data.signals.length === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--dim)]">信号数据尚未生成，请点右上角刷新。</p>
      ) : (
        groups.map((g) => (
          <div key={g} className="mt-4">
            <h3 className="text-sm font-semibold tracking-wide text-[var(--dim)]">{g}</h3>
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              {data.signals
                .filter((s) => s.group === g)
                .map((s) =>
                  s.missing ? (
                    <article key={s.key} aria-label={`${s.name}：数据未到`} className="rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface-2)]/60 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-serif-sc text-base font-bold text-[var(--text)]">{s.name}</span>
                        <span className="rounded-full bg-[var(--border)]/70 px-2.5 py-0.5 text-sm font-semibold text-[var(--dim)]">数据未到 · 暂无结论</span>
                      </div>
                      <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--text)]">{s.headline}</p>
                      <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">{s.missing}</p>
                      <p className="mt-2 border-t border-[var(--border)] pt-2 text-xs leading-relaxed text-[var(--dim)]">
                        <span className="font-medium text-[var(--text)]">这段时间怎么办：</span>
                        {s.caution}
                      </p>
                    </article>
                  ) : (
                    <article key={s.key} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-serif-sc text-base font-bold text-[var(--text)]">{s.name}</span>
                        <span className="text-xs text-[var(--dim)]">{s.date}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${toneChip(s.tone)}`}>{s.verdict}</span>
                        <span className="text-sm text-[var(--text)]">
                          综合分 <span className="font-semibold">{s.score > 0 ? `+${s.score}` : s.score}</span>
                          <span className="text-[var(--dim)]"> / 5</span>
                        </span>
                      </div>
                      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--border)]" role="img" aria-label={`综合分 ${s.score}，范围 -5 到 5`}>
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, Math.max(0, ((s.score + 5) / 10) * 100))}%`,
                            background: toneBarColor(s.tone),
                          }}
                        />
                      </div>
                      <p className="mt-2 text-sm font-medium leading-relaxed text-[var(--text)]">{s.headline}</p>
                      {/* r6 O1: mini percentile bar under a headline that
                          itself carries the percentile reading （中国国债 /
                          A股风格） — same computed value the headline text
                          prints, supplied by the server as headlineBar. */}
                      {s.headlineBar ? (
                        <div className="mt-1.5">
                          <PctBar percentile={s.headlineBar.pct} height="h-1.5" invert={s.headlineBar.invert} />
                        </div>
                      ) : null}
                      <ul className="mt-2 list-none space-y-1 text-sm leading-relaxed text-[var(--dim)]">
                        {s.basis.map((b, i) => {
                          const bar = s.basisBars[i];
                          return (
                            <li key={i}>
                              {b}
                              {/* r6 O1: mini percentile bar under each basis
                                  line whose text prints a percentile —
                                  value and lens come from the server's
                                  basisBars (same stats object as the text). */}
                              {bar ? (
                                <span className="mt-1 block">
                                  <PctBar percentile={bar.pct} height="h-1.5" invert={bar.invert} />
                                </span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                      <p className="mt-2 border-t border-[var(--border)] pt-2 text-xs leading-relaxed text-[var(--dim)]">
                        <span className="font-medium text-[var(--text)]">失效 / 风控：</span>
                        {s.caution}
                      </p>
                    </article>
                  ),
                )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 抄底逃顶 (v120; v121 backtest-calibrated zones): renders
// getDashboard.bottomTop only — a −100..+100 gauge (抄底区 ≤ −50 /
// 逃顶区 ≥ +30 since v121), the core-three resonance badge, the two
// 10-row signal tables, the 2-year history curve, and the static
// 2000–2026 backtest section. All computation is server-side; the
// history curve covers the 11 daily-recomputable signals ONLY (a
// different denominator from today's composite — the verbatim note
// under the chart says so).
// ---------------------------------------------------------------------------

type BtSignalRow = NonNullable<Dashboard["bottomTop"]>["signals"][number];

function BtStatusChip({ row }: { row: BtSignalRow }) {
  if (row.triggered === null) {
    return (
      <span className="inline-block rounded-full border border-dashed border-[var(--border)] px-2.5 py-0.5 text-xs font-semibold text-[var(--dim)]">
        暂无数据
      </span>
    );
  }
  if (!row.triggered) {
    return (
      <span className="inline-block rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-semibold text-[var(--dim)]">
        未触发
      </span>
    );
  }
  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
      style={{ background: row.side === "bottom" ? "var(--down)" : "var(--up)" }}
    >
      已触发
    </span>
  );
}

function BtSignalTable({ title, rows }: { title: string; rows: BtSignalRow[] }) {
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold tracking-wide text-[var(--dim)]">{title}</h3>
      <ScrollHint className="mt-2 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--dim)]">
              <th className="py-1 pr-2 font-normal">信号</th>
              <th className="py-1 pr-2 font-normal">当前值</th>
              <th className="py-1 pr-2 font-normal">触发阈值</th>
              <th className="py-1 pr-2 font-normal">状态</th>
              <th className="py-1 pr-2 font-normal">数据日期</th>
              <th className="py-1 font-normal">来源</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-b border-[var(--border)] last:border-0 ${r.triggered === null ? "opacity-60" : ""}`}>
                <td className="py-2 pr-2 font-medium text-[var(--text)]">
                  <span className="mr-1.5 text-xs text-[var(--dim)]">{r.id}</span>
                  {r.name}
                </td>
                <td className="py-2 pr-2 text-[var(--text)]">
                  {r.valueText}
                  {r.pct != null ? (
                    <span className="mt-1 block w-28">
                      <PctBar percentile={r.pct} height="h-1.5" />
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-2 text-[var(--dim)]">{r.threshold}</td>
                <td className="py-2 pr-2">
                  <BtStatusChip row={r} />
                </td>
                <td className="py-2 pr-2 whitespace-nowrap text-[var(--dim)]">{r.date || "—"}</td>
                <td className="py-2 text-[var(--dim)]">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollHint>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 回测 (v121): the 2000-01-01 ~ 2026-11-20 episode backtest that calibrated
// the zone thresholds (抄底区 ≤ −50 / 逃顶区 ≥ +30). Static research
// results — computed offline over 6,763 trading days with the same scoring
// definition as the live module; numbers are the research report's, shown
// verbatim (纳指100 primary, 标普500 in parentheses). Forward returns are
// measured from each episode's first day (entry close).
// ---------------------------------------------------------------------------

type BtBacktestRow = {
  threshold: string;
  episodes: number;
  days: number;
  adopted?: boolean;
  never?: boolean;
  cells: [string, string, string]; // "+20日 / +60日 / +120日": "纳指中位 / 胜率（标普中位 / 胜率）"
};

const BT_BACKTEST_BOTTOM: BtBacktestRow[] = [
  { threshold: "≤ −30", episodes: 232, days: 2104, cells: ["+1.47% / 58%（+1.17% / 62%）", "+4.09% / 70%（+3.34% / 70%）", "+7.88% / 71%（+5.49% / 71%）"] },
  { threshold: "≤ −40", episodes: 113, days: 740, cells: ["+3.31% / 60%（+2.39% / 63%）", "+4.09% / 60%（+1.96% / 60%）", "+12.27% / 66%（+5.13% / 64%）"] },
  { threshold: "≤ −50", episodes: 79, days: 467, adopted: true, cells: ["+2.25% / 58%（+2.11% / 63%）", "+7.41% / 64%（+4.30% / 65%）", "+13.20% / 74%（+7.39% / 71%）"] },
  { threshold: "≤ −60", episodes: 47, days: 193, cells: ["+0.67% / 61%（+2.24% / 61%）", "+8.73% / 72%（+5.41% / 72%）", "+12.33% / 80%（+5.57% / 65%）"] },
  { threshold: "≤ −70", episodes: 14, days: 20, cells: ["+4.37% / 57%（+4.73% / 79%）", "+12.40% / 71%（+7.20% / 93%）", "+19.84% / 86%（+12.27% / 79%）"] },
];

const BT_BACKTEST_TOP: BtBacktestRow[] = [
  { threshold: "≥ +30", episodes: 19, days: 49, adopted: true, cells: ["+0.19% / 53%（+0.02% / 53%）", "+2.65% / 53%（+2.27% / 74%）", "+8.18% / 79%（+5.29% / 79%）"] },
  { threshold: "≥ +40", episodes: 6, days: 26, cells: ["+1.82% / 83%（+1.16% / 83%）", "+8.68% / 83%（+3.79% / 100%）", "+13.92% / 83%（+6.87% / 83%）"] },
  { threshold: "≥ +50", episodes: 0, days: 0, never: true, cells: ["—", "—", "—"] },
  { threshold: "≥ +60", episodes: 0, days: 0, never: true, cells: ["—", "—", "—"] },
];

function BtBacktestTable({ title, rows }: { title: string; rows: BtBacktestRow[] }) {
  return (
    <div className="mt-4">
      <h4 className="text-sm font-semibold text-[var(--text)]">{title}</h4>
      <ScrollHint className="mt-2 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--dim)]">
              <th className="py-1 pr-2 font-normal">综合指数阈值</th>
              <th className="py-1 pr-2 font-normal">段数</th>
              <th className="py-1 pr-2 font-normal">天数</th>
              <th className="py-1 pr-2 font-normal">+20 日 中位 / 胜率</th>
              <th className="py-1 pr-2 font-normal">+60 日 中位 / 胜率</th>
              <th className="py-1 font-normal">+120 日 中位 / 胜率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.threshold} className={`border-b border-[var(--border)] last:border-0 ${r.adopted ? "bg-[var(--surface-2)]/70 font-medium" : ""} ${r.never ? "opacity-60" : ""}`}>
                <td className="py-2 pr-2 whitespace-nowrap text-[var(--text)]">
                  {r.threshold}
                  {r.adopted ? (
                    <span className="ml-2 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-semibold text-white">现行分区线</span>
                  ) : null}
                  {r.never ? <span className="ml-2 text-xs text-[var(--dim)]">26 年未出现</span> : null}
                </td>
                <td className="py-2 pr-2 text-[var(--text)]">{r.episodes}</td>
                <td className="py-2 pr-2 text-[var(--text)]">{r.days}</td>
                {r.cells.map((c, i) => (
                  <td key={i} className="py-2 pr-2 whitespace-nowrap text-[var(--text)]">{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollHint>
    </div>
  );
}

function BtBacktestSection() {
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold tracking-wide text-[var(--dim)]">回测 · 分区阈值是怎么定的（2000–2026）</h3>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-[var(--text)]">
        <p>
          回测窗口 2000-01-01 ~ 2026-11-20，共 6,763 个交易日（取数自 1999-01-04 起，给 200 日均线、RSI、52 周高点留预热期）。计分口径与线上一致：抄底得分 = 触发数 ÷ 当日可用抄底信号数 ×100，逃顶同理，综合 = 逃顶 − 抄底。检验用 episode 法：连续落在同一分区的交易日并成一段，入口取首日，前向收益自入口收盘起算，同一段行情不重复计。
        </p>
        <p>
          无条件基准（任意一天买入）：纳指100 +20 日中位 +1.53%（胜率 61.7%）、+60 日 +3.83%（66.9%）、+120 日 +7.84%（71.9%）；标普500 +20 日 +1.18%（63.0%）、+60 日 +2.96%（67.6%）、+120 日 +5.12%（69.8%）。下表每格为「纳指100 中位 / 胜率（标普500 中位 / 胜率）」。
        </p>
      </div>
      <BtBacktestTable title="抄底阈值检验" rows={BT_BACKTEST_BOTTOM} />
      <BtBacktestTable title="逃顶阈值检验" rows={BT_BACKTEST_TOP} />
      <div className="mt-4 space-y-2 text-sm leading-relaxed text-[var(--text)]">
        <p>
          <span className="font-semibold">为什么抄底线定在 −50：</span>−30 几乎不优于基准；−40 的 +60 日在标普上反而低于基准；−50 在两个指数、+60/+120 日上全面优于基准且样本足（79 段）；−60 纳指更强，但标普 +120 日优势消失、+20 日弱于基准；−70 中位最高，但只有 14 段，样本太小，不足以定线。
        </p>
        <p>
          <span className="font-semibold">为什么逃顶线定在 +30（证据弱）：</span>+40 只有 6 段（低于 8 段下限），且前向收益全面高于基准——是反向信号，不可用；+50 / +60 在 26 年里一次都没出现。+30 是唯一满足段数下限、且短周期（+20/+60 日）中位收益低于基准的阈值，但 +120 日无效果。所以逃顶区只作过热提醒，不当可靠顶部信号。
        </p>
        <p>
          <span className="font-semibold">结构性发现：</span>26 年里综合指数的实际范围是 −88 ~ +45，顶部天然被压缩——抄底分母里「纳指在 200 日均线上方」在 73% 的日子里触发，抬高了抄底得分的底数，所以逃顶区天数极少（≥ +40 仅 26 天）。不要用「对称」的直觉去要求逃顶区。
        </p>
        <p>
          <span className="font-semibold">纳入回测的信号（16 个，分段可用）：</span>2000 年起全窗口可用 11 个——VIX ≥ 28、纳指 &gt; 200 日均线、美元 &lt; 200 日均线、标普 RSI &lt; 30、标普距 52 周高点回撤 ≥ 10%、纳指偏离均线 &lt; −5%、VIX &lt; 13、标普 RSI &gt; 70、纳指偏离均线 &gt; +20%，外加两个代理：估值用 Multpl TTM PE 的 5 年滚动百分位 &gt; 80 代替前瞻 PE（月度值自次月 1 日生效），保证金用 FINRA 月度负债的 5 年滚动百分位 &gt; 95（月度值自次月 1 日生效）。2019-11-01 起加入总 Put/Call 两条（&gt; 1.1 / &lt; 0.75，CBOE 日文件此前年份无数据）；2023-11-21 起加入高收益利差两条（&gt; 4.0% / &lt; 3.0%，FRED 免费下载仅分发近约 3 年）。每日分母按当日可用信号数计：2000–2019 年抄底分母 6、逃顶分母 5，之后随信号加入逐步增加。
        </p>
        <p>
          <span className="font-semibold">口径提示（T5）：</span>线上 T5 用全历史百分位，回测里 T5 用的是 5 年滚动百分位，两者口径不同——同一月份的百分位数值与触发状态可能不一致，不要直接对照。
        </p>
        <p>
          <span className="font-semibold">未纳入（原因）：</span>CNN 恐惧与贪婪——塔内历史仅 1 年，进不了 26 年回测；AAII 看多比例——完整历史仅会员可下载，公开页只列最近约 5 个月；成分股宽度——StockCharts 登录墙、无公开 API。这三项在线上实时计分中的状态不变（恐惧与贪婪照常计分，AAII 与宽度仍为「暂无数据」、不计入分母）。
        </p>
        <p>
          <span className="font-semibold">方法与局限：</span>数据源为 Yahoo 日线（^VIX、^NDX、^GSPC、DX-Y.NYB）、FRED 高收益 OAS（BAMLH0A0HYM2）、FINRA 保证金负债官网表、Multpl TTM PE、CBOE 总 Put/Call 日文件。200 日均线 = 最近 200 个收盘价算术平均（含当日）；RSI(14) 为 Wilder 口径；52 周高点 = 最近 252 个交易日收盘最高价；偏离 = 收盘 ÷ 均线 − 1。所有信号只用当日及以前的数据，月度值自次月 1 日生效，高收益利差取当日可得的最新值；不完整的 horizon 不计入该 horizon。局限：26 年里 ≥ +40 只出现 6 次，逃顶阈值样本天然小；2000–2002 与 2008 的极端段在 −70 档只有 14 段。回测不等于未来。
        </p>
      </div>
    </div>
  );
}

function BottomTopView({ data }: { data: Dashboard }) {
  const bt = data.bottomTop;
  if (!bt) {
    return (
      <section>
        <SectionHead title="抄底逃顶 · 美股" />
        <p className="py-10 text-center text-sm text-[var(--dim)]">指数数据尚未生成，请点右上角刷新。</p>
      </section>
    );
  }
  const zoneLabel = bt.zone === "bottom" ? "抄底区" : bt.zone === "top" ? "逃顶区" : bt.zone === "neutral" ? "中性" : "暂无数据";
  const pos = bt.composite != null ? ((bt.composite + 100) / 200) * 100 : null;
  const coreRows = ["B1", "B2", "B3"].map((id) => bt.signals.find((s) => s.id === id)).filter((s): s is BtSignalRow => !!s);
  const coreHit = [bt.resonance.vix, bt.resonance.ndxAbove, bt.resonance.dxyBelow].filter(Boolean).length;
  return (
    <section>
      <SectionHead title="抄底逃顶 · 美股" />
      {/* 1 — composite gauge */}
      <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm text-[var(--dim)]">综合指数</span>
          <span className="font-serif-sc text-4xl font-black text-[var(--text)]">
            {bt.composite != null ? (bt.composite > 0 ? `+${bt.composite}` : `${bt.composite}`) : "暂无数据"}
          </span>
          <span
            className="rounded-full px-2.5 py-0.5 text-sm font-semibold text-white"
            style={{
              background:
                bt.zone === "bottom" ? "var(--down)" : bt.zone === "top" ? "var(--up)" : "var(--dim)",
            }}
          >
            {zoneLabel}
          </span>
        </div>
        <div
          className="relative mt-3 h-10 w-full overflow-hidden rounded-lg border border-[var(--border)]"
          role="img"
          aria-label={bt.composite != null ? `综合指数 ${bt.composite}，位于${zoneLabel}` : "综合指数暂无数据"}
        >
          <div className="absolute inset-y-0 left-0 flex items-center justify-center" style={{ width: "25%", background: "var(--down)", opacity: 0.8 }}>
            <span className="px-1 text-center text-[11px] font-bold leading-tight text-white">抄底区 ≤ −50</span>
          </div>
          <div className="absolute inset-y-0 flex items-center justify-center" style={{ left: "25%", width: "40%", background: "var(--surface-2)" }}>
            <span className="text-[11px] font-semibold text-[var(--dim)]">中性</span>
          </div>
          <div className="absolute inset-y-0 right-0 flex items-center justify-center" style={{ width: "35%", background: "var(--up)", opacity: 0.8 }}>
            <span className="px-1 text-center text-[11px] font-bold leading-tight text-white">逃顶区 ≥ +30</span>
          </div>
          {pos != null ? (
            <div
              aria-hidden
              className="absolute inset-y-0"
              style={{ left: `calc(${pos}% - 2px)`, width: 4, background: "var(--text)", boxShadow: "0 0 0 1.5px var(--surface)" }}
            />
          ) : null}
        </div>
        <div className="relative mt-1 h-4 text-[10px] text-[var(--dim)]" aria-hidden>
          <span className="absolute left-0">−100</span>
          <span className="absolute" style={{ left: "25%", transform: "translateX(-50%)" }}>−50</span>
          <span className="absolute" style={{ left: "50%", transform: "translateX(-50%)" }}>0</span>
          <span className="absolute" style={{ left: "65%", transform: "translateX(-50%)" }}>+30</span>
          <span className="absolute right-0">+100</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1 text-sm text-[var(--text)]">
            抄底得分{" "}
            <span className="font-semibold">{bt.bottomScore != null ? bt.bottomScore : "暂无数据"}</span>
            <span className="text-[var(--dim)]">（{bt.bottomTriggered}/{bt.bottomAvailable} 触发）</span>
          </span>
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1 text-sm text-[var(--text)]">
            逃顶得分{" "}
            <span className="font-semibold">{bt.topScore != null ? bt.topScore : "暂无数据"}</span>
            <span className="text-[var(--dim)]">（{bt.topTriggered}/{bt.topAvailable} 触发）</span>
          </span>
        </div>
        {bt.asOf ? (
          <p className="mt-2 text-xs text-[var(--dim)]">截至 {bt.asOf} 收盘（慢频信号的日期见表内）</p>
        ) : null}
      </div>
      {/* 2 — core-three resonance badge */}
      <div
        className={`mt-4 rounded-[var(--radius)] border p-4 ${
          bt.resonance.all
            ? "border-[var(--down)] bg-[var(--surface)] shadow-[var(--shadow-card)]"
            : "border-[var(--border)] bg-[var(--surface-2)]/60"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full px-2.5 py-0.5 text-sm font-semibold text-white"
            style={{ background: bt.resonance.all ? "var(--down)" : "var(--dim)" }}
          >
            {bt.resonance.all ? "三信号共振 · 抄底关注" : `核心三信号 ${coreHit}/3`}
          </span>
          {!bt.resonance.all ? <span className="text-sm text-[var(--dim)]">三者同时满足才算共振，目前未共振</span> : null}
        </div>
        <ul className="mt-2 space-y-1 text-sm leading-relaxed">
          {coreRows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-[var(--text)]">
              <span className={r.triggered ? "font-semibold" : "text-[var(--dim)]"}>{r.triggered ? "✓" : "✗"}</span>
              <span className="font-medium">{r.name}</span>
              <span className="text-[var(--dim)]">{r.valueText}</span>
              <span className="text-xs text-[var(--dim)]">（阈值 {r.threshold}）</span>
            </li>
          ))}
        </ul>
        {bt.resonance.all ? (
          <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">均值回归启发式，不是保证：历史上三者同亮时后续赔率向抄底一侧倾斜，但 VIX 可以一直高、纳指也可以随后跌破均线。</p>
        ) : null}
      </div>
      {/* 3 — signal tables */}
      <BtSignalTable title="抄底信号（10 个）" rows={bt.signals.filter((s) => s.side === "bottom")} />
      <BtSignalTable title="逃顶信号（10 个）" rows={bt.signals.filter((s) => s.side === "top")} />
      {/* 4 — history curve */}
      {bt.history.length >= 2 ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold tracking-wide text-[var(--dim)]">历史曲线 · 近 2 年综合指数</h3>
          <div className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
            <SvgLineChart
              labels={bt.history.map((h) => h.date)}
              series={[{ name: "综合指数", color: "var(--accent)", values: bt.history.map((h) => h.composite) }]}
              height={220}
              domain={[-100, 100]}
              bands={[
                { from: -100, to: -50, color: "var(--down)", opacity: 0.12 },
                { from: 30, to: 100, color: "var(--up)", opacity: 0.12 },
              ]}
              hLines={[
                { v: -50, label: "抄底区 ≤ −50", color: "var(--down)" },
                { v: 30, label: "逃顶区 ≥ +30", color: "var(--up)" },
              ]}
              yFormat={(v) => `${v > 0 ? "+" : ""}${v}`}
              valueFormat={(v) => `${v > 0 ? "+" : ""}${v}`}
            />
            {bt.entries.length > 0 ? (
              <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                历次进入极值区：{bt.entries.map((e) => `${e.date} 进${e.zone === "bottom" ? "抄底" : "逃顶"}区`).join("；")}
              </p>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">近 2 年该口径下未进入过抄底区或逃顶区。</p>
            )}
            <p className="mt-2 border-t border-[var(--border)] pt-2 text-xs leading-relaxed text-[var(--dim)]">
              历史曲线口径：仅含可日度回算的 11 个信号（VIX、均线、RSI、回撤、HY 利差），不含恐惧与贪婪、保证金、PE 百分位、P/C、AAII、宽度；与当日综合指数的分母不同，不直接对比数值。
            </p>
          </div>
        </div>
      ) : null}
      {/* 5 — backtest (v121): how the −50 / +30 zone lines were calibrated */}
      <BtBacktestSection />
      {/* 6 — method / limits footer */}
      <div className="mt-6 space-y-2 text-xs leading-relaxed text-[var(--dim)]">
        <p>
          读法：抄底得分 = 已触发的抄底信号占可用信号的比例（0–100），逃顶得分同理，综合指数 = 逃顶得分 − 抄底得分。越靠左，恐慌与超卖信号越密集；越靠右，贪婪与过热信号越密集。信号是同一时点的截面快照：极端读数可以持续数周、甚至变得更极端，历史回测不等于未来。
        </p>
        <p>暂无数据：AAII 看多比例（官网机器人验证拉不到）、成分股宽度（无公开 API）——这两项不计入得分分母；前瞻 PE 百分位在手工积累满 8 期前同样不计入。</p>
        <p className="font-medium text-[var(--text)]">仅供参考，不构成投资建议</p>
      </div>
    </section>
  );
}

function HistoryView({ data, goMethod }: { data: Dashboard; goMethod: (id: string) => void }) {
  const rows = [...data.drawdowns].sort((a, b) => a.currentDd - b.currentDd);
  return (
    <section>
      <SectionHead
        title="历史回撤 · 以史为镜"

      />
      <ScrollHint className="mt-3 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-[var(--text)]">回撤总表 · 按当前回撤深度排序</span>
          <button type="button" onClick={() => goMethod("drawdownepisode")} className="shrink-0 py-1 text-xs text-[var(--accent)]">
            回撤是怎么切分的 →
          </button>
        </div>
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--dim)]">
              <th className="py-1 pr-2 font-normal">标的</th>
              <th className="py-1 pr-2 text-right font-normal">当前回撤</th>
              <th className="py-1 pr-2 text-right font-normal">历史最深</th>
              <th className="py-1 pr-2 text-right font-normal">跌超10%次数</th>
              <th className="py-1 pr-2 text-right font-normal">跌超20%次数</th>
              <th className="py-1 pr-2 text-right font-normal">典型恢复（低点→收复）</th>
              <th className="py-1 text-right font-normal">比这次更深的历史事件</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.key} className="border-b border-[var(--border)] last:border-0">
                <td className="py-2 pr-2 font-medium text-[var(--text)]">
                  {d.name}
                  <span className="ml-1 text-xs font-normal text-[var(--dim)]">近 {d.windowYears} 年</span>
                  {d.thresholdPct !== 8 ? (
                    <span className="ml-1 text-xs font-normal text-[var(--dim)]">· 债券口径 门槛 {d.thresholdPct}%</span>
                  ) : null}
                </td>
                <td className={`py-2 pr-2 text-right font-medium ${d.currentDd <= -10 ? "text-[var(--up)]" : "text-[var(--text)]"}`}>
                  {fmt(d.currentDd, 1)}%
                </td>
                <td className="py-2 pr-2 text-right text-[var(--text)]">{fmt(d.deepest, 1)}%</td>
                <td className="py-2 pr-2 text-right text-[var(--text)]">{d.count10} 次</td>
                <td className="py-2 pr-2 text-right text-[var(--text)]">{d.count20} 次</td>
                <td className="py-2 pr-2 text-right text-[var(--dim)]">
                  {d.medianRecoverDays != null ? `约 ${d.medianRecoverDays} 天` : "—"}
                </td>
                <td className="py-2 text-right text-[var(--dim)]">{d.deeperThanNow} 次</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollHint>

      <div className="mt-4 grid gap-3">
        {rows.map((d) => (
          <article key={d.key} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-serif-sc text-base font-bold text-[var(--text)]">{d.name}</h3>
              <span className="text-xs text-[var(--dim)]">
                当前回撤 {fmt(d.currentDd, 1)}% · 高点 {d.peakDate}（{d.daysSincePeak} 天前）·{" "}
                {d.thresholdPct !== 8
                  ? `债券口径：跌超 ${d.thresholdPct}% 的事件共 ${d.episodeCount} 段，从未跌超 10%`
                  : `跌超 10% 的事件中位深度 ${d.medianDepth != null ? `${fmt(d.medianDepth, 1)}%` : "—"}`}
              </span>
            </div>
            <ScrollHint className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--dim)]">
                    <th className="py-1 pr-2 font-normal">高点</th>
                    <th className="py-1 pr-2 font-normal">低点</th>
                    <th className="py-1 pr-2 text-right font-normal">最大跌幅</th>
                    <th className="py-1 pr-2 text-right font-normal">下跌用时</th>
                    <th className="py-1 pr-2 font-normal">收复日期</th>
                    <th className="py-1 text-right font-normal">低点→收复</th>
                  </tr>
                </thead>
                <tbody>
                  {d.episodes.map((e, i) => (
                    <tr key={i} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-1.5 pr-2 text-[var(--text)]">{e.peakDate}</td>
                      <td className="py-1.5 pr-2 text-[var(--text)]">{e.troughDate}</td>
                      <td className="py-1.5 pr-2 text-right font-medium text-[var(--up)]">{fmt(e.depthPct, 1)}%</td>
                      <td className="py-1.5 pr-2 text-right text-[var(--dim)]">{e.daysDown} 天</td>
                      <td className="py-1.5 pr-2 text-[var(--text)]">{e.recoveryDate ?? "尚未收复"}</td>
                      <td className="py-1.5 text-right text-[var(--dim)]">{e.daysRecover != null ? `${e.daysRecover} 天` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollHint>
            <p className="mt-1.5 text-xs text-[var(--dim)]">
              {d.thresholdPct !== 8
                ? `只列跌幅最深的 ${d.episodes.length} 段（债券口径门槛 ${d.thresholdPct}%，全窗口共 ${d.episodeCount} 段事件；最深一段即全历史最大回撤）。`
                : `只列跌幅最深的 ${d.episodes.length} 段（全窗口共 ${d.count10} 段跌超 10%）。`}
            </p>
          </article>
        ))}
      </div>
      {data.drawdowns.length === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--dim)]">回撤数据尚未生成，请点右上角刷新（新版需要拉取更长历史，第一次会稍久）。</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Wall Street / Portfolio / Calendar views
// ---------------------------------------------------------------------------

function WallStView({ data, goMethod }: { data: Dashboard; goMethod: (id: string) => void }) {
  const vixTerm = data.derived.find((d) => d.key === "vixTerm");
  const hasFred = (key: string) => data.fred.some((f) => f.key === key);
  // Freshness honesty for the 更新于 line: the wallst stage's finishedAt
  // is only the last ATTEMPT time. When that attempt did not fully land
  // (status partial/error — e.g. FRED unreachable all day), the line
  // must say so and point at the real data dates instead of letting
  // the attempt time masquerade as data freshness. The card-date range
  // is computed from the cards actually rendered, so it can never
  // claim fresher data than the page shows.
  // D-P2-5: wallst's own staged row only — an "all"/"legacy" row's
  // status must not be attributed to this block.
  const wallstStage = data.stages.find((s) => s.stage === "wallst");
  const wallstAttemptFailed = wallstStage != null && wallstStage.status !== "ok";
  const fredMissed =
    wallstStage != null && wallstStage.status !== "ok" && wallstStage.detail.includes("FRED");
  const cardDates = data.fred.map((f) => f.date).filter((d) => d.length > 0).sort();
  const newestCardDate = cardDates[cardDates.length - 1];
  const oldestCardDate = cardDates[0];
  const missing: string[] = [];
  if (!hasFred("hySpread")) missing.push("HY/IG 信用利差");
  if (!hasFred("nfci")) missing.push("金融条件指数 NFCI");
  if (!hasFred("corpProfits")) missing.push("企业利润");
  if (!hasFred("broadUsd")) missing.push("广义美元指数");
  return (
    <section>
      <SectionHead
        title="华尔街深钻 · 利率、信用与情绪"

      />
      {wallstAttemptFailed ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--dim)]">
          本模块上次刷新尝试于 {stageTimeText(data.stages, "wallst")}（{wallstStage?.status === "error" ? "失败" : "部分失败"}）——这是最后一次尝试的时间，不是数据日期：
          {fredMissed
            ? "FRED 序列本次未拉到（失败明细见总览顶部刷新状态，本页下方另有缺位说明）；"
            : "部分序列本次未拉到（失败明细见总览顶部刷新状态）；"}
          {data.fred.length > 0
            ? `下方卡片是上次成功落库的数据，各卡的实际数据日期见卡片本身${newestCardDate ? `（本页卡片数据日期最新 ${newestCardDate}${oldestCardDate && oldestCardDate !== newestCardDate ? `、最旧 ${oldestCardDate}` : ""}）` : ""}。`
            : "本页暂无成功落库的数据可显示。"}
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] text-[var(--dim)]">本模块数据更新于 {stageTimeText(data.stages, "wallst")}</p>
      )}
      {data.fred.length > 0 ? (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {data.fred.map((f) => (
              <IndicatorCard key={f.key} ind={f} goMethod={goMethod} />
            ))}
            {vixTerm ? <IndicatorCard ind={vixTerm} goMethod={goMethod} /> : null}
          </div>
          {missing.length > 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">仍缺位：{missing.join("、")}。</p>
          ) : null}
        </>
      ) : (
        <p className="py-10 text-center text-sm leading-relaxed text-[var(--dim)]">本页数据本次未拉到，失败原因见总览顶部刷新状态。</p>
      )}

      {data.seasonality.length > 0 ? (
        <>
          <h3 className="mt-6 text-base font-bold text-[var(--text)]">季节性 · 每个月历史上的平均表现</h3>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            
            <button type="button" onClick={() => goMethod("seasonality")} className="ml-1 py-1 text-xs text-[var(--accent)]">怎么用季节性 →</button>
          </p>
          <div className="mt-2 grid gap-3 lg:grid-cols-3">
            {data.seasonality.map((s) => (
              <div key={s.key} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
                <div className="mb-2 text-sm font-medium text-[var(--text)]">{s.name}</div>
                <div className="grid grid-cols-6 gap-1 text-center">
                  {s.months.map((mo) => (
                    <div key={mo.m} className={`rounded-md px-0.5 py-1.5 ${mo.avg > 0.3 ? "bg-[var(--up)]/10" : mo.avg < -0.3 ? "bg-[var(--down)]/10" : ""}`}>
                      <div className="text-[11px] text-[var(--dim)]">{mo.m}月</div>
                      <div className={`text-xs font-semibold ${moveColor(mo.avg)}`}>{signed(mo.avg, 1)}%</div>
                      <div className="text-[10px] text-[var(--dim)]">胜率 {mo.winRate}%</div>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 text-[11px] text-[var(--dim)]">每格样本约 {s.months[0]?.n ?? 0} 年</div>
              </div>
            ))}
          </div>
        </>
      ) : null}

    </section>
  );
}

function PortfolioView({ data, goMethod }: { data: Dashboard; goMethod: (id: string) => void }) {
  const p = data.portfolio;
  const corrOf = (a: string, b: string): number | null => {
    if (a === b) return 1;
    const hit = p.correlations.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
    return hit ? hit.v : null;
  };
  return (
    <section>
      <SectionHead
        title="组合视角 · 相关性、宽度与模拟配置"

      />
      {data.breadth.length > 0 ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.breadth.map((b) => (
            <div key={b.label} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
              <div className="text-sm font-medium text-[var(--text)]">市场宽度 · {b.label}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-serif-sc text-3xl font-bold text-[var(--text)]">{b.aboveMaPct}%</span>
                <span className="text-sm text-[var(--dim)]">
                  {b.fullMarket
                    ? `的成分股在 200 日线（MA200）之上（共 ${b.total} 只）`
                    : `的标的在年线（MA250）之上（共 ${b.total} 个）`}
                </span>
              </div>
              <div className="mt-2">
                <PctBar percentile={b.aboveMaPct} ariaRound1 />
              </div>
              {b.fullMarket ? (
                <>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">
                    今日涨跌家数（1 日）：<span style={{ color: "var(--up)" }}>↑ 涨 {b.up ?? "—"}</span>
                    {" · "}<span className="text-[var(--dim)]">→ 平 {b.flat ?? "—"}</span>
                    {" · "}<span style={{ color: "var(--down)" }}>↓ 跌 {b.down ?? "—"}</span>
                    
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
                    站上 50 日线 {b.aboveMa50Pct ?? "—"}% · 站上 200 日线 {b.aboveMa200Pct ?? "—"}%。处在 52 周高点附近（距高点 ≤3%）：{b.atHigh} 只；距高点超 30%：{b.farFromHigh ?? "—"} 只。（口径：沪深 300 全部成分股，云图快照，行情截至 {b.asOf || "—"}）
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
                  处在 52 周高点附近：{b.atHigh} 个；低点附近：{b.atLow ?? "—"} 个。（口径：本台跟踪池）
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {p.corrAssets.length > 0 ? (
        <ScrollHint className="mt-4 overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-[var(--text)]">相关性矩阵 · 近 1 年日收益</span>
            <button type="button" onClick={() => goMethod("portfoliomix")} className="shrink-0 py-1 text-xs text-[var(--accent)]">怎么读相关性 →</button>
          </div>
          <table className="w-full min-w-[560px] text-center text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-[var(--dim)]">
                <th className="py-1 pr-2 text-left font-normal"> </th>
                {p.corrAssets.map((a) => (
                  <th key={a.key} className="py-1 font-normal">{a.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.corrAssets.map((ra) => (
                <tr key={ra.key} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-1.5 pr-2 text-left font-medium text-[var(--text)]">{ra.name}</td>
                  {p.corrAssets.map((rb) => {
                    const v = corrOf(ra.key, rb.key);
                    return (
                      <td
                        key={rb.key}
                        className="py-1.5"
                        style={{
                          color: v == null ? "var(--dim)" : v >= 0.5 ? "var(--up)" : v <= -0.2 ? "var(--down)" : "var(--text)",
                          fontWeight: v != null && Math.abs(v) >= 0.5 ? 600 : 400,
                        }}
                      >
                        {v == null ? "—" : v.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollHint>
      ) : null}

      {p.sims.length > 0 ? (
        <>
          <h3 className="mt-6 text-base font-bold text-[var(--text)]">模拟组合 · 固定配比、每月再平衡的历史回测</h3>
          <div className="mt-2 grid gap-3 lg:grid-cols-3">
            {p.sims.map((s) => (
              <article key={s.name} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
                <div className="font-serif-sc text-base font-bold text-[var(--text)]">{s.name}</div>
                <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">{s.desc}</p>
                <div className="mt-2">
                  <MiniChart data={s.curve} color="var(--accent)" />
                  <div className="text-[11px] text-[var(--dim)]">净值曲线（起点 100，月频，近 {s.years} 年）</div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div><div className="text-[11px] text-[var(--dim)]">年化收益</div><div className="font-medium text-[var(--text)]">{signed(s.cagr, 2)}%</div></div>
                  <div><div className="text-[11px] text-[var(--dim)]">年化波动</div><div className="font-medium text-[var(--text)]">{fmt(s.vol, 1)}%</div></div>
                  <div><div className="text-[11px] text-[var(--dim)]">最大回撤</div><div className="font-medium text-[var(--up)]">{fmt(s.maxDd, 1)}%</div></div>
                  <div><div className="text-[11px] text-[var(--dim)]">当前回撤</div><div className="font-medium text-[var(--text)]">{fmt(s.currentDd, 1)}%</div></div>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}

      {data.style.length > 0 ? (
        <>
          <h3 className="mt-6 text-base font-bold text-[var(--text)]">风格因子 · 钱的口味在往哪边偏</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.style.map((s) => (
              <IndicatorCard key={s.key} ind={s} goMethod={goMethod} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function CalendarView({ data, goMethod }: { data: Dashboard; goMethod: (id: string) => void }) {
  const [cat, setCat] = useState<string>("全部");
  const all = data.calendar.events;
  const todayBj = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const nowBjTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  // An event dated today whose stated Beijing release time has already
  // passed counts as released, not "就是今天": it sinks into the past
  // group and carries an 已发布 badge. Only events whose timeText starts
  // with an exact HH:MM can be judged this way — window estimates
  // ("约…日发布") and all-day entries have no release moment to compare.
  const isReleased = (e: (typeof all)[number]) => {
    if (e.past || e.date !== todayBj) return false;
    const m = /^(\d{2}):(\d{2})/.exec(e.timeText);
    if (!m) return false;
    return `${m[1]}:${m[2]}` <= nowBjTime;
  };
  const cats = ["全部", ...new Set(all.map((e) => e.category))];
  const evs = cat === "全部" ? all : all.filter((e) => e.category === cat);
  const upcoming = evs.filter((e) => !e.past && !isReleased(e));
  const past = evs.filter((e) => e.past || isReleased(e));
  const daysUntil = (dstr: string) => Math.round((new Date(`${dstr}T00:00:00Z`).getTime() - new Date(`${todayBj}T00:00:00Z`).getTime()) / 86400000);
  const byDate = new Map<string, typeof evs>();
  for (const e of upcoming) {
    const arr = byDate.get(e.date) ?? [];
    arr.push(e);
    byDate.set(e.date, arr);
  }
  const weekday = (dstr: string) => {
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return names[new Date(`${dstr}T00:00:00Z`).getUTCDay()] ?? "";
  };
  // 议息卡的“预期”对照：日历源不给议息决议的 forecast/previous，而 CME
  // FedWatch 没有免费程序化接口，所以当前目标区间与市场定价是构建时
  // （2026-11-19）人工核实后写死的静态标注，只挂在 2026-12-09（美东）
  // 这次会议的卡片上——日期闸门保证它不会在 12 月决议落地后错误地迁移
  // 到下一次会议。核实依据见 DATA-PLAN v25。
  const nextFomcDecision = all
    .filter((e) => !e.past && !isReleased(e) && e.category === "美联储" && e.title.includes("议息决议"))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const fomcPriced = (e: (typeof evs)[number]) =>
    nextFomcDecision !== undefined && e === nextFomcDecision && e.date <= "2026-12-10";
  const card = (e: (typeof evs)[number], dim = false) => (
    <article key={`${e.date}-${e.title}`} className={`min-w-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-3.5 ${dim ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-medium text-[var(--accent)]">{e.category}</span>
        {e.impact === "High" ? <span className="rounded-full bg-[var(--up)]/15 px-2 py-0.5 text-xs font-medium text-[var(--up)]">高影响</span> : null}
        {e.estimated ? <span className="rounded-full bg-[#c9a227]/15 px-2 py-0.5 text-xs text-[#8a6d1c] dark:text-[#d3a94e]">日期为推算</span> : null}
        {isReleased(e) ? <span className="rounded-full bg-[var(--border)]/70 px-2 py-0.5 text-xs font-medium text-[var(--dim)]">已发布</span> : null}
        <span className="ml-auto text-xs text-[var(--dim)]">{e.timeText}</span>
      </div>
      {/* F-P2-6: phone wraps the full event name (tighter size +
          break-words, same treatment as the overview 近期大事 rows) so
          财报 names like 阿里巴巴 / 拼多多 / 网易 are never cut; ≥sm
          keeps the original size. */}
      <h4 className="mt-1.5 break-words font-serif-sc text-sm font-bold leading-snug text-[var(--text)] sm:text-base sm:leading-normal">{e.title}</h4>
      {fomcPriced(e) ? (
        <div className="mt-1.5 text-sm leading-relaxed text-[var(--text)]">
          <div>
            当前目标区间：<span className="font-semibold">3.75%–4.00%</span>
            <span className="text-[var(--dim)]">（2026-10-28 议息会议维持不变）</span>
          </div>
          <p className="mt-1">
            市场定价：联邦基金期货（CME FedWatch 方法）显示，本次会议<span className="font-medium">加息 25 个基点至 4.00%–4.25% 的概率约 90%</span>，加息 50 个基点约 10%，维持不变与降息均接近 0%——决议本身几乎已被完全定价，真正的“惊奇”更可能来自点阵图与声明措辞。
          </p>
          <div className="mt-1 text-[11px] text-[var(--dim)]">定价来源：联邦基金期货定价（Frenzy Capital Fed Watch 聚合页，CME FedWatch 方法），2026-11-19 构建时核实；定价随数据发布实时变化，决议前以实时值为准。</div>
        </div>
      ) : null}
      {(e.forecast || e.previous) && (
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-[var(--dim)]">
          {e.forecast ? <span>预期：<span className="font-medium text-[var(--text)]">{e.forecast}</span></span> : null}
          {e.previous ? <span>前值：<span className="font-medium text-[var(--text)]">{e.previous}</span></span> : null}
        </div>
      )}
      <div className="mt-1.5 text-[11px] text-[var(--dim)]">来源：{e.source}</div>
    </article>
  );
  return (
    <section>
      <SectionHead
        title="大事日历 · 未来 1–3 个月"

      />
      <p className="mt-1.5 text-[11px] text-[var(--dim)]">日历数据更新于 {stageTimeText(data.stages, "calendar")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {cats.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCat(c)}
            aria-pressed={cat === c}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${cat === c ? "bg-[var(--accent)] text-white" : "bg-[var(--chip-bg)] text-[var(--chip-text)]"}`}
          >
            {c}
            <span className="ml-1 opacity-70">{c === "全部" ? all.filter((e) => !e.past && !isReleased(e)).length : all.filter((e) => e.category === c && !e.past && !isReleased(e)).length}</span>
          </button>
        ))}
        <button type="button" onClick={() => goMethod("eventcalendar")} className="ml-auto py-1.5 text-xs text-[var(--accent)]">
          大事日历怎么用 →
        </button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="临时公告类事件状态">
        {[
          { label: "OPEC / OPEC+ 会议", hit: all.filter((e) => !e.past && !isReleased(e) && e.title.includes("OPEC")).sort((a, b) => a.date.localeCompare(b.date))[0], note: "临时公告制，无固定排期" },
          { label: "美国国债拍卖", hit: all.filter((e) => !e.past && !isReleased(e) && e.title.includes("国债拍卖")).sort((a, b) => a.date.localeCompare(b.date))[0], note: "财政部按季排期" },
        ].map(({ label, hit, note }) => (
          <div key={label} className="flex flex-wrap items-baseline gap-x-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
            <span className="font-semibold text-[var(--text)]">{label}</span>
            {hit ? (
              <span className="text-[var(--text)]">
                下次安排：{hit.date}（{daysUntil(hit.date) === 0 ? "就是今天" : daysUntil(hit.date) === 1 ? "明天" : `${daysUntil(hit.date)} 天后`}）
              </span>
            ) : (
              <span className="text-[var(--dim)]">当前两周窗口内无安排</span>
            )}
            <span className="text-[var(--dim)]">{hit ? "已进入日历源窗口，见下方事件列表。" : `${note}，进入经济日历源的两周窗口时自动出现；窗口内没有即表示近期确实无安排，不是漏抓。`}</span>
          </div>
        ))}
      </div>
      {upcoming.length === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--dim)]">该分类下暂无未来事件。点右上角刷新可更新日历。</p>
      ) : (
        [...byDate.entries()].map(([date, items]) => {
          const du = daysUntil(date);
          return (
            <div key={date} className="mt-5">
              <h3 className="text-sm font-semibold text-[var(--text)]">
                {date} <span className="ml-1 font-normal text-[var(--dim)]">{weekday(date)}</span>
                <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${du === 0 ? "bg-[var(--up)]/15 text-[var(--up)]" : du === 1 ? "bg-[#c9a227]/15 text-[#8a6d1c] dark:text-[#d3a94e]" : "bg-[var(--border)]/60 text-[var(--dim)]"}`}>
                  {du === 0 ? "就是今天" : du === 1 ? "明天" : `${du} 天后`}
                </span>
              </h3>
              <div className="mt-2 grid gap-3 lg:grid-cols-2">{items.map((e) => card(e))}</div>
            </div>
          );
        })
      )}
      {past.length > 0 ? (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-[var(--dim)]">已过去（近 10 天，自动沉底）</h3>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">{past.map((e) => card(e, true))}</div>
        </div>
      ) : null}
      <p className="mt-6 text-xs leading-relaxed text-[var(--dim)]">覆盖说明：两个月开外的部分日期为按发布惯例推算（标「日期为推算」），进入两周窗口后由日历源确切日期替换；OPEC 会议与国债拍卖无固定排期，进入窗口时自动出现。</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Method library view
// ---------------------------------------------------------------------------

function MethodLibrary() {
  const groups = [...new Set(METHODS.map((m) => m.group))];
  return (
    <section>
      <SectionHead
        title="方法库 · 白话讲解"

      />
      {groups.map((g) => (
        <div key={g} className="mt-5">
          <h3 className="text-sm font-semibold tracking-wide text-[var(--dim)]">{g}</h3>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {METHODS.filter((m) => m.group === g).map((m) => (
              <article key={m.id} id={`method-${m.id}`} className="scroll-mt-40 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
                <h4 className="font-serif-sc text-base font-bold text-[var(--text)]">{m.name}</h4>
                <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">{m.plain}</p>
                <p className="mt-2 border-t border-[var(--border)] pt-2 text-sm leading-relaxed text-[var(--dim)]">
                  <span className="font-medium text-[var(--text)]">怎么看：</span>
                  {m.read}
                </p>
              </article>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 美股编年史 — five volumes over the historyofmarket.com open datasets
// (CC BY 4.0, attribution in the footer of the view). All numbers come
// from the stored datasets; anything a dataset does not carry is left
// out rather than filled in. Long-form prose from the source is NOT
// reproduced — the plain-language lines here are the console's own.
// ---------------------------------------------------------------------------

type AnyRec = Record<string, unknown>;
type ChronicleData = ApiResponse<typeof api, "getChronicle">;
const hRec = (v: unknown): AnyRec => (typeof v === "object" && v !== null ? (v as AnyRec) : {});
const hArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const hNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const hStr = (v: unknown): string => (typeof v === "string" ? v : "");
/** Signed percent from a percent value (11.9 → "+11.9%"). */
const hp = (v: number | null, d = 1): string => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
/** Signed percent from a fraction (0.119 → "+11.9%"). */
const hf = (v: number | null, d = 1): string => (v === null ? "—" : hp(v * 100, d));
/** Percent that may arrive as either a fraction or a percent number. */
const hSmart = (v: number | null, d = 1): string => (v === null ? "—" : hp(Math.abs(v) <= 1.5 ? v * 100 : v, d));

function ChLine({
  lines,
  log = false,
  hline,
  height = 150,
  yFmt,
}: {
  lines: { pts: [string, number][]; color: string }[];
  log?: boolean;
  hline?: number;
  height?: number;
  yFmt?: (v: number) => string;
}) {
  const allPts = lines.flatMap((l) => l.pts);
  if (allPts.length < 2) return null;
  const t = (v: number) => (log ? Math.log10(Math.max(v, 1e-6)) : v);
  const rawVals = allPts.map((p) => p[1]);
  let lo = Math.min(...rawVals.map(t));
  let hi = Math.max(...rawVals.map(t));
  if (hline !== undefined) {
    lo = Math.min(lo, t(hline));
    hi = Math.max(hi, t(hline));
  }
  if (hi - lo < 1e-9) hi = lo + 1;
  const W = 640;
  const H = height;
  const pad = 8;
  const X = (i: number, n: number) => pad + (i / Math.max(1, n - 1)) * (W - pad * 2);
  const Y = (v: number) => H - pad - ((t(v) - lo) / (hi - lo)) * (H - pad * 2);
  const fmtY = yFmt ?? ((v: number) => fmt(v, Math.abs(v) < 10 ? 1 : 0));
  const rawLo = log ? Math.pow(10, lo) : lo;
  const rawHi = log ? Math.pow(10, hi) : hi;
  const firstX = lines[0]?.pts[0]?.[0] ?? "";
  const lastLine = lines[0]?.pts ?? [];
  const lastX = lastLine[lastLine.length - 1]?.[0] ?? "";
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img" aria-label="走势图">
        {hline !== undefined ? (
          <line x1={pad} x2={W - pad} y1={Y(hline)} y2={Y(hline)} stroke="var(--dim)" strokeWidth="1" strokeDasharray="4 4" opacity={0.7} />
        ) : null}
        {lines.map((l, li) => (
          <polyline
            key={li}
            fill="none"
            stroke={l.color}
            strokeWidth="1.8"
            strokeLinejoin="round"
            points={l.pts.map((p, i) => `${X(i, l.pts.length).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}
          />
        ))}
      </svg>
      <div className="mt-0.5 flex items-center justify-between text-[11px] text-[var(--dim)]">
        <span>{firstX}</span>
        <span>
          纵轴 {fmtY(rawLo)} – {fmtY(rawHi)}
          {log ? "（对数）" : ""}
        </span>
        <span>{lastX}</span>
      </div>
    </div>
  );
}

function ChBars({ items, height = 150 }: { items: { label: string; value: number }[]; height?: number }) {
  if (items.length < 2) return null;
  const W = 640;
  const H = height;
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.value)), 1);
  const zeroY = H / 2;
  const bw = W / items.length;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img" aria-label="年度涨跌柱状图">
        <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--dim)" strokeWidth="1" opacity={0.6} />
        {items.map((it, i) => {
          const h = (Math.abs(it.value) / maxAbs) * (H / 2 - 6);
          return (
            <rect
              key={i}
              x={i * bw + 0.5}
              y={it.value >= 0 ? zeroY - h : zeroY}
              width={Math.max(1, bw - 1)}
              height={Math.max(1, h)}
              fill={it.value >= 0 ? "var(--up)" : "var(--down)"}
              opacity={0.85}
            />
          );
        })}
      </svg>
      <div className="mt-0.5 flex items-center justify-between text-[11px] text-[var(--dim)]">
        <span>{items[0]?.label}</span>
        <span>
          峰值 {hp(Math.max(...items.map((i) => i.value)))} / 谷值 {hp(Math.min(...items.map((i) => i.value)))}
        </span>
        <span>{items[items.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function ChSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
      <h3 className="font-serif-sc text-base font-bold text-[var(--text)]">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ChStat({ label, value, sub, pct }: { label: string; value: string; sub?: string; pct?: number | null }) {
  return (
    <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2">
      <div className="text-[11px] text-[var(--dim)]">{label}</div>
      <div className="mt-0.5 font-serif-sc text-base font-bold leading-tight text-[var(--text)]">{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] leading-snug text-[var(--dim)]">{sub}</div> : null}
      {/* pct: valuation percentile on the standard coloured scale
          (high PE percentile = expensive = red end). Only the CAPE /
          TTM PE stats pass it. */}
      {pct != null ? (
        <div className="mt-1.5">
          <PctBar percentile={pct} height="h-1.5" />
        </div>
      ) : null}
    </div>
  );
}

function ChStatsRow({ items }: { items: { label: string; value: string; sub?: string; pct?: number | null }[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((it) => (
        <ChStat key={it.label} {...it} />
      ))}
    </div>
  );
}

const DRIVER_LABEL: Record<string, string> = {
  pe: "估值驱动",
  eps: "盈利驱动",
  both: "双轮驱动",
  opposite_pe: "盈利拖累",
  opposite_eps: "估值拖累",
};
const DD_CAT_LABEL: Record<string, string> = {
  bear_market: "熊市",
  correction: "深度回调",
  narrative_break: "叙事破裂",
  mechanical_scare: "技术性惊吓",
  crash: "崩盘",
  credit_destruction: "信用危机",
  severe_bear: "深度熊市",
  exogenous_shock: "外部冲击",
  policy_shift: "政策转向",
};

function ChronicleView({
  data,
  stages,
  goView,
}: {
  data: ChronicleData | undefined;
  stages: Dashboard["stages"];
  goView: (v: View) => void;
}) {
  const [chapter, setChapter] = useState(0);
  const [sectorTab, setSectorTab] = useState<"semi" | "xlk" | "fin" | "consumer">("semi");
  const [buyYear, setBuyYear] = useState<number | null>(null);
  const [sellYear, setSellYear] = useState<number | null>(null);
  const D: Record<string, unknown> = data?.datasets ?? {};
  const g = (k: string) => hRec(D[k]);
  const stageInfo = stages.find((s) => s.stage === "chronicle");
  const chapters = ["卷一 · 世纪回报", "卷二 · 估值锚点", "卷三 · 危机节奏", "卷四 · 内部骨骼", "卷五 · 板块卷"];

  if (!data) {
    return <p className="py-16 text-center text-sm text-[var(--dim)]">正在读取编年史静态库…</p>;
  }
  if (!data.hasData) {
    return (
      <div className="py-16 text-center">
        <h2 className="font-serif-sc text-xl font-bold text-[var(--text)]">编年史静态库还没有数据</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[var(--dim)]">
          点页面右上角「刷新数据」，「美股编年史」分块会把 historyofmarket.com 的开放数据集（CC BY 4.0）一次性种子入库；
          之后每次刷新只按 manifest 哈希拉取真正变了的数据集，未变的直接跳过。
        </p>
      </div>
    );
  }

  // ---- shared parsed series -------------------------------------------
  const annual = g("sp500/annual-returns");
  const aSeries = hArr(annual["series"])
    .map((r) => hRec(r))
    .filter((r) => hNum(r["year"]) !== null && hNum(r["value"]) !== null)
    .map((r) => ({ year: hNum(r["year"])!, value: hNum(r["value"])!, ytd: r["ytd"] === true }));
  const trDs = g("sp500/annual-tr");
  const trAll = hArr(trDs["series"])
    .map((r) => hRec(r))
    .filter((r) => hNum(r["year"]) !== null && hNum(r["value"]) !== null)
    .map((r) => ({ year: hNum(r["year"])!, value: hNum(r["value"])! }));
  const trCompleteN = hNum(trDs["completeYears"]) ?? trAll.length;
  const trSeries = trAll.slice(0, trCompleteN);
  const trAvg = hNum(trDs["average"]);

  return (
    <div>
      <SectionHead
        title="美股编年史 · 一百年的标普 500"

      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        <button type="button" onClick={() => goView("history")} className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text)]">
          活数据：历史回撤 →
        </button>
        <button type="button" onClick={() => goView("signals")} className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text)]">
          活数据：决策信号 →
        </button>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="编年史分卷">
        {chapters.map((c, i) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={chapter === i}
            onClick={() => setChapter(i)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${chapter === i ? "bg-[var(--accent)] text-white" : "bg-[var(--chip-bg)] text-[var(--chip-text)]"}`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="grid gap-3 grid-cols-[minmax(0,1fr)]">
        {chapter === 0 ? (
          <>
            <ChSection
              title="年度回报全景（1928 至今）"

            >
              <ChStatsRow
                items={[
                  { label: "完整年度", value: `${hNum(annual["completeYears"]) ?? aSeries.length} 年`, sub: `${aSeries[0]?.year ?? 1928}–${aSeries[aSeries.length - 1]?.year ?? ""}` },
                  { label: "价格口径 涨 / 跌 / 平", value: `${hNum(annual["positiveYears"]) ?? "—"} / ${hNum(annual["negativeYears"]) ?? "—"} / ${hNum(annual["flatYears"]) ?? "—"}`, sub: "只看指数点位" },
                  { label: "含息全收益 涨 / 跌", value: `${hNum(trDs["positiveYears"]) ?? "—"} / ${hNum(trDs["negativeYears"]) ?? "—"}`, sub: "股息再投资后" },
                  { label: "全收益算术平均", value: hp(trAvg), sub: "但真正贴着均值的年份极少（见下）" },
                ]}
              />
              <div className="mt-3">
                <ChBars items={aSeries.filter((r) => !r.ytd).map((r) => ({ label: String(r.year), value: r.value }))} />
              </div>
              {aSeries.some((r) => r.ytd) ? (
                <p className="mt-2 text-[11px] text-[var(--dim)]">
                  {aSeries[aSeries.length - 1]?.year} 年至今（未完整年度）：{hp(aSeries[aSeries.length - 1]?.value ?? null)}，未计入上面的涨跌家数。
                </p>
              ) : null}
            </ChSection>

            <ChSection
              title="回报分布：平均数是个谎言"

            >
              {(() => {
                const buckets: { label: string; test: (v: number) => boolean }[] = [
                  { label: "≤ −20%", test: (v) => v <= -20 },
                  { label: "−20 ~ −10%", test: (v) => v > -20 && v <= -10 },
                  { label: "−10 ~ 0%", test: (v) => v > -10 && v < 0 },
                  { label: "0 ~ 10%", test: (v) => v >= 0 && v < 10 },
                  { label: "10 ~ 20%", test: (v) => v >= 10 && v < 20 },
                  { label: "20 ~ 30%", test: (v) => v >= 20 && v < 30 },
                  { label: "> 30%", test: (v) => v >= 30 },
                ];
                const nearMean = trAvg === null ? 0 : trSeries.filter((r) => Math.abs(r.value - trAvg) <= 2).length;
                return (
                  <div>
                    <div className="space-y-1.5">
                      {buckets.map((b) => {
                        const n = trSeries.filter((r) => b.test(r.value)).length;
                        return (
                          <div key={b.label} className="flex items-center gap-2 text-xs">
                            <span className="w-24 shrink-0 text-[var(--dim)]">{b.label}</span>
                            <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--border)]/40">
                              <div className="h-full bg-[var(--accent)]/70" style={{ width: `${trSeries.length ? (n / trSeries.length) * 100 : 0}%` }} />
                            </div>
                            <span className="w-10 shrink-0 text-right font-medium text-[var(--text)]">{n} 年</span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                      全收益算术平均 {hp(trAvg)}，落在平均 ±2 个百分点内的年份只有 {nearMean} 个——「平均年」在历史上基本不存在。
                    </p>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="买入年 × 卖出年：年化回报矩阵"

            >
              {(() => {
                const years = trSeries.map((r) => r.year);
                const b = buyYear !== null && years.includes(buyYear) ? buyYear : (years[Math.min(30, years.length - 1)] ?? years[0] ?? 1958);
                const sl = sellYear !== null && years.includes(sellYear) ? sellYear : (years[years.length - 1] ?? 2025);
                const span = trSeries.filter((r) => r.year > b && r.year <= sl);
                const prod = span.reduce((a, r) => a * (1 + r.value / 100), 1);
                const cagr = span.length > 0 ? (Math.pow(prod, 1 / span.length) - 1) * 100 : null;
                return (
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <label className="flex items-center gap-1.5 text-[var(--dim)]">
                        买入年末
                        <select value={b} onChange={(e) => setBuyYear(Number(e.target.value))} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[var(--text)]" aria-label="买入年份">
                          {years.slice(0, -1).map((y) => (
                            <option key={y} value={y}>{y}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5 text-[var(--dim)]">
                        卖出年末
                        <select value={sl} onChange={(e) => setSellYear(Number(e.target.value))} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[var(--text)]" aria-label="卖出年份">
                          {years.slice(1).map((y) => (
                            <option key={y} value={y}>{y}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {sl > b && span.length > 0 ? (
                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <ChStat label="持有年数" value={`${span.length} 年`} />
                        <ChStat label="累计全收益" value={hp((prod - 1) * 100)} />
                        <ChStat label="年化全收益" value={hp(cagr, 2)} />
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-[var(--dim)]">卖出年份要晚于买入年份。</p>
                    )}
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="五年滚动年化：时间是最便宜的分散"

            >
              {(() => {
                const roll: { year: number; v: number }[] = [];
                for (let i = 4; i < trSeries.length; i++) {
                  const w = trSeries.slice(i - 4, i + 1);
                  const prod = w.reduce((a, r) => a * (1 + r.value / 100), 1);
                  roll.push({ year: w[w.length - 1]!.year, v: (Math.pow(prod, 1 / 5) - 1) * 100 });
                }
                const sorted = [...roll].map((r) => r.v).sort((a, b) => a - b);
                const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
                const neg = roll.filter((r) => r.v < 0).length;
                return (
                  <div>
                    <ChStatsRow
                      items={[
                        { label: "五年窗口总数", value: `${roll.length} 个` },
                        { label: "负收益窗口", value: `${neg} 个`, sub: roll.length ? `占 ${(neg / roll.length * 100).toFixed(1)}%` : "" },
                        { label: "中位数年化", value: hp(median, 2) },
                        { label: "最差窗口", value: hp(sorted[0] ?? null, 2), sub: `最好 ${hp(sorted[sorted.length - 1] ?? null, 2)}` },
                      ]}
                    />
                    <div className="mt-3">
                      <ChLine lines={[{ pts: roll.map((r) => [String(r.year), r.v] as [string, number]), color: "var(--accent)" }]} hline={0} yFmt={(v) => `${v.toFixed(0)}%`} />
                    </div>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="百年对数图：牛熊看斜率"

            >
              {(() => {
                const c = g("sp500/century");
                const pts = hArr(c["series"])
                  .map((r) => hRec(r))
                  .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                  .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["value"])!] as [string, number]);
                return (
                  <div>
                    <ChStatsRow
                      items={[
                        { label: "价格年化（1928 至今）", value: hp((hNum(c["cagr"]) ?? 0) * 100, 2), sub: "不含股息" },
                        { label: "最新点位", value: pts.length ? fmt(pts[pts.length - 1]![1], 0) : "—", sub: pts.length ? pts[pts.length - 1]![0] : "" },
                      ]}
                    />
                    <div className="mt-3">
                      <ChLine lines={[{ pts, color: "var(--accent)" }]} log height={170} />
                    </div>
                  </div>
                );
              })()}
            </ChSection>
          </>
        ) : null}

        {chapter === 1 ? (
          <>
            <ChSection
              title="席勒 CAPE 与 TTM 市盈率（1871 至今，年末值）"

            >
              {(() => {
                const peDs = g("sp500/pe");
                const yearly = (field: string) =>
                  hArr(peDs[field])
                    .map((r) => hRec(r))
                    .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                    .map((r) => ({ date: hStr(r["date"]), value: hNum(r["value"])! }));
                const cape = yearly("cape");
                const pe = yearly("pe");
                const pctOf = (arr: { value: number }[]) => {
                  if (!arr.length) return null;
                  const last = arr[arr.length - 1]!.value;
                  return Math.round((arr.filter((x) => x.value <= last).length / arr.length) * 100);
                };
                const med = (arr: { value: number }[]) => {
                  const srt = [...arr].map((x) => x.value).sort((a, b) => a - b);
                  return srt.length ? srt[Math.floor(srt.length / 2)]! : null;
                };
                return (
                  <div>
                    <ChStatsRow
                      items={[
                        { label: "CAPE 最新", value: cape.length ? fmt(cape[cape.length - 1]!.value, 1) : "—", sub: `历史第 ${pctOf(cape) ?? "—"} 百分位 · 中位 ${med(cape) !== null ? fmt(med(cape)!, 1) : "—"}`, pct: pctOf(cape) },
                        { label: "TTM PE 最新", value: pe.length ? fmt(pe[pe.length - 1]!.value, 1) : "—", sub: `历史第 ${pctOf(pe) ?? "—"} 百分位 · 中位 ${med(pe) !== null ? fmt(med(pe)!, 1) : "—"}`, pct: pctOf(pe) },
                      ]}
                    />
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">CAPE（1871–）</div>
                      <ChLine lines={[{ pts: cape.map((r) => [r.date.slice(0, 4), r.value] as [string, number]), color: "var(--accent)" }]} height={130} />
                    </div>
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">TTM PE（1871–）</div>
                      <ChLine lines={[{ pts: pe.map((r) => [r.date.slice(0, 4), r.value] as [string, number]), color: "var(--gold)" }]} height={130} />
                    </div>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="远期市盈率：市场愿意为明年付多少倍"

            >
              {(() => {
                const fwd = g("sp500/forward-pe");
                const cur = hRec(fwd["current"]);
                const fSeries = hArr(fwd["forward"])
                  .map((r) => hRec(r))
                  .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                  .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["value"])!] as [string, number]);
                return (
                  <div>
                    <ChStatsRow
                      items={[
                        { label: "TTM PE（当前）", value: hNum(cur["trailing"]) !== null ? fmt(hNum(cur["trailing"])!, 1) : "—" },
                        { label: "远期 PE（一致预期）", value: hNum(cur["forward"]) !== null ? fmt(hNum(cur["forward"])!, 1) : "—" },
                        { label: "远期 PE（自算口径）", value: hNum(cur["forwardOwn"]) !== null ? fmt(hNum(cur["forwardOwn"])!, 1) : "—" },
                      ]}
                    />
                    <div className="mt-3">
                      <ChLine lines={[{ pts: fSeries, color: "var(--accent)" }]} height={130} />
                    </div>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="EPS 与 ROE：价格的另一条腿"

            >
              {(() => {
                const eps = hArr(g("sp500/eps")["series"])
                  .map((r) => hRec(r))
                  .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                  .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["value"])!] as [string, number]);
                const roeDs = g("sp500/roe");
                const roe = hArr(roeDs["series"])
                  .map((r) => hRec(r))
                  .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                  .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["value"])!] as [string, number]);
                return (
                  <div>
                    <ChStatsRow
                      items={[
                        { label: "EPS 最新", value: eps.length ? fmt(eps[eps.length - 1]![1], 1) : "—", sub: eps.length ? eps[eps.length - 1]![0] : "" },
                        { label: "ROE 最新", value: roe.length ? `${fmt(roe[roe.length - 1]![1], 1)}%` : "—", sub: `1960 年以来平均 ${hNum(roeDs["average"]) !== null ? fmt(hNum(roeDs["average"])!, 1) : "—"}%` },
                      ]}
                    />
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">标普 500 EPS（1871–，对数）</div>
                      <ChLine lines={[{ pts: eps, color: "var(--accent)" }]} log height={130} />
                    </div>
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">标普 500 ROE（1960–）</div>
                      <ChLine lines={[{ pts: roe, color: "var(--gold)" }]} height={120} yFmt={(v) => `${v.toFixed(0)}%`} />
                    </div>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="驱动分解：每年的涨跌是谁干的"

            >
              {(() => {
                const dd = g("sp500/driver-decomp");
                const sum = hRec(dd["summary"]);
                const rows = hArr(dd["series"]).map((r) => hRec(r)).slice(-15).reverse();
                return (
                  <div>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        ["估值驱动", hNum(sum["n_pe_driven"])],
                        ["盈利驱动", hNum(sum["n_eps_driven"])],
                        ["双轮驱动", hNum(sum["n_both_driven"])],
                        ["估值涨·盈利跌", hNum(sum["n_opposite_pe"])],
                        ["盈利涨·估值跌", hNum(sum["n_opposite_eps"])],
                      ].map(([label, n]) => (
                        <span key={label as string} className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text)]">
                          {label} {n ?? "—"} 年
                        </span>
                      ))}
                    </div>
                    <ScrollHint className="mt-3 overflow-x-auto" fadeBg="var(--bg)">
                      <table className="w-full min-w-[520px] text-xs">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                            <th className="py-1.5 pr-2 font-medium">年份</th>
                            <th className="py-1.5 pr-2 text-right font-medium">价格回报</th>
                            <th className="py-1.5 pr-2 text-right font-medium">PE 变化</th>
                            <th className="py-1.5 pr-2 text-right font-medium">EPS 变化</th>
                            <th className="py-1.5 font-medium">主导</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={String(r["year"])} className="border-b border-[var(--border)]/50">
                              <td className="py-1 pr-2 font-medium text-[var(--text)]">{String(r["year"] ?? "")}</td>
                              <td className={`py-1 pr-2 text-right ${moveColor(hNum(r["priceReturn"]) ?? 0)}`}>{hf(hNum(r["priceReturn"]))}</td>
                              <td className={`py-1 pr-2 text-right ${moveColor(hNum(r["peChange"]) ?? 0)}`}>{hf(hNum(r["peChange"]))}</td>
                              <td className={`py-1 pr-2 text-right ${moveColor(hNum(r["epsChange"]) ?? 0)}`}>{hf(hNum(r["epsChange"]))}</td>
                              <td className="py-1 text-[var(--dim)]">{DRIVER_LABEL[hStr(r["driver"])] ?? hStr(r["driver"])}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ScrollHint>
                    <p className="mt-1.5 text-[11px] text-[var(--dim)]">仅列最近 15 年；全样本计数见上方徽章。</p>
                  </div>
                );
              })()}
            </ChSection>
          </>
        ) : null}

        {chapter === 2 ? (
          <>
            <ChSection
              title="重大跌幅名册（1929 至今）"

            >
              {(() => {
                const ddDs = g("sp500/drawdowns");
                const rows = hArr(ddDs["drawdowns"])
                  .map((r) => hRec(r))
                  .filter((r) => hNum(r["decline"]) !== null)
                  .sort((a, b) => (hNum(a["decline"]) ?? 0) - (hNum(b["decline"]) ?? 0))
                  .slice(0, 15);
                return (
                  <ScrollHint className="overflow-x-auto" fadeBg="var(--bg)">
                    <table className="w-full min-w-[640px] text-xs">
                      <thead>
                        <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                          <th className="py-1.5 pr-2 font-medium">区间</th>
                          <th className="py-1.5 pr-2 text-right font-medium">跌幅</th>
                          <th className="py-1.5 pr-2 text-right font-medium">下跌天数</th>
                          <th className="py-1.5 pr-2 font-medium">分类</th>
                          <th className="py-1.5 pr-2 font-medium">诱因</th>
                          <th className="py-1.5 text-right font-medium">收复用时</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} className="border-b border-[var(--border)]/50">
                            <td className="py-1 pr-2 text-[var(--text)]">{hStr(r["period"])}</td>
                            <td className="py-1 pr-2 text-right font-medium text-[var(--down)]">{hf(hNum(r["decline"]))}</td>
                            <td className="py-1 pr-2 text-right text-[var(--dim)]">{hNum(r["days"]) ?? "—"} 天</td>
                            <td className="py-1 pr-2 text-[var(--dim)]">{DD_CAT_LABEL[hStr(r["category"])] ?? hStr(r["category"])}</td>
                            <td className="py-1 pr-2 text-[var(--text)]">{hStr(r["cause"])}</td>
                            <td className="py-1 text-right text-[var(--dim)]">
                              {r["active"] === true ? "进行中" : hNum(r["recovery_days"]) !== null ? `${hNum(r["recovery_days"])} 天` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1.5 text-[11px] text-[var(--dim)]">按跌幅列前 15 次；名册共 {hArr(ddDs["drawdowns"]).length} 次。逐标的的回撤事件全表在「历史回撤」页。</p>
                  </ScrollHint>
                );
              })()}
            </ChSection>

            <ChSection
              title="年内最深跌幅 vs 全年涨跌"

            >
              {(() => {
                const intra = g("sp500/intrayear-dd");
                const sum = hRec(intra["summary"]);
                const annualRows = hArr(intra["annual"])
                  .map((r) => hRec(r))
                  .filter((r) => hNum(r["dd"]) !== null)
                  .map((r) => ({ label: String(hNum(r["year"]) ?? ""), value: (hNum(r["dd"]) ?? 0) * 100 }));
                return (
                  <div>
                    <ChStatsRow
                      items={[
                        { label: "平均年内最深跌幅", value: hf(hNum(sum["avg_dd"])), sub: "1928–今，价格口径" },
                        { label: "平均全年回报", value: hf(hNum(sum["avg_tr"])), sub: "价格口径" },
                        { label: "年末收正年份", value: hNum(sum["positive_years_pct"]) !== null ? `${((hNum(sum["positive_years_pct"]) ?? 0) * 100).toFixed(0)}%` : "—", sub: `${hNum(sum["positive_years"]) ?? "—"} / ${hNum(sum["n_years"]) ?? "—"} 年` },
                      ]}
                    />
                    <div className="mt-3">
                      <ChBars items={annualRows} height={120} />
                    </div>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="波动率与 VIX：恐慌的体温"

            >
              {(() => {
                const vol = hArr(g("sp500/volatility")["series"])
                  .map((r) => hRec(r))
                  .filter((r) => hStr(r["date"]) && hNum(r["vol20"]) !== null);
                const vol20 = vol.map((r) => [hStr(r["date"]).slice(0, 4), (hNum(r["vol20"]) ?? 0) * 100] as [string, number]);
                const vol60 = vol.map((r) => [hStr(r["date"]).slice(0, 4), (hNum(r["vol60"]) ?? 0) * 100] as [string, number]);
                const medVol = (() => {
                  const srt = vol.map((r) => hNum(r["vol20"]) ?? 0).sort((a, b) => a - b);
                  return srt.length ? srt[Math.floor(srt.length / 2)]! * 100 : null;
                })();
                const vixDs = g("sp500/vix");
                const vixLatest = hRec(vixDs["latest"]);
                const vix = hArr(vixDs["series"])
                  .map((r) => hRec(r))
                  .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                  .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["value"])!] as [string, number]);
                return (
                  <div>
                    <ChStatsRow
                      items={[
                        { label: "20 日波动率中位（月末样本）", value: medVol !== null ? `${fmt(medVol, 1)}%` : "—" },
                        { label: "最新 20 日波动率", value: vol.length ? `${fmt((hNum(vol[vol.length - 1]!["vol20"]) ?? 0) * 100, 1)}%` : "—", sub: vol.length ? hStr(vol[vol.length - 1]!["date"]) : "" },
                        { label: "VIX 最新", value: hNum(vixLatest["value"]) !== null ? fmt(hNum(vixLatest["value"])!, 1) : "—", sub: hStr(vixLatest["date"]) },
                      ]}
                    />
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">滚动年化波动率（1928–，月末）：红 = 20 日 · 金 = 60 日</div>
                      <ChLine lines={[{ pts: vol20, color: "var(--up)" }, { pts: vol60, color: "var(--gold)" }]} height={130} yFmt={(v) => `${v.toFixed(0)}%`} />
                    </div>
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">VIX（1990–，月末）</div>
                      <ChLine lines={[{ pts: vix, color: "var(--accent)" }]} height={110} />
                    </div>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="月度季节性（2000 至今）"

            >
              {(() => {
                const mDs = g("sp500/monthly");
                const years = hArr(mDs["years"]).map((r) => hRec(r)).slice(-18);
                const prob = hRec(mDs["probability"]);
                const monthAvg = (m: number) => {
                  const vals = years.map((y) => hNum(hRec(y["months"])[String(m)])).filter((v): v is number => v !== null);
                  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                };
                const cell = (v: number | null) => {
                  if (v === null) return <span className="text-[var(--dim)]">—</span>;
                  const a = Math.min(0.85, Math.abs(v) * 8.5);
                  const bg = v >= 0 ? `rgba(192,57,43,${a.toFixed(2)})` : `rgba(30,125,79,${a.toFixed(2)})`;
                  return (
                    <span className="block rounded px-0.5 py-1 text-center" style={{ backgroundColor: bg, color: a > 0.45 ? "#fff" : undefined }}>
                      {(v * 100).toFixed(1)}
                    </span>
                  );
                };
                return (
                  <ScrollHint className="overflow-x-auto" fadeBg="var(--bg)">
                    <table className="w-full min-w-[680px] text-[11px]">
                      <thead>
                        <tr className="text-[var(--dim)]">
                          <th className="py-1 pr-1 text-left font-medium">年份</th>
                          {Array.from({ length: 12 }, (_, i) => (
                            <th key={i} className="py-1 font-medium">{i + 1}月</th>
                          ))}
                          <th className="py-1 pl-1 text-right font-medium">全年</th>
                        </tr>
                      </thead>
                      <tbody>
                        {years.map((y) => {
                          const months = hRec(y["months"]);
                          return (
                            <tr key={String(y["year"])}>
                              <td className="py-0.5 pr-1 font-medium text-[var(--text)]">{String(y["year"] ?? "")}</td>
                              {Array.from({ length: 12 }, (_, i) => (
                                <td key={i} className="px-0.5 py-0.5">{cell(hNum(months[String(i + 1)]))}</td>
                              ))}
                              <td className={`py-0.5 pl-1 text-right font-medium ${moveColor(hNum(y["annual"]) ?? 0)}`}>{hf(hNum(y["annual"]))}</td>
                            </tr>
                          );
                        })}
                        <tr className="border-t border-[var(--border)]">
                          <td className="py-1 pr-1 font-medium text-[var(--text)]">平均</td>
                          {Array.from({ length: 12 }, (_, i) => (
                            <td key={i} className="px-0.5 py-0.5">{cell(monthAvg(i + 1))}</td>
                          ))}
                          <td className="py-1 pl-1" />
                        </tr>
                        <tr>
                          <td className="py-1 pr-1 font-medium text-[var(--text)]">上涨概率</td>
                          {Array.from({ length: 12 }, (_, i) => (
                            <td key={i} className="px-0.5 py-1 text-center text-[var(--dim)]">
                              {hNum(prob[String(i + 1)]) !== null ? `${((hNum(prob[String(i + 1)]) ?? 0) * 100).toFixed(0)}%` : "—"}
                            </td>
                          ))}
                          <td className="py-1 pl-1" />
                        </tr>
                      </tbody>
                    </table>
                    <p className="mt-1.5 text-[11px] text-[var(--dim)]">热力图为最近 {years.length} 年；上涨概率为数据集 2000 年以来全样本口径。</p>
                  </ScrollHint>
                );
              })()}
            </ChSection>
          </>
        ) : null}

        {chapter === 3 ? (
          <>
            <ChSection
              title="GICS 十一行业权重：指数的配料表"

            >
              {(() => {
                const sectors = hArr(g("sp500/sectors")["sectors"])
                  .map((r) => hRec(r))
                  .filter((r) => hNum(r["weight"]) !== null)
                  .sort((a, b) => (hNum(b["weight"]) ?? 0) - (hNum(a["weight"]) ?? 0));
                const maxW = Math.max(...sectors.map((r) => hNum(r["weight"]) ?? 0), 1);
                return (
                  <div className="space-y-1.5">
                    {sectors.map((sec) => (
                      <div key={hStr(sec["id"])} className="flex items-center gap-2 text-xs">
                        <span className="w-20 shrink-0 font-medium text-[var(--text)]">{hStr(sec["name"])}</span>
                        <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--border)]/40">
                          <div className="h-full" style={{ width: `${((hNum(sec["weight"]) ?? 0) / maxW) * 100}%`, backgroundColor: hStr(sec["color"]) || "var(--accent)" }} />
                        </div>
                        <span className="w-12 shrink-0 text-right font-medium text-[var(--text)]">{fmt(hNum(sec["weight"]) ?? 0, 1)}%</span>
                        <span className="hidden w-44 shrink-0 truncate text-[var(--dim)] sm:block">{hArr(sec["examples"]).map((e) => hStr(e)).join(" · ")}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="集中度：前十名占了快四成"

            >
              {(() => {
                const latest = g("latest/concentration");
                const shares = hRec(latest["topShares"]);
                const names = hArr(shares["names"] ?? latest["top10"] ?? shares["top10Names"]).map((n) => (typeof n === "string" ? n : hStr(hRec(n)["ticker"] || hRec(n)["name"]))).filter(Boolean);
                const conc = hArr(g("mag7/concentration")["series"])
                  .map((r) => hRec(r))
                  .filter((r) => hStr(r["date"]) && hNum(r["weight"]) !== null)
                  .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["weight"])!] as [string, number]);
                return (
                  <div>
                    <ChStatsRow
                      items={[
                        { label: "第 1 大权重", value: hNum(shares["top1"]) !== null ? `${fmt(hNum(shares["top1"])!, 1)}%` : "—", sub: hStr(shares["asOf"]) },
                        { label: "前 3 大合计", value: hNum(shares["top3"]) !== null ? `${fmt(hNum(shares["top3"])!, 1)}%` : "—" },
                        { label: "前 10 大合计", value: hNum(shares["top10"]) !== null ? `${fmt(hNum(shares["top10"])!, 1)}%` : "—" },
                        { label: "七姐妹权重（最新季度）", value: conc.length ? `${fmt(conc[conc.length - 1]![1], 1)}%` : "—", sub: conc.length ? `${conc[0]![0]} 年为 ${fmt(conc[0]![1], 1)}%` : "" },
                      ]}
                    />
                    {names.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {names.map((n) => (
                          <span key={n} className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text)]">{n}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">七姐妹占标普市值权重（2018–，季度）</div>
                      <ChLine lines={[{ pts: conc, color: "var(--accent)" }]} height={120} yFmt={(v) => `${v.toFixed(0)}%`} />
                    </div>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="七姐妹等权指数与各自回撤"

            >
              {(() => {
                const idx = g("mag7/index");
                const idxPts = hArr(idx["indexSeries"])
                  .map((r) => hRec(r))
                  .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                  .map((r) => [hStr(r["date"]).slice(0, 7), hNum(r["value"])!] as [string, number]);
                const members = hArr(idx["members"]).map((r) => hRec(r));
                const ddMembers = hArr(g("mag7/drawdown")["members"]).map((r) => hRec(r));
                return (
                  <div>
                    <ChLine lines={[{ pts: idxPts, color: "var(--accent)" }]} height={130} />
                    {members.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {members.map((m) => (
                          <span key={hStr(m["ticker"])} className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text)]">
                            {hStr(m["ticker"])}
                            {hNum(m["returnMultiple"]) !== null ? ` · 2022 年以来 ×${fmt(hNum(m["returnMultiple"])!, 2)}` : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {ddMembers.length ? (
                      <ScrollHint className="mt-3 overflow-x-auto" fadeBg="var(--bg)">
                        <table className="w-full min-w-[480px] text-xs">
                          <thead>
                            <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                              <th className="py-1.5 pr-2 font-medium">个股</th>
                              <th className="py-1.5 pr-2 text-right font-medium">史上最深回撤</th>
                              <th className="py-1.5 pr-2 font-medium">最深时点</th>
                              <th className="py-1.5 text-right font-medium">当前距高点</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ddMembers.map((m) => {
                              const deepest = hRec(m["deepest"]);
                              const latestM = hRec(m["latest"]);
                              return (
                                <tr key={hStr(m["ticker"])} className="border-b border-[var(--border)]/50">
                                  <td className="py-1 pr-2 font-medium text-[var(--text)]">{hStr(m["ticker"])}</td>
                                  <td className="py-1 pr-2 text-right text-[var(--down)]">{hf(hNum(deepest["drawdown"]))}</td>
                                  <td className="py-1 pr-2 text-[var(--dim)]">{hStr(deepest["date"])}</td>
                                  <td className="py-1 text-right text-[var(--text)]">{hf(hNum(latestM["drawdown"]))}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </ScrollHint>
                    ) : null}
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="七姐妹 vs 1999 年泡沫顶点：估值并置"

            >
              {(() => {
                const ai = g("mag7/ai-valuation");
                const members = hArr(ai["members"]).map((r) => hRec(r));
                const refs = hArr(ai["reference_1999"]).map((r) => hRec(r));
                return (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">现在（数据集最新快照）</div>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                            <th className="py-1 pr-2 font-medium">个股</th>
                            <th className="py-1 pr-2 text-right font-medium">TTM PE</th>
                            <th className="py-1 text-right font-medium">远期 PE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m) => {
                            const snap = hRec(m["snapshot"]);
                            return (
                              <tr key={hStr(m["ticker"])} className="border-b border-[var(--border)]/50">
                                <td className="py-1 pr-2 font-medium text-[var(--text)]">{hStr(m["ticker"])}</td>
                                <td className="py-1 pr-2 text-right text-[var(--text)]">{hNum(snap["trailingPE"]) !== null ? fmt(hNum(snap["trailingPE"])!, 1) : "—"}</td>
                                <td className="py-1 text-right text-[var(--text)]">{hNum(snap["forwardPE"]) !== null ? fmt(hNum(snap["forwardPE"])!, 1) : "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <div className="mb-1 text-xs font-medium text-[var(--text)]">1999–2000 顶点标杆（峰值远期 PE）</div>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                            <th className="py-1 pr-2 font-medium">个股</th>
                            <th className="py-1 pr-2 text-right font-medium">峰值远期 PE</th>
                            <th className="py-1 text-right font-medium">峰值时点</th>
                          </tr>
                        </thead>
                        <tbody>
                          {refs.map((m) => (
                            <tr key={hStr(m["ticker"])} className="border-b border-[var(--border)]/50">
                              <td className="py-1 pr-2 font-medium text-[var(--text)]">{hStr(m["ticker"])}</td>
                              <td className="py-1 pr-2 text-right text-[var(--text)]">{hNum(m["peakForwardPE"]) !== null ? `${fmt(hNum(m["peakForwardPE"])!, 0)}×` : "—"}</td>
                              <td className="py-1 text-right text-[var(--dim)]">{hStr(m["peakDate"])}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="每一代都有自己的「必持名单」"

            >
              {(() => {
                const gens = hArr(g("mag7/predecessors")["generations"]).map((r) => hRec(r));
                return (
                  <div className="flex flex-wrap gap-1.5">
                    {gens.map((gen) => (
                      <span key={hStr(gen["id"])} className="rounded-full bg-[var(--surface-2)] px-3 py-1.5 text-xs text-[var(--text)]">
                        {hStr(gen["label_cn"])} · {hStr(gen["era"])}
                        {hNum(gen["peakYear"]) !== null ? ` · 峰值 ${hNum(gen["peakYear"])}` : ""}
                      </span>
                    ))}
                  </div>
                );
              })()}
            </ChSection>

            <ChSection
              title="成分股调整史：指数是活的"

            >
              {(() => {
                const changes = hArr(g("sp500/changes")["changes"]).map((r) => hRec(r));
                const recent = [...changes].slice(-12).reverse();
                return (
                  <div>
                    <div className="space-y-1.5">
                      {recent.map((c, i) => {
                        const add = hRec(c["addition"]);
                        const rem = hRec(c["removal"]);
                        return (
                          <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                            <span className="shrink-0 text-[var(--dim)]">{hStr(c["effectiveDate"])}</span>
                            {hStr(add["ticker"]) ? (
                              <span className="text-[var(--text)]">
                                调入 <span className="font-medium">{hStr(add["ticker"])}</span> {hStr(add["name"])}
                              </span>
                            ) : null}
                            {hStr(rem["ticker"]) ? (
                              <span className="text-[var(--dim)]">
                                调出 {hStr(rem["ticker"])} {hStr(rem["name"])}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-[11px] text-[var(--dim)]">数据集共记录 {changes.length} 次调整。</p>
                  </div>
                );
              })()}
            </ChSection>
          </>
        ) : null}

        {chapter === 4 ? (
          <>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="板块卷分册">
              {(
                [
                  ["semi", "半导体 SOX"],
                  ["xlk", "科技 XLK"],
                  ["fin", "金融 XLF"],
                  ["consumer", "消费 XLY/XLP"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={sectorTab === id}
                  onClick={() => setSectorTab(id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${sectorTab === id ? "bg-[var(--accent)] text-white" : "bg-[var(--chip-bg)] text-[var(--chip-text)]"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {sectorTab === "semi" ? (
              <>
                <ChSection
                  title="SOX 成分与子行业分布（30 只）"

                >
                  {(() => {
                    const comp = g("semi/composition");
                    const members = hArr(comp["members"]).map((r) => hRec(r));
                    const subs = hArr(comp["subsectors"]).map((r) => hRec(r));
                    const nameOf = (id: string) => hStr(subs.find((x) => hStr(x["id"]) === id)?.["name_cn"]) || id;
                    const counts = new Map<string, number>();
                    for (const m of members) counts.set(hStr(m["subsector"]), (counts.get(hStr(m["subsector"])) ?? 0) + 1);
                    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
                    return (
                      <div>
                        <div className="space-y-1.5">
                          {rows.map(([id, n]) => (
                            <div key={id} className="flex items-center gap-2 text-xs">
                              <span className="w-36 shrink-0 text-[var(--text)]">{nameOf(id)}</span>
                              <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--border)]/40">
                                <div className="h-full bg-[var(--accent)]/70" style={{ width: `${(n / Math.max(...rows.map((r) => r[1]), 1)) * 100}%` }} />
                              </div>
                              <span className="w-10 shrink-0 text-right font-medium text-[var(--text)]">{n} 只</span>
                            </div>
                          ))}
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
                          存储子行业在 SOX 里只有美光一家——常说的「存储三家」（美光、三星、SK 海力士）里另两家不在美股指数内，看存储周期要把韩股一起看。
                        </p>
                      </div>
                    );
                  })()}
                </ChSection>

                <ChSection title="SOX 年度回报与相对强弱">
                  {(() => {
                    const ann = g("semi/annual-returns");
                    const items = hArr(ann["series"])
                      .map((r) => hRec(r))
                      .filter((r) => hNum(r["value"]) !== null && r["ytd"] !== true)
                      .map((r) => ({ label: String(hNum(r["year"]) ?? ""), value: hNum(r["value"])! }));
                    const ratios = hRec(g("semi/ratios")["series"]);
                    const lineOf = (field: string) =>
                      hArr(ratios[field])
                        .map((r) => hRec(r))
                        .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                        .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["value"])!] as [string, number]);
                    return (
                      <div>
                        <ChStatsRow
                          items={[
                            { label: "SOX 年均涨幅", value: hp(hNum(ann["average"])), sub: `${hNum(ann["completeYears"]) ?? "—"} 个完整年度` },
                            { label: "上涨年份", value: `${hNum(ann["positiveYears"]) ?? "—"} 年`, sub: `下跌 ${hNum(ann["negativeYears"]) ?? "—"} 年` },
                          ]}
                        />
                        <div className="mt-3">
                          <ChBars items={items} height={120} />
                        </div>
                        <div className="mt-3 grid gap-3 sm:grid-cols-3">
                          {(
                            [
                              ["sox_vs_spx", "SOX / 标普 500"],
                              ["sox_vs_xlk", "SOX / XLK"],
                              ["xlk_vs_spx", "XLK / 标普 500"],
                            ] as const
                          ).map(([field, label]) => (
                            <div key={field}>
                              <div className="mb-1 text-xs font-medium text-[var(--text)]">{label}（1999 年末 = 100）</div>
                              <ChLine lines={[{ pts: lineOf(field), color: "var(--accent)" }]} height={90} />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </ChSection>

                <ChSection title="存储估值与 ETF 之争（SOXX vs SMH）">
                  {(() => {
                    const mv = g("semi/memory-valuation");
                    const members = hArr(mv["members"]).map((r) => hRec(r));
                    const refs = hArr(mv["reference_1999"]).map((r) => hRec(r));
                    const ec = g("semi/etf-compare");
                    const overlap = hRec(ec["overlap"]);
                    const etfs = hRec(ec["etfs"]);
                    const etfCard = (k: string) => {
                      const e = hRec(etfs[k]);
                      return {
                        label: `${hStr(e["symbol"]) || k.toUpperCase()} 规模 / 费率 / 成分`,
                        value: hNum(e["aum"]) !== null ? `$${fmt((hNum(e["aum"]) ?? 0) / 1e9, 1)}B` : "—",
                        sub: `费率 ${hNum(e["expenseRatio"]) !== null ? `${fmt((hNum(e["expenseRatio"]) ?? 0) * 100, 2)}%` : "—"} · ${hNum(e["count"]) ?? "—"} 只成分`,
                      };
                    };
                    return (
                      <div>
                        {members.length ? (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                                <th className="py-1 pr-2 font-medium">个股</th>
                                <th className="py-1 pr-2 text-right font-medium">TTM PE</th>
                                <th className="py-1 text-right font-medium">远期 PE</th>
                              </tr>
                            </thead>
                            <tbody>
                              {members.map((m) => {
                                const snap = hRec(m["snapshot"]);
                                const latestM = hRec(m["latest"]);
                                return (
                                  <tr key={hStr(m["ticker"])} className="border-b border-[var(--border)]/50">
                                    <td className="py-1 pr-2 font-medium text-[var(--text)]">{hStr(m["ticker"])}</td>
                                    <td className="py-1 pr-2 text-right text-[var(--text)]">{hNum(snap["trailingPE"]) !== null ? fmt(hNum(snap["trailingPE"])!, 1) : hNum(latestM["pe"]) !== null ? fmt(hNum(latestM["pe"])!, 1) : "—"}</td>
                                    <td className="py-1 text-right text-[var(--text)]">{hNum(snap["forwardPE"]) !== null ? fmt(hNum(snap["forwardPE"])!, 1) : "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        ) : null}
                        {refs.length ? (
                          <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
                            1999 年标杆（峰值远期 PE）：{refs.map((r) => `${hStr(r["ticker"])} ${hNum(r["peakForwardPE"]) ?? "—"}×（${hStr(r["peakDate"])}）`).join(" · ")}
                          </p>
                        ) : null}
                        <div className="mt-3">
                          <ChStatsRow
                            items={[
                              etfCard("soxx"),
                              etfCard("smh"),
                              { label: "成分重叠", value: `${hNum(overlap["sharedCount"]) ?? "—"} 只共有`, sub: `SOXX 独有 ${hNum(overlap["soxxOnlyCount"]) ?? "—"} 只 · SMH 独有 ${hNum(overlap["smhOnlyCount"]) ?? "—"} 只` },
                            ]}
                          />
                        </div>
                      </div>
                    );
                  })()}
                </ChSection>
              </>
            ) : null}

            {sectorTab === "xlk" ? (
              <>
                <ChSection title="XLK 前十大持仓：一个 ETF，三只票说了算">
                  {(() => {
                    const hold = g("xlk/holdings");
                    const members = hArr(hold["members"]).map((r) => hRec(r));
                    const overview = hRec(hold["overview"]);
                    const top3 = members.slice(0, 3).reduce((a, m) => a + (hNum(m["weight"]) ?? 0), 0);
                    return (
                      <div>
                        <ChStatsRow
                          items={[
                            { label: "前三合计权重", value: `${fmt(top3, 1)}%`, sub: members.slice(0, 3).map((m) => hStr(m["ticker"])).join(" · ") },
                            { label: "前十合计权重", value: hNum(overview["topHoldingsWeight"]) !== null ? `${fmt(hNum(overview["topHoldingsWeight"])!, 1)}%` : "—" },
                          ]}
                        />
                        <table className="mt-3 w-full text-xs">
                          <thead>
                            <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                              <th className="py-1 pr-2 font-medium">#</th>
                              <th className="py-1 pr-2 font-medium">个股</th>
                              <th className="py-1 text-right font-medium">权重</th>
                            </tr>
                          </thead>
                          <tbody>
                            {members.map((m) => (
                              <tr key={hStr(m["ticker"])} className="border-b border-[var(--border)]/50">
                                <td className="py-1 pr-2 text-[var(--dim)]">{hNum(m["rank"]) ?? ""}</td>
                                <td className="py-1 pr-2 text-[var(--text)]">
                                  <span className="font-medium">{hStr(m["ticker"])}</span> {hStr(m["name"])}
                                </td>
                                <td className="py-1 text-right font-medium text-[var(--text)]">{hNum(m["weight"]) !== null ? `${fmt(hNum(m["weight"])!, 2)}%` : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </ChSection>

                <ChSection title="2018 年 GICS 重分类：板块是人定义的">
                  {(() => {
                    const rc = g("xlk/reclass-2018");
                    const moved = hArr(rc["moved_out"]).map((r) => hRec(r));
                    const stayed = hArr(rc["stayed_in"]).map((r) => hRec(r));
                    return (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <div className="mb-1 text-xs font-medium text-[var(--text)]">搬出科技板块（{hStr(rc["effective_date"])} 生效）</div>
                          <div className="space-y-1">
                            {moved.map((m) => (
                              <div key={hStr(m["ticker"])} className="text-xs text-[var(--dim)]">
                                <span className="font-medium text-[var(--text)]">{hStr(m["ticker"])}</span> {hStr(m["name"])} → {hStr(m["to"])}
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="mb-1 text-xs font-medium text-[var(--text)]">留在科技板块</div>
                          <div className="space-y-1">
                            {stayed.map((m) => (
                              <div key={hStr(m["ticker"])} className="text-xs text-[var(--dim)]">
                                <span className="font-medium text-[var(--text)]">{hStr(m["ticker"])}</span> {hStr(m["name"])}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </ChSection>

                <ChSection title="XLK 年度回报与大回撤">
                  {(() => {
                    const ann = g("xlk/annual-returns");
                    const items = hArr(ann["series"])
                      .map((r) => hRec(r))
                      .filter((r) => hNum(r["value"]) !== null && r["ytd"] !== true)
                      .map((r) => ({ label: String(hNum(r["year"]) ?? ""), value: hNum(r["value"])! }));
                    const dds = hArr(g("xlk/drawdowns")["drawdowns"])
                      .map((r) => hRec(r))
                      .filter((r) => hNum(r["decline"]) !== null)
                      .sort((a, b) => (hNum(a["decline"]) ?? 0) - (hNum(b["decline"]) ?? 0))
                      .slice(0, 5);
                    return (
                      <div>
                        <ChBars items={items} height={120} />
                        {dds.length ? (
                          <table className="mt-3 w-full text-xs">
                            <thead>
                              <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                                <th className="py-1 pr-2 font-medium">最深回撤区间</th>
                                <th className="py-1 pr-2 text-right font-medium">跌幅</th>
                                <th className="py-1 text-right font-medium">收复用时</th>
                              </tr>
                            </thead>
                            <tbody>
                              {dds.map((r, i) => (
                                <tr key={i} className="border-b border-[var(--border)]/50">
                                  <td className="py-1 pr-2 text-[var(--text)]">{hStr(r["period"])}</td>
                                  <td className="py-1 pr-2 text-right font-medium text-[var(--down)]">{hf(hNum(r["decline"]))}</td>
                                  <td className="py-1 text-right text-[var(--dim)]">{r["active"] === true ? "进行中" : hNum(r["recovery_days"]) !== null ? `${hNum(r["recovery_days"])} 天` : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : null}
                      </div>
                    );
                  })()}
                </ChSection>
              </>
            ) : null}

            {sectorTab === "fin" ? (
              <>
                <ChSection title="XLF 年度回报">
                  {(() => {
                    const ann = g("fin/annual-returns");
                    const items = hArr(ann["series"])
                      .map((r) => hRec(r))
                      .filter((r) => hNum(r["value"]) !== null && r["ytd"] !== true)
                      .map((r) => ({ label: String(hNum(r["year"]) ?? ""), value: hNum(r["value"])! }));
                    return <ChBars items={items} height={120} />;
                  })()}
                </ChSection>

                <ChSection title="2008 年：五家消失 vs 五家挺过">
                  {(() => {
                    const crisis = g("fin/crisis-2008");
                    const col = (field: string, title: string) => {
                      const rows = hArr(crisis[field]).map((r) => hRec(r));
                      return (
                        <div>
                          <div className="mb-1 text-xs font-medium text-[var(--text)]">{title}</div>
                          <div className="space-y-1.5">
                            {rows.map((r) => {
                              const peak = hNum(r["peak"]);
                              const trough = hNum(r["trough"]);
                              const dd = peak && trough ? (trough / peak - 1) * 100 : null;
                              return (
                                <div key={hStr(r["ticker"])} className="text-xs">
                                  <span className="font-medium text-[var(--text)]">{hStr(r["ticker"])}</span>{" "}
                                  <span className="text-[var(--dim)]">{hStr(r["name"])}</span>
                                  <div className="text-[var(--dim)]">
                                    峰值 {peak !== null ? fmt(peak, 2) : "—"} → 谷值 {trough !== null ? fmt(trough, 2) : "—"}
                                    {dd !== null ? `（${hp(dd)}）` : ""} · {hStr(r["fate_cn"]) || hStr(r["fate"])}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    };
                    return (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {col("casualties", "消失 / 被吞并")}
                        {col("survivors", "挺过危机")}
                      </div>
                    );
                  })()}
                </ChSection>

                <ChSection title="收益率曲线 × 金融板块">
                  {(() => {
                    const rates = g("fin/rates");
                    const latest = hRec(rates["latestSpread"]);
                    const spread = hArr(rates["spread"])
                      .map((r) => hRec(r))
                      .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                      .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["value"])!] as [string, number]);
                    const yoy = hArr(rates["xlf_yoy"])
                      .map((r) => hRec(r))
                      .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                      .map((r) => [hStr(r["date"]).slice(0, 4), (hNum(r["value"]) ?? 0) * 100] as [string, number]);
                    return (
                      <div>
                        <ChStatsRow
                          items={[
                            { label: "最新 10Y−2Y 利差", value: hNum(latest["spread"]) !== null ? `${fmt(hNum(latest["spread"])!, 2)}%` : "—", sub: hStr(latest["date"]) },
                            { label: "历史倒挂段数", value: `${hArr(rates["inversions"]).length} 段`, sub: "1976 年以来" },
                          ]}
                        />
                        <div className="mt-3">
                          <div className="mb-1 text-xs font-medium text-[var(--text)]">10Y−2Y 利差（月末，虚线 = 0）</div>
                          <ChLine lines={[{ pts: spread, color: "var(--accent)" }]} hline={0} height={120} yFmt={(v) => `${v.toFixed(1)}%`} />
                        </div>
                        <div className="mt-3">
                          <div className="mb-1 text-xs font-medium text-[var(--text)]">XLF 同比涨幅（月末）</div>
                          <ChLine lines={[{ pts: yoy, color: "var(--gold)" }]} hline={0} height={110} yFmt={(v) => `${v.toFixed(0)}%`} />
                        </div>
                      </div>
                    );
                  })()}
                </ChSection>

                <ChSection title="XLF 前十大持仓">
                  {(() => {
                    const members = hArr(g("fin/holdings")["members"]).map((r) => hRec(r));
                    return (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                            <th className="py-1 pr-2 font-medium">#</th>
                            <th className="py-1 pr-2 font-medium">个股</th>
                            <th className="py-1 text-right font-medium">权重</th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m) => (
                            <tr key={hStr(m["ticker"])} className="border-b border-[var(--border)]/50">
                              <td className="py-1 pr-2 text-[var(--dim)]">{hNum(m["rank"]) ?? ""}</td>
                              <td className="py-1 pr-2 text-[var(--text)]">
                                <span className="font-medium">{hStr(m["ticker"])}</span> {hStr(m["name"])}
                              </td>
                              <td className="py-1 text-right font-medium text-[var(--text)]">{hNum(m["weight"]) !== null ? `${fmt(hNum(m["weight"])!, 2)}%` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    );
                  })()}
                </ChSection>
              </>
            ) : null}

            {sectorTab === "consumer" ? (
              <>
                <ChSection title="XLY / XLP 比值：风险偏好的温度计">
                  {(() => {
                    const ratio = g("consumer/ratio");
                    const pts = hArr(ratio["series"])
                      .map((r) => hRec(r))
                      .filter((r) => hStr(r["date"]) && hNum(r["value"]) !== null)
                      .map((r) => [hStr(r["date"]).slice(0, 4), hNum(r["value"])!] as [string, number]);
                    return (
                      <div>
                        <ChStatsRow
                          items={[
                            { label: "历史新高次数", value: `${hArr(ratio["highs"]).length} 次` },
                            { label: "历史新低次数", value: `${hArr(ratio["lows"]).length} 次` },
                            { label: "最新比值", value: pts.length ? fmt(pts[pts.length - 1]![1], 2) : "—" },
                          ]}
                        />
                        <div className="mt-3">
                          <ChLine lines={[{ pts, color: "var(--accent)" }]} log height={130} />
                        </div>
                      </div>
                    );
                  })()}
                </ChSection>

                <ChSection title="十二家消费复利机器">
                  {(() => {
                    const companies = hArr(g("consumer/companies")["companies"])
                      .map((r) => hRec(r))
                      .sort((a, b) => (hNum(b["cagr"]) ?? 0) - (hNum(a["cagr"]) ?? 0));
                    return (
                      <ScrollHint className="overflow-x-auto" fadeBg="var(--bg)">
                        <table className="w-full min-w-[560px] text-xs">
                          <thead>
                            <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                              <th className="py-1.5 pr-2 font-medium">公司</th>
                              <th className="py-1.5 pr-2 font-medium">板块</th>
                              <th className="py-1.5 pr-2 text-right font-medium">上市年</th>
                              <th className="py-1.5 pr-2 text-right font-medium">上市以来年化</th>
                              <th className="py-1.5 pr-2 text-right font-medium">最大回撤</th>
                              <th className="py-1.5 text-right font-medium">权重</th>
                            </tr>
                          </thead>
                          <tbody>
                            {companies.map((c) => (
                              <tr key={hStr(c["ticker"])} className="border-b border-[var(--border)]/50">
                                <td className="py-1 pr-2 text-[var(--text)]">
                                  <span className="font-medium">{hStr(c["ticker"])}</span> {hStr(c["name"])}
                                </td>
                                <td className="py-1 pr-2 text-[var(--dim)]">{hStr(c["sector"])}</td>
                                <td className="py-1 pr-2 text-right text-[var(--dim)]">{hNum(c["ipoYear"]) ?? "—"}</td>
                                <td className="py-1 pr-2 text-right font-medium text-[var(--text)]">{hSmart(hNum(c["cagr"]), 2)}</td>
                                <td className="py-1 pr-2 text-right text-[var(--down)]">{hSmart(hNum(c["maxDrawdown"]))}</td>
                                <td className="py-1 text-right text-[var(--dim)]">{hNum(c["weight"]) !== null ? `${fmt(hNum(c["weight"])!, 2)}%` : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </ScrollHint>
                    );
                  })()}
                </ChSection>

                <ChSection title="零售灭绝事件：活下来才是复利">
                  {(() => {
                    const ext = g("consumer/extinction");
                    const col = (field: string, title: string) => {
                      const rows = hArr(ext[field]).map((r) => hRec(r));
                      return (
                        <div>
                          <div className="mb-1 text-xs font-medium text-[var(--text)]">{title}</div>
                          <div className="space-y-1.5">
                            {rows.map((r) => (
                              <div key={hStr(r["ticker"])} className="text-xs">
                                <span className="font-medium text-[var(--text)]">{hStr(r["ticker"])}</span>{" "}
                                <span className="text-[var(--dim)]">{hStr(r["name"])}</span>
                                <div className="text-[var(--dim)]">
                                  {hStr(r["event_date"]) ? `${hStr(r["event_date"])} · ` : ""}
                                  {hStr(r["fate_cn"]) || hStr(r["fate"])}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    };
                    return (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {col("casualties", "消失的五家")}
                        {col("survivors", "挺过的五家")}
                      </div>
                    );
                  })()}
                </ChSection>

                <ChSection title="XLY 与 XLP 年度回报">
                  {(() => {
                    const barsOf = (key: string) =>
                      hArr(g(key)["series"])
                        .map((r) => hRec(r))
                        .filter((r) => hNum(r["value"]) !== null && r["ytd"] !== true)
                        .map((r) => ({ label: String(hNum(r["year"]) ?? ""), value: hNum(r["value"])! }));
                    return (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <div className="mb-1 text-xs font-medium text-[var(--text)]">XLY 可选消费</div>
                          <ChBars items={barsOf("consumer/xly-annual-returns")} height={110} />
                        </div>
                        <div>
                          <div className="mb-1 text-xs font-medium text-[var(--text)]">XLP 必需消费</div>
                          <ChBars items={barsOf("consumer/xlp-annual-returns")} height={110} />
                        </div>
                      </div>
                    );
                  })()}
                </ChSection>
              </>
            ) : null}
          </>
        ) : null}
      </div>

      <footer className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[11px] leading-relaxed text-[var(--dim)]">
        数据来源：History of Market（historyofmarket.com）公开发布的 JSON 数据集，数据许可 CC BY 4.0（署名复用）；
        {data.siteTotal > 0
          ? `来源站共发布 ${data.siteTotal} 个数据集，本台精选入库 ${data.storedCount} 个（即上方五卷所用），其余暂未收录；`
          : `本台已入库 ${data.storedCount} 个数据集（即上方五卷所用）；`}
        数据集生成于 {data.generatedAt ? data.generatedAt.replace("T", " ").slice(0, 16) : "—"}（UTC）
        {stageInfo ? `；本模块入库于 ${new Date(stageInfo.finishedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（${stageInfo.detail}）` : ""}。
        本页只搬运数据与图表口径，白话讲解为管控台自撰，未复制原文长文。个别数据集的口径（如远期 PE 标杆、年内回撤平均）以数据集自身发布值为准，与其他来源可能略有差异。
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const NAV: { id: View; label: string }[] = [
  { id: "overview", label: "总览" },
  { id: "cloud", label: "云图" },
  { id: "chronicle", label: "编年史" },
  { id: "bonds", label: "债券" },
  { id: "us", label: "美股" },
  { id: "ussec", label: "美股板块" },
  { id: "usdiv", label: "美股红利" },
  { id: "cn", label: "A股" },
  { id: "cnsec", label: "A股板块" },
  { id: "hk", label: "港股" },
  { id: "gold", label: "黄金" },
  { id: "macro", label: "宏观" },
  { id: "wallst", label: "华尔街" },
  { id: "portfolio", label: "组合" },
  { id: "calendar", label: "大事日历" },
  { id: "history", label: "历史回撤" },
  { id: "signals", label: "决策信号" },
  { id: "bottomtop", label: "抄底逃顶" },
  { id: "methods", label: "方法库" },
];

// ---------------------------------------------------------------------------
// 分块刷新：点一次刷新 = 逐块在后台拉取。每一块是独立的服务端调用，拉到
// 就入库、就重渲染那一块；没轮到的块继续显示缓存数据（每块的「更新于」
// 时间会自己说话）；某块失败只标记那一块，旧数据保留、原因写明，可以
// 单独重试失败块。进页面只读已入库的缓存，不触发任何外部拉取。
// ---------------------------------------------------------------------------

type RefreshStageId = "prices" | "yields" | "extras" | "margin" | "feargreed" | "pcr" | "pe" | "money" | "wallst" | "calendar" | "cloud-us" | "cloud-ndx" | "cloud-dow" | "cloud-rut" | "cloud-cn" | "chronicle";

const REFRESH_STAGES: { id: RefreshStageId; label: string }[] = [
  { id: "prices", label: "行情与历史序列" },
  { id: "yields", label: "国债收益率" },
  { id: "money", label: "资金面利率" },
  { id: "extras", label: "两融、成交额、南向与股息率" },
  { id: "margin", label: "融资余额与保证金负债" },
  { id: "feargreed", label: "恐惧与贪婪指数（CNN）" },
  { id: "pcr", label: "期权 Put/Call（CBOE）" },
  { id: "pe", label: "历史 PE（中证官网）" },
  { id: "wallst", label: "华尔街宏观" },
  { id: "calendar", label: "大事日历" },
  { id: "cloud-us", label: "云图 · 美股" },
  { id: "cloud-ndx", label: "云图 · 纳指 100" },
  { id: "cloud-dow", label: "云图 · 道指" },
  { id: "cloud-rut", label: "云图 · 罗素 2000" },
  { id: "cloud-cn", label: "云图 · A股" },
  { id: "chronicle", label: "美股编年史" },
];

type StageState = "pending" | "running" | "ok" | "partial" | "error" | "skipped";

/** Which refresh stage(s) feed each module page — drives the per-page
 *  「本页数据更新于」 line (modules not listed here render their own:
 *  云图/债券/华尔街/日历；总览与方法库不需要）。 */
const FRESH_BY_VIEW: Partial<Record<View, [string, string][]>> = {
  us: [
    ["行情序列", "prices"],
    ["保证金负债（FINRA）", "margin"],
    ["恐惧与贪婪指数（CNN）", "feargreed"],
  ],
  ussec: [["行情序列", "prices"]],
  usdiv: [["行情序列", "prices"]],
  cn: [
    ["行情序列", "prices"],
    ["两融、成交额、南向与股息率", "extras"],
    ["融资余额", "margin"],
    ["历史 PE", "pe"],
  ],
  cnsec: [
    ["行情序列", "prices"],
    ["历史 PE", "pe"],
  ],
  hk: [["行情序列", "prices"]],
  gold: [
    ["行情序列", "prices"],
    ["实际利率（华尔街）", "wallst"],
  ],
  macro: [
    ["行情序列", "prices"],
    ["宏观数据序列（华尔街）", "wallst"],
  ],
  portfolio: [
    ["行情序列", "prices"],
    ["两融、成交额、南向与股息率", "extras"],
  ],
  chronicle: [["编年史静态库", "chronicle"]],
  history: [["行情序列（全历史口径）", "prices"]],
  signals: [
    ["行情序列", "prices"],
    ["收益率", "yields"],
    ["历史 PE", "pe"],
    ["华尔街宏观", "wallst"],
    ["融资余额与保证金负债", "margin"],
    ["恐惧与贪婪指数（CNN）", "feargreed"],
  ],
  bottomtop: [
    ["行情序列", "prices"],
    ["恐惧与贪婪指数（CNN）", "feargreed"],
    ["期权 Put/Call（CBOE）", "pcr"],
    ["华尔街宏观（HY 利差）", "wallst"],
    ["保证金负债（FINRA）", "margin"],
  ],
};
type RefreshRun = {
  states: Partial<Record<RefreshStageId, StageState>>;
  errors: Partial<Record<RefreshStageId, string[]>>;
  summaries: Partial<Record<RefreshStageId, string>>;
  current: RefreshStageId | null;
  running: boolean;
  finishedAt: string | null;
};

/** Display names for coverage-table series keys that are not
 *  instruments (PE pipelines, the CDB spread, and the v108 margin
 *  series). Falls back to the PE-pipeline naming, then the instrument
 *  name, then the raw key. */
function coverageName(key: string, instruments: Dashboard["instruments"]): string {
  const named: Record<string, string> = {
    cape_spx: "CAPE · 标普500",
    pe_hsi_annual: "历史 PE（年度点）· 恒生指数",
    fwd_hsi_annual: "前瞻 PE（年度点）· 恒生指数",
    pe_ndx_annual: "历史 PE（年度点）· 纳斯达克100",
    cdbgov10y: "国开债 − 国债 10Y 利差（月末）",
    margin_sh: "融资余额 · 沪市（上交所官网）",
    margin_sz: "融资余额 · 深市（深交所披露）",
    margin_total: "融资余额 · 沪深合计",
    margin_total_buy: "融资买入额 · 沪深合计",
    margin_total_repay: "融资偿还额 · 沪深合计",
    margin_total_net: "融资净买入 · 沪深合计",
    margin_total_rqye: "融券余额 · 沪深合计",
    margin_total_rqyl: "融券余量 · 沪深合计",
    finra_margin_debt: "保证金负债 · FINRA（月度）",
    fear_greed_cnn: "恐惧与贪婪指数 · CNN（日度）",
    finra_credit_cash: "自由信用余额（现金账户）· FINRA（月度）",
    finra_credit_margin: "自由信用余额（保证金账户）· FINRA（月度）",
  };
  const hit = named[key];
  if (hit) return hit;
  if (key.startsWith("pe_")) return `历史 PE · ${instruments.find((i) => i.key === key.slice(3))?.name ?? key.slice(3)}`;
  return instruments.find((i) => i.key === key)?.name ?? key;
}

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("overview");
  // Stale-while-revalidate entry: the last visit's dashboard snapshot
  // (localStorage, this browser only) seeds the first render — the
  // console opens on stored data instantly, then the query refetches
  // in the background (the seed is older than staleTime) and the page
  // updates in place when the fresh payload lands. The seed also
  // restores the statistics window the user last used.
  const [seed] = useState<DashSeed | null>(() => readDashSeed());
  const [windowDays, setWindowDays] = useState(seed?.windowDays ?? 500);
  const seedForWindow = seed && seed.windowDays === windowDays ? seed : null;
  // Cache-first reads: entering the page renders the stored snapshot;
  // nothing re-fetches on mount/focus — data only moves when the user
  // hits 刷新 (which invalidates per stage as each block lands).
  const dash = useQuery({
    queryKey: ["dashboard", windowDays],
    queryFn: () => api.getDashboard({ windowDays }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    initialData: seedForWindow?.data,
    initialDataUpdatedAt: seedForWindow?.at,
  });
  const dashData = dash.data;
  const dashUpdatedAt = dash.dataUpdatedAt;
  useEffect(() => {
    if (!dashData || dashUpdatedAt === 0) return;
    writeDashSeed({ windowDays, at: dashUpdatedAt, data: dashData });
  }, [dashData, dashUpdatedAt, windowDays]);
  const cloudQ = useQuery({
    queryKey: ["cloud"],
    queryFn: () => api.getCloud({}),
    // The A-share page also reads the stored snapshot (A-P2-3 breadth
    // line below) — a read of what the cloud-cn refresh stage already
    // landed, never a fetch of its own.
    enabled: view === "cloud" || view === "cn",
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const chronQ = useQuery({
    queryKey: ["chronicle"],
    queryFn: () => api.getChronicle({}),
    enabled: view === "chronicle",
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  // V-2-2a: watchlist PE percentiles are an on-demand read like the
  // cloud detail drawer (same server pipeline), fetched only when the
  // US page opens — not part of the manual staged refresh, and the
  // dashboard's stored price snapshot is untouched by it.
  const watchPeQ = useQuery({
    queryKey: ["watchlistPe"],
    queryFn: () => api.getWatchlistPe({}),
    enabled: view === "us",
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const watchPeByKey = new Map((watchPeQ.data?.items ?? []).map((it) => [it.key, it]));
  const watchPeStatus: WatchPeStatus = watchPeQ.isError ? "error" : watchPeQ.data ? "ready" : "loading";
  const [run, setRun] = useState<RefreshRun | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  // M-P2-1: on phones the coverage list renders as cards, first 20 by
  // default; this toggles the full list. Desktop keeps the table.
  const [coverageExpanded, setCoverageExpanded] = useState(false);
  const runRef = useRef(false);

  // Idle prefetch (2026-11-21): the module pages' on-demand reads are the
  // only nav cost left (measured: 美股 watchPe ~4.5s live Yahoo+EDGAR,
  // 编年史 first load ~1.3s + 747KB, 云图 ~0.1s + 287KB; every other view
  // paints from the dashboard cache in <0.2s). After the home page has
  // rendered and the tab is idle, warm the three on-demand queries one at
  // a time into the same react-query cache the views read — opening a
  // module then hits cache, no refetch. Sequential + low priority so it
  // never races a manual refresh or user input; failures are swallowed
  // silently (no banner, no refresh-log write); skipped on save-data /
  // 2g so weak networks never pay for data the user may not open.
  useEffect(() => {
    if (!dashData) return; // home not rendered yet
    const conn = (
      navigator as Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      }
    ).connection;
    if (conn?.saveData) return;
    if (conn?.effectiveType === "slow-2g" || conn?.effectiveType === "2g") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const kick = () => {
        if (cancelled || document.visibilityState !== "visible") return;
        if (runRef.current) return; // refresh running — never compete
        void (async () => {
          const jobs: { key: string[]; skipView: View[]; fn: () => Promise<unknown> }[] = [
            { key: ["watchlistPe"], skipView: ["us"], fn: () => api.getWatchlistPe({}) },
            { key: ["chronicle"], skipView: ["chronicle"], fn: () => api.getChronicle({}) },
            { key: ["cloud"], skipView: ["cloud", "cn"], fn: () => api.getCloud({}) },
          ];
          for (const job of jobs) {
            if (cancelled || document.visibilityState !== "visible" || runRef.current) return;
            if (job.skipView.includes(view)) continue; // that view's own query is already enabled
            const state = queryClient.getQueryState(job.key);
            if (state?.data !== undefined && Date.now() - state.dataUpdatedAt < 5 * 60_000) continue; // already fresh
            try {
              await queryClient.prefetchQuery({ queryKey: job.key, queryFn: job.fn, staleTime: 5 * 60_000 });
            } catch {
              // Silent: a failed prefetch just means the view fetches on entry, as before.
            }
            await new Promise((r) => setTimeout(r, 300)); // breather between jobs
          }
        })();
      };
      if ("requestIdleCallback" in window) {
        (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback(
          kick,
          { timeout: 8000 },
        );
      } else {
        kick();
      }
    }, 1500); // let first paint + dashboard settle first
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dashData, queryClient, view]);

  // Bounded worker pool for stage refreshes (5 lanes): same limit as
  // the server's mapPool in refreshData. Order of completion is
  // nondeterministic by design — progress is driven by completed
  // count (doneCount), never by queue position.
  const REFRESH_POOL_SIZE = 5;
  async function runStagePool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i] as T);
      }
    });
    await Promise.all(workers);
  }

  const startRefresh = async (only?: RefreshStageId[], rebuild = false) => {
    if (runRef.current) return;
    runRef.current = true;
    // D-Lock: one runId per startRefresh invocation; the server lets
    // this run's 5 pooled lanes join the same lock and refuses other
    // runs with a skipped result.
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const queue = REFRESH_STAGES.filter((s) => !only || only.includes(s.id));
    setRun((prev) => {
      const states: RefreshRun["states"] = only && prev ? { ...prev.states } : {};
      const errors: RefreshRun["errors"] = only && prev ? { ...prev.errors } : {};
      const summaries: RefreshRun["summaries"] = only && prev ? { ...prev.summaries } : {};
      for (const s of queue) {
        states[s.id] = "pending";
        delete errors[s.id];
        delete summaries[s.id];
      }
      return { states, errors, summaries, current: null, running: true, finishedAt: null };
    });
    await runStagePool(queue, REFRESH_POOL_SIZE, async (stage) => {
      setRun((prev) => (prev ? { ...prev, current: stage.id, states: { ...prev.states, [stage.id]: "running" } } : prev));
      try {
        const r = await api.refreshStage({ stage: stage.id, rebuild: rebuild || undefined, runId, runTotal: queue.length });
        setRun((prev) =>
          prev
            ? {
                ...prev,
                states: {
                  ...prev.states,
                  // D-Lock: a skipped stage is terminal but neither ok
                  // nor a failure — the other run owns its data.
                  // Three-way honesty (unchanged): a stage that landed
                  // some data but still carries errors is "partial",
                  // never plain "ok" — the title, badge and retry set
                  // all key off this.
                  [stage.id]: r.skipped === true ? "skipped" : r.errors.length > 0 ? (r.ok ? "partial" : "error") : "ok",
                },
                errors: r.errors.length > 0 ? { ...prev.errors, [stage.id]: r.errors } : prev.errors,
                summaries: r.summary ? { ...prev.summaries, [stage.id]: r.summary } : prev.summaries,
              }
            : prev,
        );
      } catch (e) {
        setRun((prev) =>
          prev
            ? {
                ...prev,
                states: { ...prev.states, [stage.id]: "error" },
                errors: { ...prev.errors, [stage.id]: [e instanceof Error ? e.message : "请求失败"] },
              }
            : prev,
        );
      }
      // This block just landed: re-read the stored snapshot so exactly
      // this block re-renders fresh; everything else keeps its cache.
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (stage.id === "cloud-us" || stage.id === "cloud-ndx" || stage.id === "cloud-dow" || stage.id === "cloud-rut" || stage.id === "cloud-cn") {
        await queryClient.invalidateQueries({ queryKey: ["cloud"] });
      }
      if (stage.id === "prices") {
        await queryClient.invalidateQueries({ queryKey: ["chart"] });
      }
      if (stage.id === "chronicle") {
        await queryClient.invalidateQueries({ queryKey: ["chronicle"] });
      }
    });
    setRun((prev) => (prev ? { ...prev, current: null, running: false, finishedAt: new Date().toISOString() } : prev));
    runRef.current = false;
  };

  const failedStages = REFRESH_STAGES.filter((s) => run?.states[s.id] === "error");
  const partialStages = REFRESH_STAGES.filter((s) => run?.states[s.id] === "partial");
  // D-Lock: skipped stages are terminal (the other run owns them) but
  // never failures — they stay out of the retry set and the banner's
  // failure count, and count toward progress so the bar reaches N/N.
  const skippedStages = REFRESH_STAGES.filter((s) => run?.states[s.id] === "skipped");
  // Retry covers every block that did not fully succeed — failed AND
  // partially updated blocks alike.
  const retryStages = REFRESH_STAGES.filter((s) => run?.states[s.id] === "error" || run?.states[s.id] === "partial");
  const okStageCount = REFRESH_STAGES.filter((s) => run?.states[s.id] === "ok").length;
  const doneCount = REFRESH_STAGES.filter(
    (s) => run?.states[s.id] === "ok" || run?.states[s.id] === "partial" || run?.states[s.id] === "error" || run?.states[s.id] === "skipped",
  ).length;

  const goMethod = (id: string) => {
    setView("methods");
    window.setTimeout(() => {
      document.getElementById(`method-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  };

  // Module switch lands at the top of the new module. The page's real
  // scroller is the SDK's [data-generated-space-root] container (fixed,
  // overflow:auto) — window.scrollTo alone never moved it, so the old
  // scroll position survived every switch. Set scrollTop directly:
  // instant, no smooth animation.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    const scroller = document.querySelector("[data-generated-space-root]");
    if (scroller) scroller.scrollTop = 0;
  }, [view]);

  const data = dash.data;
  const byAsset = (asset: string) => (data?.instruments ?? []).filter((i) => i.asset === asset);
  // A-P2-3: A-share breadth from the stored CSI 300 cloud snapshot —
  // the only breadth the console can compute from data it already owns.
  // Same ±0.2% neutral band as the cloud map's own breadth counts.
  // Deliberately labelled 沪深 300 口径 on the page: it is NOT an
  // all-A-share count, and no limit-up count is derived from it.
  const cnCloudSnap = cloudQ.data?.cloud.cn;
  const cnBreadth =
    cnCloudSnap && cnCloudSnap.stocks.length > 0
      ? { ...cloudBreadth(cnCloudSnap.stocks, "d1"), total: cnCloudSnap.stocks.length, asOf: cnCloudSnap.asOf }
      : null;
  // 宏观页月频数据序列的缺位名单：哪条没拉到就在宏观页明确标注，不编数。
  const macroMissing: string[] = [];
  if (data && !data.macroFred.some((f) => f.key === "cpiYoY")) macroMissing.push("CPI 同比（BLS 官方 API / FRED CPIAUCNS）");
  if (data && !data.macroFred.some((f) => f.key === "unrate")) macroMissing.push("失业率（BLS 官方 API / FRED UNRATE）");
  if (data && !data.macroFred.some((f) => f.key === "corePceYoY")) macroMissing.push("核心 PCE 同比（BEA 发布、FRED PCEPILFE 分发）");
  const goldDerived = (data?.derived ?? []).filter((d) => ["goldSilverRatio", "goldUsCorr"].includes(d.key));
  // 黄金页实际利率兜底：完整卡片只在序列落库且过新鲜度门槛时才由服务端
  // 生成；华尔街分块刷新失败时卡片可能缺位，此时金页用服务端直读的
  // 最后成功落库点（realRateLast）兜底，明示最后值与最后成功日期，
  // 而不是只剩一句缺位说明。卡片在但 wallst 上次刷新失败/部分失败时，
  // 同样标注上方卡片就是最后成功落库数据。
  const goldAnchorCards = (data?.fred ?? []).filter((f) => ["realRate", "breakeven"].includes(f.key));
  const goldRealCard = (data?.fred ?? []).find((f) => f.key === "realRate") ?? null;
  const goldRealLast = data?.realRateLast ?? null;
  // D-P2-5: same rule as stageTimeText — wallst's own staged row only,
  // never the "all"/"legacy" full-refresh rows.
  const wallstStage = data?.stages.find((s) => s.stage === "wallst") ?? null;
  const wallstFailed = wallstStage != null && wallstStage.status !== "ok";
  const wallstWhen = wallstStage
    ? new Date(wallstStage.finishedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "";

  const modules: { id: View; title: string; stat: string }[] = data
    ? [
        {
          id: "cloud",
          title: "云图：全市场热力图",
          stat: data.cloudCounts.us + data.cloudCounts.ndx + data.cloudCounts.dow + data.cloudCounts.rut + data.cloudCounts.cn ? `标普 ${data.cloudCounts.us} 只 · 纳指 ${data.cloudCounts.ndx} 只 · 道指 ${data.cloudCounts.dow} 只 · 罗素前200 ${data.cloudCounts.rut} 只 · 沪深300 ${data.cloudCounts.cn} 只` : "刷新后出现",
        },
        {
          id: "chronicle",
          title: "美股编年史：百年标普的骨架",
          stat: "五卷 · 数据 CC BY 4.0（historyofmarket.com）",
        },
        {
          id: "bonds",
          title: "债券：利率债 · 信用债 · 资金面",
          stat: data.yields ? `10 年国债 ${fmt(data.yields.cn[2]?.yieldPct ?? 0, 2)}% · ${data.yields.date}` : "暂无数据",
        },
        {
          id: "us",
          title: "美股大盘",
          stat: data.marginUs ? `保证金负债 ${fmt(data.marginUs.debtM / 1e6, 3)} 万亿美元（${data.marginUs.month}）` : byAsset("us").length ? `${byAsset("us").length + byAsset("uswatch").length} 个标的` : "暂无数据",
        },
        {
          id: "ussec",
          title: "美股板块轮动",
          stat: byAsset("ussec").length ? `${byAsset("ussec").length} 个板块` : "暂无数据",
        },
        {
          id: "usdiv",
          title: "美股红利 ETF",
          stat: byAsset("usdiv").length ? `${byAsset("usdiv").length} 只红利 ETF` : "暂无数据",
        },
        {
          id: "cn",
          title: "A股大盘",
          stat: data.marginCn ? `融资余额 ${fmt(data.marginCn.totalYi, 0)} 亿元（${data.marginCn.date}）` : byAsset("cn").length ? `${byAsset("cn").length} 个标的` : "暂无数据",
        },
        {
          id: "cnsec",
          title: "A股板块轮动",
          stat: byAsset("cnsec").length ? `${byAsset("cnsec").length} 个板块` : "暂无数据",
        },
        {
          id: "hk",
          title: "港股与恒生科技",
          stat: byAsset("hk").length ? `${byAsset("hk").length} 个标的` : "暂无数据",
        },
        {
          id: "gold",
          title: "黄金与贵金属",
          stat: byAsset("gold").length ? `${byAsset("gold").length} 个标的` : "暂无数据",
        },
        {
          id: "macro",
          title: "宏观环境",
          stat: byAsset("macro").length ? `${byAsset("macro").length} 个标的` : "暂无数据",
        },
        {
          id: "wallst",
          title: "华尔街深钻",
          stat: data.fred.length ? `${data.fred.length} 个宏观指标` : "暂无数据",
        },
        {
          id: "portfolio",
          title: "组合视角",
          stat: data.portfolio.sims.length ? `${data.portfolio.sims.length} 个模拟组合` : "暂无数据",
        },
        {
          id: "calendar",
          title: "大事日历",
          stat: data.calendar.events.filter((e) => !e.past).length ? `未来 ${data.calendar.events.filter((e) => !e.past).length} 个事件` : "暂无数据",
        },
        {
          id: "history",
          title: "历史回撤 · 以史为镜",
          stat: data.drawdowns.length ? `${data.drawdowns.length} 个标的回撤史` : "暂无数据",
        },
        {
          id: "signals",
          title: "决策信号",
          stat: data.signals.length
            ? data.signals.some((s) => s.missing)
              ? `${data.signals.filter((s) => !s.missing).length} 条信号 · ${data.signals.filter((s) => s.missing).length} 条数据未到`
              : `${data.signals.length} 条信号`
            : "暂无数据",
        },
        {
          id: "bottomtop",
          title: "抄底逃顶 · 美股",
          stat:
            data.bottomTop?.composite != null
              ? `综合指数 ${data.bottomTop.composite > 0 ? "+" : ""}${data.bottomTop.composite} · ${data.bottomTop.zone === "bottom" ? "抄底区" : data.bottomTop.zone === "top" ? "逃顶区" : "中性"}`
              : "暂无数据",
        },
        {
          id: "methods",
          title: "方法库 · 白话讲解",
          stat: `${METHODS.length} 篇讲解`,
        },
      ]
    : [];

  const winOpt = WINDOWS.find((w) => w.days === windowDays) ?? WINDOWS[1]!;
  return (
    <WindowCtx.Provider value={{ days: windowDays, label: winOpt.label }}>
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg)]/95 pt-safe backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate font-serif-sc text-base font-bold text-[var(--text)]">市场数据总览</div>
            <div className="truncate text-xs text-[var(--dim)]">
              {data?.updatedAt
                ? `数据更新于 ${new Date(data.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
                : "尚未拉取数据"}
            </div>
          </div>
          {/* Desktop keeps the wide 刷新数据 button here; on phones the
              refresh action moves into the controls row below as a
              compact 刷新 button (NAV-2). */}
          <button
            type="button"
            onClick={() => void startRefresh()}
            disabled={run?.running ?? false}
            className="hidden shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50 sm:block"
          >
            {run?.running ? `刷新中 ${doneCount}/${REFRESH_STAGES.length}` : "刷新数据"}
          </button>
        </div>
        {/* NAV-1 (2026-11-19): on phones the 18 module pills wrapped into
            four rows and pushed the content down, so below sm the nav is a
            single-row dropdown instead — the current module shows in the
            box (accent fill + bold, same selected-state language as the
            chips) and all 18 modules are one tap away in the native
            picker. From sm up the original single-row scrollable chip
            strip is kept unchanged. */}
        {/* NAV-2 (2026-11-19): on phones all three top controls share ONE
            row — module dropdown (flex-1), 统计窗口 dropdown (same
            windowDays state as the desktop pills, so charts/percentiles
            recompute identically), and a compact 刷新 button. The window
            dropdown only appears on views that have a statistics window
            (same WINDOWLESS_VIEWS rule as the desktop pill group). The
            window rule note no longer takes its own row on phones: it
            lives in the window select's title tooltip here, and stays
            visible next to the desktop pills. */}
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 pb-3 sm:hidden">
          <div className="relative min-w-0 flex-1">
            <select
              aria-label="模块导航"
              value={view}
              onChange={(e) => setView(e.target.value as View)}
              className="w-full appearance-none rounded-full bg-[var(--accent)] py-2.5 pl-4 pr-10 text-sm font-bold text-white shadow-[var(--shadow-card)]"
            >
              {NAV.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
            <span aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs text-white">
              ▾
            </span>
          </div>
          {WINDOWLESS_VIEWS.includes(view) ? null : (
            <div className="relative shrink-0">
              <select
                aria-label="统计窗口（图表与历史百分位共用）"
                title="切换后本页图表与百分位按同一窗口重算；决策信号与历史回撤固定用全历史。"
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value))}
                className="appearance-none rounded-full bg-[var(--chip-bg)] py-2.5 pl-3 pr-8 text-sm font-medium text-[var(--chip-text)] shadow-[var(--shadow-card)]"
              >
                {WINDOWS.map((w) => (
                  <option key={w.days} value={w.days}>
                    {w.label}
                  </option>
                ))}
              </select>
              <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--chip-text)]">
                ▾
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => void startRefresh()}
            disabled={run?.running ?? false}
            className="shrink-0 rounded-full bg-[var(--accent)] px-3.5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-card)] disabled:opacity-50"
          >
            {run?.running ? `刷新中 ${doneCount}/${REFRESH_STAGES.length}` : "刷新"}
          </button>
        </div>
        <nav aria-label="模块导航" className="no-scrollbar mx-auto hidden max-w-5xl gap-1 overflow-x-auto px-4 pb-2 sm:flex">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setView(n.id)}
              aria-current={view === n.id ? "page" : undefined}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${
                view === n.id
                  ? "bg-[var(--accent)] font-medium text-white"
                  : "bg-[var(--chip-bg)] text-[var(--chip-text)]"
              }`}
            >
              {n.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-10 pt-4">
        {/* Desktop pill group below; phones use the 统计窗口 dropdown in
            the header controls row instead (NAV-2) — same windowDays state. */}
        {WINDOWLESS_VIEWS.includes(view) ? null : (
          <div className="mb-4 hidden flex-wrap items-center gap-1.5 sm:flex" role="group" aria-label="统计窗口（图表与历史百分位共用）">
            <span className="text-xs font-medium text-[var(--dim)]">统计窗口（图表与百分位同窗口）：</span>
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                onClick={() => setWindowDays(w.days)}
                aria-pressed={windowDays === w.days}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ${windowDays === w.days ? "bg-[var(--accent)] text-white" : "bg-[var(--chip-bg)] text-[var(--chip-text)]"}`}
              >
                {w.label}
              </button>
            ))}
            <span className="text-[11px] text-[var(--dim)]">切换后本页图表与百分位按同一窗口重算；决策信号与历史回撤固定用全历史。</span>
          </div>
        )}
        {run ? (
          <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3" role="status" aria-label="刷新进度">
            {/* M-P2-2: on phones the panel actions go full-width on their
                own rows (w-full, back to auto from sm up) and the rebuild
                confirm group wraps, so no button is squeezed or clipped
                at 375–390px. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-sm font-medium text-[var(--text)]">
                {run.running
                  ? `正在分块刷新（${doneCount}/${REFRESH_STAGES.length}）：${REFRESH_STAGES.find((s) => s.id === run.current)?.label ?? "…"}`
                  : failedStages.length > 0 || partialStages.length > 0 || skippedStages.length > 0
                    ? `刷新完成：${okStageCount} 块成功${partialStages.length > 0 ? `，${partialStages.length} 块部分更新` : ""}${failedStages.length > 0 ? `，${failedStages.length} 块失败（旧数据已保留）` : ""}${skippedStages.length > 0 ? `，${skippedStages.length} 块跳过（已有刷新在进行）` : ""}`
                    : "刷新完成：全部模块已更新"}
              </span>
              {!run.running && retryStages.length > 0 ? (
                <button
                  type="button"
                  onClick={() => void startRefresh(retryStages.map((s) => s.id))}
                  className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text)] sm:w-auto"
                >
                  只重试未完全成功的 {retryStages.length} 块
                </button>
              ) : null}
              {!run.running ? (
                <button
                  type="button"
                  aria-label="关闭刷新结果面板"
                  onClick={() => {
                    setConfirmRebuild(false);
                    setRun(null);
                  }}
                  className="w-full shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text)] sm:w-auto"
                >
                  关闭 ✕
                </button>
              ) : null}
              {!run.running ? (
                confirmRebuild ? (
                  <span className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmRebuild(false);
                        void startRefresh(undefined, true);
                      }}
                      className="min-w-0 flex-1 rounded-lg bg-[var(--up)] px-3 py-1.5 text-xs font-medium text-white sm:flex-none"
                    >
                      确认全量重建（慢，只拉尾巴之外的全部历史）
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRebuild(false)}
                      className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text)]"
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRebuild(true)}
                    className="w-full rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--dim)] sm:w-auto"
                  >
                    全量重建历史库
                  </button>
                )
              ) : null}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border)]/60" aria-hidden>
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all duration-500"
                style={{ width: `${(doneCount / REFRESH_STAGES.length) * 100}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {REFRESH_STAGES.map((s) => {
                const st = run.states[s.id] ?? "pending";
                return (
                  <span
                    key={s.id}
                    className={`max-w-full rounded-full px-2 py-1 text-[11px] ${
                      st === "ok"
                        ? "bg-[var(--down)]/15 text-[var(--down)]"
                        : st === "partial"
                          ? "bg-[var(--gold)]/15 font-medium text-[var(--gold)]"
                          : st === "error"
                            ? "bg-[var(--up)]/15 text-[var(--up)]"
                            : st === "running"
                              ? "bg-[var(--accent)]/15 font-medium text-[var(--accent)]"
                              : "bg-[var(--border)]/50 text-[var(--dim)]"
                    }`}
                  >
                    {s.label}
                    {st === "ok" ? " ✓" : st === "partial" ? " · 部分" : st === "error" ? " ✗" : st === "running" ? " · 拉取中" : st === "skipped" ? " · 已跳过" : ""}
                  </span>
                );
              })}
            </div>
            {!run.running && REFRESH_STAGES.some((s) => run.summaries[s.id]) ? (
              <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-[var(--dim)] [overflow-wrap:anywhere]">
                {REFRESH_STAGES.filter((s) => run.summaries[s.id]).map((s) => (
                  <p key={s.id}>
                    {s.label}：{run.summaries[s.id]}
                  </p>
                ))}
              </div>
            ) : null}
            {failedStages.length > 0 ? (
              <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-[var(--up)] [overflow-wrap:anywhere]">
                {failedStages.map((s) => (
                  <p key={s.id}>
                    {s.label}：{(run.errors[s.id] ?? []).join("；") || "拉取失败"}（该块继续显示上次的数据）
                  </p>
                ))}
              </div>
            ) : null}
            {!run.running && partialStages.length > 0 ? (
              <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-[var(--dim)] [overflow-wrap:anywhere]">
                {partialStages.map((s) => (
                  <p key={s.id}>
                    {s.label}（部分更新）：{(run.errors[s.id] ?? []).join("；")}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {dash.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">正在读取管控台数据…</p>
        ) : dash.isError ? (
          <p className="py-16 text-center text-sm text-[var(--up)]">数据读取失败，请刷新页面重试。</p>
        ) : !data || !data.hasData ? (
          <div className="py-16 text-center">
            <h2 className="font-serif-sc text-xl font-bold text-[var(--text)]">管控台还没有数据</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[var(--dim)]">
              点击下方按钮，程序会直接从 Yahoo Finance、东方财富和中国外汇交易中心（ChinaMoney）拉取近 10–20 年的历史行情、中美国债收益率与银行间资金利率，
              并算出每个指标的历史百分位。全程是程序抓取与计算，不经过 AI。
            </p>
            <button
              type="button"
              onClick={() => void startRefresh()}
              disabled={run?.running ?? false}
              className="mt-5 rounded-lg bg-[var(--accent)] px-6 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {run?.running ? `正在分块拉取（${doneCount}/${REFRESH_STAGES.length}）…` : "拉取第一批数据"}
            </button>
          </div>
        ) : (
          <>
            {view === "overview" ? (
              <>
                <section aria-label="五大资产快照">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {data.hero.map((h, hi) => (
                      <div key={h.key} className={`${hi === data.hero.length - 1 && data.hero.length % 2 === 1 ? "col-span-2 " : ""}rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-3 sm:col-span-1`}>
                        <div className="truncate text-xs text-[var(--dim)]">{h.name}</div>
                        <div className="mt-1 font-serif-sc text-xl font-bold leading-none tracking-tight text-[var(--text)]">
                          {fmt(h.value, h.decimals)}
                          <span className="ml-0.5 text-xs font-normal text-[var(--dim)]">{h.unit}</span>
                        </div>
                        <div className="mt-1.5 text-xs">
                          {h.key === "cn10y" ? (
                            <span className={h.changePct != null ? moveColor(h.changePct) : ""}>
                              {h.changePct != null ? `${signed(h.changePct, 1)} bp` : ""} · {h.date}
                            </span>
                          ) : (
                            <span className={h.changePct != null ? moveColor(h.changePct) : "text-[var(--dim)]"}>
                              {h.changePct != null ? `${signed(h.changePct, 2)}%` : "—"}{" "}
                              <span className="text-[var(--dim)]">· {h.date}</span>
                            </span>
                          )}
                        </div>
                        {h.partial ? (
                          <div className="mt-1">
                            <span className="inline-block rounded-full bg-[var(--gold)]/15 px-2 py-0.5 text-[11px] font-medium leading-tight text-[var(--gold)]">
                              盘中快照，未收盘
                            </span>
                          </div>
                        ) : null}
                        {h.percentile != null ? (
                          <div className="mt-2">
                            <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--dim)]">
                              <span>{h.invert ? "历史百分位" : "价格历史位置"} {h.percentile}</span>
                              <LabelChip label={h.label} invert={h.invert} />
                            </div>
                            <PctBar percentile={h.percentile} height="h-1.5" invert={h.invert} />
                            <div className="mt-1 text-[11px] leading-snug text-[var(--dim)]">
                              {h.count != null ? `${winOpt.label} · 样本 ${h.count} 个交易日` : "样本天数暂无"}
                            </div>
                          </div>
                        ) : (
                          <div className="mt-2 text-[11px] leading-snug text-[var(--dim)]">样本天数暂无</div>
                        )}
                      </div>
                    ))}
                  </div>
                  {data.refreshStatus !== "ok" && data.refreshDetail ? (
                    <details className="mt-1 text-xs text-[var(--up)]">
                      <summary className="cursor-pointer py-1">
                        上次刷新有 {data.refreshDetail.split("；").length} 项未成功：
                        {[...new Set(data.refreshDetail.split("；").map((seg) => seg.split(/[:：]/)[0]?.trim() ?? seg))].join("、")}
                        （点开看逐条原因）
                      </summary>
                      <p className="mt-1 leading-relaxed">{data.refreshDetail}</p>
                    </details>
                  ) : null}
                </section>

                {data.marginCn || data.marginUs ? (
                  <section aria-label="杠杆温度" className="mt-6">
                    <h2 className="font-serif-sc text-xl font-black text-[var(--text)]">杠杆温度</h2>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      {data.marginCn ? (
                        <button type="button" onClick={() => setView("cn")} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-3 text-left">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-xs text-[var(--dim)]">融资余额（沪 + 深）· A股杠杆存量</span>
                            <span className="shrink-0 text-xs text-[var(--dim)]">{data.marginCn.date}</span>
                          </div>
                          <div className="mt-1 font-serif-sc text-xl font-bold leading-none tracking-tight text-[var(--text)]">
                            {fmt(data.marginCn.totalYi, 0)}
                            <span className="ml-0.5 text-xs font-normal text-[var(--dim)]">亿元</span>
                          </div>
                          <div className="mt-1.5 text-xs">
                            <span className={moveColor(data.marginCn.netYi)}>
                              当日净买入 {data.marginCn.netYi >= 0 ? "+" : ""}
                              {fmt(data.marginCn.netYi, 1)} 亿元
                            </span>
                            <span className="text-[var(--dim)]"> · 距高点 {data.marginCn.distHighPct.toFixed(1)}%</span>
                          </div>
                          {data.marginCn.statsFull ? (
                            <div className="mt-2">
                              <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--dim)]">
                                <span>近 5 年百分位 {data.marginCn.statsFull.percentile}</span>
                                <LabelChip label={data.marginCn.statsFull.label} invert={data.marginCn.statsFull.invert} />
                              </div>
                              <PctBar percentile={data.marginCn.statsFull.percentile} height="h-1.5" invert={data.marginCn.statsFull.invert} />
                              <div className="mt-1 text-[11px] leading-snug text-[var(--dim)]">样本 {data.marginCn.statsFull.count} 个交易日 · 点开看沪深拆分、净买入与融券 →</div>
                            </div>
                          ) : null}
                        </button>
                      ) : null}
                      {data.marginUs ? (
                        <button type="button" onClick={() => setView("us")} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-3 text-left">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-xs text-[var(--dim)]">保证金负债（FINRA）· 美股杠杆存量</span>
                            <span className="shrink-0 text-xs text-[var(--dim)]">{data.marginUs.month} · 月度</span>
                          </div>
                          <div className="mt-1 font-serif-sc text-xl font-bold leading-none tracking-tight text-[var(--text)]">
                            {fmt(data.marginUs.debtM / 1e6, 3)}
                            <span className="ml-0.5 text-xs font-normal text-[var(--dim)]">万亿美元</span>
                          </div>
                          <div className="mt-1.5 text-xs">
                            {data.marginUs.yoyPct != null ? (
                              <span className={moveColor(data.marginUs.yoyPct)}>
                                同比 {data.marginUs.yoyPct >= 0 ? "+" : ""}
                                {data.marginUs.yoyPct.toFixed(1)}%
                              </span>
                            ) : null}
                            <span className="text-[var(--dim)]"> · 距历史高点 {data.marginUs.distHighPct.toFixed(1)}%</span>
                          </div>
                          {data.marginUs.stats ? (
                            <div className="mt-2">
                              <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--dim)]">
                                <span>{data.marginUs.seedStats ? `百分位（仅 ${data.marginUs.stats.count} 个月窗口）` : `全历史百分位 ${data.marginUs.stats.percentile}`}</span>
                                <LabelChip label={data.marginUs.stats.label} invert={data.marginUs.stats.invert} />
                              </div>
                              <PctBar percentile={data.marginUs.stats.percentile} height="h-1.5" invert={data.marginUs.stats.invert} />
                              <div className="mt-1 text-[11px] leading-snug text-[var(--dim)]">
                                {data.marginUs.seedStats ? "全历史待 FINRA xlsx 接入 · " : `样本 ${data.marginUs.stats.count} 个月 · `}点开看与标普 500 的对照走势 →
                              </div>
                            </div>
                          ) : null}
                        </button>
                      ) : null}
                    </div>
                  </section>
                ) : null}

                {data.fearGreed ? (
                  <section aria-label="市场情绪" className="mt-6">
                    <h2 className="font-serif-sc text-xl font-black text-[var(--text)]">市场情绪</h2>
                    <button type="button" onClick={() => setView("us")} className="mt-2 block w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-3 text-left sm:max-w-md">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 text-xs leading-snug text-[var(--dim)]">恐惧与贪婪指数（CNN）· 美股情绪温度计</span>
                        <span className="shrink-0 text-xs text-[var(--dim)]">{data.fearGreed.updatedBj} 北京时间</span>
                      </div>
                      <div className="mt-1 flex items-center gap-3">
                        <div className="w-[132px] shrink-0">
                          <FearGreedGauge score={data.fearGreed.score} labels={false} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="font-serif-sc text-2xl font-bold leading-none text-[var(--text)]">{data.fearGreed.score.toFixed(1)}</span>
                            <span
                              className="rounded-full px-2 py-0.5 text-xs font-bold"
                              style={{ background: fgBand(data.fearGreed.score).color, color: fgBand(data.fearGreed.score).onColor }}
                            >
                              {fgBand(data.fearGreed.score).label}
                            </span>
                          </div>
                          <div className="mt-1.5 text-xs text-[var(--dim)]">
                            前收 {data.fearGreed.prevClose.toFixed(1)} · 1 周前 {data.fearGreed.prevWeek.toFixed(1)} · 1 月前 {data.fearGreed.prevMonth.toFixed(1)} · 1 年前 {data.fearGreed.prevYear.toFixed(1)}
                          </div>
                          {data.fearGreed.stats ? (
                            <div className="mt-2">
                              <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--dim)]">
                                <span>近 1 年百分位 {data.fearGreed.stats.percentile}</span>
                                <LabelChip label={data.fearGreed.stats.label} invert={data.fearGreed.stats.invert} />
                              </div>
                              <PctBar percentile={data.fearGreed.stats.percentile} height="h-1.5" invert={data.fearGreed.stats.invert} />
                              <div className="mt-1 text-[11px] leading-snug text-[var(--dim)]">样本 {data.fearGreed.stats.count} 个交易日（端点历史 1 年）· 点开看 7 个分项与历史走势 →</div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </section>
                ) : null}

                {data.signals.length > 0 ? (
                  <section aria-label="决策信号速览" className="mt-6">
                    <div className="flex items-baseline justify-between gap-2">
                      <h2 className="font-serif-sc text-xl font-black text-[var(--text)]">决策信号速览</h2>
                      <button type="button" onClick={() => setView("signals")} className="shrink-0 py-1 text-xs text-[var(--accent)]">全部信号与依据 →</button>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                      {data.signals.map((s) =>
                        s.missing ? (
                          <button
                            key={s.key}
                            type="button"
                            onClick={() => setView("signals")}
                            aria-label={`${s.name}：数据未到，点开看缺失原因`}
                            className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)]/60 px-2 py-1 text-left text-[11px] leading-[15px] text-[var(--dim)]"
                          >
                            {s.name}：数据未到
                          </button>
                        ) : (
                          <button
                            key={s.key}
                            type="button"
                            onClick={() => setView("signals")}
                            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-left text-[11px] leading-[15px] text-[var(--text)]"
                          >
                            {s.name}：<span className={toneTextClass(s.tone)}>{s.verdict}</span>
                          </button>
                        ),
                      )}
                    </div>
                    {/* F-P2-8: same legend as the signals page — the
                        overview strip previously showed coloured verdicts
                        with no key. Wraps on phone. */}
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--dim)]" aria-label="信号颜色图例">
                      <span className="font-medium text-[var(--text)]">图例</span>
                      <span className="inline-flex items-center gap-1"><span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: toneBarColor("buy") }} />红 = 倾向买入</span>
                      <span className="inline-flex items-center gap-1"><span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: toneBarColor("reduce") }} />金 = 减仓</span>
                      <span className="inline-flex items-center gap-1"><span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: toneBarColor("hold") }} />灰 = 观望</span>
                      <span className="inline-flex items-center gap-1"><span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: toneBarColor("avoid") }} />绿 = 回避</span>
                    </p>
                    {data.signals.some((s) => s.missing) ? (
                      <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                        {data.signals.filter((s) => s.missing).length} 条信号的数据这次没拉到，位置保留在信号页并注明了缺失原因；下一次刷新数据到了自动恢复。
                      </p>
                    ) : null}
                  </section>
                ) : null}

                {data.calendar.events.some((e) => !e.past) ? (
                  <section aria-label="近期大事" className="mt-6">
                    <div className="flex items-baseline justify-between gap-2">
                      <h2 className="font-serif-sc text-xl font-black text-[var(--text)]">近期大事</h2>
                      <button type="button" onClick={() => setView("calendar")} className="shrink-0 py-1 text-xs text-[var(--accent)]">未来 1–3 个月日历 →</button>
                    </div>
                    <div className="mt-2 grid gap-2">
                      {data.calendar.events
                        .filter((e) => !e.past)
                        .slice(0, 5)
                        .map((e) => (
                          <button
                            key={`${e.date}-${e.title}`}
                            type="button"
                            onClick={() => setView("calendar")}
                            className="flex items-baseline gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] px-3.5 py-2.5 text-left"
                          >
                            <span className="shrink-0 text-xs font-medium text-[var(--accent)]">{e.date.slice(5)}</span>
                            {/* F-P2-6: phone wraps the full event name (no
                                ellipsis cut); ≥sm keeps the single-line
                                truncate the desktop layout already had. */}
                            <span className="min-w-0 flex-1 break-words text-sm font-medium leading-snug text-[var(--text)] sm:truncate">{e.title}</span>
                            <span className="shrink-0 text-xs text-[var(--dim)]">{e.timeText}</span>
                          </button>
                        ))}
                    </div>
                  </section>
                ) : null}

                <section aria-label="模块入口" className="mt-6">
                  <SectionHead title="模块总览 · 点进每个模块往下钻" />
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {modules.map((mod) => (
                      <button
                        key={mod.id}
                        type="button"
                        onClick={() => setView(mod.id)}
                        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4 text-left"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-serif-sc text-base font-bold text-[var(--text)]">{mod.title}</span>
                          <span className="shrink-0 text-[var(--accent)]" aria-hidden>→</span>
                        </div>
                        <div className="mt-2 text-xs font-medium text-[var(--text)]">{mod.stat}</div>
                      </button>
                    ))}
                  </div>
                </section>

                {data.coverage.length > 0 ? (
                  <section aria-label="数据覆盖" className="mt-6">
                    <details>
                      <summary className="cursor-pointer py-1 text-sm font-medium text-[var(--text)]">
                        数据覆盖 · 静态种子库（{data.coverage.length} 条序列）
                      </summary>
                      {/* Phone (<640px): card list, first 20 + expand-all —
                          every field fits the screen width, no horizontal
                          scroll (M-P2-1). Same rows/口径 as the table. */}
                      <div className="mt-2 sm:hidden">
                        <ul className="divide-y divide-[var(--border)]/60">
                          {(coverageExpanded ? data.coverage : data.coverage.slice(0, 20)).map((c) => (
                            <li key={c.key} className="py-2">
                              <div className="text-sm font-medium text-[var(--text)]">
                                {coverageName(c.key, data.instruments)}
                              </div>
                              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--dim)]">
                                <span>起始 {c.from}</span>
                                <span>最新 {c.to}</span>
                                <span className="text-[var(--text)]">{c.points.toLocaleString()} 点</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                        {data.coverage.length > 20 ? (
                          <button
                            type="button"
                            onClick={() => setCoverageExpanded((v) => !v)}
                            aria-expanded={coverageExpanded}
                            className="mt-1 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm font-medium text-[var(--text)]"
                          >
                            {coverageExpanded ? "收起" : `展开全部（共 ${data.coverage.length} 条）`}
                          </button>
                        ) : null}
                      </div>
                      <div className="mt-2 hidden overflow-x-auto sm:block">
                        <table className="w-full min-w-[520px] text-xs">
                          <thead>
                            <tr className="border-b border-[var(--border)] text-left text-[var(--dim)]">
                              <th className="py-1.5 pr-2 font-medium">序列</th>
                              <th className="py-1.5 pr-2 font-medium">起始</th>
                              <th className="py-1.5 pr-2 font-medium">最新</th>
                              <th className="py-1.5 text-right font-medium">点数</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.coverage.map((c) => (
                              <tr key={c.key} className="border-b border-[var(--border)]/50">
                                <td className="py-1 pr-2 text-[var(--text)]">{coverageName(c.key, data.instruments)}</td>
                                <td className="py-1 pr-2 text-[var(--dim)]">{c.from}</td>
                                <td className="py-1 pr-2 text-[var(--dim)]">{c.to}</td>
                                <td className="py-1 text-right text-[var(--text)]">{c.points.toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </section>
                ) : null}
              </>
            ) : null}

            {FRESH_BY_VIEW[view] ? <FreshLine stages={data.stages} items={FRESH_BY_VIEW[view]!} /> : null}

            {view === "cloud" ? (
              <CloudView
                cloud={cloudQ.data?.cloud}
                stages={data.stages}
                goMethod={goMethod}
                officialDay={{
                  us: (() => { const i = data.instruments.find((x) => x.key === "spx"); return i ? { pct: i.changePct, date: i.date } : null; })(),
                  ndx: (() => { const i = data.instruments.find((x) => x.key === "ndx"); return i ? { pct: i.changePct, date: i.date } : null; })(),
                  dow: cloudQ.data?.cloud.official.dow ?? null,
                  rut: cloudQ.data?.cloud.official.rut ?? null,
                  cn: (() => { const i = data.instruments.find((x) => x.key === "csi300"); return i ? { pct: i.changePct, date: i.date } : null; })(),
                }}
              />
            ) : null}

            {view === "chronicle" ? (
              <ChronicleView data={chronQ.data} stages={data.stages} goView={setView} />
            ) : null}

            {view === "bonds" ? <BondsModule data={data} goMethod={goMethod} /> : null}

            {view === "us" ? (
              <section>
                <SectionHead
                  title="美股大盘"

                />
                <InstrumentList instruments={byAsset("us")} goMethod={goMethod} />
                {byAsset("uswatch").length > 0 ? (
                  <>
                    <h3 className="mt-5 font-serif-sc text-lg font-bold text-[var(--text)]">自选个股与原油 ETF</h3>
                    <div className="mt-3">
                      <InstrumentList instruments={byAsset("uswatch")} goMethod={goMethod} peByKey={watchPeByKey} peStatus={watchPeStatus} />
                    </div>
                  </>
                ) : null}
                {data.fibs.length > 0 ? (
                  <>
                    <h3 className="mt-5 font-serif-sc text-lg font-bold text-[var(--text)]">斐波那契回撤 · 52 周锚点</h3>
                    <div className="mt-3 grid gap-3">
                      {data.fibs.map((f) => (
                        <FibCard key={f.key} fib={f} goMethod={goMethod} />
                      ))}
                    </div>
                  </>
                ) : null}
                {data.marginUs ? (
                  <MarginUsSection block={data.marginUs} stages={data.stages} goMethod={goMethod} />
                ) : (
                  <div className="mt-6 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface-2)]/60 p-4">
                    <p className="text-sm font-bold text-[var(--text)]">保证金负债 · 美股杠杆存量（FINRA 月度，数据尚未入库）</p>
                  </div>
                )}
                {data.fearGreed ? (
                  <FearGreedSection block={data.fearGreed} stages={data.stages} />
                ) : (
                  <div className="mt-6 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface-2)]/60 p-4">
                    <p className="text-sm font-bold text-[var(--text)]">恐惧与贪婪指数 · 市场情绪温度计（CNN，数据尚未入库）</p>
                  </div>
                )}
              </section>
            ) : null}

            {view === "ussec" ? (
              <SectorView
                title="美股板块轮动 · 11 大行业"

                instruments={byAsset("ussec")}
                benchmarkName="标普 500"
                goMethod={goMethod}
              />
            ) : null}

            {view === "usdiv" ? (
              <SectorView
                title="美股红利 ETF · 六种流派深挖"

                instruments={byAsset("usdiv")}
                benchmarkName="标普 500"
                goMethod={goMethod}
              />
            ) : null}

            {view === "cn" ? (
              <section>
                <SectionHead
                  title="A股大盘"

                />
                {data.cnMoney.length > 0 ? (
                  <>
                    <h3 className="mt-4 text-base font-bold text-[var(--text)]">资金面 · 成交额、两融、南向与股债性价比</h3>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {data.cnMoney.map((c) => (
                        <IndicatorCard key={c.key} ind={c} goMethod={goMethod} />
                      ))}
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
                      <span className="font-medium text-[var(--text)]">涨跌家数（沪深 300 成分口径）：</span>
                      {cnBreadth ? (
                        <>
                          涨 {cnBreadth.up} 只 · 平 {cnBreadth.flat} 只 · 跌 {cnBreadth.down} 只（共 {cnBreadth.total} 只成分股，云图快照 {cnBreadth.asOf || "日期暂无"}）。
                        </>
                      ) : (
                        <>云图快照尚未拉取到，暂时算不出。</>
                      )}
                    </p>
                  </>
                ) : null}
                {data.marginCn ? (
                  <MarginCnSection block={data.marginCn} stages={data.stages} goMethod={goMethod} />
                ) : (
                  <div className="mt-6 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface-2)]/60 p-4">
                    <p className="text-sm font-bold text-[var(--text)]">融资余额 · 沪深两市杠杆存量与流向（数据尚未入库）</p>
                  </div>
                )}
                <InstrumentList instruments={byAsset("cn")} goMethod={goMethod} />
              </section>
            ) : null}

            {view === "cnsec" ? (
              <SectorView
                title="A股板块轮动 · 红利 / 消费 / 科技 / 能源…"

                instruments={byAsset("cnsec")}
                benchmarkName="沪深 300"
                goMethod={goMethod}
              />
            ) : null}

            {view === "hk" ? (
              <section>
                <SectionHead
                  title="港股与恒生科技"

                />
                <InstrumentList instruments={byAsset("hk")} goMethod={goMethod} />
              </section>
            ) : null}

            {view === "gold" ? (
              <section>
                <SectionHead
                  title="黄金与贵金属"

                />
                <InstrumentList instruments={byAsset("gold")} goMethod={goMethod} />
                {goldDerived.length > 0 ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {goldDerived.map((d) => (
                      <IndicatorCard key={d.key} ind={d} goMethod={goMethod} />
                    ))}
                  </div>
                ) : null}
                {goldAnchorCards.length > 0 || goldRealLast || wallstStage ? (
                  <>
                    <h3 className="mt-5 text-base font-bold text-[var(--text)]">黄金的宏观锚 · 实际利率</h3>
                    {goldAnchorCards.length > 0 ? (
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        {goldAnchorCards.map((f) => (
                          <IndicatorCard key={f.key} ind={f} goMethod={goMethod} />
                        ))}
                      </div>
                    ) : null}
                    {wallstFailed && goldRealCard ? (
                      <p className="mt-2 rounded-[var(--radius)] border border-[var(--gold)]/50 bg-[var(--gold)]/10 p-3 text-sm leading-relaxed text-[var(--text)]">
                        华尔街分块上次刷新未完全成功（{wallstWhen}，状态：{wallstStage?.status === "error" ? "失败" : "部分失败"}），本次没有拉到新的实际利率——上方卡片就是最后成功落库的数据：最后值 {goldRealCard.value.toFixed(2)}%，最后成功日期 {goldRealCard.date}。下一次华尔街分块刷新成功后自动更新为新值。
                        {wallstStage?.detail ? <span className="mt-1 block text-xs text-[var(--dim)]">失败原因：{wallstStage.detail}</span> : null}
                      </p>
                    ) : null}
                    {!goldRealCard ? (
                      <div className="mt-2 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface-2)]/60 p-4">
                        <p className="text-sm font-bold text-[var(--text)]">美国 10 年实际利率（TIPS）· 完整卡片本次未生成</p>
                        {goldRealLast ? (
                          <>
                            <p className="mt-1.5 text-sm leading-relaxed text-[var(--text)]">
                              最后值 <span className="font-serif-sc text-xl font-bold">{goldRealLast.value.toFixed(2)}%</span>
                              <span className="text-[var(--dim)]"> · 最后成功日期 {goldRealLast.date}（库中已落库 {goldRealLast.points} 个历史点）</span>
                            </p>
                          </>
                        ) : (
                          <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">实际利率至今无成功落库记录，无最后值可显示。</p>
                        )}
                      </div>
                    ) : null}
                  </>
                ) : null}
                <h3 className="mt-5 text-base font-bold text-[var(--text)]">季度手工备注 · 央行购金 / COMEX 持仓 / GLD 持仓</h3>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
                    <p className="text-sm font-bold text-[var(--text)]">央行购金（2026 年三季度）</p>
                    <p className="mt-1.5 text-2xl font-bold text-[var(--text)]">321.2 吨</p>
                    <p className="text-xs text-[var(--dim)]">全球央行预估净买入 · 同比 +42%</p>
                    <ul className="mt-2.5 list-disc space-y-1 pl-4 text-sm leading-relaxed text-[var(--text)]">
                      <li>历史对比：去年同期 226.3 吨；近 5 年季度均值 227 吨，本季高出约 41%，为 2024 年末以来最强单季</li>
                      <li>年初至今累计 675 吨（同比 +6%）</li>
                      <li>各国上报合计仅 120 吨，未上报部分约占 63%；上报买家前两位：中国 63 吨、波兰 40 吨；俄罗斯减持 19 吨为唯一大额卖家</li>
                    </ul>
                    <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
                      参考信号：单季预估买入高于 5 年均值（227 吨）= 利率逻辑之外有结构买盘托底；若单季跌破 150 吨且黄金 ETF 同步流出，非利率支撑减弱，需重新评估。
                    </p>
                    <p className="mt-2.5 text-xs leading-relaxed text-[var(--dim)]">
                      来源：世界黄金协会《Gold Demand Trends Q3 2026》，2026-11-03 发布（数据期：2026 年三季度）·{" "}
                      <a className="underline" href="https://www.gold.org/goldhub/research/gold-demand-trends/gold-demand-trends-q3-2026" target="_blank" rel="noreferrer">gold.org 报告页</a>
                    </p>
                  </div>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
                    <p className="text-sm font-bold text-[var(--text)]">COMEX 持仓（2026-11-10）</p>
                    <p className="mt-1.5 text-2xl font-bold text-[var(--text)]">净多 112,341 手</p>
                    <p className="text-xs text-[var(--dim)]">管理基金（投机盘）净多头 · 周环比 +8,727 手</p>
                    <ul className="mt-2.5 list-disc space-y-1 pl-4 text-sm leading-relaxed text-[var(--text)]">
                      <li>多头 127,406 手 / 空头 15,065 手；总未平仓 404,725 手</li>
                      <li>历史对比：上一周（11-03）103,614 手，9 月底 120,318 手；低于 2026 年内高点（8 月底约 144,747 手）</li>
                      <li>3 年 COT 指数约 42 / 100，处中段，不拥挤</li>
                    </ul>
                    <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
                      参考信号：净多处 3 年区间中段 = 中性；若 COT 指数冲上 85 以上且金价滞涨，警惕多头踩踏；净多跌破 5 万手则说明投机盘已大幅撤离。
                    </p>
                    <p className="mt-2.5 text-xs leading-relaxed text-[var(--dim)]">
                      来源：美国商品期货交易委员会（CFTC）Commitments of Traders 分解报告，COMEX 黄金（代码 088691），持仓日 2026-11-10（周二收盘，周五发布）
                    </p>
                  </div>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-4">
                    <p className="text-sm font-bold text-[var(--text)]">GLD 持仓（2026-11-18）</p>
                    <p className="mt-1.5 text-2xl font-bold text-[var(--text)]">1,044.12 吨</p>
                    <p className="text-xs text-[var(--dim)]">SPDR Gold Shares 实物持仓 · 当日 −4.56 吨</p>
                    <ul className="mt-2.5 list-disc space-y-1 pl-4 text-sm leading-relaxed text-[var(--text)]">
                      <li>11 月至今 +2.47 吨；2026 年至今 −26.44 吨（2025 年末 1,070.56 吨）</li>
                      <li>历史对比：为历史峰值 1,353.35 吨（2012-12-07）的 77.2%</li>
                      <li>对照：全球黄金 ETF 持仓三季度净增 211 吨、季末达纪录 4,256 吨（WGC）——全球在增，增量主要在欧洲与亚洲基金，GLD 单只年内略减</li>
                    </ul>
                    <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
                      参考信号：全球 ETF 持仓创纪录 + 央行大买 = 两路长钱同向；若 GLD 单月净流出超 30 吨且金价同步破位，说明配置盘在撤，需谨慎。
                    </p>
                    <p className="mt-2.5 text-xs leading-relaxed text-[var(--dim)]">
                      来源：SPDR Gold Trust 发行商日度持仓档案，数据日 2026-11-18（美股收盘）
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
                  缺位说明：{goldRealCard ? "实际利率已改由美国财政部官网每日实际收益率曲线供给（见上方卡片）；" : goldRealLast ? `实际利率（美国财政部官网实际收益率曲线）本次未拉到——最后成功落库值为 ${goldRealLast.value.toFixed(2)}%（最后成功日期 ${goldRealLast.date}，见上方兜底卡），连通恢复后完整卡片会自动恢复；` : "实际利率（美国财政部官网实际收益率曲线）本次未拉到，且至今无成功落库记录、无最后值可显示，连通恢复后会自动出现在上方；"}</p>
              </section>
            ) : null}

            {view === "macro" ? (
              <section>
                <SectionHead
                  title="宏观环境"

                />
                <InstrumentList instruments={byAsset("macro")} goMethod={goMethod} />

                <h3 className="mt-6 text-base font-bold text-[var(--text)]">宏观数据序列 · 美国月频</h3>
                <p className="mt-1.5 text-[11px] text-[var(--dim)]">本模块数据更新于 {stageTimeText(data.stages, "wallst")}</p>
                {data.macroFred.length > 0 ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {data.macroFred.map((f) => (
                      <IndicatorCard key={f.key} ind={f} goMethod={goMethod} />
                    ))}
                  </div>
                ) : null}
                {macroMissing.length > 0 ? (
                  <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">缺位：{macroMissing.join("；")}。</p>
                ) : null}
              </section>
            ) : null}

            {view === "wallst" ? <WallStView data={data} goMethod={goMethod} /> : null}

            {view === "portfolio" ? <PortfolioView data={data} goMethod={goMethod} /> : null}

            {view === "calendar" ? <CalendarView data={data} goMethod={goMethod} /> : null}

            {view === "history" ? <HistoryView data={data} goMethod={goMethod} /> : null}

            {view === "signals" ? <SignalsView data={data} /> : null}

            {view === "bottomtop" ? <BottomTopView data={data} /> : null}

            {view === "methods" ? <MethodLibrary /> : null}

            <footer className="mt-12 border-t border-[var(--border)] pt-4 text-xs leading-relaxed text-[var(--dim)]">
              <p>
                数据来源：价格与指数来自 Yahoo Finance（各交易所最新常规收盘，恒生科技、A股板块、债券 ETF 均为上市 ETF 代理）；中美各期限国债收益率、SHIBOR、两融余额、成交额与南向资金每日净买入来自东方财富数据中心（SHIBOR 为中国外汇交易中心公布值的转引，南向为港交所每日披露值的转引）；红利低波（H30269）与上证红利（000015）指数股息率来自中证指数官网每日估值文件（股息率1/总股本口径）；沪深 300 与 10 只 A 股板块 ETF 的历史 PE 序列来自中证指数官网（指数公司发布的市盈率，月末点、近 5 年窗口）；标普 500 的历史 PE 序列来自 Multpl（月度 TTM，1871 年至今、近 5 年窗口，与耶鲁 Shiller 序列 1830 个月重叠交叉核对一致），其 CAPE 历史序列来自耶鲁 Shiller（截至 2023-09，源站未更新、当前值暂缺）；恒生指数的当前 TTM PE 与年度历史来自 Siblis Research（月度序列未公开，无 5 年百分位）；SPDR 板块与美股红利 ETF 的历史 PE 自 2026-11-20 起每周积累 Yahoo 当期 TTM PE（非官方序列，满 8 点后显示百分位）；前瞻 PE 为手工积累（标普 500 取 FactSet Earnings Insight、纳指 100 取 Siblis 当月值）；纳斯达克 100 的当前 TTM PE 与年度历史来自 Siblis Research（月度序列未公开，无 5 年百分位）；恒生国企/恒生科技等没有可用的权威免费历史 PE 来源，其卡片标注「暂无历史 PE 数据」，不估算；实际利率与通胀预期来自美国财政部官网每日收益率曲线、政策利率（EFFR）与 ACM 期限溢价来自纽约联储官网、消费者信心来自密歇根大学消费者调查官网、CPI 与失业率来自美国劳工统计局（BLS）官方 API、核心 PCE 同比来自美国经济分析局（BEA）经美联储 FRED 分发的价格指数、金融条件指数来自芝加哥联储官方数据接口（api.data.chicagofed.org）；信用利差、广义美元等来自美联储 FRED 数据库；企业利润来自美国经济分析局（BEA）NIPA 直连（FRED 镜像兜底）；大事日历来自美联储官网议息日程、BEA 发布日程、Faireconomy 经济日历与 Nasdaq 财报日历；
                融资余额（沪深两市，近 5 年日度）来自上交所官网融资融券汇总与深交所披露（深市经东方财富数据中心镜像转引、与深交所披露逐项交叉核对，两市合计为沪 + 深相加、不含北交所，与两融余额卡的三市口径分开标注）；美股保证金负债与自由信用余额来自 FINRA Margin Statistics 官方月度统计（xlsx 全历史，月度、滞后约一个月）；恐惧与贪婪指数来自 CNN Business Fear &amp; Greed Index（production.dataviz.cnn.io 官方数据端点，盘中更新）；
                回购定盘利率来自中国外汇交易中心（ChinaMoney），交易所回购 GC007 / GC001 来自东方财富行情；国开债−国债 10Y 利差（月末）来自中债收益率曲线（中债国债与中债国开债收益率曲线，中央国债登记结算公司 yield.chinabond.com.cn）。另有三处非官方输入，仅用于成分与分类、不提供价格与收益率数据：标普 500 与纳斯达克 100 成分表来自 Wikipedia、A 股行业分类来自新浪财经（Sina）、沪深 300 成分权重来自中证指数官网（CSI）。全部指标（均线、RSI、MACD、布林带、波动率、回撤、动量、利差、相关性、历史百分位）由程序对近 5–20 年日线数据直接计算；
                点右上角“刷新数据”即可更新，刷新只走程序抓取，不消耗 AI token。
              </p>
              <p className="mt-2">本页是数据分析工具，不构成投资建议。</p>
            </footer>
          </>
        )}
      </main>
    </div>
    </WindowCtx.Provider>
  );
}
