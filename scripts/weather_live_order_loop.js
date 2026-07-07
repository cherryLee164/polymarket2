// 实盘下单独立循环进程：与预测进程（weather_sync.js）分离，互不影响。
// 职责：循环调用 weather_live_order.py + reconcile，当天北京下单完成或超过 12:00 → 退出。
// 启动方式：由 weather_live_order_launcher.js 在 00:00 拉起，或手动 node 运行。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const PYTHON_BIN = process.env.PYTHON || "python";
const WEATHER_LIVE_ORDER_SCRIPT = path.join(ROOT_DIR, "scripts", "weather_live_order.py");
const WEATHER_LIVE_RECONCILE_SCRIPT = path.join(ROOT_DIR, "scripts", "weather_reconcile_live_orders.py");
const LIVE_ORDERS_PATH = path.join(ROOT_DIR, "data", "weather_predictions", "live-orders.json");
const SIM_ORDERS_PATH = path.join(ROOT_DIR, "data", "weather_predictions", "sim-orders.json");
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const LOCK_PATH = path.join(LOCKS_DIR, "weather-live-order.lock.json");

// 循环间隔：默认 5 分钟（与原 sync 周期一致）
const LOOP_INTERVAL_MS = Number(process.env.WEATHER_LIVE_LOOP_INTERVAL_MS || 5 * 60 * 1000);
// 单次 weather_live_order.py 子进程超时：首次约 60s+10min，重试约 10min+10min，留缓冲共 25 分钟
const LIVE_ORDER_TIMEOUT_MS = Number(process.env.WEATHER_LIVE_ORDER_TIMEOUT_MS || 25 * 60 * 1000);
const RECONCILE_TIMEOUT_MS = Number(process.env.WEATHER_LIVE_RECONCILE_TIMEOUT_MS || 2 * 60 * 1000);
// 实盘下单截止时间：北京时间 12:00 后不再下当天真实单
const LIVE_ORDER_DEADLINE_HOUR = Number(process.env.WEATHER_LIVE_DEADLINE_HOUR || 12);
// 实盘下单白名单：只对白名单内的城市真实下单
const LIVE_ORDER_CITY_SLUGS = new Set(
  String(process.env.WEATHER_LIVE_CITY_SLUGS || "beijing").split(",").map((s) => s.trim()).filter(Boolean),
);
const WEATHER_LIVE_MAX_ORDER_ATTEMPTS = Math.max(1, Number(process.env.WEATHER_LIVE_MAX_ORDER_ATTEMPTS || 288));
const WEATHER_LIVE_RETRY_AFTER_MS = Number(process.env.WEATHER_LIVE_RETRY_AFTER_SECONDS || 300) * 1000;
const WEATHER_LIVE_RECONCILE_ENABLED = envEnabled("WEATHER_LIVE_RECONCILE_ENABLED", true);
// 是否重试 failed 订单（仅对临时性错误重试，永久性错误如余额不足不重试）
const RETRY_FAILED_ORDERS = envEnabled("WEATHER_LIVE_RETRY_FAILED_ORDERS", true);
// 可重试的临时性错误标记（与 weather_live_order.py 的 RETRYABLE_FAILED_ERROR_MARKERS 保持一致）
const RETRYABLE_FAILED_ERROR_MARKERS = [
  "order_version_mismatch",
  "request exception",
  "500 server error",
  "internal server error",
  "server error",
  "service not ready",
  "timeout",
  "connection",
  "temporarily",
];
// 保底退出时间：北京时间 14:00 后强制退出，避免卡死
const LIVE_LOOP_DEADLINE_MINUTES = Number(process.env.WEATHER_LIVE_LOOP_DEADLINE_MINUTES || 14 * 60);
// 锁文件超时时间：超过此时间认为进程已死，自动失效（10 分钟）
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

