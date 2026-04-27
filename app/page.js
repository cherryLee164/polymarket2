import Link from "next/link";
import { getMonitorSnapshot } from "@/lib/monitor-data";
import { MonitorAutoRefresh } from "@/app/components/monitor-auto-refresh";
import { MonitorSectionPanel } from "@/app/components/monitor-section";
import { WeatherReviewPanel } from "@/app/components/weather-review-section";
import { WeatherSectionPanel } from "@/app/components/weather-section";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function getParam(searchParams, key, fallback = "") {
  const value = searchParams?.[key];
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }
  return value ?? fallback;
}

function buildHomeHref(currentQuery, patch) {
  const params = new URLSearchParams();
  const merged = { ...currentQuery, ...patch };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `/?${queryString}` : "/";
}

function WeatherTabs({ currentQuery }) {
  const activeTab = currentQuery.weatherTab === "review" ? "review" : "live";
  const tabs = [
    {
      id: "live",
      label: "实盘明细",
      helper: "收益、服务状态和今日下单明细",
    },
    {
      id: "review",
      label: "复盘数据",
      helper: "昨日亏损、温差和正偏差排行",
    },
  ];

  return (
    <section className="rounded-[2rem] border border-[var(--line)] bg-[rgba(255,255,255,0.58)] p-3 shadow-[var(--shadow)]">
      <div className="grid gap-3 md:grid-cols-2">
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              href={buildHomeHref(currentQuery, { surface: "weather", weatherTab: tab.id })}
              className={`rounded-[1.55rem] border px-5 py-4 transition ${
                active
                  ? "border-[var(--accent-strong)] bg-[linear-gradient(135deg,rgba(214,122,67,0.20),rgba(255,255,255,0.86))] shadow-[0_14px_36px_rgba(184,87,38,0.14)]"
                  : "border-[var(--line)] bg-[rgba(255,255,255,0.64)] hover:border-[var(--accent-strong)]"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-display text-2xl font-semibold tracking-[0.04em] text-neutral-950">
                  {tab.label}
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    active
                      ? "bg-[var(--accent-strong)] text-[var(--accent-ink)]"
                      : "border border-[var(--line)] text-[var(--ink-soft)]"
                  }`}
                >
                  TAB
                </span>
              </div>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">{tab.helper}</p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default async function Home({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const currentQuery = {
    surface: getParam(resolvedSearchParams, "surface", "btc"),
    startDate: getParam(resolvedSearchParams, "startDate"),
    endDate: getParam(resolvedSearchParams, "endDate"),
    monitorVariant: getParam(resolvedSearchParams, "monitorVariant", "15m"),
    monitorPage:
      getParam(resolvedSearchParams, "monitorPage") ||
      getParam(resolvedSearchParams, "page") ||
      "1",
    weatherTab: getParam(resolvedSearchParams, "weatherTab", "live"),
  };

  const isWeatherSurface = currentQuery.surface === "weather";
  const weatherTab = currentQuery.weatherTab === "review" ? "review" : "live";
  const monitorSnapshot = isWeatherSurface
    ? null
    : getMonitorSnapshot({
        startDate: currentQuery.startDate,
        endDate: currentQuery.endDate,
        page: currentQuery.monitorPage,
        monitorVariant: currentQuery.monitorVariant,
      });
  const monitorActiveRun = isWeatherSurface
    ? null
    : monitorSnapshot.activeRuns.find(
        (run) => run.monitorVariant === currentQuery.monitorVariant,
      ) ?? null;

  return (
    <main className="notranslate min-h-screen bg-transparent text-neutral-950" translate="no">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-5 py-8 lg:px-8">
        <header className="overflow-hidden rounded-[2.3rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(255,246,224,0.92))] shadow-[var(--shadow)]">
          <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between lg:p-7">
            <div className="max-w-4xl">
              <p className="font-display text-sm uppercase tracking-[0.55em] text-[var(--ink-soft)]">
                Polymarket Console
              </p>
              <h1 className="font-display mt-4 text-4xl font-semibold tracking-[0.05em] text-neutral-950 md:text-5xl">
                {isWeatherSurface ? "天气事件后台" : "BTC 监控后台"}
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--ink-soft)]">
                {isWeatherSurface
                  ? "这里主要看天气事件的抓取、下单和实盘结果，页面只保留核心数据。"
                  : "这里保留 BTC 监控与运行状态，恢复页继续单独展示。"}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={buildHomeHref(currentQuery, { surface: "btc", weatherTab: undefined })}
                className={`rounded-full px-5 py-3 text-sm font-semibold transition ${
                  !isWeatherSurface
                    ? "bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] text-[var(--accent-ink)] shadow-[0_12px_30px_rgba(184,87,38,0.22)]"
                    : "border border-[var(--line)] text-neutral-800 hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
                }`}
              >
                BTC
              </Link>
              <Link
                href={buildHomeHref(currentQuery, { surface: "weather" })}
                className={`rounded-full px-5 py-3 text-sm font-semibold transition ${
                  isWeatherSurface
                    ? "bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] text-[var(--accent-ink)] shadow-[0_12px_30px_rgba(184,87,38,0.22)]"
                    : "border border-[var(--line)] text-neutral-800 hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
                }`}
              >
                天气
              </Link>
              <Link
                href="/recovery"
                className="rounded-full border border-[var(--line)] px-5 py-3 text-sm font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
              >
                恢复页
              </Link>
            </div>
          </div>
        </header>

        {isWeatherSurface ? (
          <>
            <WeatherTabs currentQuery={currentQuery} />
            {weatherTab === "review" ? <WeatherReviewPanel /> : <WeatherSectionPanel />}
          </>
        ) : (
          <>
            <MonitorAutoRefresh
              key={currentQuery.monitorVariant}
              monitorVariant={currentQuery.monitorVariant}
            />

            <MonitorSectionPanel
              activeRun={monitorActiveRun}
              activeRuns={monitorSnapshot.activeRuns}
              currentQuery={currentQuery}
              filters={monitorSnapshot.summaryPage.filters}
              pagination={monitorSnapshot.summaryPage.pagination}
              selectedMonitorVariant={currentQuery.monitorVariant}
              summaries={monitorSnapshot.summaryPage.items}
              thresholdAggregate={monitorSnapshot.summaryPage.thresholdAggregate}
            />
          </>
        )}
      </div>
    </main>
  );
}
