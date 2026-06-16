import { getWeatherDashboardSnapshot } from "@/lib/weather-trading-data";
import { HydrationStable } from "@/app/components/hydration-stable";
import { CityTemperatureStrips } from "@/app/components/weather-review-city-strips";

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

function metricToneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-neutral-950";
  }
  return numeric > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function cellByDate(row, date) {
  return row?.cells?.find((cell) => cell.date === date) || null;
}

function getWeatherResultPnlUsd(row) {
  const accounting = Number(row?.accountingPnlUsd);
  if (Number.isFinite(accounting)) {
    return accounting;
  }
  const fallback = Number(row?.pnlUsd);
  return Number.isFinite(fallback) ? fallback : null;
}

function buildYesterdayLossCities({ liveRecords, review }) {
  const yesterday = review.dates?.[Math.max(0, review.dates.length - 2)] || null;
  if (!yesterday) {
    return { date: null, rows: [] };
  }

  const reviewByCity = new Map((review.rows || []).map((row) => [row.citySlug, row]));
  const rows = (liveRecords || [])
    .filter((row) => row.date === yesterday && String(row.status || "").toLowerCase() === "resolved")
    .map((row) => {
      const pnlUsd = getWeatherResultPnlUsd(row);
      const cityReview = reviewByCity.get(row.citySlug);
      const dayCell = cellByDate(cityReview, yesterday);
      return {
        ...row,
        pnlUsd,
        deltaC: dayCell?.deltaC ?? null,
        actualMaxTempC: dayCell?.actualMaxTempC ?? row.actualMaxTempC ?? null,
        forecastMaxTempC: dayCell?.forecastMaxTempC ?? row.forecastMaxTempC ?? null,
      };
    })
    .filter((row) => Number.isFinite(row.pnlUsd) && row.pnlUsd < 0)
    .sort((left, right) => Number(left.pnlUsd) - Number(right.pnlUsd));

  return { date: yesterday, rows };
}

function MetricCard({ label, value, helper, money = true, tone = "default" }) {
  const valueClass = money
    ? metricToneClass(value)
    : tone === "loss"
      ? "text-[var(--signal-down)]"
      : "text-neutral-950";
  return (
    <article className="rounded-[1.35rem] border border-[var(--line)] bg-[var(--panel)] px-4 py-3 shadow-[var(--shadow)]">
      <p className="text-sm text-[var(--ink-soft)]">{label}</p>
      <div className={`mt-2 text-3xl font-semibold ${valueClass}`}>
        {money ? formatMoney(value) : value}
      </div>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{helper}</p>
    </article>
  );
}

function WeatherReviewFallback() {
  return (
    <div className="space-y-6">
      <section className="rounded-[1.8rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] p-5 shadow-[var(--shadow)]">
        <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Weather Review</p>
        <h3 className="mt-3 text-xl font-semibold text-neutral-950">天气复盘数据加载中</h3>
        <p className="mt-2 text-sm text-[var(--ink-soft)]">正在读取本地快照，避免实时写入数据造成页面首屏不一致。</p>
      </section>
    </div>
  );
}

export async function WeatherReviewPanel() {
  const snapshot = await getWeatherDashboardSnapshot({ sync: false });
  const liveSummary = snapshot.liveOrders?.summary || {};
  const liveOverall = liveSummary.overall || {};
  const liveToday = liveSummary.today || {};
  const liveSevenDay = liveSummary.sevenDay || {};
  const review = snapshot.weatherReview || {
    dates: [],
    rows: [],
    positiveOver3Ranking: [],
    summary: {},
  };
  const yesterdayLossCities = buildYesterdayLossCities({
    liveRecords: snapshot.liveOrders?.records || [],
    review,
  });
  const lossCityNames = yesterdayLossCities.rows
    .map((row) => row.cityZh || row.cityEn || row.citySlug)
    .join("、");
  const lossHelper = yesterdayLossCities.rows.length
    ? `${formatDate(yesterdayLossCities.date)} · ${lossCityNames}`
    : `${formatDate(yesterdayLossCities.date)} · 无亏损`;

  return (
    <HydrationStable fallback={<WeatherReviewFallback />}>
      <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-4">
        <MetricCard label="实盘总收益" value={liveOverall.netPnlUsd} helper="按预收益 / 投注额口径" />
        <MetricCard label="当天收益" value={liveToday.netPnlUsd} helper={formatDate(snapshot.localDate)} />
        <MetricCard
          label="7 天收益"
          value={liveSevenDay.netPnlUsd}
          helper={`${formatDate(liveSevenDay.startDate)} - ${formatDate(liveSevenDay.endDate)}`}
        />
        <MetricCard
          label="昨日亏损城市"
          value={`${yesterdayLossCities.rows.length}`}
          helper={lossHelper}
          money={false}
          tone="loss"
        />
      </section>

      <CityTemperatureStrips allDates={review.allDates} allRows={review.allRows} />
      </div>
    </HydrationStable>
  );
}
