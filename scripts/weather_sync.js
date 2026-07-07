const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const { fetchJson: fetchJsonWithFallback } = require("./shared/http");

const ROOT_DIR = path.join(__dirname, "..");
const INTERVAL_MS = Number(process.env.WEATHER_SYNC_INTERVAL_MS || 5 * 60 * 1000);
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const LOCK_PATH = path.join(LOCKS_DIR, "weather-sync.lock.json");
const SIM_ORDERS_PATH = path.join(ROOT_DIR, "data", "weather_predictions", "sim-orders.json");
const WEATHER_CONFIG_PATH = path.join(ROOT_DIR, "data", "weather_predictions", "config.json");
const PYTHON_BIN = process.env.PYTHON || "python";
// 模拟下单起始日期：只结算此日期及之后的订单，防止历史数据被反复结算
// 2026-06-17 是项目首次真实下单的日期，之前的历史订单一律不结算
const SIM_ORDERS_START_DATE = process.env.SIM_ORDERS_START_DATE || "2026-06-17";

// 收益记录自动更新：每天北京时间 0:10 后自动获取余额并更新 xlsx
const PROFIT_RECORD_PATH = path.join(ROOT_DIR, "收益记录.xlsx");
const PROFIT_RECORD_NEW_PATH = path.join(ROOT_DIR, "收益记录.new.xlsx");
const PROFIT_RECORD_STATE_PATH = path.join(ROOT_DIR, "data", "weather_predictions", "profit-record-state.json");
const PROFIT_BALANCE_SNAPSHOTS_PATH = path.join(ROOT_DIR, "data", "weather_predictions", "profit-balance-snapshots.jsonl");
const PROFIT_UPDATE_TIME_MINUTES = 10; // 0:10 北京时间
const GET_BALANCE_SCRIPT = path.join(ROOT_DIR, "scripts", "get_balance.py");

function appendBalanceSnapshot(record) {
  ensureDir(path.dirname(PROFIT_BALANCE_SNAPSHOTS_PATH));
  fs.appendFileSync(PROFIT_BALANCE_SNAPSHOTS_PATH, JSON.stringify(record) + "\n", "utf8");
}

function envEnabled(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || `${raw}`.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(`${raw}`.trim().toLowerCase());
}

function log(message) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  console.log(`[${ts}] [WEATHER] ${message}`);
}

