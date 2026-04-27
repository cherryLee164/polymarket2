import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";

const ROOT_DIR = process.cwd();
const LOCKS_DIR = path.join(ROOT_DIR, "data", "locks");
const MONITOR_LOGS_DIR = path.join(ROOT_DIR, "data", "monitor_logs");
const ORDERS_RECOVERY_DIR = path.join(ROOT_DIR, "data", "orders_recovery");
const WEATHER_DATA_DIR = path.join(ROOT_DIR, "data", "weather_predictions");
const MONITOR_VARIANTS = ["5m", "15m", "1h", "4h"];

const MATCHERS = {
  monitorLauncher: ["scripts[\\\\/]monitor-launcher\\.js"],
  monitorWorker: ["scripts[\\\\/]monitor\\.js"],
  recoveryLauncher: ["scripts[\\\\/]order_recovery_launcher\\.js"],
  recoveryWorker: ["scripts[\\\\/]order_recovery\\.py"],
  weatherLauncher: ["scripts[\\\\/]weather_sync_launcher\\.js"],
  weatherWorker: ["scripts[\\\\/]weather_sync\\.js"],
};

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
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockStatus(filePath) {
  const payload = readJson(filePath);
  const pid = Number(payload?.pid || 0);
  return {
    filePath,
    exists: Boolean(payload),
    pid: Number.isInteger(pid) ? pid : null,
    alive: pidAlive(pid),
    startedAt: payload?.startedAt || null,
  };
}

function removeFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function runPowerShell(command, capture = false) {
  return execFileSync("powershell", ["-NoProfile", "-Command", command], {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    windowsHide: true,
    encoding: capture ? "utf8" : undefined,
  });
}

