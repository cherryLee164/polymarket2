import { getWeatherDashboardSnapshot } from "@/lib/weather-trading-data";
import { WeatherLiveControls } from "@/app/components/weather-live-controls";

const DISPLAY_TIME_ZONE = "Asia/Shanghai";
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatMoney(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const sign = numeric > 0 ? "+" : "";
  return `${sign}$${numeric.toFixed(digits)}`;
}

function formatPrice(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(3) : "--";
}

function formatDate(ymd) {
  const [year, month, day] = String(ymd || "").split("-");
  if (!year || !month || !day) {
    return ymd || "--";
  }
  return `${year}/${month}/${day}`;
}

function formatShortDate(ymd) {
  const [, month, day] = String(ymd || "").split("-");
  if (!month || !day) {
    return ymd || "--";
  }
  return `${month}/${day}`;
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return DATE_TIME_FORMATTER.format(parsed).replace(",", "");
}

function renderPnlClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-neutral-900";
  }
  return numeric > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function estimateNoWinPnlUsd(row) {
  const existing = Number(row?.estimatedNoWinPnlUsd);
  if (Number.isFinite(existing)) {
    return existing;
  }
  const price = Number(row?.buyNoPrice);
  const stake = Number(row?.requestedStakeUsd ?? row?.stakeUsd ?? 1);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stake) || stake <= 0) {
    return null;
  }
  return Number((stake / price - stake).toFixed(6));
}

function formatWeatherPhrase(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  return /[A-Za-z]{3,}/.test(text) ? null : text;
}

function formatWeatherPair(row) {
  const parts = [formatWeatherPhrase(row?.dayWeather), formatWeatherPhrase(row?.nightWeather)].filter(Boolean);
  return parts.length ? parts.join(" / ") : "--";
}

function getOrderAttemptCount(row) {
  return Array.isArray(row?.orderAttempts) && row.orderAttempts.length > 0
    ? row.orderAttempts.length
    : row?.orderId
      ? 1
      : 0;
}

function getLiveStatusLabel(row) {
  const fillStatus = String(row?.fillStatus || "").toLowerCase();
  const status = String(row?.status || "").toLowerCase();

  if (fillStatus === "submitted-unconfirmed") {
    return "待确认";
  }
  if (fillStatus === "bot-order-fill" && status === "pending") {
    return "待结算";
  }
  if (status === "resolved") {
    return Number(row?.pnlUsd) >= 0 ? "盈利" : "亏损";
  }
  if (status === "no-fill") {
    return "未成交";
  }
  if (status === "weather-only" || status === "weather-resolved-no-order") {
    return "未下单";
  }
  if (status === "placing") {
    return "下单中";
  }
  return row?.result || row?.status || "--";
}

function getLiveStatusDetail(row) {
  const fillStatus = String(row?.fillStatus || "").toLowerCase();
  const status = String(row?.status || "").toLowerCase();
  const buyNoPrice = Number(row?.buyNoPrice);
  const priceCap = Number(row?.priceCap);
  const attempts = getOrderAttemptCount(row);

  if (fillStatus === "submitted-unconfirmed") {
    return "已提交，等待链上确认";
  }
  if (fillStatus === "bot-order-fill" && String(row?.status || "").toLowerCase() === "pending") {
    return "已成交，等待结算";
  }
  if (status === "no-fill" && Number.isFinite(buyNoPrice) && Number.isFinite(priceCap) && buyNoPrice > priceCap) {
    return `No 价 ${formatPrice(buyNoPrice)} 高于上限 ${formatPrice(priceCap)}`;
  }
  if (status === "no-fill") {
    return attempts > 0 ? `已尝试 ${attempts} 次，仍未成交` : "已尝试，仍未成交";
  }
  if (status === "weather-resolved-no-order") {
    return "已结算，但未见 bot 下单";
  }
  if (status === "weather-only") {
    return "当天有天气数据，未见 bot 下单";
  }
  if (status === "placing") {
    return "正在提交订单";
  }
  return row?.resolvedOutcome || "--";
}