// 强制关闭占用 xlsx 文件的进程（WPS/Excel），写入收益记录前调用
const EXCEL_PROCESS_NAMES = ["wps", "et", "wpp", "EXCEL", "ET"];
function killExcelProcesses() {
  if (process.platform !== "win32") return;
  try {
    const result = spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `Get-Process ${EXCEL_PROCESS_NAMES.join(",")} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500`,
    ], { encoding: "utf8", timeout: 10000 });
    if (result.status === 0) {
      log("profit record: 已强制关闭占用进程（wps/excel）");
    }
  } catch (e) {
    log(`profit record: 关闭占用进程失败: ${e.message}`);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// 锁文件超时时间：超过此时间认为进程已死，自动失效（10 分钟）
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

function pidAlive(pid) {
  if (!pid || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  const current = readJson(LOCK_PATH);
  if (current) {
    const pid = Number(current.pid || 0);
    const startedAt = current.startedAt ? new Date(current.startedAt).getTime() : 0;
    const ageMs = Date.now() - startedAt;
    // PID 存活且未超时，才认为有另一个实例在运行
    if (pidAlive(pid) && ageMs < LOCK_TIMEOUT_MS) {
      log(`weather sync already running pid=${pid}, exiting`);
      process.exit(0);
    }
    // PID 不存活或锁文件超时，清理旧锁文件
    if (ageMs >= LOCK_TIMEOUT_MS) {
      log(`stale lock detected (age=${Math.round(ageMs / 1000)}s), removing`);
    }
  }
  ensureDir(LOCKS_DIR);
  fs.writeFileSync(
    LOCK_PATH,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function releaseLock() {
  try {
    const current = readJson(LOCK_PATH);
    if (current && Number(current.pid || 0) === process.pid) {
      fs.rmSync(LOCK_PATH, { force: true });
    }
  } catch {}
}

function toReasonableTemp(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= -80 && num <= 80 ? num : null;
}

function didBucketResolveYes(candidate, actualMaxTempC) {
  const actual = toReasonableTemp(actualMaxTempC);
  const bucketValue = toReasonableTemp(candidate?.marketBucketValue ?? candidate?.targetTempC);
  if (!Number.isFinite(actual) || !Number.isFinite(bucketValue)) {
    return null;
  }
  if (candidate?.marketBucketKind === "lower") {
    return actual <= bucketValue;
  }
  if (candidate?.marketBucketKind === "upper") {
    return actual >= bucketValue;
  }
  if (candidate?.marketBucketKind === "range") {
    return actual >= bucketValue - 1 && actual <= bucketValue + 1;
  }
  return actual === bucketValue;
}

function roundMoney(value, digits = 6) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : null;
}

// 获取目标温度市场的真实 No 价格（调 gamma-api）
// 返回 { marketSlug, marketTitle, marketQuestion, marketBucketKind, marketBucketValue, buyNoPrice } 或 null
async function fetchTargetTempMarket(record, targetTempC) {
  if (!record?.eventSlug || !Number.isFinite(targetTempC)) {
    return null;
  }
  try {
    const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(record.eventSlug)}`;
    const payload = await fetchJsonWithFallback(url, "gamma-api-events");
    const event = Array.isArray(payload) && payload.length ? payload[0] : null;
    if (!event || !Array.isArray(event.markets)) throw new Error("no markets");

    const parseOutcomeArray = (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return []; }
      }
      return [];
    };

    for (const market of event.markets) {
      const question = String(market?.question || "");
      const exactMatch = question.match(/(\d+)\s*°?\s*C\b/i);
      if (!exactMatch) continue;
      const value = Number(exactMatch[1]);
      if (!Number.isFinite(value) || value !== targetTempC) continue;
      if (/or\s+higher/i.test(question) || /or\s+below/i.test(question)) continue;

      const outcomes = parseOutcomeArray(market?.outcomes);
      const prices = parseOutcomeArray(market?.outcomePrices).map(Number);
      if (!outcomes.length || outcomes.length !== prices.length) continue;
      const noIndex = outcomes.findIndex((o) => String(o).toLowerCase() === "no");
      if (noIndex < 0) continue;
      const noPrice = Number.isFinite(prices[noIndex]) ? prices[noIndex] : null;
      if (!Number.isFinite(noPrice) || noPrice <= 0 || noPrice >= 1) continue;

      return {
        marketSlug: market.slug,
        marketTitle: question,
        marketQuestion: market.question,
        marketBucketKind: "exact",
        marketBucketValue: value,
        buyNoPrice: noPrice,
      };
    }
    throw new Error("no exact match");
  } catch (apiError) {
    // Fallback: gamma-api 请求失败时，使用 records.json 中的 candidateMarkets 数据
    const candidates = Array.isArray(record?.candidateMarkets) ? record.candidateMarkets : [];
    const fallback = candidates.find(
      (m) => Number(m?.targetTempC) === targetTempC && m?.marketBucketKind === "exact",
    );
    if (fallback && Number.isFinite(Number(fallback.buyNoPrice))) {
      const noPrice = Number(fallback.buyNoPrice);
      if (noPrice > 0 && noPrice < 1) {
        return {
          marketSlug: fallback.marketSlug,
          marketTitle: fallback.marketTitle,
          marketQuestion: fallback.marketQuestion,
          marketBucketKind: "exact",
          marketBucketValue: targetTempC,
          buyNoPrice: noPrice,
        };
      }
    }
    return null;
  }
}

// 所有城市统一北京时间 00:10 下单
function getOrderTimeBeijingMinutes() {
  return 0 * 60 + 10; // 00:10 北京时间
}

// 获取当前北京时间的分钟数（0-1439）
function getCurrentBeijingMinutes() {
  const now = new Date();
  const beijingFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = beijingFormatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  return hour * 60 + minute;
}

async function maybeRunSimulationOrders(snapshot) {
  const config = readJson(WEATHER_CONFIG_PATH) || {};
  const existingOrders = readJson(SIM_ORDERS_PATH) || [];
  const allOrders = Array.isArray(existingOrders) ? existingOrders : [];
  const existingKeys = new Set(allOrders.map((o) => o.key).filter(Boolean));
  const todayYmd = snapshot.localDate;

  // 获取所有历史记录，构建城市+日期的 delta 映射（用于跟昨天策略）
  const allRecords = snapshot.records || [];
  const bestByCityDate = new Map();
  for (const record of allRecords) {
    if (!record.citySlug || !record.date) continue;
    const key = `${record.citySlug}:${record.date}`;
    const existing = bestByCityDate.get(key);
    if (!existing || record.captureSlotId === "00") {
      bestByCityDate.set(key, record);
    }
  }

  const allDates = [...new Set(allRecords.map((r) => r.date).filter(Boolean))].sort();
  const deltaByCityDate = new Map();
  for (const record of allRecords) {
    if (!record.citySlug || !record.date) continue;
    const actual = toReasonableTemp(record.actualMaxTempC);
    const forecast = toReasonableTemp(record.forecastMaxTempC);
    const delta =
      Number.isFinite(Number(record.temperatureDeltaC)) && Number.isFinite(actual) && Number.isFinite(forecast)
        ? Number(record.temperatureDeltaC)
        : Number.isFinite(actual) && Number.isFinite(forecast)
          ? roundMoney(actual - forecast, 1)
          : null;
    if (Number.isFinite(delta)) {
      deltaByCityDate.set(`${record.citySlug}:${record.date}`, delta);
    }
  }

  // 获取今天的 slot "00" 记录
  const todayRecords = allRecords.filter(
    (r) => r.date === todayYmd && r.captureSlotId === "00" && r.eventSlug,
  );

  const newOrders = [];
  const STAKE_USD = 1;
  // 与实盘保持一致：No 价格超过 0.90 不买入
  const MAX_NO_PRICE = Number(config?.maxNoPrice || 0.90);
  const currentBeijingMinutes = getCurrentBeijingMinutes();

  // 动态 import 城市配置（ES module）
  const weatherDataModule = await import(pathToFileURL(path.join(ROOT_DIR, "lib", "weather-data.js")).href);
  const cityConfigs = weatherDataModule.WEATHER_CITY_CONFIGS || [];

  for (const record of todayRecords) {
    // ========== 下单时间检查 ==========
    // 国内和亚洲城市在北京时间 00:10 下单，其他城市在当地凌晨 00:10（换算成北京时间）下单
    const cityConfig = cityConfigs.find((c) => c.citySlug === record.citySlug);
    const orderTimeMinutes = getOrderTimeBeijingMinutes();
    if (currentBeijingMinutes < orderTimeMinutes) continue; // 还没到下单时间，跳过

    // ========== 温差下单策略（跟昨天温差） ==========
    // 逻辑：昨天温差 = 昨天实际 - 昨天预报
    //       今天目标温度 = 今天预报 + 昨天温差
    //       温度必须相等才下单，用 gamma-api 获取真实 No 价格
    const dateIdx = allDates.indexOf(todayYmd);
    if (dateIdx <= 0) continue;
    const prevDate = allDates[dateIdx - 1];
    const prevDelta = deltaByCityDate.get(`${record.citySlug}:${prevDate}`);
    if (!Number.isFinite(prevDelta)) continue;
    const followOffset = Math.round(prevDelta);

    // 目标温度 = 今天预报 + 昨天温差
    const forecastToday = toReasonableTemp(record.forecastMaxTempC);
    if (forecastToday === null) continue;
    const targetTempC = forecastToday + followOffset;

    // 用 gamma-api 获取目标温度市场的真实 No 价格
    const matchedMarket = await fetchTargetTempMarket(record, targetTempC);
    if (!matchedMarket) continue; // 没有匹配温度的市场则跳过

    const buyNoPrice = Number(matchedMarket.buyNoPrice);
    if (!Number.isFinite(buyNoPrice) || buyNoPrice <= 0 || buyNoPrice >= 1 || buyNoPrice > MAX_NO_PRICE) continue;

    const marketSlug = matchedMarket.marketSlug;
    const marketBucketValue = matchedMarket.marketBucketValue;
    const marketBucketKind = matchedMarket.marketBucketKind;
    const marketTitle = matchedMarket.marketTitle;
    const marketQuestion = matchedMarket.marketQuestion;

    const key = [todayYmd, "sim-follow-yesterday", "00", record.citySlug, marketSlug].join(":");
    if (existingKeys.has(key)) continue;

    newOrders.push({
      key,
      strategyId: "sim-follow-yesterday",
      strategyLabel: `跟昨天${prevDelta > 0 ? "+" : ""}${prevDelta}°`,
      date: todayYmd,
      captureSlotId: "00",
      captureSlotLabel: "00:10",
      citySlug: record.citySlug,
      cityZh: record.cityZh,
      cityEn: record.cityEn,
      forecastTarget: record.forecastTarget,
      forecastMinTempC: record.forecastMinTempC,
      forecastMaxTempC: record.forecastMaxTempC,
      actualMaxTempC: record.actualMaxTempC || null,
      temperatureDeltaC: record.temperatureDeltaC || null,
      temperatureOffsetC: followOffset,
      prevDateDeltaC: prevDelta,
      targetTempC,
      marketSlug,
      marketTitle,
      marketQuestion,
      marketBucketKind,
      marketBucketValue,
      buyNoPrice,
      stakeUsd: STAKE_USD,
      status: "pending",
      resolvedOutcome: null,
      accountingPnlUsd: null,
      eventSlug: record.eventSlug,
      eventUrl: record.eventUrl,
      placedAt: new Date().toISOString(),
    });
  }

  // 结算已完成的模拟订单（有 actualMaxTempC 但 status 还是 pending）
  // 优化：只检测 pending 状态的订单，已结算（status === "resolved"）的不再遍历
  // 防护：只结算 >= SIM_ORDERS_START_DATE 的订单，防止历史数据被反复结算
  let resolvedCount = 0;
  const pendingOrders = allOrders.filter(
    (o) => o.status === "pending" && String(o.date || "") >= SIM_ORDERS_START_DATE,
  );
  for (const order of pendingOrders) {
    // 从 records 中查找对应的实际温度
    const matchedRecord = allRecords.find(
      (r) =>
        r.citySlug === order.citySlug &&
        r.date === order.date &&
        r.captureSlotId === "00" &&
        r.status === "resolved" &&
        toReasonableTemp(r.actualMaxTempC) !== null,
    );
    if (!matchedRecord) continue;

    const actualTemp = toReasonableTemp(matchedRecord.actualMaxTempC);
    if (actualTemp === null) continue;

    const yesWins = didBucketResolveYes(
      {
        marketBucketKind: order.marketBucketKind,
        marketBucketValue: order.marketBucketValue,
      },
      actualTemp,
    );
    if (yesWins === null) continue;

    const buyNoPrice = Number(order.buyNoPrice);
    const stakeUsd = Number(order.stakeUsd) || STAKE_USD;
    const accountingPnlUsd = yesWins
      ? roundMoney(-stakeUsd)
      : roundMoney(stakeUsd / buyNoPrice - stakeUsd);

    order.status = "resolved";
    order.actualMaxTempC = actualTemp;
    order.resolvedOutcome = yesWins ? "yes" : "no";
    order.accountingPnlUsd = accountingPnlUsd;
    order.resolvedAt = new Date().toISOString();
    resolvedCount++;
  }

  // 保存
  const savedOrders = [...allOrders, ...newOrders];
  if (newOrders.length > 0 || resolvedCount > 0) {
    ensureDir(path.dirname(SIM_ORDERS_PATH));
    fs.writeFileSync(
      SIM_ORDERS_PATH,
      `${JSON.stringify(savedOrders, null, 2)}\n`,
      "utf8",
    );
    log(`simulation orders: +${newOrders.length} new, ${resolvedCount} resolved, total=${savedOrders.length}`);
    return true;
  }

  return false;
}

// 获取北京时间昨天的日期（YYYY-MM-DD）
function getBeijingYesterdayYmd() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  beijing.setDate(beijing.getDate() - 1);
  const y = beijing.getFullYear();
  const m = String(beijing.getMonth() + 1).padStart(2, "0");
  const d = String(beijing.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Excel 日期序列号转 YYYY-MM-DD
function excelSerialToYmd(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + serial * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function cellDateToYmd(cellValue) {
  if (cellValue instanceof Date) {
    return `${cellValue.getUTCFullYear()}-${String(cellValue.getUTCMonth() + 1).padStart(2, "0")}-${String(cellValue.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof cellValue === "number") {
    return excelSerialToYmd(cellValue);
  }
  return null;
}

// 日期转 Excel 行号
function profitDateToCell(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  if (year !== 2026) return null;
  const monthSheetMap = {
    6: { sheetName: "6月", startDay: 21, days: 30 },
    7: { sheetName: "7月", startDay: 1, days: 31 },
    8: { sheetName: "8月", startDay: 1, days: 31 },
    9: { sheetName: "9月", startDay: 1, days: 30 },
  };
  const cfg = monthSheetMap[month];
  if (!cfg) return null;
  if (day < cfg.startDay || day > cfg.days) return null;
  const row = 1 + (day - cfg.startDay + 1);
  return { sheetName: cfg.sheetName, row, month, startDay: cfg.startDay, days: cfg.days };
}

// 每天北京时间 0:10 后自动获取余额并更新收益记录 xlsx
async function maybeUpdateProfitRecord() {
  const currentBeijingMinutes = getCurrentBeijingMinutes();
  if (currentBeijingMinutes < PROFIT_UPDATE_TIME_MINUTES) return; // 还没到 0:10

  const yesterday = getBeijingYesterdayYmd();
  const state = readJson(PROFIT_RECORD_STATE_PATH) || {};
  if (state.lastUpdatedDate === yesterday) return; // 今天已更新过

  // 获取余额
  const result = spawnSync(PYTHON_BIN, [GET_BALANCE_SCRIPT], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status !== 0) {
    log(`profit record: 获取余额失败: ${result.stderr || "unknown"}`);
    return;
  }
  let balanceData;
  try {
    balanceData = JSON.parse(result.stdout.trim());
  } catch {
    log(`profit record: 解析余额输出失败`);
    return;
  }
  if (balanceData.error) {
    log(`profit record: 余额错误: ${balanceData.error}`);
    return;
  }
  const amount = balanceData.portfolioUsd;
  if (!Number.isFinite(amount)) {
    log(`profit record: 金额无效: ${amount}`);
    return;
  }

  // 先写余额快照（pending），确保即使后续 Excel 写入失败也有余额记录可查
  const snapshotTime = new Date().toISOString();
  appendBalanceSnapshot({
    date: yesterday,
    amount,
    status: "pending",
    source: "get_balance.py",
    capturedAt: snapshotTime,
  });
  log(`profit record: 余额快照已记录 ${yesterday} 金额=${amount}`);

  // 查找昨天的单元格
  const cellRef = profitDateToCell(yesterday);
  if (!cellRef) {
    log(`profit record: 日期 ${yesterday} 不在 6-9月范围内，跳过`);
    return;
  }

  // 更新 xlsx（只读写原文件，避免数据分裂；被占用则等待重试）
  try {
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    let readPath = PROFIT_RECORD_PATH;
    await wb.xlsx.readFile(readPath);
    const ws = wb.getWorksheet(cellRef.sheetName);
    if (!ws) {
      log(`profit record: Sheet "${cellRef.sheetName}" 不存在`);
      return;
    }
    // 检查日期是否匹配
    const cellYmd = cellDateToYmd(ws.getCell(`A${cellRef.row}`).value);
    if (cellYmd !== yesterday) {
      log(`profit record: 日期不匹配: 期望 ${yesterday}, 实际 ${cellYmd}`);
      return;
    }
    // 如果已有金额，不覆盖，但仍更新 state 避免下次重复检查
    const existingAmount = ws.getCell(`B${cellRef.row}`).value;
    if (existingAmount !== null && existingAmount !== undefined) {
      log(`profit record: ${yesterday} 已有金额 ${existingAmount}，跳过写入但更新 state`);
      ensureDir(path.dirname(PROFIT_RECORD_STATE_PATH));
      fs.writeFileSync(
        PROFIT_RECORD_STATE_PATH,
        `${JSON.stringify({ lastUpdatedDate: yesterday, lastUpdatedAmount: existingAmount, lastUpdatedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
      return;
    }
    // 填入金额
    ws.getCell(`B${cellRef.row}`).value = amount;
    // 在该月最后一行下面加一行"X月总收益"汇总
    // 公式用 LOOKUP 动态查找最后一个非空余额，避免月底未填金额时算错
    const monthLastRow = 1 + (cellRef.days - cellRef.startDay + 1);
    const summaryRow = monthLastRow + 1;
    const existingSummary = ws.getCell(`A${summaryRow}`).value;
    if (existingSummary === null || existingSummary === undefined || existingSummary === "") {
      ws.getCell(`A${summaryRow}`).value = `${cellRef.month}月总收益`;
      ws.getCell(`B${summaryRow}`).value = {
        formula: `LOOKUP(2,1/(B2:B${monthLastRow}<>""),B2:B${monthLastRow})-B2`,
      };
      ws.getCell(`C${summaryRow}`).value = null;
      const bold = { font: { bold: true } };
      ws.getCell(`A${summaryRow}`).style = bold;
      ws.getCell(`B${summaryRow}`).style = bold;
      log(`profit record: 已添加 ${cellRef.sheetName}!A${summaryRow} "${cellRef.month}月总收益"`);
    }
    // 写入：只写原文件，被占用则强制关闭占用进程后重试，最多 3 次
    // 不再写 .new.xlsx 以避免数据分裂（曾经发生 .new.xlsx 有数据但原文件空着的问题）
    let writeOk = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await wb.xlsx.writeFile(PROFIT_RECORD_PATH);
        writeOk = true;
        break;
      } catch (e) {
        lastErr = e;
        if (e.code === "EBUSY" || e.code === "EPERM") {
          log(`profit record: 原文件被占用，第 ${attempt} 次尝试强制关闭占用进程后重试...`);
          killExcelProcesses();
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          throw e;
        }
      }
    }
    if (!writeOk) {
      throw new Error(`写入 xlsx 失败（重试 3 次）: ${lastErr?.message || "unknown"}`);
    }
  } catch (e) {
    log(`profit record: 更新失败: ${e.message}`);
    return;
  }

  // 更新状态文件
  const confirmedAt = new Date().toISOString();
  ensureDir(path.dirname(PROFIT_RECORD_STATE_PATH));
  fs.writeFileSync(
    PROFIT_RECORD_STATE_PATH,
    `${JSON.stringify({ lastUpdatedDate: yesterday, lastUpdatedAmount: amount, lastUpdatedAt: confirmedAt }, null, 2)}\n`,
    "utf8",
  );
  // 写入确认快照
  appendBalanceSnapshot({
    date: yesterday,
    amount,
    status: "confirmed",
    source: "profit-record-xlsx",
    sheet: cellRef.sheetName,
    cell: `B${cellRef.row}`,
    capturedAt: snapshotTime,
    confirmedAt,
  });
  // 核对日志：日期、金额、sheet、cell、state 是否一致
  log(`profit record: 已更新 ${yesterday} 金额=${amount}`);
  log(`profit record: 核对 sheet=${cellRef.sheetName} cell=B${cellRef.row} date=${yesterday} amount=${amount} state=${yesterday}`);
}

// 预测进程退出条件追踪：连续 N 次 runOnce 没有 sim orders 新增，认为当天预测+sim 已完成
let lastSimOrderCount = 0;
let simOrdersStableRuns = 0;
// 预测进程保底退出时间：北京时间 02:00 后强制退出，避免一直等数据源
const PREDICT_DEADLINE_MINUTES = Number(process.env.WEATHER_PREDICT_DEADLINE_MINUTES || 120);

async function runOnce() {
  const modulePath = path.join(ROOT_DIR, "lib", "weather-trading-data.js");
  const weather = await import(pathToFileURL(modulePath).href);
  let snapshot = await weather.getWeatherDashboardSnapshot();
  // live order 和 reconcile 已拆分到独立的 weather_live_order_loop.js 进程，sync 只负责预测+sim+profit
  const simOrderRan = await maybeRunSimulationOrders(snapshot);
  if (simOrderRan) {
    snapshot = await weather.getWeatherDashboardSnapshot();
  }
  const missingCapture = (snapshot.captureBackfill?.slots || [])
    .filter((slot) => slot.started && slot.missingCount > 0)
    .map((slot) => `${slot.slotLabel}:${slot.missingCount}`)
    .join(",");
  log(
    `synced date=${snapshot.localDate} total=${snapshot.records.length} ` +
      `today=${snapshot.summary.today.records} wins=${snapshot.summary.overall.wins} ` +
      `losses=${snapshot.summary.overall.losses} pending=${snapshot.summary.overall.pending} ` +
      `net=${snapshot.summary.overall.netPnlUsd} ` +
      `missingCapture=${missingCapture || "none"} ` +
      `liveToday=${snapshot.liveOrders?.summary?.today?.records ?? 0} ` +
      `livePending=${snapshot.liveOrders?.summary?.overall?.pending ?? 0} ` +
      `liveNet=${snapshot.liveOrders?.summary?.overall?.netPnlUsd ?? 0} ` +
      `midday95Today=${snapshot.middayNo95?.summary?.today?.records ?? 0} ` +
      `midday95Net=${snapshot.middayNo95?.summary?.overall?.netPnlUsd ?? 0} ` +
      `offsetSimToday=${snapshot.offsetSimulation?.summary?.today?.records ?? 0} ` +
      `offsetSimNet=${snapshot.offsetSimulation?.summary?.overall?.netPnlUsd ?? 0} ` +
      `simOrders=${snapshot.simOrders?.records?.length ?? 0} ` +
      `simOrdersNet=${snapshot.simOrders?.summary?.overall?.netPnlUsd ?? 0}`,
  );

  // 每天北京时间 0:10 后自动更新收益记录
  try {
    await maybeUpdateProfitRecord();
  } catch (error) {
    log(`profit record: 异常: ${error?.message || error}`);
  }

  // 退出条件：当天 sim orders 已生成且连续 2 次没有新增 → 预测+sim 完成
  // 保底：北京时间 02:00 后强制退出，避免一直等数据源
  const todayYmd = snapshot.localDate;
  const allSimOrders = readJson(SIM_ORDERS_PATH) || [];
  const todaySimOrderCount = (Array.isArray(allSimOrders) ? allSimOrders : [])
    .filter((o) => o?.date === todayYmd).length;
  if (todaySimOrderCount > 0 && todaySimOrderCount === lastSimOrderCount) {
    simOrdersStableRuns++;
  } else {
    simOrdersStableRuns = 0;
  }
  lastSimOrderCount = todaySimOrderCount;

  const beijingMinutes = getCurrentBeijingMinutes();
  const deadlineReached = beijingMinutes >= PREDICT_DEADLINE_MINUTES;
  const stableDone =
    todaySimOrderCount > 0 &&
    simOrdersStableRuns >= 2 &&
    beijingMinutes >= PROFIT_UPDATE_TIME_MINUTES; // 确保 profit record（0:10 后）有机会跑
  if (stableDone || deadlineReached) {
    log(
      `predict+sim done, exiting simOrders=${todaySimOrderCount} ` +
        `stableRuns=${simOrdersStableRuns} beijingMinutes=${beijingMinutes} ` +
        `reason=${deadlineReached ? "deadline" : "stable"}`,
    );
    releaseLock();
    process.exit(0);
  }
  log(
    `predict+sim waiting simOrders=${todaySimOrderCount} ` +
      `stableRuns=${simOrdersStableRuns} beijingMinutes=${beijingMinutes} ` +
        `deadline=${PREDICT_DEADLINE_MINUTES}`,
  );
}

async function main() {
  acquireLock();
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(0);
  });
  const runOnceMode = process.argv.includes("--once");
  log(`weather sync ${runOnceMode ? "once" : "loop"} started interval=${INTERVAL_MS}ms`);
  if (runOnceMode) {
    try {
      await runOnce();
    } catch (error) {
      log(`sync failed: ${error?.message || error}`);
    }
    releaseLock();
    process.exit(0);
  }
  while (true) {
    try {
      await runOnce();
    } catch (error) {
      log(`sync failed: ${error?.message || error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, INTERVAL_MS)));
  }
}

main().catch((error) => {
  log(`fatal: ${error?.message || error}`);
  process.exit(1);
});
