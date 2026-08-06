import path from "path";
import fs from "fs/promises";

const TRACKED_USER_ADDRESS = "0xe7123a5454f9be0a197d5909d2720a4d473c9a10";
const TRACKED_USER_NAME = "alexbita";

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data", "weather_predictions");
const TRACKS_PATH = path.join(DATA_DIR, "user-tracks.jsonl");
const SNAPSHOTS_PATH = path.join(DATA_DIR, "user-balance-snapshots.jsonl");

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// 读取余额快照，计算每日收益
async function readUserBalanceSnapshots() {
  try {
    const text = await fs.readFile(SNAPSHOTS_PATH, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);

    // 按日期去重，保留最后一条
    const byDate = new Map();
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item || !item.date) continue;
        byDate.set(item.date, { ...item, amount: Number(item.amount) || 0 });
      } catch {
        continue;
      }
    }

    const sorted = Array.from(byDate.values()).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );

    // 计算每日收益
    const withPnl = sorted.map((item, idx) => {
      const prev = idx > 0 ? sorted[idx - 1] : null;
      const pnl = prev ? round(item.amount - prev.amount, 2) : null;
      return { ...item, pnlUsd: pnl };
    });

    // 按月分组
    const monthMap = new Map();
    for (const item of withPnl) {
      const month = item.date.slice(0, 7);
      if (!monthMap.has(month)) {
        monthMap.set(month, {
          month,
          days: 0,
          startBalanceUsd: item.amount,
          endBalanceUsd: item.amount,
          totalPnlUsd: 0,
          items: [],
        });
      }
      const g = monthMap.get(month);
      g.days += 1;
      g.endBalanceUsd = item.amount;
      if (item.pnlUsd != null) {
        g.totalPnlUsd = round(g.totalPnlUsd + item.pnlUsd, 2);
      }
      g.items.push(item);
    }

    const months = Array.from(monthMap.values()).sort((a, b) =>
      a.month < b.month ? 1 : a.month > b.month ? -1 : 0,
    );

    const latest = sorted[sorted.length - 1] || null;

    return {
      months,
      latestBalance: latest ? latest.amount : null,
      latestDate: latest ? latest.date : null,
      totalRecords: sorted.length,
      latestInvested: latest ? latest.totalInvested : null,
      latestSettledCount: latest ? latest.settledCount : null,
      latestPendingCount: latest ? latest.pendingCount : null,
      latestPendingValue: latest ? latest.pendingValue : null,
    };
  } catch {
    return {
      months: [],
      latestBalance: null,
      latestDate: null,
      totalRecords: 0,
      latestInvested: null,
      latestSettledCount: null,
      latestPendingCount: null,
      latestPendingValue: null,
    };
  }
}

// 读取最近交易记录
async function readUserTracks(limit = 50) {
  try {
    const text = await fs.readFile(TRACKS_PATH, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    // 按时间倒序，取最近 limit 条
    records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return records.slice(0, limit);
  } catch {
    return [];
  }
}

// 聚合追踪数据
export async function getUserTrackerData() {
  try {
    const [snapshots, tracks] = await Promise.all([
      readUserBalanceSnapshots(),
      readUserTracks(50),
    ]);

    // 今日交易统计
    const now = new Date();
    const beijingDate = new Date(now.getTime() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const todayStart = new Date(beijingDate + "T00:00:00+08:00").getTime() / 1000;
    const todayTracks = tracks.filter((t) => t.timestamp >= todayStart);
    const todayInvested = todayTracks
      .filter((t) => t.side === "BUY")
      .reduce((s, t) => s + (t.usdcSize || 0), 0);
    const todaySold = todayTracks
      .filter((t) => t.side === "SELL")
      .reduce((s, t) => s + (t.usdcSize || 0), 0);

    return {
      user: { name: TRACKED_USER_NAME, address: TRACKED_USER_ADDRESS },
      snapshots,
      tracks,
      todaySummary: {
        tradeCount: todayTracks.length,
        invested: round(todayInvested, 2),
        sold: round(todaySold, 2),
      },
      fetchedAt: now.toISOString(),
    };
  } catch (error) {
    return {
      user: { name: TRACKED_USER_NAME, address: TRACKED_USER_ADDRESS },
      snapshots: { months: [], latestBalance: null, totalRecords: 0 },
      tracks: [],
      todaySummary: { tradeCount: 0, invested: 0, sold: 0 },
      error: error?.message || "fetch-failed",
      fetchedAt: new Date().toISOString(),
    };
  }
}
