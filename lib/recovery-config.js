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
export const DEFAULT_RECOVERY_ENTRY_LEAD_MINUTES = 60;
export const DEFAULT_RECOVERY_LIMIT_PRICE_CENTS = 40;
export const DEFAULT_RECOVERY_LIMIT_SHARES = 5;
export const RECOVERY_ENTRY_LEAD_MINUTES_MIN = 1;
export const RECOVERY_ENTRY_LEAD_MINUTES_MAX = 240;
export const RECOVERY_LIMIT_PRICE_CENTS_MIN = 1;
export const RECOVERY_LIMIT_PRICE_CENTS_MAX = 99;
export const RECOVERY_LIMIT_SHARES_MIN = 0.01;
export const RECOVERY_LIMIT_SHARES_MAX = 10000;

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

function normalizePositiveNumber(value, fallback, min, max, decimals = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const bounded = Math.min(max, Math.max(min, numeric));
  const factor = 10 ** decimals;
  return Math.round(bounded * factor) / factor;
}

async function envNumber(keys, fallback, min, max, decimals = 2) {
  for (const key of keys) {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && fromProcess !== "") {
      return normalizePositiveNumber(fromProcess, fallback, min, max, decimals);
    }
  }
  for (const fileName of ENV_FILES) {
    try {
      const text = await fs.readFile(path.join(process.cwd(), fileName), "utf8");
      const envValues = parseEnvContent(text);
      for (const key of keys) {
        if (envValues[key] !== undefined && envValues[key] !== "") {
          return normalizePositiveNumber(envValues[key], fallback, min, max, decimals);
        }
      }
    } catch {}
  }
  return fallback;
}

async function defaultRecoveryLimitConfig() {
  const entryLeadMinutes = await envNumber(
    ["RECOVERY_4H_PRESTART_ENTRY_LEAD_MINUTES"],
    DEFAULT_RECOVERY_ENTRY_LEAD_MINUTES,
    RECOVERY_ENTRY_LEAD_MINUTES_MIN,
    RECOVERY_ENTRY_LEAD_MINUTES_MAX,
    0,
  );
  const limitPriceCents = await envNumber(
    ["RECOVERY_4H_LIMIT_PRICE_CENTS", "RECOVERY_4H_THRESHOLD_CENTS", "RECOVERY_THRESHOLD_CENTS"],
    DEFAULT_RECOVERY_LIMIT_PRICE_CENTS,
    RECOVERY_LIMIT_PRICE_CENTS_MIN,
    RECOVERY_LIMIT_PRICE_CENTS_MAX,
    2,
  );
  const limitShares = await envNumber(
    ["RECOVERY_4H_LIMIT_ORDER_SHARES"],
    DEFAULT_RECOVERY_LIMIT_SHARES,
    RECOVERY_LIMIT_SHARES_MIN,
    RECOVERY_LIMIT_SHARES_MAX,
    4,
  );
  const estimatedOrderUsd = Number(((limitPriceCents * limitShares) / 100).toFixed(6));
  return {
    entryLeadMinutes,
    limitPriceCents,
    limitShares,
    estimatedOrderUsd,
  };
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

export function normalizeRecoveryEntryLeadMinutes(
  value,
  fallback = DEFAULT_RECOVERY_ENTRY_LEAD_MINUTES,
) {
  return normalizePositiveNumber(
    value,
    fallback,
    RECOVERY_ENTRY_LEAD_MINUTES_MIN,
    RECOVERY_ENTRY_LEAD_MINUTES_MAX,
    0,
  );
}

export function normalizeRecoveryLimitPriceCents(
  value,
  fallback = DEFAULT_RECOVERY_LIMIT_PRICE_CENTS,
) {
  return normalizePositiveNumber(
    value,
    fallback,
    RECOVERY_LIMIT_PRICE_CENTS_MIN,
    RECOVERY_LIMIT_PRICE_CENTS_MAX,
    2,
  );
}

export function normalizeRecoveryLimitShares(value, fallback = DEFAULT_RECOVERY_LIMIT_SHARES) {
  return normalizePositiveNumber(
    value,
    fallback,
    RECOVERY_LIMIT_SHARES_MIN,
    RECOVERY_LIMIT_SHARES_MAX,
    4,
  );
}

export async function readRecoveryConfig() {
  const fallbackBaseMultiplier = await defaultRecoveryBaseMultiplier();
  const fallbackLimitConfig = await defaultRecoveryLimitConfig();
  try {
    const text = await fs.readFile(CONFIG_PATH, "utf8");
    const payload = JSON.parse(text);
    const baseMultiplier = normalizeRecoveryBaseMultiplier(
      payload?.baseMultiplier,
      fallbackBaseMultiplier,
    );
    const entryLeadMinutes = normalizeRecoveryEntryLeadMinutes(
      payload?.entryLeadMinutes,
      fallbackLimitConfig.entryLeadMinutes,
    );
    const limitPriceCents = normalizeRecoveryLimitPriceCents(
      payload?.limitPriceCents,
      fallbackLimitConfig.limitPriceCents,
    );
    const limitShares = normalizeRecoveryLimitShares(
      payload?.limitShares,
      fallbackLimitConfig.limitShares,
    );
    const estimatedOrderUsd = Number(((limitPriceCents * limitShares) / 100).toFixed(6));
    return {
      strategyType: "fixed-4h-limit-orders",
      entryMode: normalizeRecoveryEntryMode(payload?.entryMode),
      baseMultiplier,
      baseLegUsd: baseMultiplier,
      recoveryLegUsd: baseMultiplier * 2,
      entryLeadMinutes,
      limitPriceCents,
      limitShares,
      estimatedOrderUsd,
      updatedAt: payload?.updatedAt || null,
    };
  } catch {
    return {
      strategyType: "fixed-4h-limit-orders",
      entryMode: DEFAULT_RECOVERY_ENTRY_MODE,
      baseMultiplier: fallbackBaseMultiplier,
      baseLegUsd: fallbackBaseMultiplier,
      recoveryLegUsd: fallbackBaseMultiplier * 2,
      ...fallbackLimitConfig,
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
  const entryLeadMinutes = normalizeRecoveryEntryLeadMinutes(
    input?.entryLeadMinutes ?? current.entryLeadMinutes,
    current.entryLeadMinutes,
  );
  const limitPriceCents = normalizeRecoveryLimitPriceCents(
    input?.limitPriceCents ?? current.limitPriceCents,
    current.limitPriceCents,
  );
  const limitShares = normalizeRecoveryLimitShares(
    input?.limitShares ?? current.limitShares,
    current.limitShares,
  );
  const payload = {
    strategyType: "fixed-4h-limit-orders",
    entryMode,
    baseMultiplier,
    entryLeadMinutes,
    limitPriceCents,
    limitShares,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return readRecoveryConfig();
}
