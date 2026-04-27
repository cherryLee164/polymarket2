const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const PYTHON_BIN = process.env.PYTHON || "python";
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "auto_redeem.py");
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const LOCK_PATH = path.join(LOCKS_DIR, "weather-settlement.lock.json");
const DATA_DIR = path.join(ROOT_DIR, "data", "weather_predictions", "redeems");
const START_HOUR = Number(process.env.WEATHER_SETTLEMENT_START_HOUR || 16);
const INTERVAL_MS = Number(process.env.WEATHER_SETTLEMENT_INTERVAL_MS || 2 * 60 * 60 * 1000);
const TZ = "Asia/Shanghai";
const RUN_ONCE = process.argv.includes("--once");

let shuttingDown = false;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    if (!key || (process.env[key] != null && `${process.env[key]}`.trim() !== "")) {
      continue;
    }
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

for (const envName of [".env.order.local", ".env.order", ".env.local", ".env"]) {
  loadEnvFile(path.join(ROOT_DIR, envName));
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
  ensureDir(LOCKS_DIR);
  const current = readJson(LOCK_PATH);
  if (current && pidAlive(Number(current.pid || 0))) {
    console.error(`weather settlement already running pid=${current.pid}`);
    process.exit(0);
  }
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

function formatLocal(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(",", "");
}

function localParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
}

function msUntilNextStart(date) {
  const parts = localParts(date);
  const hour = Number(parts.hour);
  if (hour >= START_HOUR) {
    return 0;
  }
  const currentUtcMs = date.getTime();
  const targetUtcGuess = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    START_HOUR - 8,
    0,
    0,
    0,
  );
  return Math.max(60 * 1000, targetUtcGuess - currentUtcMs);
}

function log(message) {
  console.log(`[${formatLocal(new Date())} ${TZ}] [WEATHER-SETTLEMENT] ${message}`);
}

function runOnce() {
  ensureDir(DATA_DIR);
  const result = spawnSync(PYTHON_BIN, ["-u", SCRIPT_PATH, "--once"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ORDER_DRY_RUN: "false",
      ORDER_AUTO_REDEEM_DATA_DIR: DATA_DIR,
      ORDER_AUTO_REDEEM_TRACKED_ONLY: "false",
      ORDER_AUTO_REDEEM_TRACK_SOURCE: "weather",
      ORDER_AUTO_REDEEM_SLUG_PREFIXES: "highest-temperature-in-",
      ORDER_AUTO_SELL_ENABLED: "false",
      ORDER_AUTO_CLAIM_ENABLED: "true",
      ORDER_AUTO_REDEEM_ENABLED: "true",
      ORDER_SETTLEMENT_MAX_CLAIMS_PER_RUN: process.env.WEATHER_SETTLEMENT_MAX_CLAIMS_PER_RUN || "50",
      ORDER_SETTLEMENT_MAX_SELLS_PER_RUN: "0",
    },
    encoding: "utf8",
    timeout: Number(process.env.WEATHER_SETTLEMENT_TIMEOUT_MS || 10 * 60 * 1000),
    windowsHide: false,
  });
  if (result.stdout?.trim()) {
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      log(`stdout: ${line}`);
    }
  }
  if (result.stderr?.trim()) {
    for (const line of result.stderr.trim().split(/\r?\n/)) {
      log(`stderr: ${line}`);
    }
  }
  if (result.error) {
    log(`run failed: ${result.error.message || result.error}`);
  } else {
    log(`run exited status=${result.status}`);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(1000, ms)));
}

async function main() {
  acquireLock();
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    shuttingDown = true;
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shuttingDown = true;
    releaseLock();
    process.exit(0);
  });

  log(`started mode=${RUN_ONCE ? "once" : "loop"} startHour=${START_HOUR}:00 interval=${Math.round(INTERVAL_MS / 60000)}m`);
  if (RUN_ONCE) {
    const waitMs = msUntilNextStart(new Date());
    if (waitMs > 0) {
      log(`before ${START_HOUR}:00, skip one-shot settlement`);
      return;
    }
    runOnce();
    return;
  }

  while (!shuttingDown) {
    const waitMs = msUntilNextStart(new Date());
    if (waitMs > 0) {
      log(`before ${START_HOUR}:00, next scan in ${Math.round(waitMs / 60000)}m`);
      await sleep(waitMs);
      continue;
    }
    runOnce();
    await sleep(INTERVAL_MS);
  }
}

main().catch((error) => {
  log(`fatal: ${error?.message || error}`);
  process.exit(1);
});
