import { getWeatherDashboardSnapshot } from "@/lib/weather-trading-data";

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

function formatShortDate(ymd) {
  const [, month, day] = String(ymd || "").split("-");
  if (!month || !day) {
    return ymd || "--";
  }
  return `${month}/${day}`;
}

function formatTemp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${Number.isInteger(numeric) ? numeric.toFixed(0) : numeric.toFixed(1)}°`;
}

function formatDelta(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  const rendered = Number.isInteger(numeric) ? numeric.toFixed(0) : numeric.toFixed(1);
  return numeric > 0 ? `+${rendered}` : rendered;
}

function metricToneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "text-neutral-950";
  }
  return numeric > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function deltaToneClass(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "border-[var(--line)] bg-white text-neutral-900";
  }
  if (numeric > 3) {
    return "border-[rgba(180,58,47,0.22)] bg-[rgba(180,58,47,0.10)] text-[var(--signal-down)]";
  }
  if (numeric > 0) {
    return "border-[rgba(214,122,67,0.22)] bg-[rgba(214,122,67,0.11)] text-[var(--accent-strong)]";
  }
  return "border-[rgba(22,122,82,0.18)] bg-[rgba(22,122,82,0.08)] text-[var(--signal-up)]";
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

function MetricCard({ label, value, helper, money = true }) {
  return (
    <article className="rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] px-5 py-5 shadow-[var(--shadow)]">
      <p className="text-sm text-[var(--ink-soft)]">{label}</p>
      <div className={`mt-3 text-4xl font-semibold ${money ? metricToneClass(value) : "text-neutral-950"}`}>
        {money ? formatMoney(value) : value}
      </div>
      <p className="mt-3 text-sm text-[var(--ink-soft)]">{helper}</p>
    </article>
  );
}

function DailyPnlStrip({ rows }) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[rgba(255,255,255,0.62)] p-5 shadow-[var(--shadow)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Weather PnL</p>
          <h2 className="font-display mt-3 text-2xl font-semibold tracking-[0.05em] text-neutral-950">
            近 7 天天气收益
          </h2>
        </div>
        <p className="text-sm text-[var(--ink-soft)]">赢单按预收益，输单按投注额亏损</p>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
        {rows.map((row) => (
          <article
            key={row.date}
            className="rounded-[1.35rem] border border-[var(--line)] bg-[rgba(255,255,255,0.78)] px-4 py-4"
          >
            <p className="text-sm text-[var(--ink-soft)]">{formatShortDate(row.date)}</p>
            <div className={`mt-2 text-2xl font-semibold ${metricToneClass(row.netPnlUsd)}`}>
              {formatMoney(row.netPnlUsd)}
            </div>
            <p className="mt-2 text-sm text-[var(--ink-soft)]">{row.settledRecords || 0} 条已结算</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function YesterdayLossCities({ data }) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.86),rgba(255,239,224,0.7))] p-5 shadow-[var(--shadow)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Yesterday Loss</p>
          <h2 className="font-display mt-3 text-2xl font-semibold tracking-[0.05em] text-neutral-950">
            昨日亏损城市
          </h2>
        </div>
        <p className="text-sm text-[var(--ink-soft)]">{formatDate(data.date)}，用于今天手动下单参考</p>
      </div>

      <div className="mt-5 flex gap-3 overflow-x-auto pb-1">
        {data.rows.length ? (
          data.rows.map((row) => (
            <article
              key={`${row.citySlug}:${row.marketSlug}`}
              className="min-w-[260px] rounded-[1.35rem] border border-[rgba(180,58,47,0.18)] bg-[rgba(255,255,255,0.78)] px-4 py-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-neutral-950">{row.cityZh || row.cityEn}</div>
                  <div className="mt-1 text-xs text-[var(--ink-soft)]">{row.marketTitle || row.forecastTarget}</div>
                </div>
                <div className="text-xl font-semibold text-[var(--signal-down)]">{formatMoney(row.pnlUsd)}</div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-[var(--ink-soft)]">
                <div className="rounded-xl border border-[var(--line)] bg-white/70 px-3 py-2">
                  <div>温差</div>
                  <div className="mt-1 font-semibold text-neutral-950">{formatDelta(row.deltaC)}</div>
                </div>
                <div className="rounded-xl border border-[var(--line)] bg-white/70 px-3 py-2">
                  <div>实际</div>
                  <div className="mt-1 font-semibold text-neutral-950">{formatTemp(row.actualMaxTempC)}</div>
                </div>
                <div className="rounded-xl border border-[var(--line)] bg-white/70 px-3 py-2">
                  <div>预报</div>
                  <div className="mt-1 font-semibold text-neutral-950">{formatTemp(row.forecastMaxTempC)}</div>
                </div>
              </div>
            </article>
          ))
        ) : (
          <div className="w-full rounded-[1.35rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] px-4 py-6 text-sm text-[var(--ink-soft)]">
            昨日没有亏损城市。
          </div>
        )}
      </div>
    </section>
  );
}

function PositiveDriftRanking({ rows, dayCount }) {
  const maxCount = rows.reduce((max, row) => Math.max(max, row.positiveOver3Count || 0), 0);

  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Positive Drift</p>
          <h2 className="font-display mt-3 text-2xl font-semibold tracking-[0.05em] text-neutral-950">
            实际高温高于预报 3°C 以上排行
          </h2>
        </div>
        <p className="text-sm text-[var(--ink-soft)]">最近 {dayCount} 天，次数从多到少</p>
      </div>

      <div className="mt-5 flex gap-3 overflow-x-auto pb-1">
        {rows.length ? (
          rows.map((row) => {
            const width = maxCount > 0 ? `${Math.max(14, (row.positiveOver3Count / maxCount) * 100)}%` : "0%";
            const examples = row.positiveOver3Dates
              .slice(0, 3)
              .map((item) => `${formatShortDate(item.date)} ${formatDelta(item.deltaC)}`)
              .join(" / ");
            return (
              <article
                key={row.citySlug}
                className="min-w-[280px] rounded-[1.35rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] px-4 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-neutral-950">{row.cityZh}</div>
                    <div className="mt-1 text-sm text-[var(--ink-soft)]">最大正差 {formatDelta(row.maxPositiveDeltaC)}°</div>
                  </div>
                  <div className="text-2xl font-semibold text-[var(--signal-down)]">{row.positiveOver3Count} 次</div>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-[rgba(17,17,17,0.08)]">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent),var(--signal-down))]"
                    style={{ width }}
                  />
                </div>
                <div className="mt-3 text-sm text-[var(--ink-soft)]">{examples || "无样本"}</div>
              </article>
            );
          })
        ) : (
          <div className="w-full rounded-[1.35rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] px-4 py-6 text-sm text-[var(--ink-soft)]">
            最近 7 天还没有出现实际高温高于预报 3°C 以上的城市。
          </div>
        )}
      </div>
    </section>
  );
}

function CityTemperatureStrips({ review }) {
  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-display text-xs uppercase tracking-[0.38em] text-[var(--ink-soft)]">Forecast Error</p>
          <h2 className="font-display mt-3 text-2xl font-semibold tracking-[0.05em] text-neutral-950">
            9 城市最近 7 天温差
          </h2>
        </div>
        <p className="text-sm text-[var(--ink-soft)]">每格 = 实际高温 - 预报高温</p>
      </div>

      <div className="mt-5 space-y-3">
        {review.rows.map((row) => (
          <article
            key={row.citySlug}
            className="rounded-[1.55rem] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] px-4 py-4"
          >
            <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)] xl:items-center">
              <div>
                <div className="text-xl font-semibold text-neutral-950">{row.cityZh}</div>
                <div className="mt-1 max-w-sm truncate text-sm text-[var(--ink-soft)]">{row.forecastTarget}</div>
                <div className="mt-3 text-xs text-[var(--ink-soft)]">
                  &gt; +3°C：{row.positiveOver3Count || 0} 次
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                {review.dates.map((date) => {
                  const cell = cellByDate(row, date);
                  const resolved = Number.isFinite(Number(cell?.deltaC));
                  return (
                    <div
                      key={`${row.citySlug}:${date}`}
                      className={`rounded-[1.15rem] border px-3 py-3 ${resolved ? deltaToneClass(cell.deltaC) : "border-dashed border-[var(--line)] bg-white/45 text-[var(--ink-soft)]"}`}
                    >
                      <div className="text-xs font-medium opacity-70">{formatShortDate(date)}</div>
                      <div className="mt-1 text-2xl font-semibold">{resolved ? formatDelta(cell.deltaC) : "--"}</div>
                      <div className="mt-1 text-xs leading-5 opacity-75">
                        实 {formatTemp(cell?.actualMaxTempC)} / 预 {formatTemp(cell?.forecastMaxTempC)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export async function WeatherReviewPanel() {
  const snapshot = await getWeatherDashboardSnapshot({ sync: false });
  const liveSummary = snapshot.liveOrders?.summary || {};
  const liveOverall = liveSummary.overall || {};
  const liveToday = liveSummary.today || {};
  const liveSevenDay = liveSummary.sevenDay || {};
  const dailyBreakdown = liveSevenDay.dailyBreakdown || [];
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

  return (
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
          helper={`${formatDate(yesterdayLossCities.date)} 亏损名单`}
          money={false}
        />
      </section>

      <DailyPnlStrip rows={dailyBreakdown} />
      <PositiveDriftRanking rows={review.positiveOver3Ranking || []} dayCount={review.summary?.dayCount || 7} />
      <YesterdayLossCities data={yesterdayLossCities} />
      <CityTemperatureStrips review={review} />
    </div>
  );
}