function envEnabled(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || `${raw}`.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(`${raw}`.trim().toLowerCase());
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function log(message) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  console.log(`[${ts}] [LIVE-LOOP] ${message}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function pidAlive(pid) {
  if (!pid || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  const existing = readJson(LOCK_PATH);
  if (existing) {
    const pid = Number(existing.pid || 0);
    const startedAt = existing.startedAt ? new Date(existing.startedAt).getTime() : 0;
    const ageMs = Date.now() - startedAt;
    const alive = pidAlive(pid);
    if (alive && ageMs < LOCK_TIMEOUT_MS) {
      log(`already running pid=${pid}, exiting`);
      process.exit(0);
    }
    if (!alive) {
      log(`dead lock detected (pid=${pid} not alive), removing`);
    } else if (ageMs >= LOCK_TIMEOUT_MS) {
      log(`stale lock detected (age=${Math.round(ageMs / 1000)}s), removing`);
    }
    try {
      fs.rmSync(LOCK_PATH, { force: true });
    } catch {}
  }
  writeJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
}

function releaseLock() {
  try {
    const current = readJson(LOCK_PATH);
    if (current && Number(current.pid || 0) === process.pid) {
      fs.rmSync(LOCK_PATH, { force: true });
    }
  } catch {}
}

function getBeijingDate() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function getBeijingMinutes() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  return hour * 60 + minute;
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
  if (record?.orderId) return true;
  if (Array.isArray(record?.orderIds) && record.orderIds.some(Boolean)) return true;
  const attempts = Array.isArray(record?.orderAttempts) ? record.orderAttempts : [];
  return attempts.some((attempt) => {
    const response = attempt?.response && typeof attempt.response === "object" ? attempt.response : {};
    return Boolean(
      attempt?.orderId || response.orderID || response.orderId || response.success === true,
    );
  });
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
  if (numeric(record?.actualBuyCostUsd) > 0 && numeric(record?.actualBuyShares) > 0) return true;
  return (
    fillStatus === "position-detected" &&
    Math.max(numeric(record?.spentUsd), numeric(record?.stakeUsd)) > 0 &&
    numeric(record?.sharesBought) > 0
  );
}

function lastAttemptTime(record) {
  const attempts = Array.isArray(record?.orderAttempts) ? record.orderAttempts : [];
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const raw = lastAttempt?.attemptedAt || record?.lastAttemptAt || record?.placedAt;
  const ts = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

// 判断某条 live order 记录是否还可重试（未完成且可继续尝试）
function isRetryableLiveOrder(record, localDate) {
  if (record?.date !== localDate) return false;
  const status = String(record?.status || "").toLowerCase();
  // failed 单独处理：仅对临时性错误重试，永久性错误（如余额不足）算终态
  if (status === "failed") {
    if (!RETRY_FAILED_ORDERS) return false;
    const errorText = String(record?.error || "").toLowerCase();
    const isTemporary = RETRYABLE_FAILED_ERROR_MARKERS.some((marker) => errorText.includes(marker));
    if (!isTemporary) return false; // 永久性错误，不重试
    if (orderAttemptCount(record) >= WEATHER_LIVE_MAX_ORDER_ATTEMPTS) return false;
    const lastAttempt = lastAttemptTime(record);
    return lastAttempt == null || Date.now() - lastAttempt >= WEATHER_LIVE_RETRY_AFTER_MS;
  }
  if (!["pending", "placing", "no-fill"].includes(status)) return false;
  if (hasConfirmedLiveFill(record)) return false;
  if (hasSubmittedLiveOrder(record)) return false;
  const fillStatus = String(record?.fillStatus || "").toLowerCase();
  if (fillStatus === "price-above-limit" || String(record?.skipReason || "").startsWith("no-price-above-")) {
    return false;
  }
  if (orderAttemptCount(record) >= WEATHER_LIVE_MAX_ORDER_ATTEMPTS) return false;
  const lastAttempt = lastAttemptTime(record);
  return lastAttempt == null || Date.now() - lastAttempt >= WEATHER_LIVE_RETRY_AFTER_MS;
}

// 判断今天白名单城市的 sim candidate 是否已生成（预测进程是否跑完 sim）
function todaySimCandidatesCount(localDate) {
  const all = readJson(SIM_ORDERS_PATH) || [];
  const arr = Array.isArray(all) ? all : [];
  return arr.filter(
    (o) => o?.date === localDate && LIVE_ORDER_CITY_SLUGS.has(String(o?.citySlug || "")),
  ).length;
}

// 判断今天的 live order 是否已全部处理完毕（所有 candidate 都有记录且无可重试）
function isLiveOrderDone(localDate) {
  const candidateCount = todaySimCandidatesCount(localDate);
  if (candidateCount === 0) return false; // sim 还没跑完，不算完成
  const all = readJson(LIVE_ORDERS_PATH) || [];
  const arr = Array.isArray(all) ? all : [];
  const todayWhitelisted = arr.filter(
    (o) => o?.date === localDate && LIVE_ORDER_CITY_SLUGS.has(String(o?.citySlug || "")),
  );
  if (todayWhitelisted.length < candidateCount) return false; // 还有 candidate 没下单
  // 有可重试记录 → 未完成
  return !todayWhitelisted.some((r) => isRetryableLiveOrder(r, localDate));
}

function logChildOutput(label, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  for (const line of trimmed.split(/\r?\n/)) {
    log(`${label}: ${line}`);
  }
}

function runLiveOrderOnce(localDate) {
  log(`running weather_live_order.py date=${localDate}`);
  const result = spawnSync(PYTHON_BIN, [WEATHER_LIVE_ORDER_SCRIPT], {
    cwd: ROOT_DIR,
    env: { ...process.env, WEATHER_LIVE_DATE: localDate },
    encoding: "utf8",
    timeout: LIVE_ORDER_TIMEOUT_MS,
    windowsHide: false,
  });
  logChildOutput("live-order stdout", result.stdout);
  logChildOutput("live-order stderr", result.stderr);
  if (result.error) {
    log(`live order failed: ${result.error.message || result.error}`);
    // 子进程被超时 kill 或 spawn 失败视为临时错误
    return { ok: false, exitCode: null, transient: true };
  }
  log(`live order exited status=${result.status}`);
  // status 0: 成功或全部跳过；1: 一般错误；2: 有临时错误，可重试；3: 永久错误，应退出
  if (result.status === 3) {
    return { ok: false, exitCode: 3, permanent: true };
  }
  if (result.status === 2) {
    return { ok: false, exitCode: 2, transient: true };
  }
  return { ok: result.status === 0, exitCode: result.status };
}

function runReconcileOnce() {
  if (!WEATHER_LIVE_RECONCILE_ENABLED) return;
  const result = spawnSync(PYTHON_BIN, [WEATHER_LIVE_RECONCILE_SCRIPT], {
    cwd: ROOT_DIR,
    env: process.env,
    encoding: "utf8",
    timeout: RECONCILE_TIMEOUT_MS,
    windowsHide: true,
  });
  logChildOutput("live-reconcile stdout", result.stdout);
  logChildOutput("live-reconcile stderr", result.stderr);
  if (result.error) {
    log(`live reconcile failed: ${result.error.message || result.error}`);
  } else if (result.status !== 0) {
    log(`live reconcile exited status=${result.status}`);
  }
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

  const localDate = getBeijingDate();
  log(
    `live order loop started date=${localDate} ` +
      `whitelist=${[...LIVE_ORDER_CITY_SLUGS].join(",")} ` +
      `deadline=${LIVE_ORDER_DEADLINE_HOUR}:00 ` +
      `interval=${LOOP_INTERVAL_MS}ms`,
  );

  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  while (true) {
    const beijingMinutes = getBeijingMinutes();
    // 12:00 截止：不再下当天真实单
    if (beijingMinutes >= LIVE_ORDER_DEADLINE_HOUR * 60) {
      log(`deadline reached beijingMinutes=${beijingMinutes} deadline=${LIVE_ORDER_DEADLINE_HOUR * 60}, exiting`);
      // 截止前最后跑一次 reconcile，确保状态同步
      runReconcileOnce();
      process.exit(0);
    }
    // 保底退出：14:00 强制退出，避免异常卡死
    if (beijingMinutes >= LIVE_LOOP_DEADLINE_MINUTES) {
      log(`hard deadline reached beijingMinutes=${beijingMinutes}, exiting`);
      process.exit(0);
    }

    // 检查 sim candidate 是否已生成（预测进程是否跑完 sim）
    const simCount = todaySimCandidatesCount(localDate);
    if (simCount === 0) {
      log(`no sim candidates yet for ${localDate}, waiting for predict process`);
      // 风险2防护：给预测进程1小时窗口，超过01:00仍无sim候选说明预测失败或当天无单，避免空转到12:00
      if (beijingMinutes >= 60) {
        log(`no sim candidates until 01:00, predict likely failed or no orders today, exiting`);
        process.exit(0);
      }
    } else {
      // 检查是否已完成
      if (isLiveOrderDone(localDate)) {
        log(`live order done for ${localDate}, running final reconcile and exiting`);
        runReconcileOnce();
        process.exit(0);
      }
      // 跑一次下单
      const orderResult = runLiveOrderOnce(localDate);
      // 永久错误：直接退出，避免无意义重试
      if (orderResult.permanent) {
        log(`permanent error detected, exiting`);
        runReconcileOnce();
        process.exit(1);
      }
      if (orderResult.transient || !orderResult.ok) {
        consecutiveFailures += 1;
        log(
          `live order transient/general failure consecutive=${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log(`too many consecutive failures, exiting`);
          runReconcileOnce();
          process.exit(1);
        }
      } else {
        consecutiveFailures = 0;
      }
      // 跑一次 reconcile
      runReconcileOnce();
    }

    // 等待下一轮
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, LOOP_INTERVAL_MS)));
  }
}

main().catch((error) => {
  log(`fatal: ${error?.message || error}`);
  process.exit(1);
});
