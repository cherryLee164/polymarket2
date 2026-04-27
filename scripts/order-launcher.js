const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const fs = require("fs");

const ROOT_DIR = path.resolve(__dirname, "..");
const ORDER_SCRIPT = path.join(ROOT_DIR, "scripts", "order.py");
const PYTHON_BIN = process.env.PYTHON || "python";
const RESTART_DELAY_MS = Number(process.env.ORDER_LAUNCHER_RESTART_DELAY_MS || 5000);

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

for (const envName of [".env.order.local", ".env.order", ".env.local", ".env"]) {
  loadEnvFile(path.join(ROOT_DIR, envName));
}

const ENABLE_4H = ["1", "true", "yes", "on"].includes(
  String(process.env.ORDER_4H_TRADING_ENABLED || "false").trim().toLowerCase(),
);

const variants = [
  {
    label: "1H",
    script: ORDER_SCRIPT,
    args: ["-u", ORDER_SCRIPT],
    env: {
      ORDER_VARIANT: "1h",
      ORDER_DRY_RUN: "true",
    },
  },
];

if (ENABLE_4H) {
  variants.push({
    label: "4H",
    script: ORDER_SCRIPT,
    args: ["-u", ORDER_SCRIPT],
    env: {
      ORDER_VARIANT: "4h",
      ORDER_DRY_RUN: "false",
    },
  });
}

const children = new Map();
let shuttingDown = false;

function safeWrite(target, text) {
  try {
    if (!target.destroyed && !target.writableEnded) {
      target.write(text);
    }
  } catch (error) {
    if (error && error.code !== "EPIPE") {
      throw error;
    }
  }
}

function wireOutput(stream, label, target) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    safeWrite(target, `[${label}] ${line}\n`);
  });
  rl.on("close", () => {
    safeWrite(target, `[${label}] stream closed\n`);
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
}

function startVariant(variant) {
  const child = spawn(PYTHON_BIN, variant.args || ["-u", variant.script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...variant.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  children.set(variant.label, child);
  wireOutput(child.stdout, variant.label, process.stdout);
  wireOutput(child.stderr, variant.label, process.stderr);

  child.on("exit", (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    safeWrite(process.stderr, `[${variant.label}] exited with ${detail}\n`);
    if (children.get(variant.label) === child) {
      children.delete(variant.label);
    }
    if (!shuttingDown) {
      safeWrite(
        process.stderr,
        `[${variant.label}] restarting in ${Math.round(RESTART_DELAY_MS / 1000)}s\n`,
      );
      setTimeout(() => {
        if (!shuttingDown && !children.has(variant.label)) {
          startVariant(variant);
        }
      }, RESTART_DELAY_MS);
    }
  });
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

for (const variant of variants) {
  startVariant(variant);
}

process.on("SIGINT", () => {
  stopAll("SIGINT");
});

process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});
