"use client";

import { useState, useEffect, useCallback } from "react";

function formatMoney(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(digits)}`;
}

function formatBalance(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  return `$${n.toFixed(digits)}`;
}

function formatPercent(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function formatTime(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  return beijing.toISOString().slice(5, 16).replace("T", " ");
}

function toneClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "text-[var(--ink-soft)]";
  return n > 0 ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]";
}

function extractCity(title) {
  if (!title) return "--";
  const match = title.match(/temperature in (.+?) (?:be|on)/i);
  if (match) return match[1];
  return title.slice(0, 30);
}

export function UserTrackerSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/user-tracker", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "请求失败");
      setData(json);
      setError("");
    } catch (err) {
      setError(err?.message || "请求失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 60000);
    return () => clearInterval(timer);
  }, [fetchData]);

  if (loading) {
    return (
      <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
        <h3 className="font-display text-2xl font-semibold text-neutral-950">用户追踪</h3>
        <p className="mt-3 text-sm text-[var(--ink-soft)]">加载中...</p>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[var(--shadow)]">
        <h3 className="font-display text-2xl font-semibold text-neutral-950">用户追踪</h3>
        <p className="mt-3 text-sm text-[var(--signal-down)]">{error}</p>
      </section>
    );
  }

  const summary = data?.summary;
  const activity = data?.activity || [];
  const positions = data?.positions || [];

  return (
    <section className="space-y-4">
      {/* 概览卡片 */}
      <div className="rounded-[1.6rem] border border-[var(--line)] bg-[rgba(255,255,255,0.74)] p-5 shadow-[var(--shadow)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">追踪用户</p>
            <p className="mt-1 font-display text-2xl font-semibold text-neutral-950">
              @{data?.user?.name || "unknown"}
            </p>
            <p className="mt-1 text-xs text-[var(--ink-soft)]">
              {data?.user?.address?.slice(0, 10)}...{data?.user?.address?.slice(-6)}
            </p>
          </div>
          {summary ? (
            <div className="flex flex-wrap gap-6">
              <div className="text-right">
                <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">总投入</p>
                <p className="mt-1 font-display text-2xl font-semibold text-neutral-950">
                  {formatBalance(summary.totalInvested)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">当前价值</p>
                <p className="mt-1 font-display text-2xl font-semibold text-neutral-950">
                  {formatBalance(summary.totalCurrentValue)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">总盈亏</p>
                <p className={`mt-1 font-display text-2xl font-semibold ${toneClass(summary.totalPnl)}`}>
                  {formatMoney(summary.totalPnl)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-[0.28em] text-[var(--ink-soft)]">收益率</p>
                <p className={`mt-1 font-display text-2xl font-semibold ${toneClass(summary.returnRate)}`}>
                  {formatPercent(summary.returnRate)}
                </p>
              </div>
            </div>
          ) : null}
        </div>
        {summary ? (
          <div className="mt-4 flex flex-wrap gap-4 border-t border-[var(--line)] pt-3 text-sm text-[var(--ink-soft)]">
            <span>持仓数: {summary.positionCount}</span>
            <span>今日交易: {summary.todayTradeCount} 笔</span>
            <span>今日买入: {formatBalance(summary.todayInvested)}</span>
            <span>今日卖出: {formatBalance(summary.todaySold)}</span>
            <span className="ml-auto text-xs">每60秒自动刷新 · {data?.fetchedAt ? formatTime(data.fetchedAt) : ""}</span>
          </div>
        ) : null}
      </div>

      {/* 最近交易 */}
      <div className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
        <h3 className="font-display text-xl font-semibold text-neutral-950">最近交易</h3>
        <div className="mt-3 max-h-[400px] overflow-y-auto rounded-[1rem] border border-[var(--line)]">
          <table className="min-w-full text-left text-sm">
            <thead className="sticky top-0 bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
              <tr>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">城市</th>
                <th className="px-3 py-2 font-medium">方向</th>
                <th className="px-3 py-2 font-medium">买入/卖出</th>
                <th className="px-3 py-2 font-medium">数量</th>
                <th className="px-3 py-2 font-medium">金额</th>
                <th className="px-3 py-2 font-medium">价格</th>
              </tr>
            </thead>
            <tbody>
              {activity.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-[var(--ink-soft)]">暂无交易记录</td>
                </tr>
              ) : (
                activity.map((item, idx) => (
                  <tr key={idx} className="border-t border-[var(--line)]">
                    <td className="px-3 py-2 text-xs text-[var(--ink-soft)]">{formatTime(item.time)}</td>
                    <td className="px-3 py-2 font-medium text-neutral-950">{extractCity(item.title)}</td>
                    <td className="px-3 py-2 text-xs">{item.outcome}</td>
                    <td className={`px-3 py-2 text-xs font-semibold ${item.side === "BUY" ? "text-[var(--signal-up)]" : "text-[var(--signal-down)]"}`}>
                      {item.side === "BUY" ? "买入" : "卖出"}
                    </td>
                    <td className="px-3 py-2 text-[var(--ink-soft)]">{item.size}</td>
                    <td className="px-3 py-2 text-[var(--ink-soft)]">{formatBalance(item.usdcSize)}</td>
                    <td className="px-3 py-2 text-[var(--ink-soft)]">{item.price != null ? `$${item.price}` : "--"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 当前持仓 */}
      <div className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
        <h3 className="font-display text-xl font-semibold text-neutral-950">当前持仓</h3>
        <div className="mt-3 max-h-[500px] overflow-y-auto rounded-[1rem] border border-[var(--line)]">
          <table className="min-w-full text-left text-sm">
            <thead className="sticky top-0 bg-[rgba(246,236,216,0.55)] text-xs text-[var(--ink-soft)]">
              <tr>
                <th className="px-3 py-2 font-medium">市场</th>
                <th className="px-3 py-2 font-medium">方向</th>
                <th className="px-3 py-2 font-medium">投入</th>
                <th className="px-3 py-2 font-medium">当前价值</th>
                <th className="px-3 py-2 font-medium">盈亏</th>
                <th className="px-3 py-2 font-medium">收益率</th>
                <th className="px-3 py-2 font-medium">到期</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-[var(--ink-soft)]">暂无持仓</td>
                </tr>
              ) : (
                positions.map((p, idx) => (
                  <tr key={idx} className="border-t border-[var(--line)]">
                    <td className="px-3 py-2 font-medium text-neutral-950 text-xs">{extractCity(p.title)}</td>
                    <td className="px-3 py-2 text-xs">{p.outcome}</td>
                    <td className="px-3 py-2 text-[var(--ink-soft)]">{formatBalance(p.initialValue)}</td>
                    <td className="px-3 py-2 text-[var(--ink-soft)]">{formatBalance(p.currentValue)}</td>
                    <td className={`px-3 py-2 font-semibold ${toneClass(p.cashPnl)}`}>{formatMoney(p.cashPnl)}</td>
                    <td className={`px-3 py-2 text-xs ${toneClass(p.percentPnl)}`}>{formatPercent(p.percentPnl)}</td>
                    <td className="px-3 py-2 text-xs text-[var(--ink-soft)]">{p.endDate || "--"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
