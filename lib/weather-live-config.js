import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data", "weather_predictions");
const WEATHER_CONFIG_PATH = path.join(DATA_DIR, "config.json");

export const WEATHER_LIVE_BASE_STAKE_OPTIONS = [1, 2, 3, 4, 5];
export const DEFAULT_WEATHER_LIVE_BASE_STAKE = 1;
// 旧序列: [1, 2, 2, 2, 3] — 递进翻倍模式，已暂停使用
// export const WEATHER_LIVE_STAKE_MULTIPLIERS = [1, 2, 2, 2, 3];
export const WEATHER_LIVE_STAKE_MULTIPLIERS = [1, 1, 1, 1, 1];
export const WEATHER_TEMPERATURE_OFFSET_OPTIONS = [-1, 0, 1];
export const DEFAULT_WEATHER_TEMPERATURE_OFFSETS = [0];
export const WEATHER_EXECUTION_MODES = ["simulation", "live"];
export const DEFAULT_WEATHER_EXECUTION_MODE = "live";

function offsetKey(offset) {
  return String(Number(offset) || 0);
}

export function normalizeWeatherLiveBaseStake(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !WEATHER_LIVE_BASE_STAKE_OPTIONS.includes(numeric)) {
    return DEFAULT_WEATHER_LIVE_BASE_STAKE;
  }
  return numeric;
}

export function normalizeWeatherStakeMultipliers(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[,\-\s]+/)
        .filter(Boolean);
  const normalized = raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0 && item <= 20)
    .map((item) => Number(item.toFixed(3)));
  return normalized.length ? normalized.slice(0, 8) : [...WEATHER_LIVE_STAKE_MULTIPLIERS];
}

export function buildWeatherLiveStakeSequence(
  baseStake = DEFAULT_WEATHER_LIVE_BASE_STAKE,
  multipliers = WEATHER_LIVE_STAKE_MULTIPLIERS,
) {
  const base = normalizeWeatherLiveBaseStake(baseStake);
  return normalizeWeatherStakeMultipliers(multipliers).map((multiplier) =>
    Number((base * multiplier).toFixed(6)),
  );
}

export function formatWeatherLiveStakeSequence(sequence) {
  return (Array.isArray(sequence) ? sequence : [])
    .map((item) => {
      const numeric = Number(item);
      return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(3)));
    })
    .join("-");
}

export function normalizeWeatherTemperatureOffsets(value) {
  const raw = Array.isArray(value) ? value : DEFAULT_WEATHER_TEMPERATURE_OFFSETS;
  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    const numeric = Number(item);
    if (!Number.isInteger(numeric) || !WEATHER_TEMPERATURE_OFFSET_OPTIONS.includes(numeric) || seen.has(numeric)) {
      continue;
    }
    seen.add(numeric);
    normalized.push(numeric);
  }
  return normalized.length ? normalized.sort((left, right) => left - right) : [...DEFAULT_WEATHER_TEMPERATURE_OFFSETS];
}

export function normalizeWeatherExecutionMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return WEATHER_EXECUTION_MODES.includes(mode) ? mode : DEFAULT_WEATHER_EXECUTION_MODE;
}

function normalizeOffsetStrategy(offset, payload = {}, fallback = {}) {
  const numericOffset = Number(offset);
  const baseStake = normalizeWeatherLiveBaseStake(
    payload?.baseStake ?? payload?.liveBaseStake ?? fallback.baseStake ?? fallback.liveBaseStake,
  );
  const multipliers = normalizeWeatherStakeMultipliers(
    payload?.multipliers ?? payload?.stakeMultipliers ?? fallback.multipliers,
  );
  const stakeSequence = buildWeatherLiveStakeSequence(baseStake, multipliers);
  return {
    offset: numericOffset,
    enabled: Boolean(payload?.enabled ?? fallback.enabled ?? false),
    baseStake,
    multipliers,
    stakeSequence,
    sequenceLabel: formatWeatherLiveStakeSequence(stakeSequence),
    multiplierLabel: formatWeatherLiveStakeSequence(multipliers),
  };
}

