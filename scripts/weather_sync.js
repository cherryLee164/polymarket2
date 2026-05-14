const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT_DIR = path.join(__dirname, "..");
const INTERVAL_MS = Number(process.env.WEATHER_SYNC_INTERVAL_MS || 5 * 60 * 1000);
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const LOCK_PATH = path.join(LOCKS_DIR, "weather-sync.lock.json");
const WEATHER_LIVE_RECORDS_PATH = path.join(ROOT_DIR, "data", "weather_predictions", "live-orders.json");
const WEATHER_CONFIG_PATH = path.join(ROOT_DIR, "data", "weather_predictions", "config.json");
const PYTHON_BIN = process.env.PYTHON || "python";
const WEATHER_LIVE_ORDER_SCRIPT = path.join(ROOT_DIR, "scripts", "weather_live_order.py");
const WEATHER_LIVE_RECONCILE_SCRIPT = path.join(ROOT_DIR, "scripts", "weather_reconcile_live_orders.py");
const WEATHER_LIVE_AUTO_ENABLED = envEnabled("WEATHER_LIVE_AUTO_ENABLED", true);
const WEATHER_LIVE_RECONCILE_ENABLED = envEnabled("WEATHER_LIVE_RECONCILE_ENABLED", true);
const WEATHER_LIVE_ORDER_TIMEOUT_MS = Number(
  process.env.WEATHER_LIVE_ORDER_TIMEOUT_MS || 4 * 60 * 1000,
);
const WEATHER_LIVE_RECONCILE_TIMEOUT_MS = Number(
  process.env.WEATHER_LIVE_RECONCILE_TIMEOUT_MS || 2 * 60 * 1000,
);
const WEATHER_LIVE_MAX_ORDER_ATTEMPTS = Math.max(
  1,
  Number(process.env.WEATHER_LIVE_MAX_ORDER_ATTEMPTS || 288),
);
const WEATHER_LIVE_RETRY_AFTER_MS = Number(process.env.WEATHER_LIVE_RETRY_AFTER_SECONDS || 300) * 1000;
const WEATHER_LIVE_MAX_NO_PRICE = Number(process.env.WEATHER_LIVE_MAX_NO_PRICE || 0.95);
const WEATHER_LIVE_HIGH_PRICE_SKIP_REASON = `no-price-above-${WEATHER_LIVE_MAX_NO_PRICE.toFixed(2)}`;

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
  if (current && pidAlive(Number(current.pid || 0))) {
    log(`weather sync already running pid=${current.pid}, exiting`);
    process.exit(0);
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

function isTradeableWeatherRecord(record, localDate) {
  const noPrice = Number(record?.buyNoPrice);
  return (
    record?.date === localDate &&
    record?.captureSlotId === "00" &&
    record?.marketSlug &&
    record?.eventSlug &&
    Number.isFinite(noPrice) &&
    noPrice > 0 &&
    noPrice <= WEATHER_LIVE_MAX_NO_PRICE &&
    String(record?.status || "").toLowerCase() !== "resolved"
  );
}

function readWeatherLiveConfig() {
  const config = readJson(WEATHER_CONFIG_PATH) || {};
  const mode = ["simulation", "live"].includes(String(config.executionMode || "").toLowerCase())
    ? String(config.executionMode).toLowerCase()
    : "live";
  const offsets = Array.isArray(config.temperatureOffsets)
    ? config.temperatureOffsets
        .map((item) => Number(item))
        .filter((item, index, array) => [-1, 0, 1].includes(item) && array.indexOf(item) === index)
    : [0];
  return { mode, offsets: offsets.length ? offsets : [0] };
}

function countTodayWeatherCandidates(snapshot) {
  const config = readWeatherLiveConfig();
  if (config.mode !== "live") {
    return 0;
  }
  const enabledOffsets = new Set(config.offsets);
  return (snapshot.records || []).reduce((total, record) => {
    if (record?.date !== snapshot.localDate || record?.captureSlotId !== "00" || !record?.eventSlug) {
      return total;
    }
    const candidates = Array.isArray(record.candidateMarkets) ? record.candidateMarkets : [];
    if (candidates.length) {
      return (
        total +
        candidates.filter((candidate) => {
          const noPrice = Number(candidate?.buyNoPrice);
          return (
            enabledOffsets.has(Number(candidate?.temperatureOffsetC)) &&
            candidate?.marketSlug &&
            Number.isFinite(noPrice) &&
            noPrice > 0 &&
            noPrice <= WEATHER_LIVE_MAX_NO_PRICE
          );
        }).length
      );
    }
    return total + (enabledOffsets.has(Number(record?.temperatureOffsetC || 0)) && isTradeableWeatherRecord(record, snapshot.localDate) ? 1 : 0);
  }, 0);
}

function todayLiveOrderRecords(snapshot) {
  const rawRecords = readJson(WEATHER_LIVE_RECORDS_PATH);
  const records = Array.isArray(rawRecords) ? rawRecords : snapshot.liveOrders?.records || [];
  return records.filter((record) => record?.date === snapshot.localDate);
}

function countTodayLiveOrders(snapshot) {
  return todayLiveOrderRecords(snapshot).filter(
    (record) =>
      isHighPriceSkippedLiveOrder(record) ||
      !["failed", "skipped", "cancelled", "canceled"].includes(
        String(record?.status || "").toLowerCase(),
      ),
  ).length;
}

function isHighPriceSkippedLiveOrder(record) {
  return (
    String(record?.status || "").toLowerCase() === "skipped" &&
    (record?.skipReason === WEATHER_LIVE_HIGH_PRICE_SKIP_REASON ||
      String(record?.fillStatus || "").toLowerCase() === "price-above-limit")
  );
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderAttemptCount(record) {
  if (Array.isArray(record?.orderAttempts) && record.orderAttempts.length > 0) {
    return record.orderAttempts.length;
  }
  return record?.orderId ? 1 : 0;
}

function hasSubmittedLiveOrder(record) {
  if (record?.orderId) {
    return true;
  }
  if (Array.isArray(record?.orderIds) && record.orderIds.some(Boolean)) {
    return true;
  }
  const attempts = Array.isArray(record?.orderAttempts) ? record.orderAttempts : [];
  return attempts.some((attempt) => {
    const response =
      attempt?.response && typeof attempt.response === "object" ? attempt.response : {};
    return Boolean(
      attempt?.orderId ||
        response.orderID ||
        response.orderId ||
        response.success === true
    );
  });
}

function lastAttemptTime(record) {
  const attempts = Array.isArray(record?.orderAttempts) ? record.orderAttempts : [];
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const raw = lastAttempt?.attemptedAt || record?.lastAttemptAt || record?.placedAt;
  const ts = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

function hasConfirmedLiveFill(record) {
  const fillStatus = String(record?.fillStatus || "").toLowerCase();
  if (
    [
      "submitted-unconfirmed",
      "no-position-after-attempt",
      "no-position-after-retries",
      "missing-order-id",
      "no-bot-order-fill",
    ].includes(fillStatus)
  ) {
    return false;
  }
  if (numeric(record?.actualBuyCostUsd) > 0 && numeric(record?.actualBuyShares) > 0) {
    return true;
  }
  return (
    fillStatus === "position-detected" &&
    Math.max(numeric(record?.spentUsd), numeric(record?.stakeUsd)) > 0 &&
    numeric(record?.sharesBought) > 0
  );
}

function isRetryableUnconfirmedLiveOrder(record, localDate) {
  if (record?.date !== localDate) {
    return false;
  }
  const status = String(record?.status || "").toLowerCase();
  if (!["pending", "placing", "no-fill"].includes(status)) {
    return false;
  }
  if (hasConfirmedLiveFill(record)) {
    return false;
  }
  if (hasSubmittedLiveOrder(record)) {
    return false;
  }
  if (
    record?.skipReason === WEATHER_LIVE_HIGH_PRICE_SKIP_REASON ||
    String(record?.fillStatus || "").toLowerCase() === "price-above-limit"
  ) {
    return false;
  }
  if (orderAttemptCount(record) >= WEATHER_LIVE_MAX_ORDER_ATTEMPTS) {
    return false;
  }
  const lastAttempt = lastAttemptTime(record);
  return lastAttempt == null || Date.now() - lastAttempt >= WEATHER_LIVE_RETRY_AFTER_MS;
}

function countRetryableLiveOrders(snapshot) {
  return todayLiveOrderRecords(snapshot).filter((record) =>
    isRetryableUnconfirmedLiveOrder(record, snapshot.localDate),
  ).length;
}

function logChildOutput(label, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    log(`${label}: ${line}`);
  }
}

function maybeRunWeatherLiveOrders(snapshot) {
  if (!WEATHER_LIVE_AUTO_ENABLED) {
    return false;
  }
  const candidateCount = countTodayWeatherCandidates(snapshot);
  if (candidateCount <= 0) {
    return false;
  }
  const liveCount = countTodayLiveOrders(snapshot);
  const retryCount = countRetryableLiveOrders(snapshot);
  if (liveCount >= candidateCount && retryCount <= 0) {
    return false;
  }

  log(
    `live auto order needed date=${snapshot.localDate} candidates=${candidateCount} ` +
      `live=${liveCount} retry=${retryCount}; running weather_live_order.py`,
  );
  const result = spawnSync(PYTHON_BIN, [WEATHER_LIVE_ORDER_SCRIPT], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      WEATHER_LIVE_DATE: snapshot.localDate,
    },
    encoding: "utf8",
    timeout: WEATHER_LIVE_ORDER_TIMEOUT_MS,
    windowsHide: false,
  });
  logChildOutput("live-order stdout", result.stdout);
  logChildOutput("live-order stderr", result.stderr);
  if (result.error) {
    log(`live auto order failed: ${result.error.message || result.error}`);
    return false;
  }
  if (result.status !== 0) {
    log(`live auto order exited status=${result.status}`);
    return false;
  }
  return true;
}

