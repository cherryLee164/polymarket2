const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const PYTHON_BIN = process.env.PYTHON || "python";
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "order_recovery.py");
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const LOCK_PATH = path.join(LOCKS_DIR, "order-recovery-launcher.lock.json");
const RESTART_DELAY_MS = Number(process.env.RECOVERY_LAUNCHER_RESTART_DELAY_MS || 5000);

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
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }
    const existing = process.env[key];
    if (existing != null && `${existing}`.trim() !== "") {
      continue;
    }
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "" && existing != null) {
      continue;
    }
    process.env[key] = value;
  }
}

for (const envName of [
  ".env.order.recovery.local",
  ".env.order.recovery",
  ".env.order.local",
  ".env.order",
  ".env.local",
  ".env",
]) {
  loadEnvFile(path.join(ROOT_DIR, envName));
}

function envEnabled(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || `${raw}`.trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(`${raw}`.trim().toLowerCase());
}

const variants = [
  { id: "1h", label: "1H-RECOVERY", enabled: envEnabled("RECOVERY_1H_ENABLED", true) },
  { id: "4h", label: "4H-RECOVERY", enabled: envEnabled("RECOVERY_4H_ENABLED", true) },
].filter((variant) => variant.enabled);

const children = new Map();
let shuttingDown = false;

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
    process.stderr.write(`recovery launcher already running (pid=${existing.pid}), exiting\n`);
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

function startVariant(variant) {
  const child = spawn(PYTHON_BIN, ["-u", SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      RECOVERY_VARIANT: variant.id,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  children.set(variant.id, child);
  wireOutput(child.stdout, variant.label, process.stdout);
  wireOutput(child.stderr, variant.label, process.stderr);

  child.on("exit", (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    safeWrite(process.stderr, `[${variant.label}] exited with ${detail}\n`);
    if (children.get(variant.id) === child) {
      children.delete(variant.id);
    }
    if (!shuttingDown) {
      setTimeout(() => {
        if (!shuttingDown && !children.has(variant.id)) {
          startVariant(variant);
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
  for (const child of children.values()) {
    if (child && !child.killed) {
      child.kill(signal);
    }
  }
  releaseLock();
}

acquireLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

if (!variants.length) {
  safeWrite(process.stderr, "[RECOVERY] no enabled variants, exiting\n");
  releaseLock();
  process.exit(0);
}

for (const variant of variants) {
  startVariant(variant);
}