function listMatchingProcesses(matchers) {
  const patterns = (Array.isArray(matchers) ? matchers : [])
    .map((item) => `'${escapePowerShellSingleQuoted(item)}'`)
    .join(", ");
  const command = [
    `$patterns = @(${patterns});`,
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    "  $cmd = [string]($_.CommandLine);",
    "  $cmd -and (($patterns | Where-Object { $cmd -match $_ }).Count -gt 0)",
    "} | Select-Object ProcessId, Name, CommandLine;",
    "if ($targets) { $targets | ConvertTo-Json -Compress } else { '[]' }",
  ].join(" ");

  try {
    const output = String(runPowerShell(command, true) || "").trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function stopMatchingProcesses(matchers) {
  const patterns = (Array.isArray(matchers) ? matchers : [])
    .map((item) => `'${escapePowerShellSingleQuoted(item)}'`)
    .join(", ");
  const command = [
    `$patterns = @(${patterns});`,
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    "  $cmd = [string]($_.CommandLine);",
    "  $cmd -and (($patterns | Where-Object { $cmd -match $_ }).Count -gt 0)",
    "};",
    "foreach ($target in $targets) {",
    "  try { Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop } catch {}",
    "}",
    "Start-Sleep -Milliseconds 500;",
  ].join(" ");
  runPowerShell(command, false);
}

function buildStateLabel(state) {
  if (state === "running") {
    return "运行中";
  }
  if (state === "partial") {
    return "部分运行";
  }
  return "已暂停";
}

function buildMonitorLockPath(variant) {
  return path.join(LOCKS_DIR, `monitor-${variant}.lock`);
}

function getMonitorStatuses() {
  const workerCount = listMatchingProcesses(MATCHERS.monitorWorker).length;
  return MONITOR_VARIANTS.map((variant, index) => {
    const lockStatus = readLockStatus(buildMonitorLockPath(variant));
    return {
      variant,
      ...lockStatus,
      processDetected: index < workerCount,
      running: lockStatus.alive || index < workerCount,
    };
  });
}

export function getBtcServiceStatus() {
  const monitorStatuses = getMonitorStatuses();
  const monitorLauncherCount = listMatchingProcesses(MATCHERS.monitorLauncher).length;
  const recoveryLauncherCount = listMatchingProcesses(MATCHERS.recoveryLauncher).length;
  const recoveryWorkerCount = listMatchingProcesses(MATCHERS.recoveryWorker).length;
  const runningCount = monitorStatuses.filter((item) => item.running).length;
  const recoveryLauncherLock = readLockStatus(path.join(LOCKS_DIR, "order-recovery-launcher.lock.json"));
  const recoveryWorkerLock = readLockStatus(path.join(LOCKS_DIR, "order-recovery-4h.lock.json"));

  let state = "stopped";
  if (runningCount >= monitorStatuses.length && recoveryWorkerCount > 0) {
    state = "running";
  } else if (
    runningCount > 0 ||
    monitorLauncherCount > 0 ||
    recoveryLauncherCount > 0 ||
    recoveryWorkerCount > 0 ||
    recoveryLauncherLock.alive ||
    recoveryWorkerLock.alive
  ) {
    state = "partial";
  }

  return {
    state,
    label: buildStateLabel(state),
    detail: `监控 ${runningCount}/${monitorStatuses.length}，4小时下单${recoveryWorkerCount > 0 ? "已启动" : "已暂停"}`,
    monitor: {
      expectedCount: monitorStatuses.length,
      runningCount,
      launcherCount: monitorLauncherCount,
      workerCount: listMatchingProcesses(MATCHERS.monitorWorker).length,
      variants: monitorStatuses,
    },
    recovery: {
      launcherRunning: recoveryLauncherLock.alive || recoveryLauncherCount > 0,
      workerRunning: recoveryWorkerLock.alive || recoveryWorkerCount > 0,
      launcherCount: recoveryLauncherCount,
      workerCount: recoveryWorkerCount,
    },
  };
}

export function getWeatherServiceStatus() {
  const launcherLock = readLockStatus(path.join(LOCKS_DIR, "weather-sync-launcher.lock.json"));
  const workerLock = readLockStatus(path.join(LOCKS_DIR, "weather-sync.lock.json"));
  const launcherCount = listMatchingProcesses(MATCHERS.weatherLauncher).length;
  const workerCount = listMatchingProcesses(MATCHERS.weatherWorker).length;

  let state = "stopped";
  if (launcherCount > 0 && workerCount > 0) {
    state = "running";
  } else if (launcherCount > 0 || workerCount > 0 || launcherLock.alive || workerLock.alive) {
    state = "partial";
  }

  return {
    state,
    label: buildStateLabel(state),
    detail: `天气同步${workerCount > 0 ? "已启动" : "已暂停"}`,
    launcherRunning: launcherLock.alive || launcherCount > 0,
    workerRunning: workerLock.alive || workerCount > 0,
    launcherCount,
    workerCount,
  };
}

function stopBtcOrderServices() {
  stopMatchingProcesses([...MATCHERS.recoveryLauncher, ...MATCHERS.recoveryWorker]);
  removeFiles([
    path.join(LOCKS_DIR, "order-recovery-launcher.lock.json"),
    path.join(LOCKS_DIR, "order-recovery-4h.lock.json"),
  ]);
}

export function ensureBtcMonitorServices() {
  const monitorStatuses = getMonitorStatuses();
  const monitorLauncherCount = listMatchingProcesses(MATCHERS.monitorLauncher).length;
  const monitorWorkerCount = listMatchingProcesses(MATCHERS.monitorWorker).length;
  const runningCount = monitorStatuses.filter((item) => item.running).length;

  if (monitorLauncherCount > 0 || monitorWorkerCount > 0 || runningCount > 0) {
    return getBtcServiceStatus();
  }

  ensureDir(MONITOR_LOGS_DIR);
  const monitorOut = path.join(MONITOR_LOGS_DIR, "launcher.out.log");
  const monitorErr = path.join(MONITOR_LOGS_DIR, "launcher.err.log");
  const command = [
    `$root='${escapePowerShellSingleQuoted(ROOT_DIR)}';`,
    `Start-Process -FilePath 'node' -ArgumentList 'scripts/monitor-launcher.js' -WorkingDirectory $root -RedirectStandardOutput '${escapePowerShellSingleQuoted(monitorOut)}' -RedirectStandardError '${escapePowerShellSingleQuoted(monitorErr)}' -WindowStyle Hidden;`,
    "Start-Sleep -Milliseconds 800;",
  ].join(" ");
  runPowerShell(command, false);
  return getBtcServiceStatus();
}

export function stopBtcServices() {
  stopBtcOrderServices();
  return getBtcServiceStatus();
}

export function startBtcServices() {
  ensureBtcMonitorServices();
  stopBtcOrderServices();
  ensureDir(ORDERS_RECOVERY_DIR);
  const recoveryOut = path.join(ORDERS_RECOVERY_DIR, "launcher.out.log");
  const recoveryErr = path.join(ORDERS_RECOVERY_DIR, "launcher.err.log");
  const command = [
    `$root='${escapePowerShellSingleQuoted(ROOT_DIR)}';`,
    `Start-Process -FilePath 'node' -ArgumentList 'scripts/order_recovery_launcher.js' -WorkingDirectory $root -RedirectStandardOutput '${escapePowerShellSingleQuoted(recoveryOut)}' -RedirectStandardError '${escapePowerShellSingleQuoted(recoveryErr)}' -WindowStyle Hidden;`,
    "Start-Sleep -Milliseconds 800;",
  ].join(" ");
  runPowerShell(command, false);
  return getBtcServiceStatus();
}

export function stopWeatherService() {
  stopMatchingProcesses([...MATCHERS.weatherLauncher, ...MATCHERS.weatherWorker]);
  removeFiles([
    path.join(LOCKS_DIR, "weather-sync-launcher.lock.json"),
    path.join(LOCKS_DIR, "weather-sync.lock.json"),
  ]);
  return getWeatherServiceStatus();
}

export function startWeatherService() {
  stopWeatherService();
  ensureDir(WEATHER_DATA_DIR);
  const weatherOut = path.join(WEATHER_DATA_DIR, "launcher.out.log");
  const weatherErr = path.join(WEATHER_DATA_DIR, "launcher.err.log");
  const command = [
    `$root='${escapePowerShellSingleQuoted(ROOT_DIR)}';`,
    `Start-Process -FilePath 'node' -ArgumentList 'scripts/weather_sync_launcher.js' -WorkingDirectory $root -RedirectStandardOutput '${escapePowerShellSingleQuoted(weatherOut)}' -RedirectStandardError '${escapePowerShellSingleQuoted(weatherErr)}' -WindowStyle Hidden;`,
    "Start-Sleep -Milliseconds 800;",
  ].join(" ");
  runPowerShell(command, false);
  return getWeatherServiceStatus();
}
