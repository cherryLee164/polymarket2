// 实盘下单进程 launcher：spawn weather_live_order_loop.js，子进程退出后自己也退出。
// 与 weather_sync_launcher.js 独立，互不影响。由 schtasks 在 00:00 拉起。

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const NODE_BIN = process.execPath || "node";
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "weather_live_order_loop.js");
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const LOCK_PATH = path.join(LOCKS_DIR, "weather-live-order-launcher.lock.json");

let child = null;
let shuttingDown = false;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
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

const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

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
      process.stderr.write(`weather live order launcher already running (pid=${pid}), exiting\n`);
      process.exit(0);
    }
    // PID 已死或锁已超时：清理残留 lock，避免子进程崩溃后无法重启
    if (!alive) {
      process.stderr.write(`dead launcher lock detected (pid=${pid} not alive), removing\n`);
    } else if (ageMs >= LOCK_TIMEOUT_MS) {
      process.stderr.write(`stale launcher lock detected (age=${Math.round(ageMs / 1000)}s), removing\n`);
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

function safeWrite(stream, text) {
  try {
    if (!stream.destroyed && !stream.writableEnded) {
      stream.write(text);
    }
  } catch (error) {
    if (!error || error.code !== "EPIPE") throw error;
  }
}

function wireOutput(stream, label, target) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => safeWrite(target, `[${label}] ${line}\n`));
  rl.on("close", () => safeWrite(target, `[${label}] stream closed\n`));
}

function startWorker() {
  child = spawn(NODE_BIN, [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  wireOutput(child.stdout, "LIVE-ORDER", process.stdout);
  wireOutput(child.stderr, "LIVE-ORDER", process.stderr);

  child.on("exit", (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    safeWrite(process.stderr, `[LIVE-ORDER] exited with ${detail}\n`);
    child = null;
    // 下单进程完成后直接退出，不再自动重启（由 schtasks 在 00:00 重新拉起）
    if (!shuttingDown) {
      safeWrite(process.stderr, `[LIVE-ORDER] live order process finished, launcher exiting\n`);
      releaseLock();
      process.exit(0);
    }
  });
}

function stopAll(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill(signal);
  }
  releaseLock();
}

for (const envName of [".env", ".env.local", ".env.order", ".env.order.local"]) {
  loadEnvFile(path.join(ROOT_DIR, envName));
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

acquireLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

startWorker();
