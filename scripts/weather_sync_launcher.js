const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const NODE_BIN = process.execPath || "node";
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "weather_sync.js");
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const LOCK_PATH = path.join(LOCKS_DIR, "weather-sync-launcher.lock.json");
const RESTART_DELAY_MS = Number(process.env.WEATHER_SYNC_LAUNCHER_RESTART_DELAY_MS || 5000);

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
    process.stderr.write(`weather sync launcher already running (pid=${existing.pid}), exiting\n`);
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

function startWorker() {
  child = spawn(NODE_BIN, [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  wireOutput(child.stdout, "WEATHER", process.stdout);
  wireOutput(child.stderr, "WEATHER", process.stderr);

  child.on("exit", (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    safeWrite(process.stderr, `[WEATHER] exited with ${detail}\n`);
    child = null;
    if (!shuttingDown) {
      safeWrite(
        process.stderr,
        `[WEATHER] restarting in ${Math.round(RESTART_DELAY_MS / 1000)}s\n`,
      );
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
]) {
  loadEnvFile(path.join(ROOT_DIR, envName));
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

acquireLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

startWorker();