function buildTodayWeatherDetailRows(snapshot, liveRecords) {
  const todayYmd = snapshot.localDate;
  const liveMap = new Map(
    (liveRecords || [])
      .filter((item) => item.date === todayYmd)
      .map((item) => [`${item.citySlug}:${item.marketSlug}`, item]),
  );

  return (snapshot.records || [])
    .filter((item) => item.date === todayYmd && item.captureSlotId === "00")
    .map((weather) => {
      const live = liveMap.get(`${weather.citySlug}:${weather.marketSlug}`);
      if (live) {
        return {
          ...weather,
          ...live,
          stakeUsd: Number(live.actualBuyCostUsd ?? live.stakeUsd ?? 0) || 0,
          estimatedNoWinPnlUsd: estimateNoWinPnlUsd(live),
        };
      }
      return {
        ...weather,
        key: `${weather.key}:weather-only`,
        placedAt: null,
        stakeUsd: 0,
        requestedStakeUsd: Number(weather.progressiveStakeUsd ?? 1) || 1,
        status: weather.status === "resolved" ? "weather-resolved-no-order" : "weather-only",
        fillStatus: null,
        estimatedNoWinPnlUsd: estimateNoWinPnlUsd({
          ...weather,
          requestedStakeUsd: Number(weather.progressiveStakeUsd ?? 1) || 1,
        }),
        payoutUsd: null,
        pnlUsd: null,
      };
    })
    .sort((left, right) =>
      String(left.cityZh || left.citySlug || "").localeCompare(
        String(right.cityZh || right.citySlug || ""),
        "zh-CN",
      ),
    );
}

function SummaryCard({ label, value, helper, tone = "neutral" }) {
  const toneClass = {
    neutral: "text-neutral-950",
    up: "text-[var(--signal-up)]",
    down: "text-[var(--signal-down)]",
  }[tone];

  return (
    <article className="rounded-[1.7rem] border border-[var(--line)] bg-[var(--panel)] px-5 py-4 shadow-[var(--shadow)]">
      <p className="text-sm text-[var(--ink-soft)]">{label}</p>
      <p className={`font-display mt-2 text-[2.05rem] font-semibold ${toneClass}`}>{value}</p>
      {helper ? <p className="mt-1 text-sm text-[var(--ink-soft)]">{helper}</p> : null}
    </article>
  );
}

