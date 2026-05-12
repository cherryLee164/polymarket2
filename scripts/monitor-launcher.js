const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const ROOT_DIR = path.resolve(__dirname, '..');
const MONITOR_SCRIPT = path.join(ROOT_DIR, 'scripts', 'monitor.js');

const variants = [
  {
    label: '1H',
    env: {
      MONITOR_VARIANT: '1h',
      MONITOR_WINDOW_HOURS: '1',
      MONITOR_WINDOW_MINUTES: '60',
      SAMPLE_INTERVAL_MS: '5000',
    },
  },
  {
    label: '4H',
    env: {
      MONITOR_VARIANT: '4h',
      MONITOR_WINDOW_HOURS: '4',
      MONITOR_WINDOW_MINUTES: '240',
      SAMPLE_INTERVAL_MS: '15000',
    },
  },
  {
    label: '15M',
    env: {
      MONITOR_VARIANT: '15m',
      MONITOR_WINDOW_HOURS: '0.25',
      MONITOR_WINDOW_MINUTES: '15',
      SAMPLE_INTERVAL_MS: '5000',
    },
  },
];

const children = [];
let shuttingDown = false;

function safeWrite(target, text) {
  try {
    if (!target.destroyed && !target.writableEnded) {
      target.write(text);
    }
  } catch (error) {
    if (error && error.code !== 'EPIPE') {
      throw error;
    }
  }
}

function wireOutput(stream, label, target) {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    safeWrite(target, `[${label}] ${line}\n`);
  });
  rl.on('close', () => {
    safeWrite(target, `[${label}] stream closed\n`);
  });
}

function stopAll(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

function startVariant(variant) {
  const child = spawn(process.execPath, [MONITOR_SCRIPT], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...variant.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  child.__label = variant.label;
  children.push(child);

  wireOutput(child.stdout, variant.label, process.stdout);
  wireOutput(child.stderr, variant.label, process.stderr);

  child.on('exit', (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    safeWrite(process.stderr, `[${variant.label}] exited with ${detail}\n`);
    if (!shuttingDown) {
      stopAll('SIGINT');
      process.exitCode = code || 1;
    }
  });
}

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

for (const variant of variants) {
  startVariant(variant);
}

process.on('SIGINT', () => {
  stopAll('SIGINT');
});

process.on('SIGTERM', () => {
  stopAll('SIGTERM');
});
