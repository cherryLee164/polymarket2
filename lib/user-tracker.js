import path from "path";
import fs from "fs/promises";

const TRACKED_USER_ADDRESS = "0xe7123a5454f9be0a197d5909d2720a4d473c9a10";
const TRACKED_USER_NAME = "alexbita";
const DATA_API_BASE = "https://data-api.polymarket.com";
const FETCH_TIMEOUT_MS = 15000;

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 获取用户最近交易活动
async function fetchUserActivity(limit = 50) {
  const url = `${DATA_API_BASE}/activity?user=${TRACKED_USER_ADDRESS}&limit=${limit}`;
  const data = await fetchWithTimeout(url);
  if (!Array.isArray(data)) return [];
  return data
    .filter((item) => item.type === "TRADE")
    .map((item) => ({
      timestamp: item.timestamp,
      time: new Date(item.timestamp * 1000).toISOString(),
      title: item.title || "",
      slug: item.slug || "",
      eventSlug: item.eventSlug || "",
      outcome: item.outcome || "",
      side: item.side || "",
      size: round(item.size, 4),
      usdcSize: round(item.usdcSize, 2),
      price: round(item.price, 4),
      txHash: item.transactionHash || "",
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

// 获取用户当前持仓
async function fetchUserPositions(limit = 100) {
  const url = `${DATA_API_BASE}/positions?user=${TRACKED_USER_ADDRESS}&limit=${limit}`;
  const data = await fetchWithTimeout(url);
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => ({
      title: item.title || "",
      slug: item.slug || "",
      eventSlug: item.eventSlug || "",
      outcome: item.outcome || "",
      size: round(item.size, 4),
      avgPrice: round(item.avgPrice, 4),
      initialValue: round(item.initialValue, 2),
      currentValue: round(item.currentValue, 2),
      cashPnl: round(item.cashPnl, 2),
      percentPnl: round(item.percentPnl, 2),
      realizedPnl: round(item.realizedPnl, 2),
      curPrice: round(item.curPrice, 4),
      redeemable: item.redeemable || false,
      endDate: item.endDate || "",
    }))
    .sort((a, b) => (b.initialValue || 0) - (a.initialValue || 0));
}

// 聚合追踪数据
export async function getUserTrackerData() {
  try {
    const [activity, positions] = await Promise.all([
      fetchUserActivity(50),
      fetchUserPositions(100),
    ]);

    // 只保留天气相关的市场
    const weatherActivity = activity.filter(
      (a) => a.title.toLowerCase().includes("temperature") || a.eventSlug.includes("temperature"),
    );
    const weatherPositions = positions.filter(
      (p) => p.title.toLowerCase().includes("temperature") || p.eventSlug.includes("temperature"),
    );

    // 统计总投入、总盈亏
    const totalInvested = weatherPositions.reduce((s, p) => s + (p.initialValue || 0), 0);
    const totalCurrentValue = weatherPositions.reduce((s, p) => s + (p.currentValue || 0), 0);
    const totalCashPnl = weatherPositions.reduce((s, p) => s + (p.cashPnl || 0), 0);
    const totalRealizedPnl = weatherPositions.reduce((s, p) => s + (p.realizedPnl || 0), 0);

    // 今日交易
    const now = new Date();
    const beijingDate = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const todayStart = new Date(beijingDate + "T00:00:00+08:00").getTime() / 1000;
    const todayActivity = weatherActivity.filter((a) => a.timestamp >= todayStart);
    const todayInvested = todayActivity
      .filter((a) => a.side === "BUY")
      .reduce((s, a) => s + (a.usdcSize || 0), 0);
    const todaySold = todayActivity
      .filter((a) => a.side === "SELL")
      .reduce((s, a) => s + (a.usdcSize || 0), 0);

    return {
      user: { name: TRACKED_USER_NAME, address: TRACKED_USER_ADDRESS },
      summary: {
        totalInvested: round(totalInvested, 2),
        totalCurrentValue: round(totalCurrentValue, 2),
        totalCashPnl: round(totalCashPnl, 2),
        totalRealizedPnl: round(totalRealizedPnl, 2),
        totalPnl: round(totalCashPnl + totalRealizedPnl, 2),
        returnRate: totalInvested > 0 ? round(((totalCashPnl + totalRealizedPnl) / totalInvested) * 100, 2) : null,
        positionCount: weatherPositions.length,
        todayTradeCount: todayActivity.length,
        todayInvested: round(todayInvested, 2),
        todaySold: round(todaySold, 2),
      },
      activity: weatherActivity.slice(0, 30),
      positions: weatherPositions.slice(0, 50),
      fetchedAt: now.toISOString(),
    };
  } catch (error) {
    return {
      user: { name: TRACKED_USER_NAME, address: TRACKED_USER_ADDRESS },
      summary: null,
      activity: [],
      positions: [],
      error: error?.message || "fetch-failed",
      fetchedAt: new Date().toISOString(),
    };
  }
}
