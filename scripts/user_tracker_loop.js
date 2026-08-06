/**
 * @alexbita 用户追踪脚本
 * - 每60秒检测新交易，记录到 user-tracks.jsonl
 * - 每天 0:10 北京时间快照持仓总价值，记录到 user-balance-snapshots.jsonl
 *
 * 用法: node scripts/user_tracker_loop.js
 */

const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

const TRACKED_USER_ADDRESS = "0xe7123a5454f9be0a197d5909d2720a4d473c9a10";
const DATA_API_BASE = "https://data-api.polymarket.com";
const FETCH_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 60000;
const SNAPSHOT_MINUTE = 10; // 北京时间 0:10

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data", "weather_predictions");
const TRACKS_PATH = path.join(DATA_DIR, "user-tracks.jsonl");
const SNAPSHOTS_PATH = path.join(DATA_DIR, "user-balance-snapshots.jsonl");
const SEEN_TX_PATH = path.join(DATA_DIR, "user-tracks-seen.txt");

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function beijingDate() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function beijingHourMinute() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  return { hour: beijing.getUTCHours(), minute: beijing.getUTCMinutes() };
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 加载已见交易 hash，避免重复记录
let seenTxSet = new Set();
async function loadSeenTx() {
  try {
    const text = await fsp.readFile(SEEN_TX_PATH, "utf8");
    seenTxSet = new Set(text.split(/\r?\n/).filter(Boolean));
  } catch {
    seenTxSet = new Set();
  }
}

async function saveSeenTx() {
  const lines = Array.from(seenTxSet).slice(-5000); // 保留最近5000条
  await fsp.writeFile(SEEN_TX_PATH, lines.join("\n") + "\n", "utf8");
}

async function ensureDataDir() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  } catch {}
}

// 检测新交易
async function pollActivity() {
  try {
    const url = `${DATA_API_BASE}/activity?user=${TRACKED_USER_ADDRESS}&limit=50`;
    const data = await fetchWithTimeout(url);
    if (!Array.isArray(data)) return;

    let newCount = 0;
    for (const item of data) {
      if (item.type !== "TRADE") continue;
      const txHash = item.transactionHash || `${item.timestamp}_${item.asset}_${item.side}`;
      if (seenTxSet.has(txHash)) continue;
      seenTxSet.add(txHash);

      const record = {
        timestamp: item.timestamp,
        time: new Date(item.timestamp * 1000).toISOString(),
        title: item.title || "",
        slug: item.slug || "",
        outcome: item.outcome || "",
        side: item.side || "",
        size: round(item.size, 4),
        usdcSize: round(item.usdcSize, 2),
        price: round(item.price, 4),
        txHash,
      };
      await fsp.appendFile(TRACKS_PATH, JSON.stringify(record) + "\n", "utf8");
      newCount++;
    }

    if (newCount > 0) {
      console.log(`[${new Date().toISOString()}] 新交易 ${newCount} 条`);
      await saveSeenTx();
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] pollActivity error: ${err.message}`);
  }
}

// 每日快照：获取持仓总价值
async function takeSnapshot() {
  try {
    const url = `${DATA_API_BASE}/positions?user=${TRACKED_USER_ADDRESS}&limit=200`;
    const data = await fetchWithTimeout(url);
    if (!Array.isArray(data)) return;

    // 只统计天气相关市场
    const weatherPositions = data.filter(
      (p) =>
        (p.title || "").toLowerCase().includes("temperature") ||
        (p.eventSlug || "").includes("temperature"),
    );

    const totalValue = weatherPositions.reduce((s, p) => s + (Number(p.currentValue) || 0), 0);
    const totalInvested = weatherPositions.reduce((s, p) => s + (Number(p.initialValue) || 0), 0);
    const totalCashPnl = weatherPositions.reduce((s, p) => s + (Number(p.cashPnl) || 0), 0);

    const date = beijingDate();
    const record = {
      date,
      amount: round(totalValue, 2),
      totalInvested: round(totalInvested, 2),
      totalCashPnl: round(totalCashPnl, 2),
      positionCount: weatherPositions.length,
      capturedAt: new Date().toISOString(),
    };

    // 去重：如果今天已有快照，跳过
    try {
      const existing = await fsp.readFile(SNAPSHOTS_PATH, "utf8");
      const lines = existing.split(/\r?\n/).filter(Boolean);
      const todayExists = lines.some((line) => {
        try {
          const r = JSON.parse(line);
          return r.date === date;
        } catch {
          return false;
        }
      });
      if (todayExists) {
        console.log(`[${new Date().toISOString()}] 快照已存在 date=${date}, 跳过`);
        return;
      }
    } catch {}

    await fsp.appendFile(SNAPSHOTS_PATH, JSON.stringify(record) + "\n", "utf8");
    console.log(`[${new Date().toISOString()}] 快照完成 date=${date} amount=${record.amount} positions=${record.positionCount}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] takeSnapshot error: ${err.message}`);
  }
}

async function main() {
  await ensureDataDir();
  await loadSeenTx();

  console.log(`[${new Date().toISOString()}] 用户追踪脚本启动`);
  console.log(`  追踪地址: ${TRACKED_USER_ADDRESS}`);
  console.log(`  轮询间隔: ${POLL_INTERVAL_MS / 1000}秒`);
  console.log(`  快照时间: 北京时间 0:${SNAPSHOT_MINUTE}`);

  let lastSnapshotDate = "";

  // 立即执行一次
  await pollActivity();
  await takeSnapshot();

  // 定时轮询
  setInterval(async () => {
    await pollActivity();

    // 检查是否到了快照时间（0:10 北京时间）
    const { hour, minute } = beijingHourMinute();
    const today = beijingDate();
    if (hour === 0 && minute === SNAPSHOT_MINUTE && lastSnapshotDate !== today) {
      lastSnapshotDate = today;
      await takeSnapshot();
    }
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