export function normalizeWeatherOffsetStrategies(payload = {}) {
  const selectedOffsets = normalizeWeatherTemperatureOffsets(payload?.temperatureOffsets);
  const oldBaseStake = normalizeWeatherLiveBaseStake(payload?.liveBaseStake);
  const oldMultipliers = normalizeWeatherStakeMultipliers(payload?.stakeMultipliers);
  const rawStrategies = payload?.offsetStrategies && typeof payload.offsetStrategies === "object"
    ? payload.offsetStrategies
    : {};

  const strategies = {};
  for (const offset of WEATHER_TEMPERATURE_OFFSET_OPTIONS) {
    const raw = rawStrategies[offsetKey(offset)] || rawStrategies[offset] || {};
    strategies[offsetKey(offset)] = normalizeOffsetStrategy(offset, raw, {
      enabled: selectedOffsets.includes(offset),
      baseStake: oldBaseStake,
      multipliers: oldMultipliers,
    });
  }
  if (!Object.values(strategies).some((strategy) => strategy.enabled)) {
    strategies["0"] = {
      ...strategies["0"],
      enabled: true,
    };
  }
  return strategies;
}

export async function readWeatherLiveConfig() {
  try {
    const text = await fs.readFile(WEATHER_CONFIG_PATH, "utf8");
    const payload = JSON.parse(text);
    const executionMode = normalizeWeatherExecutionMode(payload?.executionMode);
    const offsetStrategies = normalizeWeatherOffsetStrategies(payload);
    const enabledStrategies = Object.values(offsetStrategies).filter((strategy) => strategy.enabled);
    const primaryStrategy = offsetStrategies["0"] || enabledStrategies[0];
    return {
      liveBaseStake: primaryStrategy?.baseStake || DEFAULT_WEATHER_LIVE_BASE_STAKE,
      liveStakeSequence: primaryStrategy?.stakeSequence || buildWeatherLiveStakeSequence(),
      liveSequenceLabel: primaryStrategy?.sequenceLabel || formatWeatherLiveStakeSequence(buildWeatherLiveStakeSequence()),
      temperatureOffsets: enabledStrategies.map((strategy) => strategy.offset).sort((left, right) => left - right),
      offsetStrategies,
      executionMode,
      updatedAt: payload?.updatedAt || null,
    };
  } catch {
    const offsetStrategies = normalizeWeatherOffsetStrategies({
      temperatureOffsets: DEFAULT_WEATHER_TEMPERATURE_OFFSETS,
      liveBaseStake: DEFAULT_WEATHER_LIVE_BASE_STAKE,
    });
    const primaryStrategy = offsetStrategies["0"];
    return {
      liveBaseStake: DEFAULT_WEATHER_LIVE_BASE_STAKE,
      liveStakeSequence: primaryStrategy.stakeSequence,
      liveSequenceLabel: primaryStrategy.sequenceLabel,
      temperatureOffsets: [...DEFAULT_WEATHER_TEMPERATURE_OFFSETS],
      offsetStrategies,
      executionMode: DEFAULT_WEATHER_EXECUTION_MODE,
      updatedAt: null,
    };
  }
}

export async function writeWeatherLiveConfig(input = {}) {
  const current = await readWeatherLiveConfig();
  const nextPayload = {
    executionMode: normalizeWeatherExecutionMode(input?.executionMode ?? current.executionMode),
    offsetStrategies: normalizeWeatherOffsetStrategies({
      temperatureOffsets: input?.temperatureOffsets ?? current.temperatureOffsets,
      liveBaseStake: input?.liveBaseStake ?? current.liveBaseStake,
      offsetStrategies: input?.offsetStrategies ?? current.offsetStrategies,
    }),
    updatedAt: new Date().toISOString(),
  };
  nextPayload.temperatureOffsets = Object.values(nextPayload.offsetStrategies)
    .filter((strategy) => strategy.enabled)
    .map((strategy) => strategy.offset)
    .sort((left, right) => left - right);
  nextPayload.liveBaseStake = nextPayload.offsetStrategies["0"]?.baseStake || DEFAULT_WEATHER_LIVE_BASE_STAKE;
  nextPayload.stakeMultipliers = nextPayload.offsetStrategies["0"]?.multipliers || [...WEATHER_LIVE_STAKE_MULTIPLIERS];

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(WEATHER_CONFIG_PATH, `${JSON.stringify(nextPayload, null, 2)}\n`, "utf8");
  return readWeatherLiveConfig();
}
