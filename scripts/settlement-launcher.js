const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const ROOT_DIR = path.resolve(__dirname, "..");
const SETTLEMENT_SCRIPT = path.join(ROOT_DIR, "scripts", "auto_redeem.py");
const PYTHON_BIN = process.env.PYTHON || "python";
const RESTART_DELAY_MS = Number(
  process.env.SETTLEMENT_LAUNCHER_RESTART_DELAY_MS ||
    process.env.ORDER_LAUNCHER_RESTART_DELAY_MS ||
    5000,
);

let child = null;
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

function stopChild(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill(signal);
  }
}

function startWorker() {
  child = spawn(PYTHON_BIN, ["-u", SETTLEMENT_SCRIPT], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ORDER_SETTLEMENT_IDLE_INTERVAL_MS:
        process.env.ORDER_SETTLEMENT_IDLE_INTERVAL_MS || "300000",
      ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS:
        process.env.ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS || "300000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  wireOutput(child.stdout, "SETTLE", process.stdout);
  wireOutput(child.stderr, "SETTLE", process.stderr);

  child.on("exit", (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    safeWrite(process.stderr, `[SETTLE] exited with ${detail}\n`);
    child = null;
    if (!shuttingDown) {
      safeWrite(
        process.stderr,
        `[SETTLE] restarting in ${Math.round(RESTART_DELAY_MS / 1000)}s\n`,
      );
      setTimeout(() => {
        if (!shuttingDown && !child) {
          startWorker();
        }
      }, RESTART_DELAY_MS);
    }
  });
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

startWorker();

process.on("SIGINT", () => {
  stopChild("SIGINT");
});

process.on("SIGTERM", () => {
  stopChild("SIGTERM");
});
