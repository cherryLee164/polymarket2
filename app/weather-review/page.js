import Link from "next/link";

import { WeatherReviewPanel } from "@/app/components/weather-review-section";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WeatherReviewPage() {
  return (
    <main className="notranslate min-h-screen bg-transparent px-4 py-6 text-neutral-950 sm:px-6 lg:px-8" translate="no">
      <div className="mx-auto max-w-[1680px] space-y-6">
        <header className="overflow-hidden rounded-[2.3rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(255,246,224,0.92))] shadow-[var(--shadow)]">
          <div className="flex flex-col gap-5 p-6 lg:flex-row lg:items-start lg:justify-between lg:p-7">
            <div className="max-w-4xl">
              <p className="font-display text-sm uppercase tracking-[0.55em] text-[var(--ink-soft)]">
                Weather Review
              </p>
              <h1 className="font-display mt-4 text-4xl font-semibold tracking-[0.05em] text-neutral-950 md:text-5xl">
                天气复盘页
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--ink-soft)]">
                按预收益口径看实盘盈亏，并复盘每个城市实际高温和预报高温的偏差。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/?surface=weather&weatherTab=review"
                className="rounded-full border border-[var(--line)] px-5 py-3 text-sm font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
              >
                天气后台
              </Link>
              <Link
                href="/"
                className="rounded-full border border-[var(--line)] px-5 py-3 text-sm font-semibold text-neutral-800 transition hover:border-[var(--accent-strong)] hover:text-[var(--accent-strong)]"
              >
                BTC
              </Link>
            </div>
          </div>
        </header>

        <WeatherReviewPanel />
      </div>
    </main>
  );
}
