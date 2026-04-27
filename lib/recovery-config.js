import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data", "orders_recovery");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ENV_FILES = [
  ".env.order.recovery.local",
  ".env.order.recovery",
  ".env.order.local",
  ".env.order",
  ".env.local",
  ".env",
];

export const RECOVERY_ENTRY_MODES = ["limit-pair", "trigger-threshold"];
export const DEFAULT_RECOVERY_ENTRY_MODE = "limit-pair";
export const RECOVERY_BASE_MULTIPLIER_MIN = 1;
export const RECOVERY_BASE_MULTIPLIER_MAX = 5;

function parseEnvContent(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function normalizeEnvBaseMultiplier(value) {
  const variantValue = Number(process.env.RECOVERY_4H_BASE_LEG_USD);
  const genericValue = Number(process.env.RECOVERY_BASE_LEG_USD);
  if (Number.isFinite(variantValue) && variantValue >= RECOVERY_BASE_MULTIPLIER_MIN) {
    return Math.min(RECOVERY_BASE_MULTIPLIER_MAX, Math.round(variantValue));
  }
  if (Number.isFinite(genericValue) && genericValue >= RECOVERY_BASE_MULTIPLIER_MIN) {
    return Math.min(RECOVERY_BASE_MULTIPLIER_MAX, Math.round(genericValue));
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < RECOVERY_BASE_MULTIPLIER_MIN) {
    return null;
  }
  return Math.min(RECOVERY_BASE_MULTIPLIER_MAX, Math.round(numeric));
}

async function defaultRecoveryBaseMultiplier() {
  const envBaseMultiplier = normalizeEnvBaseMultiplier();
  if (envBaseMultiplier) {
    return envBaseMultiplier;
  }
  for (const fileName of ENV_FILES) {
    try {
      const text = await fs.readFile(path.join(process.cwd(), fileName), "utf8");
      const envValues = parseEnvContent(text);
      const variantValue = normalizeEnvBaseMultiplier(envValues.RECOVERY_4H_BASE_LEG_USD);
      if (variantValue) {
        return variantValue;
      }
      const genericValue = normalizeEnvBaseMultiplier(envValues.RECOVERY_BASE_LEG_USD);
      if (genericValue) {
        return genericValue;
      }
    } catch {}
  }
  return 1;
}

export function normalizeRecoveryEntryMode(value) {
  const text = String(value || "").trim().toLowerCase();
  return RECOVERY_ENTRY_MODES.includes(text) ? text : DEFAULT_RECOVERY_ENTRY_MODE;
}

export function normalizeRecoveryBaseMultiplier(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const rounded = Math.round(numeric);
  if (rounded < RECOVERY_BASE_MULTIPLIER_MIN || rounded > RECOVERY_BASE_MULTIPLIER_MAX) {
    return fallback;
  }
  return rounded;
}

export async function readRecoveryConfig() {
  const fallbackBaseMultiplier = await defaultRecoveryBaseMultiplier();
  try {
    const text = await fs.readFile(CONFIG_PATH, "utf8");
    const payload = JSON.parse(text);
    const baseMultiplier = normalizeRecoveryBaseMultiplier(
      payload?.baseMultiplier,
      fallbackBaseMultiplier,
    );
    return {
      entryMode: normalizeRecoveryEntryMode(payload?.entryMode),
      baseMultiplier,
      baseLegUsd: baseMultiplier,
      recoveryLegUsd: baseMultiplier * 2,
      updatedAt: payload?.updatedAt || null,
    };
  } catch {
    return {
      entryMode: DEFAULT_RECOVERY_ENTRY_MODE,
      baseMultiplier: fallbackBaseMultiplier,
      baseLegUsd: fallbackBaseMultiplier,
      recoveryLegUsd: fallbackBaseMultiplier * 2,
      updatedAt: null,
    };
  }
}

export async function writeRecoveryConfig(input = {}) {
  const current = await readRecoveryConfig();
  const entryMode = normalizeRecoveryEntryMode(input?.entryMode ?? current.entryMode);
  const baseMultiplier = normalizeRecoveryBaseMultiplier(
    input?.baseMultiplier ?? current.baseMultiplier,
    current.baseMultiplier,
  );
  const payload = {
    entryMode,
    baseMultiplier,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return readRecoveryConfig();
}
