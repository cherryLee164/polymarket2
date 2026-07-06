/**
 * Weather Sync 保活检查脚本
 * 用法：由 Windows 计划任务定期调用（每 10 分钟）或登录时调用
 * 逻辑：检查 weather_sync_launcher 是否在运行，若未运行则自动拉起
 *       拉起后等待 8 秒验证进程是否真的存活，失败则重试最多 3 次
 *       若 lock 文件存在但 PID 已死，自动清理 stale lock
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const LAUNCHER_SCRIPT = path.join(ROOT_DIR, "scripts", "weather_sync_launcher.js");
const LAUNCHER_LOCK_PATH = path.join(ROOT_DIR, "data", "locks", "weather-sync-launcher.lock.json");
const NODE_BIN = process.execPath || "node";

// 拉起 launcher 后等待验证的时间（毫秒）
const VERIFY_DELAY_MS = Number(process.env.WEATHER_GUARD_VERIFY_DELAY_MS || 8000);
// 最大重试次数
const MAX_RETRIES = Number(process.env.WEATHER_GUARD_MAX_RETRIES || 3);
// 每次重试之间的间隔（毫秒）
const RETRY_INTERVAL_MS = Number(process.env.WEATHER_GUARD_RETRY_INTERVAL_MS || 5000);

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
  console.log(`[${ts}] [WEATHER-GUARD] ${msg}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    log(`writeJson failed: ${error?.message || error}`);
  }
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLauncherRunning() {
  const lock = readJson(LAUNCHER_LOCK_PATH);
  if (!lock || !lock.pid) return false;
  const alive = pidAlive(lock.pid);
  if (!alive && lock.pid) {
    // PID 已死但 lock 还在 → 清理 stale lock，否则 launcher 会以为有实例在跑而退出
    log(`stale launcher lock detected (pid=${lock.pid} dead), removing`);
    try {
      fs.rmSync(LAUNCHER_LOCK_PATH, { force: true });
    } catch {}
  }
  return alive;
}

function startLauncher() {
  log(`starting weather_sync_launcher: ${LAUNCHER_SCRIPT}`);
  const child = spawn(NODE_BIN, [LAUNCHER_SCRIPT], {
    cwd: ROOT_DIR,
    stdio: "ignore",
    detached: true,
    windowsHide: false,
  });
  child.unref();
  log(`launcher spawned pid=${child.pid}`);
  return child.pid;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWithRetry() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log(`attempt ${attempt}/${MAX_RETRIES}`);
    const pid = startLauncher();

    // 等待 launcher 真正启动并写入 lock 文件
    log(`waiting ${VERIFY_DELAY_MS}ms to verify launcher pid=${pid} is alive...`);
    await sleep(VERIFY_DELAY_MS);

    if (isLauncherRunning()) {
      log(`launcher verified running (pid=${pid})`);
      return true;
    }

    // 验证失败：可能 launcher 启动后立即崩溃（例如 lock 冲突、脚本错误）
    log(`launcher pid=${pid} not running after verify, will retry in ${RETRY_INTERVAL_MS}ms`);

    // 清理可能残留的 stale lock，避免下次重试时 launcher 误判为已有实例
    try {
      fs.rmSync(LAUNCHER_LOCK_PATH, { force: true });
    } catch {}

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_INTERVAL_MS);
    }
  }
  log(`all ${MAX_RETRIES} attempts failed, giving up (will retry on next scheduled run)`);
  return false;
}

async function main() {
  if (isLauncherRunning()) {
    log("launcher already running, skip");
    return;
  }
  log("launcher not running, starting with retry...");
  await startWithRetry();
}

main().catch((error) => {
  log(`fatal: ${error?.message || error}`);
  process.exit(1);
});