function maybeRunWeatherLiveReconcile(snapshot) {
  if (!WEATHER_LIVE_RECONCILE_ENABLED) {
    return false;
  }
  const liveCount = snapshot.liveOrders?.records?.length || 0;
  if (liveCount <= 0) {
    return false;
  }

  const result = spawnSync(PYTHON_BIN, [WEATHER_LIVE_RECONCILE_SCRIPT], {
    cwd: ROOT_DIR,
    env: process.env,
    encoding: "utf8",
    timeout: WEATHER_LIVE_RECONCILE_TIMEOUT_MS,
    windowsHide: true,
  });
  logChildOutput("live-reconcile stdout", result.stdout);
  logChildOutput("live-reconcile stderr", result.stderr);
  if (result.error) {
    log(`live reconcile failed: ${result.error.message || result.error}`);
    return false;
  }
  if (result.status !== 0) {
    log(`live reconcile exited status=${result.status}`);
    return false;
  }
  return String(result.stdout || "").includes("changed=") && !String(result.stdout || "").includes("changed=0");
}

async function runOnce() {
  const modulePath = path.join(ROOT_DIR, "lib", "weather-trading-data.js");
  const weather = await import(pathToFileURL(modulePath).href);
  let snapshot = await weather.getWeatherDashboardSnapshot();
  const liveReconciledBeforeOrder = maybeRunWeatherLiveReconcile(snapshot);
  if (liveReconciledBeforeOrder) {
    snapshot = await weather.getWeatherDashboardSnapshot();
  }
  const liveOrderRan = maybeRunWeatherLiveOrders(snapshot);
  if (liveOrderRan) {
    snapshot = await weather.getWeatherDashboardSnapshot();
  }
  const liveReconciledAfterOrder = liveOrderRan ? maybeRunWeatherLiveReconcile(snapshot) : false;
  if (liveReconciledAfterOrder) {
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
      `offsetSimNet=${snapshot.offsetSimulation?.summary?.overall?.netPnlUsd ?? 0}`,
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
  log(`weather sync loop started interval=${INTERVAL_MS}ms`);
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