function DailyPnlStrip({ title, rows }) {
  return (
    <section className="rounded-[1.8rem] border border-[var(--line)] bg-[rgba(255,255,255,0.62)] p-4 shadow-[var(--shadow)]">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Daily PnL</p>
          <h3 className="mt-3 text-xl font-semibold text-neutral-950">{title}</h3>
        </div>
        <p className="text-sm text-[var(--ink-soft)]">最近 7 天，按已结算实盘订单统计</p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
        {rows.map((row) => (
          <article
            key={row.date}
            className="rounded-[1.2rem] border border-[var(--line)] bg-[rgba(255,255,255,0.7)] px-4 py-4"
          >
            <p className="text-sm text-[var(--ink-soft)]">{formatShortDate(row.date)}</p>
            <div className={`mt-2 text-2xl font-semibold ${renderPnlClass(row.netPnlUsd)}`}>
              {formatMoney(row.netPnlUsd)}
            </div>
            <p className="mt-2 text-sm text-[var(--ink-soft)]">
              {formatDate(row.date)}，{row.settledRecords || 0} 笔
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

function StakeCell({ row }) {
  const actualStakeUsd = Number(row?.stakeUsd);
  const requestedStakeUsd = Number(row?.requestedStakeUsd ?? row?.stakeUsd ?? 0);
  const stepIndex = Number(row?.progressiveStepIndex);
  const primaryValue =
    Number.isFinite(actualStakeUsd) && actualStakeUsd > 0
      ? formatMoney(actualStakeUsd)
      : Number.isFinite(requestedStakeUsd) && requestedStakeUsd > 0
        ? `计划 ${formatMoney(requestedStakeUsd)}`
        : "--";

  return (
    <td className="px-5 py-4">
      <div className="text-base font-semibold text-neutral-950">{primaryValue}</div>
      <div className="mt-1 text-sm text-[var(--ink-soft)]">
        档位 {Number.isFinite(stepIndex) ? stepIndex + 1 : 1}
      </div>
    </td>
  );
}

function LiveRecordTable({ title, rows }) {
  return (
    <section className="overflow-hidden rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
        <h3 className="font-display text-2xl font-semibold tracking-[0.05em] text-neutral-950">
          {title}
        </h3>
        <p className="text-sm text-[var(--ink-soft)]">{rows.length} 城</p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-left">
          <thead className="bg-[rgba(246,236,216,0.55)] text-sm text-[var(--ink-soft)]">
            <tr>
              <th className="px-5 py-3 font-medium">城市</th>
              <th className="px-5 py-3 font-medium">下单时间</th>
              <th className="px-5 py-3 font-medium">天气预报</th>
              <th className="px-5 py-3 font-medium">买 No</th>
              <th className="px-5 py-3 font-medium">投入</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">预收益</th>
              <th className="px-5 py-3 font-medium">收益</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.key} className="border-t border-[var(--line)] align-top">
                  <td className="px-5 py-4">
                    <div className="font-semibold text-neutral-950">{row.cityZh}</div>
                    <div className="mt-1 text-sm text-[var(--ink-soft)]">{row.forecastTarget}</div>
                  </td>
                  <td className="px-5 py-4 text-sm text-neutral-900">{formatDateTime(row.placedAt)}</td>
                  <td className="px-5 py-4">
                    <div className="text-base font-semibold text-neutral-950">
                      {row.forecastMinTempC}~{row.forecastMaxTempC}
                    </div>
                    <div className="mt-1 text-sm text-[var(--ink-soft)]">目标高温 {row.targetTempC}°C</div>
                    <div className="text-sm text-[var(--ink-soft)]">{formatWeatherPair(row)}</div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="text-base font-semibold text-neutral-950">{formatPrice(row.buyNoPrice)}</div>
                    <div className="mt-1 text-sm text-[var(--ink-soft)]">{row.marketTitle}</div>
                  </td>
                  <StakeCell row={row} />
                  <td className="px-5 py-4">
                    <div className="text-base font-semibold text-neutral-950">{getLiveStatusLabel(row)}</div>
                    <div className="mt-1 text-sm text-[var(--ink-soft)]">{getLiveStatusDetail(row)}</div>
                  </td>
                  <td className={`px-5 py-4 text-base font-semibold ${renderPnlClass(row.estimatedNoWinPnlUsd)}`}>
                    {formatMoney(row.estimatedNoWinPnlUsd)}
                  </td>
                  <td className={`px-5 py-4 text-base font-semibold ${renderPnlClass(row.pnlUsd)}`}>
                    {row.status === "pending" ? "--" : formatMoney(row.pnlUsd)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-8 text-center text-sm text-[var(--ink-soft)]" colSpan={8}>
                  暂无当天 00:10 天气记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export async function WeatherSectionPanel() {
  const snapshot = await getWeatherDashboardSnapshot({ sync: false });
  const liveOrders = snapshot.liveOrders || {};
  const liveRecords = liveOrders.records || [];
  const liveToday = liveOrders.summary?.today || {};
  const liveOverall = liveOrders.summary?.overall || {};
  const liveSevenDay = liveOrders.summary?.sevenDay || {};
  const liveConfig = snapshot.liveConfig || {};
  const todayLiveRecords = buildTodayWeatherDetailRows(snapshot, liveRecords);
  const dailyBreakdown = liveSevenDay.dailyBreakdown || [];

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2.2rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(255,246,224,0.92))] shadow-[var(--shadow)]">
        <div className="flex flex-col gap-5 p-5 lg:p-6">
          <div className="grid gap-4 md:grid-cols-3">
            <SummaryCard
              label="实盘总收益"
              value={formatMoney(liveOverall.netPnlUsd)}
              helper="按已结算实盘订单统计"
              tone={Number(liveOverall.netPnlUsd) >= 0 ? "up" : "down"}
            />
            <SummaryCard
              label="当天收益"
              value={formatMoney(liveToday.netPnlUsd)}
              helper={formatDate(snapshot.localDate)}
              tone={Number(liveToday.netPnlUsd) >= 0 ? "up" : "down"}
            />
            <SummaryCard
              label="7天收益"
              value={formatMoney(liveSevenDay.netPnlUsd)}
              helper={`${formatDate(liveSevenDay.startDate)} - ${formatDate(liveSevenDay.endDate)}`}
              tone={Number(liveSevenDay.netPnlUsd) >= 0 ? "up" : "down"}
            />
          </div>

          <DailyPnlStrip title="天气近 7 天逐日收益" rows={dailyBreakdown} />

          <WeatherLiveControls
            currentBaseStake={liveConfig.liveBaseStake || 1}
            sequenceLabel={liveConfig.liveSequenceLabel || "1-2-3"}
            serviceStatus={snapshot.serviceStatus}
          />
        </div>
      </section>

      <LiveRecordTable title={`${formatDate(snapshot.localDate)} 实盘明细`} rows={todayLiveRecords} />
    </div>
  );
}
