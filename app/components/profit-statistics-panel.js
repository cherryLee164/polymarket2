import { getWeatherDashboardSnapshot } from "@/lib/weather-trading-data";
import { HydrationStable } from "@/app/components/hydration-stable";
import { ProfitStatisticsSection } from "@/app/components/profit-statistics-section";

function ProfitFallback() {
  return (
    <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
      <h3 className="font-display text-2xl font-semibold text-neutral-950">月/天收益统计</h3>
      <p className="mt-3 text-sm text-[var(--ink-soft)]">加载中...</p>
    </section>
  );
}

export async function ProfitStatisticsPanel() {
  const snapshot = await getWeatherDashboardSnapshot({ sync: false });

  return (
    <HydrationStable fallback={<ProfitFallback />}>
      <ProfitStatisticsSection profitSnapshots={snapshot.profitSnapshots} />
    </HydrationStable>
  );
}
