import { getWeatherDashboardSnapshot } from "@/lib/weather-trading-data";
import { WEATHER_CITY_CONFIGS, getOrderTimeBeijing } from "@/lib/weather-data";
import { HydrationStable } from "@/app/components/hydration-stable";
import { WeatherLiveControls } from "@/app/components/weather-live-controls";
import { PaginatedRecordTables } from "@/app/components/weather-paginated-tables";

// citySlug → region 映射，用于 live 页面按区域过滤
const CITY_REGION_MAP = new Map(
  WEATHER_CITY_CONFIGS.map((c) => [c.citySlug, c.region || "domestic"]),
);
// citySlug → 下单时间（北京时间）映射
const CITY_ORDER_TIME_MAP = new Map(
  WEATHER_CITY_CONFIGS.map((c) => [c.citySlug, getOrderTimeBeijing(c)]),
);
// 收益统计起始日期：只统计此日期及之后的收益，防止历史数据被反复计算
const SIM_ORDERS_START_DATE = "2026-06-17";

function formatMoney(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}$${numeric.toFixed(digits)}`;
}

function formatDate(ymd) {
  const [year, month, day] = String(ymd || "").split("-");
  if (!year || !month || !day) {
    return ymd || "--";
  }
  return `${year}/${month}/${day}`;
}

// 从 records.json 的已结算记录直接算收益（不依赖 live-orders）
function computeRecordPnl(record) {
  const price = Number(record.buyNoPrice);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  const actual = Number(record.actualMaxTempC);
  const bucket = Number(record.marketBucketValue);
  const kind = record.marketBucketKind || "exact";
  if (!Number.isFinite(actual) || !Number.isFinite(bucket)) return null;

  let yesWins;
  if (kind === "exact") yesWins = actual === bucket;
  else if (kind === "lower") yesWins = actual <= bucket;
  else if (kind === "upper") yesWins = actual >= bucket;
  else yesWins = actual === bucket;

  return yesWins ? -1 : 1 / price - 1;
}

// 温差下单策略（sim-follow-yesterday）收益统计
function buildSimOrdersSummary(simOrdersRaw, todayYmd) {
  const orders = Array.isArray(simOrdersRaw) ? simOrdersRaw : [];
  const resolved = orders.filter((o) => o.status === "resolved" && String(o.date || "") >= SIM_ORDERS_START_DATE);
  const pending = orders.filter((o) => o.status === "pending" && String(o.date || "") >= SIM_ORDERS_START_DATE);
  let wins = 0, losses = 0, netPnlUsd = 0, todayPnlUsd = 0;
  let todayWins = 0, todayLosses = 0;
  for (const o of resolved) {
    const pnl = Number(o.accountingPnlUsd);
    if (!Number.isFinite(pnl)) continue;
    netPnlUsd += pnl;
    if (pnl > 0) wins++; else losses++;
    if (o.date === todayYmd) {
      todayPnlUsd += pnl;
      if (pnl > 0) todayWins++; else todayLosses++;
    }
  }
  return {
    overall: {
      netPnlUsd: Math.round(netPnlUsd * 1e6) / 1e6,
      settledRecords: resolved.length,
      wins,
      losses,
    },
    today: {
      netPnlUsd: Math.round(todayPnlUsd * 1e6) / 1e6,
      settledRecords: resolved.filter((o) => o.date === todayYmd).length,
      wins: todayWins,
      losses: todayLosses,
    },
    pendingCount: pending.length,
  };
}

function SummaryCard({ label, value, helper, tone = "neutral" }) {
  const toneClass = {
    neutral: "text-neutral-950",
    up: "text-[var(--signal-up)]",
    down: "text-[var(--signal-down)]",
  }[tone];

  return (
    <article className="rounded-[1.35rem] border border-[var(--line)] bg-[var(--panel)] px-4 py-3 shadow-[var(--shadow)]">
      <p className="text-sm text-[var(--ink-soft)]">{label}</p>
      <p className={`font-display mt-1 text-[1.65rem] font-semibold ${toneClass}`}>{value}</p>
      {helper ? <p className="mt-1 text-sm text-[var(--ink-soft)]">{helper}</p> : null}
    </article>
  );
}

// 直接从 records 构建每日行数据（不再依赖 live-orders）
// 实盘明细页用温差下单数据展示：从 simOrders 中找 strategyId === "sim-follow-yesterday" 的订单覆盖 record 的下单字段
function buildAllDateRows(snapshot) {
  // 过滤无效记录：captureSlotId="00" 且预报温度有效（>0 表示有真实数据）
  const allRecords = (snapshot.records || []).filter(
    (item) => item.captureSlotId === "00" && Number(item.forecastMaxTempC) > 0,
  );
  const dates = [...new Set(allRecords.map((r) => r.date))].sort().reverse();

  // 构建温差下单订单索引：`${date}:${citySlug}` → simOrder
  const simOrdersRaw = snapshot.simOrders?.records;
  const simOrders = Array.isArray(simOrdersRaw) ? simOrdersRaw : [];
  const followYesterdayMap = new Map();
  for (const order of simOrders) {
    if (order.strategyId !== "sim-follow-yesterday") continue;
    const key = `${order.date}:${order.citySlug}`;
    // 同一城市同一天可能有多条，保留第一条
    if (!followYesterdayMap.has(key)) {
      followYesterdayMap.set(key, order);
    }
  }

  return dates.map((date) => {
    const rows = allRecords
      .filter((item) => item.date === date)
      .map((record) => {
        // 查找对应的温差下单订单
        const followOrder = followYesterdayMap.get(`${record.date}:${record.citySlug}`);
        // 优先用温差下单订单（sim-follow-yesterday），否则 fallback 用 record 自身的 0-offset 下单数据
        const hasFollowOrder = Boolean(followOrder);
        const hasRecordOrder = Boolean(record.marketSlug);
        const merged = hasFollowOrder
          ? {
              ...record,
              targetTempC: followOrder.targetTempC,
              temperatureOffsetC: followOrder.temperatureOffsetC,
              prevDateDeltaC: followOrder.prevDateDeltaC,
              marketSlug: followOrder.marketSlug,
              marketTitle: followOrder.marketTitle,
              marketQuestion: followOrder.marketQuestion,
              marketBucketKind: followOrder.marketBucketKind,
              marketBucketValue: followOrder.marketBucketValue,
              buyNoPrice: followOrder.buyNoPrice,
              sharesBought: Number.isFinite(Number(followOrder.buyNoPrice)) && Number(followOrder.buyNoPrice) > 0
                ? Number(record.stakeUsd || 1) / Number(followOrder.buyNoPrice)
                : null,
              // 直接用 simOrder 的结算数据，不重新计算
              orderStatus: followOrder.status,
              orderAccountingPnlUsd: Number.isFinite(Number(followOrder.accountingPnlUsd))
                ? Number(followOrder.accountingPnlUsd)
                : null,
              orderResolvedOutcome: followOrder.resolvedOutcome ?? null,
            }
          : hasRecordOrder
            ? {
                // fallback: 用 record 自身的 0-offset 下单数据
                ...record,
                targetTempC: record.targetTempC ?? Number(record.forecastMaxTempC),
                temperatureOffsetC: 0,
                prevDateDeltaC: null,
                orderStatus: record.status,
                orderAccountingPnlUsd: Number.isFinite(Number(record.pnlUsd))
                  ? Number(record.pnlUsd)
                  : null,
                orderResolvedOutcome: record.resolvedOutcome ?? null,
              }
            : {
                ...record,
                targetTempC: null,
                temperatureOffsetC: null,
                prevDateDeltaC: null,
                marketSlug: null,
                marketTitle: null,
                marketQuestion: null,
                marketBucketKind: null,
                marketBucketValue: null,
                buyNoPrice: null,
                sharesBought: null,
              };

        // 收益：优先用 simOrder 的结算金额，没有则用 computeRecordPnl 估算
        const orderPnl = merged.orderAccountingPnlUsd;
        const fallbackPnl = computeRecordPnl(merged);
        const pnl = Number.isFinite(orderPnl) ? orderPnl : fallbackPnl;
        const deltaC = Number.isFinite(Number(record.temperatureDeltaC))
          ? Number(record.temperatureDeltaC)
          : Number.isFinite(Number(record.actualMaxTempC)) && Number.isFinite(Number(record.forecastMaxTempC))
            ? Number(record.actualMaxTempC) - Number(record.forecastMaxTempC)
            : null;
        // 预收益：如果 No 赢了（实际温度 ≠ 目标温度）能赚多少 = stakeUsd / buyNoPrice - stakeUsd
        const buyNoPriceNum = Number(merged.buyNoPrice);
        const stakeUsdNum = Number(merged.stakeUsd) || 1;
        const expectedPnlUsd = Number.isFinite(buyNoPriceNum) && buyNoPriceNum > 0
          ? Math.round((stakeUsdNum / buyNoPriceNum - stakeUsdNum) * 1000) / 1000
          : null;
        return {
          ...merged,
          impliedPnlUsd: pnl,
          expectedPnlUsd,
          temperatureDeltaC: deltaC,
          region: CITY_REGION_MAP.get(record.citySlug) || "domestic",
          orderTimeBeijing: CITY_ORDER_TIME_MAP.get(record.citySlug) || "00:10",
        };
      })
      .sort((left, right) =>
        String(left.cityZh || left.citySlug || "").localeCompare(String(right.cityZh || right.citySlug || ""), "zh-CN"),
      );
    return { date, rows };
  });
}

function WeatherLiveFallback() {
  return (
    <div className="space-y-6">
      <section className="rounded-[1.8rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] p-5 shadow-[var(--shadow)]">
        <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Weather Live</p>
        <h3 className="mt-3 text-xl font-semibold text-neutral-950">天气实盘数据加载中</h3>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">正在读取本地快照，避免实时写入数据造成页面首屏不一致。</p>
      </section>
    </div>
  );
}

export async function WeatherSectionPanel() {
  const snapshot = await getWeatherDashboardSnapshot({ sync: false });
  const liveConfig = snapshot.liveConfig || {};
  const allRecords = (snapshot.records || []).filter((item) => item.captureSlotId === "00");
  const simSummary = buildSimOrdersSummary(snapshot.simOrders?.records, snapshot.localDate);
  const allDateRows = buildAllDateRows(snapshot);

  return (
    <HydrationStable fallback={<WeatherLiveFallback />}>
      <div className="space-y-6">
      <section className="overflow-hidden rounded-[1.8rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(255,246,224,0.92))] shadow-[var(--shadow)]">
        <div className="flex flex-col gap-4 p-4 lg:p-5">
          <div className="grid gap-3 md:grid-cols-4">
            <SummaryCard
              label="总收益"
              value={formatMoney(simSummary.overall.netPnlUsd)}
              helper={`${simSummary.overall.settledRecords} 笔已结算`}
              tone={Number(simSummary.overall.netPnlUsd) >= 0 ? "up" : "down"}
            />
            <SummaryCard
              label="当天收益"
              value={formatMoney(simSummary.today.netPnlUsd)}
              helper={formatDate(snapshot.localDate)}
              tone={Number(simSummary.today.netPnlUsd) >= 0 ? "up" : "down"}
            />
            <SummaryCard
              label="胜负统计"
              value={`胜 ${simSummary.overall.wins} / 负 ${simSummary.overall.losses}`}
              helper={`${simSummary.overall.settledRecords} 笔已结算`}
              tone={simSummary.overall.wins >= simSummary.overall.losses ? "up" : "down"}
            />
            <SummaryCard
              label="待结算"
              value={`${simSummary.pendingCount} 笔`}
              helper="温差下单策略"
              tone="neutral"
            />
          </div>

          <WeatherLiveControls
            currentBaseStake={liveConfig.liveBaseStake || 1}
            serviceStatus={snapshot.serviceStatus}
            executionMode={liveConfig.executionMode || "live"}
            temperatureOffsets={liveConfig.temperatureOffsets || [0]}
            offsetStrategies={liveConfig.offsetStrategies || {}}
          />
        </div>
      </section>

      <PaginatedRecordTables allDateRows={allDateRows} />
      </div>
    </HydrationStable>
  );
}
