const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const PYTHON_BIN = process.env.PYTHON || "python";
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "auto_redeem.py");
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const LOCK_PATH = path.join(LOCKS_DIR, "settlement-recovery-launcher.lock.json");
const RESTART_DELAY_MS = Number(process.env.RECOVERY_SETTLEMENT_RESTART_DELAY_MS || 5000);
const RUN_ONCE = process.argv.includes("--once");
const DEFAULT_SETTLEMENT_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_SELLS_PER_RUN = 50;
const DEFAULT_REDEEM_SLUG_PREFIXES = [
  "bitcoin-up-or-down-",
  "btc-updown-",
  "highest-temperature-in-",
].join(",");

let child = null;
let shuttingDown = false;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
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
  const existing = readJson(LOCK_PATH);
  if (existing && pidAlive(Number(existing.pid || 0))) {
    process.stderr.write(`recovery settlement launcher already running (pid=${existing.pid}), exiting\n`);
    process.exit(0);
  }
  writeJson(LOCK_PATH, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
}

function releaseLock() {
  try {
    const current = readJson(LOCK_PATH);
    if (current && Number(current.pid || 0) === process.pid) {
      fs.rmSync(LOCK_PATH, { force: true });
    }
  } catch {}
}

function safeWrite(stream, text) {
  try {
    if (!stream.destroyed && !stream.writableEnded) {
      stream.write(text);
    }
  } catch (error) {
    if (!error || error.code !== "EPIPE") {
      throw error;
    }
  }
}

function wireOutput(stream, label, target) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => safeWrite(target, `[${label}] ${line}\n`));
  rl.on("close", () => safeWrite(target, `[${label}] stream closed\n`));
}

function buildSettlementEnv() {
  return {
    ...process.env,
    ORDER_SETTLEMENT_IDLE_INTERVAL_MS: String(
      process.env.SETTLEMENT_IDLE_INTERVAL_MS ||
        process.env.SETTLEMENT_INTERVAL_MS ||
        DEFAULT_SETTLEMENT_INTERVAL_MS,
    ),
    ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS: String(
      process.env.SETTLEMENT_ACTIVE_INTERVAL_MS ||
        process.env.SETTLEMENT_INTERVAL_MS ||
        DEFAULT_SETTLEMENT_INTERVAL_MS,
    ),
    ORDER_AUTO_REDEEM_DATA_DIR: String(
      process.env.SETTLEMENT_DATA_DIR ||
        path.join(ROOT_DIR, "data", "orders_recovery", "redeems"),
    ),
    ORDER_AUTO_REDEEM_TRACKED_ONLY: String(
      process.env.SETTLEMENT_TRACKED_ONLY || "true",
    ),
    ORDER_AUTO_REDEEM_TRACK_SOURCE: String(
      process.env.SETTLEMENT_TRACK_SOURCE || "all",
    ),
    ORDER_AUTO_REDEEM_SLUG_PREFIXES: String(
      process.env.SETTLEMENT_SLUG_PREFIXES || DEFAULT_REDEEM_SLUG_PREFIXES,
    ),
    ORDER_AUTO_SELL_ENABLED: String(
      process.env.SETTLEMENT_AUTO_SELL_ENABLED || "true",
    ),
    ORDER_AUTO_SELL_SLUG_PREFIXES: String(
      process.env.SETTLEMENT_AUTO_SELL_SLUG_PREFIXES ||
        process.env.SETTLEMENT_SLUG_PREFIXES ||
        DEFAULT_REDEEM_SLUG_PREFIXES,
    ),
    ORDER_AUTO_CLAIM_ENABLED: String(
      process.env.SETTLEMENT_AUTO_CLAIM_ENABLED || "true",
    ),
    ORDER_SETTLEMENT_MAX_SELLS_PER_RUN: String(
      process.env.SETTLEMENT_MAX_SELLS_PER_RUN || DEFAULT_MAX_SELLS_PER_RUN,
    ),
    ORDER_SETTLEMENT_MAX_CLAIMS_PER_RUN: String(
      process.env.SETTLEMENT_MAX_CLAIMS_PER_RUN ||
        process.env.RECOVERY_SETTLEMENT_MAX_CLAIMS_PER_RUN ||
        50,
    ),
  };
}

function runOnce() {
  const result = spawnSync(PYTHON_BIN, ["-u", SCRIPT_PATH, "--once"], {
    cwd: ROOT_DIR,
    env: buildSettlementEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: Number(process.env.SETTLEMENT_ONCE_TIMEOUT_MS || 10 * 60 * 1000),
    windowsHide: false,
  });
  if (result.stdout?.trim()) {
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      safeWrite(process.stdout, `[SETTLEMENT] ${line}\n`);
    }
  }
  if (result.stderr?.trim()) {
    for (const line of result.stderr.trim().split(/\r?\n/)) {
      safeWrite(process.stderr, `[SETTLEMENT] ${line}\n`);
    }
  }
  if (result.error) {
    safeWrite(process.stderr, `[SETTLEMENT] failed: ${result.error.message || result.error}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status || 0;
}

function startWorker() {
  child = spawn(PYTHON_BIN, ["-u", SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: buildSettlementEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  wireOutput(child.stdout, "RECOVERY-SETTLEMENT", process.stdout);
  wireOutput(child.stderr, "RECOVERY-SETTLEMENT", process.stderr);

  child.on("exit", (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    safeWrite(process.stderr, `[RECOVERY-SETTLEMENT] exited with ${detail}\n`);
    child = null;
    if (!shuttingDown) {
      setTimeout(() => {
        if (!shuttingDown && !child) {
          startWorker();
        }
      }, RESTART_DELAY_MS);
    }
  });
}

function stopAll(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill(signal);
  }
  releaseLock();
}

for (const envName of [
  ".env",
  ".env.local",
  ".env.order",
  ".env.order.local",
  ".env.order.recovery",
  ".env.order.recovery.local",
]) {
  loadEnvFile(path.join(ROOT_DIR, envName));
}

acquireLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

if (RUN_ONCE) {
  runOnce();
  releaseLock();
} else {
  startWorker();
}
