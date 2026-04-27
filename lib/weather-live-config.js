import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data", "weather_predictions");
const WEATHER_CONFIG_PATH = path.join(DATA_DIR, "config.json");

export const WEATHER_LIVE_BASE_STAKE_OPTIONS = [1, 2, 3, 4, 5];
export const DEFAULT_WEATHER_LIVE_BASE_STAKE = 1;
export const WEATHER_LIVE_STAKE_MULTIPLIERS = [1, 2, 2, 3, 5];

export function normalizeWeatherLiveBaseStake(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !WEATHER_LIVE_BASE_STAKE_OPTIONS.includes(numeric)) {
    return DEFAULT_WEATHER_LIVE_BASE_STAKE;
  }
  return numeric;
}

export function buildWeatherLiveStakeSequence(baseStake = DEFAULT_WEATHER_LIVE_BASE_STAKE) {
  const base = normalizeWeatherLiveBaseStake(baseStake);
  return WEATHER_LIVE_STAKE_MULTIPLIERS.map((multiplier) => base * multiplier);
}

export function formatWeatherLiveStakeSequence(sequence) {
  return (Array.isArray(sequence) ? sequence : []).map((item) => Number(item)).join("-");
}

export async function readWeatherLiveConfig() {
  try {
    const text = await fs.readFile(WEATHER_CONFIG_PATH, "utf8");
    const payload = JSON.parse(text);
    const liveBaseStake = normalizeWeatherLiveBaseStake(payload?.liveBaseStake);
    const liveStakeSequence = buildWeatherLiveStakeSequence(liveBaseStake);
    return {
      liveBaseStake,
      liveStakeSequence,
      liveSequenceLabel: formatWeatherLiveStakeSequence(liveStakeSequence),
      updatedAt: payload?.updatedAt || null,
    };
  } catch {
    const liveStakeSequence = buildWeatherLiveStakeSequence(DEFAULT_WEATHER_LIVE_BASE_STAKE);
    return {
      liveBaseStake: DEFAULT_WEATHER_LIVE_BASE_STAKE,
      liveStakeSequence,
      liveSequenceLabel: formatWeatherLiveStakeSequence(liveStakeSequence),
      updatedAt: null,
    };
  }
}

export async function writeWeatherLiveConfig(input = {}) {
  const current = await readWeatherLiveConfig();
  const next = {
    liveBaseStake: normalizeWeatherLiveBaseStake(input?.liveBaseStake ?? current.liveBaseStake),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(WEATHER_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return readWeatherLiveConfig();
}
