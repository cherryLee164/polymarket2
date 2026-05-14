import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { WEATHER_CITY_CONFIGS } from "./weather-data.js";
import {
  buildWeatherLiveStakeSequence,
  formatWeatherLiveStakeSequence,
  WEATHER_TEMPERATURE_OFFSET_OPTIONS,
  readWeatherLiveConfig,
} from "./weather-live-config.js";
import { getWeatherServiceStatus } from "./service-control.js";

const require = createRequire(import.meta.url);
const {
  fetchJson: sharedFetchJson,
  fetchText: sharedFetchText,
} = require("../scripts/shared/http.js");

const TZ = "Asia/Shanghai";
const DATA_DIR = path.join(process.cwd(), "data", "weather_predictions");
const RECORDS_PATH = path.join(DATA_DIR, "records.json");
const MIDDAY_NO95_RECORDS_PATH = path.join(DATA_DIR, "records-midday-no95.json");
const THRESHOLD_SIM_RECORDS_PATH = path.join(DATA_DIR, "records-threshold-sim.json");
const LIVE_ORDER_RECORDS_PATH = path.join(DATA_DIR, "live-orders.json");
const MISSING_CAPTURE_STATE_PATH = path.join(DATA_DIR, "missing-capture-state.json");
const BASE_STAKE_USD = 1;
const PRICE_EPSILON = 0.001;
const RESOLUTION_WIN_PRICE = normalizeProbabilityThreshold(
  process.env.WEATHER_RESOLUTION_WIN_PRICE,
  0.99,
);
const RESOLUTION_LOSE_PRICE = normalizeProbabilityThreshold(
  process.env.WEATHER_RESOLUTION_LOSE_PRICE,
  0.01,
);
const CAPTURE_SLOT_WINDOW_HOURS = Number(process.env.WEATHER_CAPTURE_SLOT_WINDOW_HOURS || 2);
const CAPTURE_SLOT_WINDOW_MINUTES = CAPTURE_SLOT_WINDOW_HOURS * 60;
const MISSING_CAPTURE_RETRY_MS = Number(
  process.env.WEATHER_MISSING_CAPTURE_RETRY_MS || 30 * 60 * 1000,
);
const MISSING_CAPTURE_BACKFILL_ENABLED = String(
  process.env.WEATHER_MISSING_CAPTURE_BACKFILL_ENABLED || "true",
).toLowerCase() !== "false";
const CAPTURE_SLOTS = [
  { id: "00", label: "00:10", hour: 0, minute: 10 },
  { id: "06", label: "06:10", hour: 6, minute: 10 },
  { id: "12", label: "12:10", hour: 12, minute: 10 },
];
const ENABLED_CAPTURE_SLOT_IDS = new Set(
  String(process.env.WEATHER_CAPTURE_SLOTS || "00")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const ENABLED_CAPTURE_SLOTS = CAPTURE_SLOTS.filter((item) => ENABLED_CAPTURE_SLOT_IDS.has(item.id));
const DEFAULT_CAPTURE_SLOT = ENABLED_CAPTURE_SLOTS[0] || CAPTURE_SLOTS[0];
const CITY_CONFIG_BY_SLUG = new Map(WEATHER_CITY_CONFIGS.map((item) => [item.citySlug, item]));
const MIDDAY_NO95_STRATEGY_ID = "midday-no95";
const WEATHER_LIVE_STRATEGY_ID = "weather-live-125";
const WEATHER_OFFSET_SIM_STRATEGY_ID = "weather-offset-sim";
const MIDDAY_NO95_CAPTURE_SLOT = { id: "midday-no95", label: "12:30", hour: 12, minute: 30 };
const MIDDAY_NO95_CAPTURE_WINDOW_MINUTES = Number(process.env.WEATHER_NO95_CAPTURE_WINDOW_MINUTES || 120);
const MIDDAY_NO95_STAKE_USD = Number(process.env.WEATHER_NO95_STAKE_USD || 1) || 1;
const MIDDAY_NO95_MIN_THRESHOLD = normalizeProbabilityThreshold(
  process.env.WEATHER_NO95_MIN_THRESHOLD ?? process.env.WEATHER_NO95_THRESHOLD,
  0.95,
);
const MIDDAY_NO95_MAX_THRESHOLD = normalizeProbabilityThreshold(process.env.WEATHER_NO95_MAX_THRESHOLD, 0.99);
const THRESHOLD_SIM_STRATEGY_ID = "weather-threshold-sim";
const THRESHOLD_SIM_CAPTURE_WINDOW_MINUTES = Number(process.env.WEATHER_SIM_CAPTURE_WINDOW_MINUTES || 60);
const THRESHOLD_SIM_STAKE_USD = Number(process.env.WEATHER_SIM_STAKE_USD || 1) || 1;
const DEFAULT_THRESHOLD_SIM_THRESHOLDS = "85,88,90,92,95,97";
const THRESHOLD_SIM_MAX_NO_PRICE = normalizeProbabilityThreshold(
  process.env.WEATHER_SIM_MAX_NO_PRICE ?? process.env.WEATHER_SIM_MAX_THRESHOLD,
  0.99,
);

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return Number(Number(value).toFixed(digits));
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toReasonableTemperature(value) {
  const num = toNumber(value);
  return num !== null && num >= -80 && num <= 80 ? num : null;
}

function normalizeProbabilityThreshold(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric > 1 ? numeric / 100 : numeric;
}

function parseSimulationSlots(value) {
  return String(value || "10:00,11:00,12:00,13:00")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
      if (!match) {
        return null;
      }
      const hour = Number(match[1]);
      const minute = Number(match[2] || 0);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return null;
      }
      const id = `${String(hour).padStart(2, "0")}${minute ? String(minute).padStart(2, "0") : ""}`;
      return {
        id,
        label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        hour,
        minute,
      };
    })
    .filter(Boolean);
}

function parseSimulationThresholds(value) {
  const thresholds = String(value || DEFAULT_THRESHOLD_SIM_THRESHOLDS)
    .split(",")
    .map((item) => normalizeProbabilityThreshold(item.trim(), null))
    .filter((item) => Number.isFinite(item) && item > 0 && item < 1)
    .sort((left, right) => left - right);
  return thresholds.length
    ? [...new Set(thresholds.map((item) => round(item, 6)))]
    : parseSimulationThresholds(DEFAULT_THRESHOLD_SIM_THRESHOLDS);
}

function thresholdLabel(value) {
  const numeric = normalizeProbabilityThreshold(value, 0.9);
  return `${Math.round(numeric * 100)}+`;
}

function thresholdKey(value) {
  const numeric = normalizeProbabilityThreshold(value, 0.9);
  return String(Math.round(numeric * 10000)).padStart(4, "0");
}

const THRESHOLD_SIM_CAPTURE_SLOTS = parseSimulationSlots(process.env.WEATHER_SIM_CAPTURE_SLOTS);
const THRESHOLD_SIM_THRESHOLDS = parseSimulationThresholds(process.env.WEATHER_SIM_THRESHOLDS);

function resolveThresholdSimSlot(record) {
  const keySlotId = String(record?.key || "").match(
    /:weather-threshold-sim:(?:scan|trade):([^:]+):/,
  )?.[1];
  if (keySlotId) {
    const keySlot = THRESHOLD_SIM_CAPTURE_SLOTS.find((item) => item.id === keySlotId);
    if (keySlot) {
      return keySlot;
    }
  }

  const label = String(record?.strategyLabel || record?.captureSlotLabel || "");
  const labelMatch = label.match(/^(\d{1,2}):(\d{2})/);
  if (labelMatch) {
    const hour = Number(labelMatch[1]);
    const minute = Number(labelMatch[2]);
    const labelSlot = THRESHOLD_SIM_CAPTURE_SLOTS.find(
      (item) => item.hour === hour && Number(item.minute || 0) === minute,
    );
    if (labelSlot) {
      return labelSlot;
    }
  }

  const recordSlotId = String(record?.captureSlotId || "");
  return (
    THRESHOLD_SIM_CAPTURE_SLOTS.find((item) => item.id === recordSlotId) ??
    THRESHOLD_SIM_CAPTURE_SLOTS[0]
  );
}

function sumField(items, field) {
  return (
    round(
      items.reduce((total, item) => total + (Number(item?.[field]) || 0), 0),
      6,
    ) ?? 0
  );
}

function getFormatterParts(date, options) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    ...options,
  });
  return formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
}

function getLocalDateString(date = new Date()) {
  const parts = getFormatterParts(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localDateStringToDate(ymd) {
  const [year, month, day] = String(ymd || "")
    .split("-")
    .map((value) => Number(value));
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function shiftLocalDateString(ymd, deltaDays) {
  const baseDate = localDateStringToDate(ymd);
  if (!baseDate) {
    return null;
  }
  baseDate.setUTCDate(baseDate.getUTCDate() + deltaDays);
  return getLocalDateString(baseDate);
}

function buildRecentLocalDateStrings(endYmd, count = 7) {
  const dates = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const ymd = shiftLocalDateString(endYmd, -offset);
    if (ymd) {
      dates.push(ymd);
    }
  }
  return dates;
}

function getLocalHour(date = new Date()) {
  const parts = getFormatterParts(date, {
    hour: "2-digit",
    hourCycle: "h23",
  });
  return Number(parts.hour);
}

function getLocalMinute(date = new Date()) {
  const parts = getFormatterParts(date, {
    minute: "2-digit",
  });
  return Number(parts.minute);
}

function getLocalDayMinute(date = new Date()) {
  return getLocalHour(date) * 60 + getLocalMinute(date);
}

function isSlotWindowActive(slot, windowMinutes, date = new Date()) {
  const dayMinute = getLocalDayMinute(date);
  const startMinute = slot.hour * 60 + (slot.minute || 0);
  return dayMinute >= startMinute && dayMinute < startMinute + windowMinutes;
}

function getSlotStartDayMinute(slot) {
  return slot.hour * 60 + (slot.minute || 0);
}

function hasSlotStarted(slot, date = new Date()) {
  return getLocalDayMinute(date) >= getSlotStartDayMinute(slot);
}

function formatDisplayDate(ymd) {
  const [year, month, day] = String(ymd || "").split("-");
  if (!year || !month || !day) {
    return ymd || "--";
  }
  return `${year}/${month}/${day}`;
}

function getCaptureSlot(slotLike) {
  if (typeof slotLike === "string") {
    return CAPTURE_SLOTS.find((item) => item.id === slotLike) ?? DEFAULT_CAPTURE_SLOT;
  }
  if (slotLike && typeof slotLike === "object" && typeof slotLike.id === "string") {
    return CAPTURE_SLOTS.find((item) => item.id === slotLike.id) ?? DEFAULT_CAPTURE_SLOT;
  }
  return DEFAULT_CAPTURE_SLOT;
}

function compareCaptureSlots(left, right) {
  const leftSlot = getCaptureSlot(left);
  const rightSlot = getCaptureSlot(right);
  return leftSlot.hour * 60 + (leftSlot.minute || 0) - (rightSlot.hour * 60 + (rightSlot.minute || 0));
}

function inferCaptureSlotIdFromCapturedAt(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    return DEFAULT_CAPTURE_SLOT.id;
  }
  const dayMinute = getLocalDayMinute(parsed);
  const sortedSlots = [...CAPTURE_SLOTS].sort(compareCaptureSlots);
  let current = sortedSlots[0] || DEFAULT_CAPTURE_SLOT;
  for (const slot of sortedSlots) {
    const startMinute = slot.hour * 60 + (slot.minute || 0);
    if (dayMinute >= startMinute) {
      current = slot;
      continue;
    }
    break;
  }
  return current.id;
}

function resolveActiveCaptureSlot(date = new Date()) {
  const dayMinute = getLocalDayMinute(date);
  return (
    ENABLED_CAPTURE_SLOTS.find(
      (slot) => {
        const startMinute = slot.hour * 60 + (slot.minute || 0);
        return dayMinute >= startMinute && dayMinute < startMinute + CAPTURE_SLOT_WINDOW_MINUTES;
      },
    ) ?? null
  );
}

function monthName(monthIndex) {
  return [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ][monthIndex];
}

function buildEventSlug(baseSlug, ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  return `${baseSlug}-on-${monthName(month - 1)}-${day}-${year}`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function fetchJson(url, label = "weather") {
  return sharedFetchJson(url, label);
}

async function fetchText(url, label = "weather-text") {
  return sharedFetchText(url, label);
}

function parseOutcomeArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getNoPrice(market) {
  const outcomes = parseOutcomeArray(market?.outcomes);
  const prices = parseOutcomeArray(market?.outcomePrices).map((item) => Number(item));
  if (!outcomes.length || outcomes.length !== prices.length) {
    return null;
  }
  const noIndex = outcomes.findIndex((item) => String(item).toLowerCase() === "no");
  if (noIndex < 0) {
    return null;
  }
  return Number.isFinite(prices[noIndex]) ? prices[noIndex] : null;
}

function getResolvedOutcome(market) {
  const outcomes = parseOutcomeArray(market?.outcomes);
  const prices = parseOutcomeArray(market?.outcomePrices).map((item) => Number(item));
  if (!outcomes.length || outcomes.length !== prices.length) {
    return null;
  }
  const yesIndex = outcomes.findIndex((item) => String(item).toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((item) => String(item).toLowerCase() === "no");
  if (yesIndex < 0 || noIndex < 0) {
    return null;
  }
  const yesPrice = prices[yesIndex];
  const noPrice = prices[noIndex];
  if (yesPrice >= RESOLUTION_WIN_PRICE && noPrice <= RESOLUTION_LOSE_PRICE + PRICE_EPSILON) {
    return "yes";
  }
  if (noPrice >= RESOLUTION_WIN_PRICE && yesPrice <= RESOLUTION_LOSE_PRICE + PRICE_EPSILON) {
    return "no";
  }
  return null;
}

function resolveAccountingStakeUsd(record) {
  const actualCost = Number(record?.actualBuyCostUsd);
  if (Number.isFinite(actualCost) && actualCost > 0) {
    return round(actualCost, 6);
  }
  const stake = Number(record?.stakeUsd);
  if (Number.isFinite(stake) && stake > 0) {
    return round(stake, 6);
  }
  const requested = Number(record?.requestedStakeUsd);
  if (Number.isFinite(requested) && requested > 0) {
    return round(requested, 6);
  }
  return null;
}

function estimateNoWinPnlUsd(record) {
  const actualCost = Number(record?.actualBuyCostUsd);
  const actualShares = Number(record?.actualBuyShares);
  if (
    Number.isFinite(actualCost) &&
    actualCost > 0 &&
    Number.isFinite(actualShares) &&
    actualShares > 0
  ) {
    return round(actualShares - actualCost, 6);
  }
  const existing = Number(record?.estimatedNoWinPnlUsd);
  if (Number.isFinite(existing)) {
    return round(existing, 6);
  }
  const stake = resolveAccountingStakeUsd(record);
  const price = Number(record?.buyNoPrice);
  if (!Number.isFinite(stake) || stake <= 0 || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  return round(stake / price - stake, 6);
}

function computeWeatherAccountingPnl(record) {
  if (String(record?.status || "").toLowerCase() !== "resolved") {
    return null;
  }
  let resolvedOutcome = String(record?.resolvedOutcome || "").trim().toLowerCase();
  if (!resolvedOutcome) {
    const result = String(record?.result || "").trim().toLowerCase();
    const legacyPnl = Number(record?.pnlUsd);
    if (result === "profit" || legacyPnl > 0) {
      resolvedOutcome = "no";
    } else if (result === "loss" || legacyPnl < 0) {
      resolvedOutcome = "yes";
    }
  }
  if (resolvedOutcome === "no") {
    return estimateNoWinPnlUsd(record);
  }
  if (resolvedOutcome === "yes") {
    const stake = resolveAccountingStakeUsd(record);
    return Number.isFinite(stake) ? round(-stake, 6) : null;
  }
  return null;
}

function inferActualTemperatureFromEvent(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  for (const market of markets) {
    if (getResolvedOutcome(market) !== "yes") {
      continue;
    }
    const bucket = parseMarketBucket(market);
    if (!bucket) {
      continue;
    }
    return {
      actualMaxTempC: bucket.value,
      actualTempBucketKind: bucket.kind,
      actualTempLabel: bucket.label || market.groupItemTitle || null,
      actualMarketSlug: market.slug || null,
    };
  }
  return null;
}

function enrichActualTemperature(record, event) {
  const actual = inferActualTemperatureFromEvent(event);
  if (!actual) {
    return record;
  }
  const forecastMax = toReasonableTemperature(record?.forecastMaxTempC ?? record?.targetTempC);
  const actualMax = toReasonableTemperature(actual.actualMaxTempC);
  const delta =
    Number.isFinite(forecastMax) && Number.isFinite(actualMax)
      ? round(actualMax - forecastMax, 1)
      : null;
  return {
    ...record,
    ...actual,
    actualMaxTempC: actualMax,
    temperatureDeltaC: delta,
  };
}

function needsResolutionRefresh(record) {
  if (
    !record?.marketSlug ||
    ["failed", "skipped", "cancelled", "canceled", "no-fill"].includes(
      String(record.status || "").toLowerCase(),
    )
  ) {
    return false;
  }
  if (record.status !== "resolved") {
    return true;
  }
  return !Number.isFinite(Number(record.actualMaxTempC));
}

function parseMarketBucket(market) {
  const title = String(market?.groupItemTitle || "").trim();
  let match = title.match(/^(\d+)°C$/i);
  if (match) {
    return { kind: "exact", value: Number(match[1]), label: title };
  }
  match = title.match(/^(\d+)°C or below$/i);
  if (match) {
    return { kind: "lower", value: Number(match[1]), label: title };
  }
  match = title.match(/^(\d+)°C or higher$/i);
  if (match) {
    return { kind: "upper", value: Number(match[1]), label: title };
  }
  return null;
}

function chooseMarketForForecastHigh(markets, forecastHighC) {
  return chooseMarketForTargetTemperature(markets, forecastHighC);
}

function chooseMarketForTargetTemperature(markets, targetTempC) {
  const parsed = (markets || [])
    .map((market) => ({ market, bucket: parseMarketBucket(market) }))
    .filter((item) => item.bucket);
  const exact = parsed.find(
    (item) => item.bucket.kind === "exact" && item.bucket.value === targetTempC,
  );
  if (exact) {
    return { market: exact.market, bucket: exact.bucket, selectionMode: "exact" };
  }

  const exactValues = parsed
    .filter((item) => item.bucket.kind === "exact")
    .map((item) => item.bucket.value)
    .sort((left, right) => left - right);

  const lower = parsed.find((item) => item.bucket.kind === "lower");
  if (lower && exactValues.length && targetTempC < exactValues[0]) {
    return { market: lower.market, bucket: lower.bucket, selectionMode: "lower-bound-fallback" };
  }

  const upper = parsed.find((item) => item.bucket.kind === "upper");
  if (upper && exactValues.length && targetTempC > exactValues[exactValues.length - 1]) {
    return { market: upper.market, bucket: upper.bucket, selectionMode: "upper-bound-fallback" };
  }

  return null;
}

function buildWeatherOffsetCandidates(markets, forecastMaxTempC) {
  if (!Number.isFinite(Number(forecastMaxTempC))) {
    return [];
  }
  const byMarket = new Map();
  for (const offset of WEATHER_TEMPERATURE_OFFSET_OPTIONS) {
    const targetTempC = Number(forecastMaxTempC) + offset;
    const selected = chooseMarketForTargetTemperature(markets, targetTempC);
    if (!selected?.market?.slug) {
      continue;
    }
    const noPrice = getNoPrice(selected.market);
    const key = `${offset}:${selected.market.slug}`;
    if (byMarket.has(key)) {
      continue;
    }
    byMarket.set(key, {
      temperatureOffsetC: offset,
      targetTempC,
      marketSlug: selected.market.slug,
      marketTitle: selected.bucket.label,
      marketQuestion: selected.market.question,
      marketSelectionMode: selected.selectionMode,
      marketBucketKind: selected.bucket.kind,
      marketBucketValue: selected.bucket.value,
      buyNoPrice: round(noPrice, 4),
      sharesBought: noPrice && noPrice > 0 ? round(BASE_STAKE_USD / noPrice, 6) : null,
      marketClosed: Boolean(selected.market.closed),
    });
  }
  return [...byMarket.values()].sort((left, right) => left.temperatureOffsetC - right.temperatureOffsetC);
}

async function fetchForecastForCity(config, ymd) {
  if (config?.forecastSource === "hko-fnd") {
    return fetchHongKongForecast(config, ymd);
  }
  if (config?.forecastSource === "cwa-county-63") {
    return fetchTaipeiForecast(config, ymd);
  }
  return fetchNmcForecast(config, ymd);
}

async function fetchNmcForecast(config, ymd) {
  const payload = await fetchJson(
    `https://www.nmc.cn/rest/weather?stationid=${encodeURIComponent(config.nmcStationCode)}`,
    `nmc-${config.citySlug}`,
  );
  const predict = payload?.data?.predict;
  const details = Array.isArray(predict?.detail) ? predict.detail : [];
  const today = details.find((item) => item?.date === ymd) ?? null;
  const fallback = details.find(
    (item) => String(item?.day?.weather?.temperature ?? "") !== "9999",
  );
  const selected = today ?? fallback;
  if (!selected) {
    return null;
  }

  const maxTemp = toNumber(selected?.day?.weather?.temperature);
  const minTemp = toNumber(selected?.night?.weather?.temperature);
  if (!Number.isFinite(maxTemp) || !Number.isFinite(minTemp)) {
    return null;
  }

  return {
    forecastDate: selected.date,
    publishTime: predict?.publish_time ?? null,
    minTempC: minTemp,
    maxTempC: maxTemp,
    rangeText: `${minTemp}~${maxTemp}`,
    dayWeather: selected?.day?.weather?.info ?? null,
    nightWeather: selected?.night?.weather?.info ?? null,
  };
}

function compactDate(ymd) {
  return String(ymd || "").replaceAll("-", "");
}

function formatCompactDate(compact) {
  if (!/^\d{8}$/.test(String(compact || ""))) {
    return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

async function fetchHongKongForecast(config, ymd) {
  const payload = await fetchJson(
    "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=en",
    `hko-${config.citySlug}`,
  );
  const items = Array.isArray(payload?.weatherForecast) ? payload.weatherForecast : [];
  const selected =
    items.find((item) => String(item?.forecastDate) === compactDate(ymd)) ?? items[0] ?? null;
  if (!selected) {
    return null;
  }

  const minTemp = toNumber(selected?.forecastMintemp?.value);
  const maxTemp = toNumber(selected?.forecastMaxtemp?.value);
  if (!Number.isFinite(minTemp) || !Number.isFinite(maxTemp)) {
    return null;
  }

  return {
    forecastDate: formatCompactDate(selected.forecastDate) ?? ymd,
    publishTime: payload?.updateTime ?? null,
    minTempC: minTemp,
    maxTempC: maxTemp,
    rangeText: `${minTemp}~${maxTemp}`,
    dayWeather: selected?.forecastWeather ?? null,
    nightWeather: selected?.forecastWind ?? null,
  };
}

function parseCwaCountyForecastScript(scriptText) {
  const sandbox = {};
  vm.runInNewContext(`${scriptText}; result = { IssuedTime_36hr, TableData_36hr };`, sandbox);
  return sandbox.result ?? null;
}

function extractCwaDatePart(timeRange) {
  const match = String(timeRange || "").match(/^(\d{2})\/(\d{2})-/);
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

async function fetchTaipeiForecast(config, ymd) {
  const script = await fetchText(
    "https://www.cwa.gov.tw/Data/js/TableData_36hr_County_C.js",
    `cwa-${config.citySlug}`,
  );
  const parsed = parseCwaCountyForecastScript(script);
  const rows = Array.isArray(parsed?.TableData_36hr?.["63"]) ? parsed.TableData_36hr["63"] : [];
  const targetMonthDay = `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
  const selectedRows = rows.filter((row) => extractCwaDatePart(row?.TimeRange) === targetMonthDay);
  const usableRows = selectedRows.length ? selectedRows : rows.slice(0, 3);
  if (!usableRows.length) {
    return null;
  }

  const lows = usableRows.map((row) => toNumber(row?.Temp?.C?.L)).filter(Number.isFinite);
  const highs = usableRows.map((row) => toNumber(row?.Temp?.C?.H)).filter(Number.isFinite);
  if (!lows.length || !highs.length) {
    return null;
  }

  const dayRow =
    usableRows.find((row) => String(row?.Type || "").toUpperCase() === "TM") ?? usableRows[0];
  const nightRow =
    usableRows.find((row) => String(row?.Type || "").toUpperCase() === "TMN") ??
    usableRows[usableRows.length - 1];

  return {
    forecastDate: selectedRows.length ? ymd : null,
    publishTime: parsed?.IssuedTime_36hr ?? null,
    minTempC: Math.min(...lows),
    maxTempC: Math.max(...highs),
    rangeText: `${Math.min(...lows)}~${Math.max(...highs)}`,
    dayWeather: dayRow?.Wx ?? null,
    nightWeather: nightRow?.Wx ?? null,
  };
}

async function fetchEventForCity(config, ymd) {
  const eventSlug = buildEventSlug(config.eventBaseSlug, ymd);
  const payload = await fetchJson(
    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`,
    `gamma-${config.citySlug}`,
  );
  const event = Array.isArray(payload) && payload.length ? payload[0] : null;
  return { eventSlug, event };
}

function buildRecordKey(config, ymd, slotLike = CAPTURE_SLOTS[0]) {
  const slot = getCaptureSlot(slotLike);
  return `${ymd}:${slot.id}:${config.citySlug}`;
}

function buildMiddayNo95ScanKey(config, ymd) {
  return `${ymd}:${MIDDAY_NO95_STRATEGY_ID}:scan:${config.citySlug}`;
}

function buildMiddayNo95TradeKey(config, ymd, marketSlug) {
  return `${ymd}:${MIDDAY_NO95_STRATEGY_ID}:trade:${config.citySlug}:${marketSlug}`;
}

function buildThresholdSimScanKey(config, ymd, slotLike, threshold) {
  return `${ymd}:${THRESHOLD_SIM_STRATEGY_ID}:scan:${slotLike.id}:${thresholdKey(threshold)}:${config.citySlug}`;
}

function buildThresholdSimTradeKey(config, ymd, slotLike, threshold, marketSlug) {
  return `${ymd}:${THRESHOLD_SIM_STRATEGY_ID}:trade:${slotLike.id}:${thresholdKey(threshold)}:${config.citySlug}:${marketSlug}`;
}

function mergeConfigIntoRecord(record, config) {
  if (!record || !config) {
    return record;
  }
  const eventSlug = record.eventSlug || buildEventSlug(config.eventBaseSlug, record.date);
  return {
    ...record,
    cityZh: config.cityZh,
    cityEn: config.cityEn,
    forecastTarget: config.forecastTarget,
    forecastPageUrl: config.nmcPageUrl,
    forecastStationCode: config.nmcStationCode,
    settlementStationName: config.settlementStationName,
    settlementStationCode: config.settlementStationCode,
    eventSlug,
    eventUrl: `https://polymarket.com/zh/event/${eventSlug}`,
    note: config.note,
  };
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object" || !record.citySlug) {
    return null;
  }
  const config = CITY_CONFIG_BY_SLUG.get(record.citySlug);
  if (!config) {
    return null;
  }
  const rawSlotId = record.captureSlotId || inferCaptureSlotIdFromCapturedAt(record.capturedAt);
  if (!ENABLED_CAPTURE_SLOT_IDS.has(rawSlotId)) {
    return null;
  }
  const slot = getCaptureSlot(rawSlotId);
  const normalized = {
    ...record,
    date:
      record.date ||
      getLocalDateString(record.capturedAt ? new Date(record.capturedAt) : new Date()),
    captureSlotId: slot.id,
    captureSlotLabel: slot.label,
    captureSlotHour: slot.hour,
    captureSlotMinute: slot.minute || 0,
    stakeUsd: round(Number(record.stakeUsd) || BASE_STAKE_USD, 6) ?? BASE_STAKE_USD,
  };
  normalized.key = buildRecordKey({ citySlug: normalized.citySlug }, normalized.date, slot);
  return mergeConfigIntoRecord(normalized, config);
}

function normalizeMiddayNo95Record(record) {
  if (!record || typeof record !== "object" || !record.citySlug) {
    return null;
  }
  const config = CITY_CONFIG_BY_SLUG.get(record.citySlug);
  if (!config) {
    return null;
  }
  const merged = mergeConfigIntoRecord(record, config);
  const normalized = {
    ...merged,
    strategyId: MIDDAY_NO95_STRATEGY_ID,
    strategyLabel: merged.strategyLabel || "12:30 >95c",
    recordType: merged.recordType || "trade",
    date:
      merged.date ||
      getLocalDateString(merged.capturedAt ? new Date(merged.capturedAt) : new Date()),
    captureSlotId: MIDDAY_NO95_CAPTURE_SLOT.id,
    captureSlotLabel: MIDDAY_NO95_CAPTURE_SLOT.label,
    captureSlotHour: MIDDAY_NO95_CAPTURE_SLOT.hour,
    captureSlotMinute: MIDDAY_NO95_CAPTURE_SLOT.minute,
  };

  if (normalized.recordType === "scan") {
    normalized.key =
      normalized.key || buildMiddayNo95ScanKey({ citySlug: normalized.citySlug }, normalized.date);
    return normalized;
  }

  if (!normalized.marketSlug) {
    return null;
  }

  normalized.key =
    normalized.key ||
    buildMiddayNo95TradeKey({ citySlug: normalized.citySlug }, normalized.date, normalized.marketSlug);
  normalized.stakeUsd = round(Number(normalized.stakeUsd) || MIDDAY_NO95_STAKE_USD, 6) ?? MIDDAY_NO95_STAKE_USD;
  normalized.minThresholdNoPrice = round(
    normalizeProbabilityThreshold(normalized.minThresholdNoPrice ?? normalized.thresholdNoPrice, MIDDAY_NO95_MIN_THRESHOLD),
    6,
  );
  normalized.maxThresholdNoPrice = round(
    normalizeProbabilityThreshold(normalized.maxThresholdNoPrice, MIDDAY_NO95_MAX_THRESHOLD),
    6,
  );
  const buyNoPrice = Number(normalized.buyNoPrice);
  if (
    !Number.isFinite(buyNoPrice) ||
    buyNoPrice <= Number(normalized.minThresholdNoPrice) ||
    buyNoPrice >= Number(normalized.maxThresholdNoPrice)
  ) {
    return null;
  }
  return normalized;
}

function normalizeThresholdSimRecord(record) {
  if (!record || typeof record !== "object" || !record.citySlug) {
    return null;
  }
  const config = CITY_CONFIG_BY_SLUG.get(record.citySlug);
  if (!config) {
    return null;
  }
  const slot = resolveThresholdSimSlot(record);
  if (!slot) {
    return null;
  }
  const threshold = normalizeProbabilityThreshold(record.thresholdNoPrice, THRESHOLD_SIM_THRESHOLDS[0] || 0.9);
  const merged = mergeConfigIntoRecord(record, config);
  const normalized = {
    ...merged,
    strategyId: THRESHOLD_SIM_STRATEGY_ID,
    strategyLabel: merged.strategyLabel || `${slot.label} No ${thresholdLabel(threshold)}`,
    recordType: merged.recordType || "trade",
    date:
      merged.date ||
      getLocalDateString(merged.capturedAt ? new Date(merged.capturedAt) : new Date()),
    captureSlotId: slot.id,
    captureSlotLabel: slot.label,
    captureSlotHour: slot.hour,
    captureSlotMinute: slot.minute || 0,
    thresholdNoPrice: round(threshold, 6),
  };

  if (normalized.recordType === "scan") {
    normalized.key =
      normalized.key || buildThresholdSimScanKey({ citySlug: normalized.citySlug }, normalized.date, slot, threshold);
    return normalized;
  }

  if (!normalized.marketSlug) {
    return null;
  }

  normalized.key =
    normalized.key ||
    buildThresholdSimTradeKey(
      { citySlug: normalized.citySlug },
      normalized.date,
      slot,
      threshold,
      normalized.marketSlug,
    );
  normalized.stakeUsd = round(Number(normalized.stakeUsd) || THRESHOLD_SIM_STAKE_USD, 6) ?? THRESHOLD_SIM_STAKE_USD;
  const buyNoPrice = Number(normalized.buyNoPrice);
  if (
    !Number.isFinite(buyNoPrice) ||
    buyNoPrice < Number(normalized.thresholdNoPrice) ||
    buyNoPrice > THRESHOLD_SIM_MAX_NO_PRICE
  ) {
    return null;
  }
  normalized.accountingPnlUsd = computeWeatherAccountingPnl(normalized);
  normalized.accountingPnlMethod =
    normalized.accountingPnlUsd === null ? null : "estimated-win-or-stake-loss";
  return normalized;
}

function buildLiveOrderKey(record, slotLike = DEFAULT_CAPTURE_SLOT) {
  const slot = getCaptureSlot(slotLike);
  return [
    record?.date || getLocalDateString(),
    WEATHER_LIVE_STRATEGY_ID,
    slot.id,
    record?.citySlug || "city",
    record?.marketSlug || "market",
  ].join(":");
}

function normalizeLiveOrderRecord(record) {
  if (!record || typeof record !== "object" || !record.citySlug) {
    return null;
  }
  const config = CITY_CONFIG_BY_SLUG.get(record.citySlug);
  if (!config) {
    return null;
  }
  const rawSlotId = record.captureSlotId || inferCaptureSlotIdFromCapturedAt(record.capturedAt);
  const slot = getCaptureSlot(rawSlotId);
  const normalized = {
    ...record,
    strategyId: WEATHER_LIVE_STRATEGY_ID,
    strategyLabel: record.strategyLabel || "天气实盘同城",
    date:
      record.date ||
      getLocalDateString(record.capturedAt ? new Date(record.capturedAt) : new Date()),
    captureSlotId: slot.id,
    captureSlotLabel: slot.label,
    captureSlotHour: slot.hour,
    captureSlotMinute: slot.minute || 0,
    stakeUsd:
      round(Number(record.stakeUsd ?? record.requestedStakeUsd ?? BASE_STAKE_USD), 6) ??
      BASE_STAKE_USD,
    status: record.status || "pending",
  };
  normalized.key = normalized.key || buildLiveOrderKey(normalized, slot);
  normalized.estimatedNoWinPnlUsd = estimateNoWinPnlUsd(normalized);
  normalized.accountingStakeUsd = resolveAccountingStakeUsd(normalized);
  normalized.accountingPnlUsd = computeWeatherAccountingPnl(normalized);
  normalized.accountingPnlMethod =
    normalized.accountingPnlUsd === null ? null : "estimated-win-or-stake-loss";
  return mergeConfigIntoRecord(normalized, config);
}

function isActiveLiveOrder(record) {
  const status = String(record?.status || "").toLowerCase();
  return !["failed", "skipped", "cancelled", "canceled"].includes(status);
}

async function createDailyRecord(config, ymd, slotLike = DEFAULT_CAPTURE_SLOT, options = {}) {
  const slot = getCaptureSlot(slotLike);
  const forecast = await fetchForecastForCity(config, ymd);
  const { eventSlug, event } = await fetchEventForCity(config, ymd);
  const isBackfill = options.captureMode === "missing-backfill";
  const base = {
    key: buildRecordKey(config, ymd, slot),
    date: ymd,
    captureSlotId: slot.id,
    captureSlotLabel: slot.label,
    captureSlotHour: slot.hour,
    captureSlotMinute: slot.minute || 0,
    captureMode: isBackfill ? "missing-backfill" : "scheduled",
    missingCaptureBackfill: isBackfill,
    scheduledCaptureLabel: slot.label,
    citySlug: config.citySlug,
    cityZh: config.cityZh,
    cityEn: config.cityEn,
    forecastTarget: config.forecastTarget,
    forecastPageUrl: config.nmcPageUrl,
    forecastStationCode: config.nmcStationCode,
    settlementStationName: config.settlementStationName,
    settlementStationCode: config.settlementStationCode,
    eventSlug,
    eventUrl: `https://polymarket.com/zh/event/${eventSlug}`,
    capturedAt: new Date().toISOString(),
    stakeUsd: BASE_STAKE_USD,
    status: "pending",
    result: "待结算",
    pnlUsd: null,
    note: isBackfill
      ? `${config.note || ""}${config.note ? " | " : ""}${slot.label} missed-window backfill`
      : config.note,
  };

  if (!forecast) {
    return {
      ...base,
      status: "forecast-unavailable",
      result: "预报缺失",
      forecastRangeText: "--",
      targetTempC: null,
      buyNoPrice: null,
      sharesBought: null,
    };
  }

  const record = {
    ...base,
    forecastPublishTime: forecast.publishTime,
    forecastRangeText: forecast.rangeText,
    forecastMinTempC: forecast.minTempC,
    forecastMaxTempC: forecast.maxTempC,
    targetTempC: forecast.maxTempC,
    dayWeather: forecast.dayWeather,
    nightWeather: forecast.nightWeather,
  };

  if (!event || !Array.isArray(event.markets)) {
    return {
      ...record,
      status: "market-unavailable",
      result: "事件缺失",
      buyNoPrice: null,
      sharesBought: null,
    };
  }

  const candidateMarkets = buildWeatherOffsetCandidates(event.markets, forecast.maxTempC);
  const selectedCandidate = candidateMarkets.find((item) => item.temperatureOffsetC === 0) || candidateMarkets[0] || null;
  if (!selectedCandidate) {
    return {
      ...record,
      status: "market-not-mapped",
      result: "无对应市场",
      buyNoPrice: null,
      sharesBought: null,
      candidateMarkets,
    };
  }

  return {
    ...record,
    temperatureOffsetC: selectedCandidate.temperatureOffsetC,
    marketSlug: selectedCandidate.marketSlug,
    marketTitle: selectedCandidate.marketTitle,
    marketQuestion: selectedCandidate.marketQuestion,
    marketSelectionMode: selectedCandidate.marketSelectionMode,
    marketBucketKind: selectedCandidate.marketBucketKind,
    marketBucketValue: selectedCandidate.marketBucketValue,
    candidateMarkets,
    buyNoPrice: selectedCandidate.buyNoPrice,
    sharesBought: selectedCandidate.sharesBought,
    marketClosed: selectedCandidate.marketClosed,
  };
}

async function enrichRecordOffsetCandidates(record, config) {
  if (Array.isArray(record?.candidateMarkets) && record.candidateMarkets.length) {
    return record;
  }
  const forecastMaxTempC = toReasonableTemperature(record?.forecastMaxTempC ?? record?.targetTempC);
  if (!Number.isFinite(forecastMaxTempC)) {
    return record;
  }
  try {
    const { event } = await fetchEventForCity(config, record.date);
    if (!event || !Array.isArray(event.markets)) {
      return record;
    }
    const candidateMarkets = buildWeatherOffsetCandidates(event.markets, forecastMaxTempC);
    if (!candidateMarkets.length) {
      return record;
    }
    return {
      ...record,
      candidateMarkets,
    };
  } catch {
    return record;
  }
}

function chooseMiddayNo95Markets(markets, minThreshold, maxThreshold) {
  return (Array.isArray(markets) ? markets : [])
    .map((market) => {
      const bucket = parseMarketBucket(market);
      const noPrice = getNoPrice(market);
      return { market, bucket, noPrice };
    })
    .filter(
      (item) =>
        !item.market?.closed &&
        Number.isFinite(item.noPrice) &&
        item.noPrice > minThreshold &&
        item.noPrice < maxThreshold,
    )
    .sort((left, right) => {
      if (right.noPrice !== left.noPrice) {
        return right.noPrice - left.noPrice;
      }
      return String(left.market?.groupItemTitle || "").localeCompare(
        String(right.market?.groupItemTitle || ""),
        "en",
      );
    });
}

function chooseThresholdSimMarkets(markets, threshold) {
  return (Array.isArray(markets) ? markets : [])
    .map((market) => {
      const bucket = parseMarketBucket(market);
      const noPrice = getNoPrice(market);
      return { market, bucket, noPrice };
    })
    .filter(
      (item) =>
        !item.market?.closed &&
        Number.isFinite(item.noPrice) &&
        item.noPrice >= threshold &&
        item.noPrice <= THRESHOLD_SIM_MAX_NO_PRICE,
    )
    .sort((left, right) => {
      if (right.noPrice !== left.noPrice) {
        return right.noPrice - left.noPrice;
      }
      return String(left.market?.groupItemTitle || "").localeCompare(
        String(right.market?.groupItemTitle || ""),
        "en",
      );
    });
}

async function createMiddayNo95RecordsForCity(config, ymd) {
  const capturedAt = new Date().toISOString();
  const [forecast, eventPayload] = await Promise.all([
    fetchForecastForCity(config, ymd).catch(() => null),
    fetchEventForCity(config, ymd),
  ]);
  const eventSlug = eventPayload?.eventSlug || buildEventSlug(config.eventBaseSlug, ymd);
  const event = eventPayload?.event ?? null;
  const matches = chooseMiddayNo95Markets(event?.markets, MIDDAY_NO95_MIN_THRESHOLD, MIDDAY_NO95_MAX_THRESHOLD);

  const scanRecord = normalizeMiddayNo95Record({
    key: buildMiddayNo95ScanKey(config, ymd),
    recordType: "scan",
    strategyId: MIDDAY_NO95_STRATEGY_ID,
    strategyLabel: "12:30 95-99c",
    date: ymd,
    citySlug: config.citySlug,
    cityZh: config.cityZh,
    cityEn: config.cityEn,
    eventSlug,
    eventUrl: `https://polymarket.com/zh/event/${eventSlug}`,
    capturedAt,
    status: "scanned",
    result: matches.length ? `matched-${matches.length}` : "no-match",
    selectedCount: matches.length,
    minThresholdNoPrice: MIDDAY_NO95_MIN_THRESHOLD,
    maxThresholdNoPrice: MIDDAY_NO95_MAX_THRESHOLD,
    forecastPublishTime: forecast?.publishTime ?? null,
    forecastRangeText: forecast?.rangeText ?? null,
    forecastMinTempC: forecast?.minTempC ?? null,
    forecastMaxTempC: forecast?.maxTempC ?? null,
    targetTempC: forecast?.maxTempC ?? null,
    dayWeather: forecast?.dayWeather ?? null,
    nightWeather: forecast?.nightWeather ?? null,
    note: config.note,
  });

  const tradeRecords = matches
    .map(({ market, bucket, noPrice }) =>
      normalizeMiddayNo95Record({
        key: buildMiddayNo95TradeKey(config, ymd, market.slug),
        recordType: "trade",
        strategyId: MIDDAY_NO95_STRATEGY_ID,
        strategyLabel: "12:30 95-99c",
        date: ymd,
        citySlug: config.citySlug,
        cityZh: config.cityZh,
        cityEn: config.cityEn,
        forecastTarget: config.forecastTarget,
        forecastPageUrl: config.nmcPageUrl,
        forecastStationCode: config.nmcStationCode,
        settlementStationName: config.settlementStationName,
        settlementStationCode: config.settlementStationCode,
        eventSlug,
        eventUrl: `https://polymarket.com/zh/event/${eventSlug}`,
        capturedAt,
        stakeUsd: MIDDAY_NO95_STAKE_USD,
        status: "pending",
        result: "待结算",
        pnlUsd: null,
        minThresholdNoPrice: MIDDAY_NO95_MIN_THRESHOLD,
        maxThresholdNoPrice: MIDDAY_NO95_MAX_THRESHOLD,
        forecastPublishTime: forecast?.publishTime ?? null,
        forecastRangeText: forecast?.rangeText ?? null,
        forecastMinTempC: forecast?.minTempC ?? null,
        forecastMaxTempC: forecast?.maxTempC ?? null,
        targetTempC: forecast?.maxTempC ?? null,
        dayWeather: forecast?.dayWeather ?? null,
        nightWeather: forecast?.nightWeather ?? null,
        marketSlug: market.slug,
        marketTitle: bucket?.label || market.groupItemTitle || market.question,
        marketQuestion: market.question,
        marketSelectionMode: "all-no-above-threshold",
        marketBucketKind: bucket?.kind ?? null,
        marketBucketValue: bucket?.value ?? null,
        buyNoPrice: round(noPrice, 4),
        sharesBought: round(MIDDAY_NO95_STAKE_USD / noPrice, 6),
        marketClosed: Boolean(market.closed),
        note: config.note,
      }),
    )
    .filter(Boolean);

  return { scanRecord, tradeRecords };
}

async function createThresholdSimRecordsForCity(config, ymd, slot) {
  const capturedAt = new Date().toISOString();
  const [forecast, eventPayload] = await Promise.all([
    fetchForecastForCity(config, ymd).catch(() => null),
    fetchEventForCity(config, ymd),
  ]);
  const eventSlug = eventPayload?.eventSlug || buildEventSlug(config.eventBaseSlug, ymd);
  const event = eventPayload?.event ?? null;
  const scanRecords = [];
  const tradeRecords = [];

  for (const threshold of THRESHOLD_SIM_THRESHOLDS) {
    const matches = chooseThresholdSimMarkets(event?.markets, threshold);
    const strategyLabel = `${slot.label} No ${thresholdLabel(threshold)}`;
    scanRecords.push(
      normalizeThresholdSimRecord({
        key: buildThresholdSimScanKey(config, ymd, slot, threshold),
        recordType: "scan",
        strategyId: THRESHOLD_SIM_STRATEGY_ID,
        strategyLabel,
        date: ymd,
        captureSlotId: slot.id,
        captureSlotLabel: slot.label,
        captureSlotHour: slot.hour,
        captureSlotMinute: slot.minute || 0,
        citySlug: config.citySlug,
        cityZh: config.cityZh,
        cityEn: config.cityEn,
        eventSlug,
        eventUrl: `https://polymarket.com/zh/event/${eventSlug}`,
        capturedAt,
        status: "scanned",
        result: matches.length ? `matched-${matches.length}` : "no-match",
        selectedCount: matches.length,
        thresholdNoPrice: threshold,
        forecastPublishTime: forecast?.publishTime ?? null,
        forecastRangeText: forecast?.rangeText ?? null,
        forecastMinTempC: forecast?.minTempC ?? null,
        forecastMaxTempC: forecast?.maxTempC ?? null,
        targetTempC: forecast?.maxTempC ?? null,
        dayWeather: forecast?.dayWeather ?? null,
        nightWeather: forecast?.nightWeather ?? null,
        note: config.note,
      }),
    );

    for (const { market, bucket, noPrice } of matches) {
      const record = normalizeThresholdSimRecord({
        key: buildThresholdSimTradeKey(config, ymd, slot, threshold, market.slug),
        recordType: "trade",
        strategyId: THRESHOLD_SIM_STRATEGY_ID,
        strategyLabel,
        date: ymd,
        captureSlotId: slot.id,
        captureSlotLabel: slot.label,
        captureSlotHour: slot.hour,
        captureSlotMinute: slot.minute || 0,
        citySlug: config.citySlug,
        cityZh: config.cityZh,
        cityEn: config.cityEn,
        forecastTarget: config.forecastTarget,
        forecastPageUrl: config.nmcPageUrl,
        forecastStationCode: config.nmcStationCode,
        settlementStationName: config.settlementStationName,
        settlementStationCode: config.settlementStationCode,
        eventSlug,
        eventUrl: `https://polymarket.com/zh/event/${eventSlug}`,
        capturedAt,
        stakeUsd: THRESHOLD_SIM_STAKE_USD,
        status: "pending",
        result: "待结算",
        pnlUsd: null,
        thresholdNoPrice: threshold,
        forecastPublishTime: forecast?.publishTime ?? null,
        forecastRangeText: forecast?.rangeText ?? null,
        forecastMinTempC: forecast?.minTempC ?? null,
        forecastMaxTempC: forecast?.maxTempC ?? null,
        targetTempC: forecast?.maxTempC ?? null,
        dayWeather: forecast?.dayWeather ?? null,
        nightWeather: forecast?.nightWeather ?? null,
        marketSlug: market.slug,
        marketTitle: bucket?.label || market.groupItemTitle || market.question,
        marketQuestion: market.question,
        marketSelectionMode: "all-no-above-threshold",
        marketBucketKind: bucket?.kind ?? null,
        marketBucketValue: bucket?.value ?? null,
        buyNoPrice: round(noPrice, 4),
        sharesBought: round(THRESHOLD_SIM_STAKE_USD / noPrice, 6),
        marketClosed: Boolean(market.closed),
        note: config.note,
      });
      if (record) {
        tradeRecords.push(record);
      }
    }
  }

  return {
    scanRecords: scanRecords.filter(Boolean),
    tradeRecords,
  };
}

function settleRecord(record, market) {
  const outcome = getResolvedOutcome(market);
  if (!outcome) {
    return record;
  }

  const stakeUsd = Number(record.stakeUsd ?? BASE_STAKE_USD);
  const noPrice = Number(record.buyNoPrice);
  const sharesBought =
    Number(record.sharesBought || 0) > 0
      ? Number(record.sharesBought)
      : Number.isFinite(noPrice) && noPrice > 0
        ? round(stakeUsd / noPrice, 6)
        : 0;

  if (outcome === "no") {
    const payout = Number(sharesBought || 0);
    return {
      ...record,
      status: "resolved",
      result: "盈利",
      resolvedOutcome: "No",
      resolvedAt: new Date().toISOString(),
      payoutUsd: round(payout, 6),
      pnlUsd: round(payout - stakeUsd, 6),
    };
  }

  return {
    ...record,
    status: "resolved",
    result: "亏损",
    resolvedOutcome: "Yes",
    resolvedAt: new Date().toISOString(),
    payoutUsd: 0,
    pnlUsd: round(-stakeUsd, 6),
  };
}

async function refreshRecordResolutions(records) {
  const output = new Map(records.map((record) => [record.key, record]));
  const pendingByEvent = new Map();

  for (const record of records) {
    if (!needsResolutionRefresh(record)) {
      continue;
    }
    const items = pendingByEvent.get(record.eventSlug) || [];
    items.push(record);
    pendingByEvent.set(record.eventSlug, items);
  }

  for (const [eventSlug, items] of pendingByEvent.entries()) {
    try {
      const payload = await fetchJson(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`,
        `gamma-resolve-batch-${eventSlug}`,
      );
      const event = Array.isArray(payload) && payload.length ? payload[0] : null;
      const marketsBySlug = new Map(
        (Array.isArray(event?.markets) ? event.markets : []).map((market) => [market.slug, market]),
      );
      for (const record of items) {
        const market = marketsBySlug.get(record.marketSlug);
        if (!market) {
          continue;
        }
        const enrichedRecord = enrichActualTemperature(
          {
            ...record,
            marketClosed: Boolean(market.closed),
          },
          event,
        );
        output.set(
          record.key,
          record.status === "resolved" ? enrichedRecord : settleRecord(enrichedRecord, market),
        );
      }
    } catch {
      for (const record of items) {
        output.set(record.key, record);
      }
    }
  }

  return records.map((record) => output.get(record.key) || record);
}

function compareRecordChronology(left, right) {
  if (left.date !== right.date) {
    return String(left.date).localeCompare(String(right.date));
  }
  if (Number(left.captureSlotHour || 0) !== Number(right.captureSlotHour || 0)) {
    return Number(left.captureSlotHour || 0) - Number(right.captureSlotHour || 0);
  }
  if (String(left.capturedAt || "") !== String(right.capturedAt || "")) {
    return String(left.capturedAt || "").localeCompare(String(right.capturedAt || ""));
  }
  return String(left.key || "").localeCompare(String(right.key || ""));
}

function scaleResolvedResult(record, stakeUsd) {
  const price = Number(record.buyNoPrice);
  const outcome = String(record.resolvedOutcome || "").toLowerCase();
  if (outcome === "no" && Number.isFinite(price) && price > 0) {
    const payout = round(stakeUsd / price, 6);
    return {
      payoutUsd: payout,
      pnlUsd: round(payout - stakeUsd, 6),
    };
  }
  if (outcome === "yes") {
    return {
      payoutUsd: 0,
      pnlUsd: round(-stakeUsd, 6),
    };
  }

  const baseStake = Number(record.stakeUsd);
  const basePayout = Number(record.payoutUsd);
  const basePnl = Number(record.pnlUsd);
  if (Number.isFinite(baseStake) && baseStake > 0) {
    if (Number.isFinite(basePayout)) {
      const payout = round((basePayout / baseStake) * stakeUsd, 6);
      return {
        payoutUsd: payout,
        pnlUsd: round(payout - stakeUsd, 6),
      };
    }
    if (Number.isFinite(basePnl)) {
      const pnl = round((basePnl / baseStake) * stakeUsd, 6);
      return {
        payoutUsd: pnl === null ? null : round(stakeUsd + pnl, 6),
        pnlUsd: pnl,
      };
    }
  }

  return {
    payoutUsd: null,
    pnlUsd: null,
  };
}

function summarizePerformance(records, todayYmd, { pnlField, stakeField }) {
  const settled = records.filter(
    (item) => item.status === "resolved" && Number.isFinite(Number(item?.[pnlField])),
  );
  const wins = settled.filter((item) => Number(item?.[pnlField]) > 0);
  const losses = settled.filter((item) => Number(item?.[pnlField]) < 0);
  const pending = records.filter((item) => item.status !== "resolved");
  const days = new Set(records.map((item) => item.date)).size;
  const todayRecords = records.filter((item) => item.date === todayYmd);
  const todaySettled = todayRecords.filter(
    (item) => item.status === "resolved" && Number.isFinite(Number(item?.[pnlField])),
  );
  const recentDateKeys = buildRecentLocalDateStrings(todayYmd, 7);
  const sevenDayStartYmd = recentDateKeys[0] || todayYmd;
  const sevenDayRecords = records.filter(
    (item) => item.date >= sevenDayStartYmd && item.date <= todayYmd,
  );
  const sevenDaySettled = sevenDayRecords.filter(
    (item) => item.status === "resolved" && Number.isFinite(Number(item?.[pnlField])),
  );
  const settledByDate = new Map();
  for (const item of sevenDaySettled) {
    const key = item.date;
    const items = settledByDate.get(key) || [];
    items.push(item);
    settledByDate.set(key, items);
  }

  const captureSlots = [...new Set([...ENABLED_CAPTURE_SLOTS.map((item) => item.id), ...records.map((item) => getCaptureSlot(item.captureSlotId).id)])]
    .sort(compareCaptureSlots)
    .map((slotId) => {
      const slot = getCaptureSlot(slotId);
      const slotRecords = records.filter((item) => getCaptureSlot(item.captureSlotId).id === slot.id);
      const slotSettled = slotRecords.filter(
        (item) => item.status === "resolved" && Number.isFinite(Number(item?.[pnlField])),
      );
      return {
        slotId: slot.id,
        slotLabel: slot.label,
        slotHour: slot.hour,
        totalRecords: slotRecords.length,
        settledRecords: slotSettled.length,
        pending: slotRecords.filter((item) => item.status !== "resolved").length,
        wins: slotSettled.filter((item) => Number(item?.[pnlField]) > 0).length,
        losses: slotSettled.filter((item) => Number(item?.[pnlField]) < 0).length,
        totalStakeUsd: sumField(slotSettled, stakeField),
        netPnlUsd: sumField(slotSettled, pnlField),
      };
    });

  return {
    overall: {
      trackedDays: days,
      totalRecords: records.length,
      settledRecords: settled.length,
      wins: wins.length,
      losses: losses.length,
      pending: pending.length,
      totalStakeUsd: sumField(settled, stakeField),
      netPnlUsd: sumField(settled, pnlField),
    },
    today: {
      date: todayYmd,
      records: todayRecords.length,
      settledRecords: todaySettled.length,
      wins: todaySettled.filter((item) => Number(item?.[pnlField]) > 0).length,
      losses: todaySettled.filter((item) => Number(item?.[pnlField]) < 0).length,
      pending: todayRecords.filter((item) => item.status !== "resolved").length,
      totalStakeUsd: sumField(todaySettled, stakeField),
      netPnlUsd: sumField(todaySettled, pnlField),
    },
    sevenDay: {
      startDate: sevenDayStartYmd,
      endDate: todayYmd,
      records: sevenDayRecords.length,
      settledRecords: sevenDaySettled.length,
      wins: sevenDaySettled.filter((item) => Number(item?.[pnlField]) > 0).length,
      losses: sevenDaySettled.filter((item) => Number(item?.[pnlField]) < 0).length,
      totalStakeUsd: sumField(sevenDaySettled, stakeField),
      netPnlUsd: sumField(sevenDaySettled, pnlField),
      dailyBreakdown: recentDateKeys.map((date) => {
        const items = settledByDate.get(date) || [];
        return {
          date,
          settledRecords: items.length,
          totalStakeUsd: sumField(items, stakeField),
          netPnlUsd: sumField(items, pnlField),
        };
      }),
    },
    captureSlots,
  };
}

function summarizeRecordSet(records, pnlField, stakeField) {
  const settled = records.filter(
    (item) => item.status === "resolved" && Number.isFinite(Number(item?.[pnlField])),
  );
  const totalStakeUsd = sumField(settled, stakeField);
  const netPnlUsd = sumField(settled, pnlField);
  return {
    records: records.length,
    settledRecords: settled.length,
    pending: records.filter((item) => item.status !== "resolved").length,
    wins: settled.filter((item) => Number(item?.[pnlField]) > 0).length,
    losses: settled.filter((item) => Number(item?.[pnlField]) < 0).length,
    totalStakeUsd,
    netPnlUsd,
    roi: Number(totalStakeUsd) > 0 ? round(Number(netPnlUsd) / Number(totalStakeUsd), 6) : null,
  };
}

function buildThresholdSimStrategyRows(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.captureSlotId}:${thresholdKey(record.thresholdNoPrice)}`;
    const items = groups.get(key) || [];
    items.push(record);
    groups.set(key, items);
  }

  return THRESHOLD_SIM_CAPTURE_SLOTS.flatMap((slot) =>
    THRESHOLD_SIM_THRESHOLDS.map((threshold) => {
      const key = `${slot.id}:${thresholdKey(threshold)}`;
      const items = groups.get(key) || [];
      return {
        key,
        slotId: slot.id,
        slotLabel: slot.label,
        slotHour: slot.hour,
        slotMinute: slot.minute || 0,
        thresholdNoPrice: threshold,
        thresholdLabel: thresholdLabel(threshold),
        label: `${slot.label} No ${thresholdLabel(threshold)}`,
        summary: summarizeRecordSet(items, "accountingPnlUsd", "stakeUsd"),
      };
    }),
  )
    .sort((left, right) => {
      const slotDiff = left.slotHour * 60 + left.slotMinute - (right.slotHour * 60 + right.slotMinute);
      if (slotDiff !== 0) {
        return slotDiff;
      }
      return Number(left.thresholdNoPrice || 0) - Number(right.thresholdNoPrice || 0);
    });
}

function buildCityProgressiveStrategyWithSequence(records, todayYmd, sequence, sequenceLabel) {
  const progressiveSequence = Array.isArray(sequence)
    ? sequence.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
    : [];
  const resolvedSequence = progressiveSequence.length ? progressiveSequence : buildWeatherLiveStakeSequence();
  const resolvedSequenceLabel =
    sequenceLabel && String(sequenceLabel).trim()
      ? String(sequenceLabel).trim()
      : formatWeatherLiveStakeSequence(resolvedSequence);
  const resultsByKey = new Map();
  const byCity = new Map();

  for (const record of records) {
    const items = byCity.get(record.citySlug) || [];
    items.push(record);
    byCity.set(record.citySlug, items);
  }

  for (const rows of byCity.values()) {
    rows.sort(compareRecordChronology);
    let cyclePnlUsd = 0;
    let stepIndex = 0;
    const rowsByDate = new Map();

    for (const record of rows) {
      const items = rowsByDate.get(record.date) || [];
      items.push(record);
      rowsByDate.set(record.date, items);
    }

    for (const dayRows of rowsByDate.values()) {
      const stakeUsd = resolvedSequence[Math.min(stepIndex, resolvedSequence.length - 1)];
      let dayPnlUsd = 0;
      let hasResolvedRows = false;
      let allRowsResolved = true;

      for (const record of dayRows) {
        let pnlUsd = null;
        let payoutUsd = null;

        if (record.status === "resolved") {
          const scaled = scaleResolvedResult(record, stakeUsd);
          pnlUsd = scaled.pnlUsd;
          payoutUsd = scaled.payoutUsd;
          if (Number.isFinite(Number(pnlUsd))) {
            dayPnlUsd += Number(pnlUsd);
            hasResolvedRows = true;
          } else {
            allRowsResolved = false;
          }
        } else {
          allRowsResolved = false;
        }

        resultsByKey.set(record.key, {
          progressiveStakeUsd: stakeUsd,
          progressivePayoutUsd: payoutUsd,
          progressivePnlUsd: pnlUsd,
          progressiveStepIndex: stepIndex,
          progressiveLossStreakBefore: stepIndex,
          progressiveLossStreakAfter: stepIndex,
          progressiveCyclePnlBefore: round(cyclePnlUsd, 6) ?? cyclePnlUsd,
          progressiveCyclePnlAfter: round(cyclePnlUsd, 6) ?? cyclePnlUsd,
        });
      }

      let nextCyclePnlUsd = cyclePnlUsd;
      let nextStepIndex = stepIndex;
      if (allRowsResolved && hasResolvedRows) {
        if (dayPnlUsd > 0) {
          nextCyclePnlUsd = 0;
          nextStepIndex = 0;
        } else {
          nextCyclePnlUsd = round(cyclePnlUsd + dayPnlUsd, 6) ?? cyclePnlUsd + dayPnlUsd;
          nextStepIndex = Math.min(stepIndex + 1, resolvedSequence.length - 1);
        }
      }

      for (const record of dayRows) {
        const current = resultsByKey.get(record.key) || {};
        resultsByKey.set(record.key, {
          ...current,
          progressiveLossStreakAfter: nextStepIndex,
          progressiveCyclePnlAfter: round(nextCyclePnlUsd, 6) ?? nextCyclePnlUsd,
        });
      }

      cyclePnlUsd = nextCyclePnlUsd;
      stepIndex = nextStepIndex;
    }
  }

  const enrichedRecords = records.map((record) => ({
    ...record,
    ...resultsByKey.get(record.key),
  }));

  return {
    id: `city-progressive-${resolvedSequenceLabel}`,
    label: `同城 ${resolvedSequenceLabel}`,
    scope: "same-city",
    sequence: resolvedSequence,
    records: enrichedRecords,
    summary: summarizePerformance(enrichedRecords, todayYmd, {
      pnlField: "progressivePnlUsd",
      stakeField: "progressiveStakeUsd",
    }),
  };
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    if (left.date !== right.date) {
      return String(right.date).localeCompare(String(left.date));
    }
    if (Number(left.captureSlotHour || 0) !== Number(right.captureSlotHour || 0)) {
      return Number(right.captureSlotHour || 0) - Number(left.captureSlotHour || 0);
    }
    const cityCompare = String(left.cityZh || "").localeCompare(String(right.cityZh || ""), "zh-CN");
    if (cityCompare !== 0) {
      return cityCompare;
    }
    return String(right.capturedAt || "").localeCompare(String(left.capturedAt || ""));
  });
}

function sortMiddayNo95Records(records) {
  return [...records].sort((left, right) => {
    if (left.date !== right.date) {
      return String(right.date).localeCompare(String(left.date));
    }
    if (left.recordType !== right.recordType) {
      return left.recordType === "trade" ? -1 : 1;
    }
    const cityCompare = String(left.cityZh || "").localeCompare(String(right.cityZh || ""), "zh-CN");
    if (cityCompare !== 0) {
      return cityCompare;
    }
    const priceDiff = Number(right.buyNoPrice || 0) - Number(left.buyNoPrice || 0);
    if (priceDiff !== 0) {
      return priceDiff;
    }
    return String(left.marketTitle || "").localeCompare(String(right.marketTitle || ""), "en");
  });
}

function sortThresholdSimRecords(records) {
  return [...records].sort((left, right) => {
    if (left.date !== right.date) {
      return String(right.date).localeCompare(String(left.date));
    }
    if (Number(left.captureSlotHour || 0) !== Number(right.captureSlotHour || 0)) {
      return Number(left.captureSlotHour || 0) - Number(right.captureSlotHour || 0);
    }
    if (Number(left.thresholdNoPrice || 0) !== Number(right.thresholdNoPrice || 0)) {
      return Number(left.thresholdNoPrice || 0) - Number(right.thresholdNoPrice || 0);
    }
    if (left.recordType !== right.recordType) {
      return left.recordType === "trade" ? -1 : 1;
    }
    const cityCompare = String(left.cityZh || "").localeCompare(String(right.cityZh || ""), "zh-CN");
    if (cityCompare !== 0) {
      return cityCompare;
    }
    const priceDiff = Number(right.buyNoPrice || 0) - Number(left.buyNoPrice || 0);
    if (priceDiff !== 0) {
      return priceDiff;
    }
    return String(left.marketTitle || "").localeCompare(String(right.marketTitle || ""), "en");
  });
}

function sortLiveOrderRecords(records) {
  return [...records].sort((left, right) => {
    if (left.date !== right.date) {
      return String(right.date).localeCompare(String(left.date));
    }
    const cityCompare = String(left.cityZh || "").localeCompare(String(right.cityZh || ""), "zh-CN");
    if (cityCompare !== 0) {
      return cityCompare;
    }
    return String(right.placedAt || right.capturedAt || "").localeCompare(
      String(left.placedAt || left.capturedAt || ""),
    );
  });
}

async function syncWeatherMiddayNo95SimulationData(now = new Date()) {
  await ensureDir(DATA_DIR);
  const todayYmd = getLocalDateString(now);
  const existing = await readJson(MIDDAY_NO95_RECORDS_PATH, []);
  const normalizedExisting = (Array.isArray(existing) ? existing : [])
    .map((item) => normalizeMiddayNo95Record(item))
    .filter(Boolean);
  const map = new Map(normalizedExisting.map((item) => [item.key, item]));

  if (isSlotWindowActive(MIDDAY_NO95_CAPTURE_SLOT, MIDDAY_NO95_CAPTURE_WINDOW_MINUTES, now)) {
    for (const config of WEATHER_CITY_CONFIGS) {
      const scanKey = buildMiddayNo95ScanKey(config, todayYmd);
      if (map.has(scanKey)) {
        continue;
      }
      try {
        const { scanRecord, tradeRecords } = await createMiddayNo95RecordsForCity(config, todayYmd);
        if (scanRecord) {
          map.set(scanKey, scanRecord);
        }
        for (const tradeRecord of tradeRecords) {
          map.set(tradeRecord.key, tradeRecord);
        }
      } catch (error) {
        map.set(
          scanKey,
          normalizeMiddayNo95Record({
            key: scanKey,
            recordType: "scan",
            strategyId: MIDDAY_NO95_STRATEGY_ID,
            strategyLabel: "12:30 95-99c",
            date: todayYmd,
            citySlug: config.citySlug,
            cityZh: config.cityZh,
            cityEn: config.cityEn,
            capturedAt: new Date().toISOString(),
            status: "sync-error",
            result: "sync-error",
            selectedCount: 0,
            minThresholdNoPrice: MIDDAY_NO95_MIN_THRESHOLD,
            maxThresholdNoPrice: MIDDAY_NO95_MAX_THRESHOLD,
            note: `${config.note || ""}${config.note ? " | " : ""}${error?.message || error}`,
          }),
        );
      }
    }
  }

  const refreshed = await refreshRecordResolutions(
    [...map.values()].map((item) => normalizeMiddayNo95Record(item)).filter(Boolean),
  );
  const storedRecords = sortMiddayNo95Records(
    refreshed.map((item) => normalizeMiddayNo95Record(item)).filter(Boolean),
  );
  await writeJson(MIDDAY_NO95_RECORDS_PATH, storedRecords);

  const tradeRecords = storedRecords.filter((item) => item.recordType === "trade");
  const summary = summarizePerformance(tradeRecords, todayYmd, {
    pnlField: "pnlUsd",
    stakeField: "stakeUsd",
  });
  const firstTradeDate = tradeRecords.length
    ? [...tradeRecords].sort(compareRecordChronology)[0]?.date || null
    : null;

  return {
    id: MIDDAY_NO95_STRATEGY_ID,
    label: "12:30 95-99c",
    minThresholdNoPrice: MIDDAY_NO95_MIN_THRESHOLD,
    maxThresholdNoPrice: MIDDAY_NO95_MAX_THRESHOLD,
    stakeUsd: MIDDAY_NO95_STAKE_USD,
    captureSlot: { ...MIDDAY_NO95_CAPTURE_SLOT },
    activeCapture: isSlotWindowActive(MIDDAY_NO95_CAPTURE_SLOT, MIDDAY_NO95_CAPTURE_WINDOW_MINUTES, now),
    records: tradeRecords,
    scanRecords: storedRecords.filter((item) => item.recordType === "scan"),
    summary,
    startedAt: firstTradeDate,
  };
}

async function syncWeatherThresholdSimulationData(now = new Date()) {
  await ensureDir(DATA_DIR);
  const todayYmd = getLocalDateString(now);
  const existing = await readJson(THRESHOLD_SIM_RECORDS_PATH, []);
  const normalizedExisting = (Array.isArray(existing) ? existing : [])
    .map((item) => normalizeThresholdSimRecord(item))
    .filter(Boolean);
  const map = new Map(normalizedExisting.map((item) => [item.key, item]));
  const activeSlots = THRESHOLD_SIM_CAPTURE_SLOTS.filter((slot) =>
    isSlotWindowActive(slot, THRESHOLD_SIM_CAPTURE_WINDOW_MINUTES, now),
  );

  for (const slot of activeSlots) {
    for (const config of WEATHER_CITY_CONFIGS) {
      const scanKeys = THRESHOLD_SIM_THRESHOLDS.map((threshold) =>
        buildThresholdSimScanKey(config, todayYmd, slot, threshold),
      );
      if (scanKeys.every((key) => map.has(key))) {
        continue;
      }
      try {
        const { scanRecords, tradeRecords } = await createThresholdSimRecordsForCity(config, todayYmd, slot);
        for (const scanRecord of scanRecords) {
          map.set(scanRecord.key, scanRecord);
        }
        for (const tradeRecord of tradeRecords) {
          map.set(tradeRecord.key, tradeRecord);
        }
      } catch (error) {
        for (const threshold of THRESHOLD_SIM_THRESHOLDS) {
          const scanRecord = normalizeThresholdSimRecord({
            key: buildThresholdSimScanKey(config, todayYmd, slot, threshold),
            recordType: "scan",
            strategyId: THRESHOLD_SIM_STRATEGY_ID,
            strategyLabel: `${slot.label} No ${thresholdLabel(threshold)}`,
            date: todayYmd,
            captureSlotId: slot.id,
            captureSlotLabel: slot.label,
            captureSlotHour: slot.hour,
            captureSlotMinute: slot.minute || 0,
            citySlug: config.citySlug,
            cityZh: config.cityZh,
            cityEn: config.cityEn,
            capturedAt: new Date().toISOString(),
            status: "sync-error",
            result: "sync-error",
            selectedCount: 0,
            thresholdNoPrice: threshold,
            note: `${config.note || ""}${config.note ? " | " : ""}${error?.message || error}`,
          });
          if (scanRecord) {
            map.set(scanRecord.key, scanRecord);
          }
        }
      }
    }
  }

  const refreshed = await refreshRecordResolutions(
    [...map.values()].map((item) => normalizeThresholdSimRecord(item)).filter(Boolean),
  );
  const storedRecords = sortThresholdSimRecords(
    refreshed.map((item) => normalizeThresholdSimRecord(item)).filter(Boolean),
  );
  await writeJson(THRESHOLD_SIM_RECORDS_PATH, storedRecords);

  const tradeRecords = storedRecords.filter((item) => item.recordType === "trade");
  const summary = summarizePerformance(tradeRecords, todayYmd, {
    pnlField: "accountingPnlUsd",
    stakeField: "stakeUsd",
  });
  const firstTradeDate = tradeRecords.length
    ? [...tradeRecords].sort(compareRecordChronology)[0]?.date || null
    : null;

  return {
    id: THRESHOLD_SIM_STRATEGY_ID,
    label: `天气模拟 No ${THRESHOLD_SIM_THRESHOLDS.map(thresholdLabel).join(" / ")}`,
    stakeUsd: THRESHOLD_SIM_STAKE_USD,
    captureSlots: THRESHOLD_SIM_CAPTURE_SLOTS.map((slot) => ({ ...slot })),
    thresholds: THRESHOLD_SIM_THRESHOLDS,
    activeCaptureSlots: activeSlots.map((slot) => ({ ...slot })),
    records: tradeRecords,
    scanRecords: storedRecords.filter((item) => item.recordType === "scan"),
    strategyRows: buildThresholdSimStrategyRows(tradeRecords),
    summary,
    startedAt: firstTradeDate,
  };
}

function getCaptureStateKey(ymd, slotLike) {
  const slot = getCaptureSlot(slotLike);
  return `${ymd}:${slot.id}`;
}

function isRetryableCaptureRecord(record) {
  if (!record) {
    return true;
  }
  if (["sync-error", "forecast-unavailable", "market-unavailable"].includes(record.status)) {
    return true;
  }
  return !Number.isFinite(Number(record.buyNoPrice));
}

function getMissingCaptureCities(map, ymd, slotLike) {
  const slot = getCaptureSlot(slotLike);
  return WEATHER_CITY_CONFIGS.filter((config) =>
    isRetryableCaptureRecord(map.get(buildRecordKey(config, ymd, slot))),
  );
}

function getCaptureStateEntry(state, ymd, slotLike) {
  const key = getCaptureStateKey(ymd, slotLike);
  const entry = state && typeof state === "object" ? state[key] : null;
  return entry && typeof entry === "object" ? entry : {};
}

function shouldRetryMissingCapture(state, ymd, slotLike, now) {
  const entry = getCaptureStateEntry(state, ymd, slotLike);
  const lastAttemptMs = Number(entry.lastAttemptMs || 0);
  return !lastAttemptMs || now.getTime() - lastAttemptMs >= MISSING_CAPTURE_RETRY_MS;
}

function buildCapturePlans({ map, todayYmd, activeCaptureSlot, captureState, now }) {
  const plans = new Map();
  if (activeCaptureSlot) {
    plans.set(activeCaptureSlot.id, {
      slot: activeCaptureSlot,
      captureMode: "scheduled",
      reason: "active-window",
    });
  }

  if (!MISSING_CAPTURE_BACKFILL_ENABLED) {
    return [...plans.values()];
  }

  for (const slot of ENABLED_CAPTURE_SLOTS) {
    if (!hasSlotStarted(slot, now)) {
      continue;
    }
    if (plans.has(slot.id)) {
      continue;
    }
    const missingCities = getMissingCaptureCities(map, todayYmd, slot);
    if (!missingCities.length) {
      continue;
    }
    if (!shouldRetryMissingCapture(captureState, todayYmd, slot, now)) {
      continue;
    }
    plans.set(slot.id, {
      slot,
      captureMode: "missing-backfill",
      reason: "missing-capture-backfill",
    });
  }

  return [...plans.values()];
}

function buildCaptureBackfillStatus({ map, todayYmd, captureState, now }) {
  return {
    enabled: MISSING_CAPTURE_BACKFILL_ENABLED,
    retryMs: MISSING_CAPTURE_RETRY_MS,
    slots: ENABLED_CAPTURE_SLOTS.map((slot) => {
      const key = getCaptureStateKey(todayYmd, slot);
      const entry = getCaptureStateEntry(captureState, todayYmd, slot);
      const missingCities = hasSlotStarted(slot, now) ? getMissingCaptureCities(map, todayYmd, slot) : [];
      const lastAttemptMs = Number(entry.lastAttemptMs || 0);
      const nextAttemptMs =
        missingCities.length && lastAttemptMs
          ? Math.max(lastAttemptMs + MISSING_CAPTURE_RETRY_MS, now.getTime())
          : null;
      return {
        key,
        slotId: slot.id,
        slotLabel: slot.label,
        slotHour: slot.hour,
        slotMinute: slot.minute || 0,
        started: hasSlotStarted(slot, now),
        complete: missingCities.length === 0 && hasSlotStarted(slot, now),
        missingCount: missingCities.length,
        missingCities: missingCities.map((config) => ({
          citySlug: config.citySlug,
          cityZh: config.cityZh,
        })),
        lastAttemptAt: entry.lastAttemptAt || null,
        nextAttemptAt: nextAttemptMs ? new Date(nextAttemptMs).toISOString() : null,
        completedAt: entry.completedAt || null,
        attempts: Number(entry.attempts || 0),
      };
    }),
  };
}

function updateCaptureStateForSlot(state, ymd, slotLike, missingCities, now, processed) {
  const slot = getCaptureSlot(slotLike);
  const key = getCaptureStateKey(ymd, slot);
  const existing = getCaptureStateEntry(state, ymd, slot);
  const next = {
    ...existing,
    date: ymd,
    slotId: slot.id,
    slotLabel: slot.label,
    missingCities: missingCities.map((config) => config.citySlug),
    missingCount: missingCities.length,
    updatedAt: now.toISOString(),
  };

  if (processed) {
    next.lastAttemptMs = now.getTime();
    next.lastAttemptAt = now.toISOString();
    next.attempts = Number(existing.attempts || 0) + 1;
  }
  if (!missingCities.length) {
    next.completedAt = existing.completedAt || now.toISOString();
  } else {
    delete next.completedAt;
  }

  state[key] = next;
}

export async function syncWeatherPredictionData(now = new Date(), liveConfig = null) {
  await ensureDir(DATA_DIR);
  const todayYmd = getLocalDateString(now);
  const activeCaptureSlot = resolveActiveCaptureSlot(now);
  const existing = await readJson(RECORDS_PATH, []);
  const captureState = (await readJson(MISSING_CAPTURE_STATE_PATH, {})) || {};
  const normalizedExisting = (Array.isArray(existing) ? existing : [])
    .map((item) => normalizeRecord(item))
    .filter(Boolean);
  const map = new Map(normalizedExisting.map((item) => [item.key, item]));
  const capturePlans = buildCapturePlans({
    map,
    todayYmd,
    activeCaptureSlot,
    captureState,
    now,
  });
  const processedSlotIds = new Set();

  for (const plan of capturePlans) {
    const activeSlot = plan.slot;
    processedSlotIds.add(activeSlot.id);
    for (const config of WEATHER_CITY_CONFIGS) {
      const key = buildRecordKey(config, todayYmd, activeSlot);
      const existingRecord = map.get(key);
      if (existingRecord && !isRetryableCaptureRecord(existingRecord)) {
        map.set(key, await enrichRecordOffsetCandidates(mergeConfigIntoRecord(existingRecord, config), config));
        continue;
      }
      try {
        map.set(
          key,
          await createDailyRecord(config, todayYmd, activeSlot, {
            captureMode: plan.captureMode,
          }),
        );
      } catch (error) {
        map.set(
          key,
          normalizeRecord({
            key,
            date: todayYmd,
            captureSlotId: activeSlot.id,
            captureSlotLabel: activeSlot.label,
            captureSlotHour: activeSlot.hour,
            captureSlotMinute: activeSlot.minute || 0,
            captureMode: plan.captureMode,
            missingCaptureBackfill: plan.captureMode === "missing-backfill",
            scheduledCaptureLabel: activeSlot.label,
            citySlug: config.citySlug,
            cityZh: config.cityZh,
            cityEn: config.cityEn,
            capturedAt: new Date().toISOString(),
            stakeUsd: BASE_STAKE_USD,
            status: "sync-error",
            result: "抓取失败",
            pnlUsd: null,
            note: `${config.note || ""}${config.note ? " | " : ""}${error?.message || error}`,
          }),
        );
      }
    }
  }

  for (const config of WEATHER_CITY_CONFIGS) {
    const key = buildRecordKey(config, todayYmd, DEFAULT_CAPTURE_SLOT);
    const existingRecord = map.get(key);
    if (existingRecord && !Array.isArray(existingRecord.candidateMarkets)) {
      map.set(key, await enrichRecordOffsetCandidates(mergeConfigIntoRecord(existingRecord, config), config));
    }
  }

  for (const [key, record] of map.entries()) {
    const normalized = normalizeRecord(record);
    if (normalized) {
      map.set(key, normalized);
    }
  }

  const refreshedRecords = await refreshRecordResolutions(
    [...map.values()]
      .map((item) => normalizeRecord(item))
      .filter(Boolean),
  );

  const storedRecords = sortRecords(refreshedRecords.map((item) => normalizeRecord(item)).filter(Boolean));
  await writeJson(RECORDS_PATH, storedRecords);
  const refreshedMap = new Map(storedRecords.map((item) => [item.key, item]));
  for (const slot of ENABLED_CAPTURE_SLOTS) {
    if (!hasSlotStarted(slot, now)) {
      continue;
    }
    updateCaptureStateForSlot(
      captureState,
      todayYmd,
      slot,
      getMissingCaptureCities(refreshedMap, todayYmd, slot),
      now,
      processedSlotIds.has(slot.id),
    );
  }
  await writeJson(MISSING_CAPTURE_STATE_PATH, captureState);
  const captureBackfill = buildCaptureBackfillStatus({
    map: refreshedMap,
    todayYmd,
    captureState,
    now,
  });

  const baseSummary = summarizePerformance(storedRecords, todayYmd, {
    pnlField: "pnlUsd",
    stakeField: "stakeUsd",
  });
  const sequence = liveConfig?.liveStakeSequence || buildWeatherLiveStakeSequence();
  const sequenceLabel = liveConfig?.liveSequenceLabel || formatWeatherLiveStakeSequence(sequence);
  const progressiveStrategy = buildCityProgressiveStrategyWithSequence(
    storedRecords,
    todayYmd,
    sequence,
    sequenceLabel,
  );
  const records = sortRecords(progressiveStrategy.records);

  return {
    generatedAt: new Date().toISOString(),
    localDate: todayYmd,
    localHour: getLocalHour(now),
    activeCaptureSlot: activeCaptureSlot ? { ...activeCaptureSlot } : null,
    captureBackfill,
    records,
    summary: baseSummary,
    strategies: {
      cityProgressive125: {
        id: progressiveStrategy.id,
        label: progressiveStrategy.label,
        scope: progressiveStrategy.scope,
        sequence: progressiveStrategy.sequence,
        summary: progressiveStrategy.summary,
      },
    },
  };
}

async function readWeatherPredictionDataSnapshot(now = new Date(), liveConfig = null) {
  await ensureDir(DATA_DIR);
  const todayYmd = getLocalDateString(now);
  const activeCaptureSlot = resolveActiveCaptureSlot(now);
  const existing = await readJson(RECORDS_PATH, []);
  const captureState = (await readJson(MISSING_CAPTURE_STATE_PATH, {})) || {};
  const storedRecords = sortRecords(
    (Array.isArray(existing) ? existing : [])
      .map((item) => normalizeRecord(item))
      .filter(Boolean),
  );
  const map = new Map(storedRecords.map((item) => [item.key, item]));
  const baseSummary = summarizePerformance(storedRecords, todayYmd, {
    pnlField: "pnlUsd",
    stakeField: "stakeUsd",
  });
  const sequence = liveConfig?.liveStakeSequence || buildWeatherLiveStakeSequence();
  const sequenceLabel = liveConfig?.liveSequenceLabel || formatWeatherLiveStakeSequence(sequence);
  const progressiveStrategy = buildCityProgressiveStrategyWithSequence(
    storedRecords,
    todayYmd,
    sequence,
    sequenceLabel,
  );

  return {
    generatedAt: new Date().toISOString(),
    localDate: todayYmd,
    localHour: getLocalHour(now),
    activeCaptureSlot: activeCaptureSlot ? { ...activeCaptureSlot } : null,
    captureBackfill: buildCaptureBackfillStatus({
      map,
      todayYmd,
      captureState,
      now,
    }),
    records: sortRecords(progressiveStrategy.records),
    summary: baseSummary,
    strategies: {
      cityProgressive125: {
        id: progressiveStrategy.id,
        label: progressiveStrategy.label,
        scope: progressiveStrategy.scope,
        sequence: progressiveStrategy.sequence,
        summary: progressiveStrategy.summary,
      },
    },
  };
}

async function readWeatherMiddayNo95SimulationData(now = new Date()) {
  await ensureDir(DATA_DIR);
  const todayYmd = getLocalDateString(now);
  const existing = await readJson(MIDDAY_NO95_RECORDS_PATH, []);
  const storedRecords = sortMiddayNo95Records(
    (Array.isArray(existing) ? existing : [])
      .map((item) => normalizeMiddayNo95Record(item))
      .filter(Boolean),
  );
  const tradeRecords = storedRecords.filter((item) => item.recordType === "trade");
  const summary = summarizePerformance(tradeRecords, todayYmd, {
    pnlField: "pnlUsd",
    stakeField: "stakeUsd",
  });
  const firstTradeDate = tradeRecords.length
    ? [...tradeRecords].sort(compareRecordChronology)[0]?.date || null
    : null;

  return {
    id: MIDDAY_NO95_STRATEGY_ID,
    label: "12:30 95-99c",
    minThresholdNoPrice: MIDDAY_NO95_MIN_THRESHOLD,
    maxThresholdNoPrice: MIDDAY_NO95_MAX_THRESHOLD,
    stakeUsd: MIDDAY_NO95_STAKE_USD,
    captureSlot: { ...MIDDAY_NO95_CAPTURE_SLOT },
    activeCapture: isSlotWindowActive(MIDDAY_NO95_CAPTURE_SLOT, MIDDAY_NO95_CAPTURE_WINDOW_MINUTES, now),
    records: tradeRecords,
    scanRecords: storedRecords.filter((item) => item.recordType === "scan"),
    summary,
    startedAt: firstTradeDate,
  };
}

function getRecordOffsetCandidates(record) {
  const candidates = Array.isArray(record?.candidateMarkets) ? record.candidateMarkets : [];
  const normalized = candidates
    .map((candidate) => {
      const offset = Number(candidate?.temperatureOffsetC);
      const buyNoPrice = Number(candidate?.buyNoPrice);
      if (!Number.isInteger(offset) || !WEATHER_TEMPERATURE_OFFSET_OPTIONS.includes(offset) || !candidate?.marketSlug) {
        return null;
      }
      return {
        temperatureOffsetC: offset,
        targetTempC: toReasonableTemperature(candidate.targetTempC ?? Number(record?.forecastMaxTempC) + offset),
        marketSlug: candidate.marketSlug,
        marketTitle: candidate.marketTitle || candidate.marketQuestion || null,
        marketQuestion: candidate.marketQuestion || null,
        marketSelectionMode: candidate.marketSelectionMode || null,
        marketBucketKind: candidate.marketBucketKind || "exact",
        marketBucketValue: toReasonableTemperature(candidate.marketBucketValue ?? candidate.targetTempC),
        buyNoPrice: Number.isFinite(buyNoPrice) ? round(buyNoPrice, 4) : null,
        marketClosed: Boolean(candidate.marketClosed),
      };
    })
    .filter(Boolean);

  if (normalized.length) {
    return normalized;
  }
  if (!record?.marketSlug) {
    return [];
  }
  const buyNoPrice = Number(record?.buyNoPrice);
  return [
    {
      temperatureOffsetC: Number(record?.temperatureOffsetC) || 0,
      targetTempC: toReasonableTemperature(record?.targetTempC ?? record?.forecastMaxTempC),
      marketSlug: record.marketSlug,
      marketTitle: record.marketTitle || record.marketQuestion || null,
      marketQuestion: record.marketQuestion || null,
      marketSelectionMode: record.marketSelectionMode || null,
      marketBucketKind: record.marketBucketKind || "exact",
      marketBucketValue: toReasonableTemperature(record?.marketBucketValue ?? record?.targetTempC ?? record?.forecastMaxTempC),
      buyNoPrice: Number.isFinite(buyNoPrice) ? round(buyNoPrice, 4) : null,
      marketClosed: Boolean(record.marketClosed),
    },
  ];
}

function didWeatherBucketResolveYes(candidate, actualMaxTempC) {
  const actual = toReasonableTemperature(actualMaxTempC);
  const bucketValue = toReasonableTemperature(candidate?.marketBucketValue ?? candidate?.targetTempC);
  if (!Number.isFinite(actual) || !Number.isFinite(bucketValue)) {
    return null;
  }
  if (candidate?.marketBucketKind === "lower") {
    return actual <= bucketValue;
  }
  if (candidate?.marketBucketKind === "upper") {
    return actual >= bucketValue;
  }
  return actual === bucketValue;
}

function buildWeatherOffsetSimulation(records, todayYmd, liveConfig = null) {
  const simRecords = [];
  for (const record of records || []) {
    const candidates = getRecordOffsetCandidates(record);
    for (const candidate of candidates) {
      const buyNoPrice = Number(candidate.buyNoPrice);
      if (!Number.isFinite(buyNoPrice) || buyNoPrice <= 0 || buyNoPrice >= 1) {
        continue;
      }
      const yesWins = didWeatherBucketResolveYes(candidate, record.actualMaxTempC);
      const resolved = record.status === "resolved" && yesWins !== null;
      const stakeUsd = BASE_STAKE_USD;
      const accountingPnlUsd = resolved
        ? yesWins
          ? -stakeUsd
          : round(stakeUsd / buyNoPrice - stakeUsd, 6)
        : null;
      simRecords.push({
        key: [
          record.date,
          WEATHER_OFFSET_SIM_STRATEGY_ID,
          record.captureSlotId || DEFAULT_CAPTURE_SLOT.id,
          record.citySlug,
          `offset-${candidate.temperatureOffsetC}`,
          candidate.marketSlug,
        ].join(":"),
        strategyId: WEATHER_OFFSET_SIM_STRATEGY_ID,
        strategyLabel: `${candidate.temperatureOffsetC > 0 ? "+" : ""}${candidate.temperatureOffsetC}C`,
        date: record.date,
        captureSlotId: record.captureSlotId,
        captureSlotLabel: record.captureSlotLabel,
        citySlug: record.citySlug,
        cityZh: record.cityZh,
        cityEn: record.cityEn,
        forecastTarget: record.forecastTarget,
        forecastMinTempC: record.forecastMinTempC,
        forecastMaxTempC: record.forecastMaxTempC,
        actualMaxTempC: record.actualMaxTempC,
        temperatureDeltaC: record.temperatureDeltaC,
        temperatureOffsetC: candidate.temperatureOffsetC,
        targetTempC: candidate.targetTempC,
        marketSlug: candidate.marketSlug,
        marketTitle: candidate.marketTitle,
        marketQuestion: candidate.marketQuestion,
        marketBucketKind: candidate.marketBucketKind,
        marketBucketValue: candidate.marketBucketValue,
        buyNoPrice,
        stakeUsd,
        status: resolved ? "resolved" : "pending",
        resolvedOutcome: resolved ? (yesWins ? "yes" : "no") : null,
        accountingPnlUsd,
        eventSlug: record.eventSlug,
        eventUrl: record.eventUrl,
        capturedAt: record.capturedAt,
      });
    }
  }

  const strategyRows = WEATHER_TEMPERATURE_OFFSET_OPTIONS.map((offset) => {
    const rows = simRecords.filter((record) => record.temperatureOffsetC === offset);
    return {
      key: String(offset),
      temperatureOffsetC: offset,
      label: `${offset > 0 ? "+" : ""}${offset}C`,
      selected: (liveConfig?.temperatureOffsets || []).includes(offset),
      liveConfig: liveConfig?.offsetStrategies?.[String(offset)] || null,
      summary: summarizePerformance(rows, todayYmd, {
        pnlField: "accountingPnlUsd",
        stakeField: "stakeUsd",
      }).overall,
    };
  });
  return {
    id: WEATHER_OFFSET_SIM_STRATEGY_ID,
    label: "Weather -1/0/+1 offset simulation",
    stakeUsd: BASE_STAKE_USD,
    offsets: WEATHER_TEMPERATURE_OFFSET_OPTIONS,
    selectedOffsets: liveConfig?.temperatureOffsets || [0],
    executionMode: liveConfig?.executionMode || "live",
    records: sortRecords(simRecords),
    strategyRows,
    summary: summarizePerformance(simRecords, todayYmd, {
      pnlField: "accountingPnlUsd",
      stakeField: "stakeUsd",
    }),
  };
}

async function readWeatherThresholdSimulationData(now = new Date()) {
  await ensureDir(DATA_DIR);
  const todayYmd = getLocalDateString(now);
  const activeSlots = THRESHOLD_SIM_CAPTURE_SLOTS.filter((slot) =>
    isSlotWindowActive(slot, THRESHOLD_SIM_CAPTURE_WINDOW_MINUTES, now),
  );
  const existing = await readJson(THRESHOLD_SIM_RECORDS_PATH, []);
  const storedRecords = sortThresholdSimRecords(
    (Array.isArray(existing) ? existing : [])
      .map((item) => normalizeThresholdSimRecord(item))
      .filter(Boolean),
  );
  const tradeRecords = storedRecords.filter((item) => item.recordType === "trade");
  const summary = summarizePerformance(tradeRecords, todayYmd, {
    pnlField: "accountingPnlUsd",
    stakeField: "stakeUsd",
  });
  const firstTradeDate = tradeRecords.length
    ? [...tradeRecords].sort(compareRecordChronology)[0]?.date || null
    : null;

  return {
    id: THRESHOLD_SIM_STRATEGY_ID,
    label: `天气模拟 No ${THRESHOLD_SIM_THRESHOLDS.map(thresholdLabel).join(" / ")}`,
    stakeUsd: THRESHOLD_SIM_STAKE_USD,
    captureSlots: THRESHOLD_SIM_CAPTURE_SLOTS.map((slot) => ({ ...slot })),
    thresholds: THRESHOLD_SIM_THRESHOLDS,
    activeCaptureSlots: activeSlots.map((slot) => ({ ...slot })),
    records: tradeRecords,
    scanRecords: storedRecords.filter((item) => item.recordType === "scan"),
    strategyRows: buildThresholdSimStrategyRows(tradeRecords),
    summary,
    startedAt: firstTradeDate,
  };
}

function buildLiveOrderSummary(records, todayYmd) {
  const activeRecords = records.filter(isActiveLiveOrder).map((record) => ({
    ...record,
    accountingStakeUsd: resolveAccountingStakeUsd(record),
    accountingPnlUsd: computeWeatherAccountingPnl(record),
    accountingPnlMethod:
      computeWeatherAccountingPnl(record) === null ? null : "estimated-win-or-stake-loss",
  }));
  const summary = summarizePerformance(activeRecords, todayYmd, {
    pnlField: "accountingPnlUsd",
    stakeField: "accountingStakeUsd",
  });
  const todayRecords = activeRecords.filter((item) => item.date === todayYmd);
  const confirmedPending = activeRecords.filter(
    (item) =>
      item.status !== "resolved" &&
      Number(item.actualBuyCostUsd ?? item.stakeUsd ?? 0) > 0,
  );
  const todayConfirmedPending = todayRecords.filter(
    (item) =>
      item.status !== "resolved" &&
      Number(item.actualBuyCostUsd ?? item.stakeUsd ?? 0) > 0,
  );
  summary.overall.pending = confirmedPending.length;
  summary.today.pending = todayConfirmedPending.length;
  summary.overall.submittedStakeUsd = sumField(activeRecords, "accountingStakeUsd");
  summary.today.submittedStakeUsd = sumField(todayRecords, "accountingStakeUsd");
  return { activeRecords, summary };
}

function selectWeatherReviewRecord(records, date, citySlug) {
  return (records || [])
    .filter((record) => record.date === date && record.citySlug === citySlug)
    .sort((left, right) => {
      const leftPreferred = left.captureSlotId === DEFAULT_CAPTURE_SLOT.id ? 0 : 1;
      const rightPreferred = right.captureSlotId === DEFAULT_CAPTURE_SLOT.id ? 0 : 1;
      if (leftPreferred !== rightPreferred) {
        return leftPreferred - rightPreferred;
      }
      const slotCompare = compareCaptureSlots(left.captureSlotId, right.captureSlotId);
      if (slotCompare !== 0) {
        return slotCompare;
      }
      return String(right.capturedAt || "").localeCompare(String(left.capturedAt || ""));
    })[0] ?? null;
}

function buildWeatherReview(records, todayYmd) {
  const dates = buildRecentLocalDateStrings(todayYmd, 7);
  const rows = WEATHER_CITY_CONFIGS.map((config) => {
    const cells = dates.map((date) => {
      const record = selectWeatherReviewRecord(records, date, config.citySlug);
      const forecastMaxTempC = toReasonableTemperature(record?.forecastMaxTempC ?? record?.targetTempC);
      const forecastMinTempC = toReasonableTemperature(record?.forecastMinTempC);
      const actualMaxTempC = toReasonableTemperature(record?.actualMaxTempC);
      const deltaC =
        Number.isFinite(Number(record?.temperatureDeltaC)) &&
        Number.isFinite(actualMaxTempC) &&
        Number.isFinite(forecastMaxTempC)
          ? Number(record.temperatureDeltaC)
          : Number.isFinite(actualMaxTempC) && Number.isFinite(forecastMaxTempC)
            ? round(actualMaxTempC - forecastMaxTempC, 1)
            : null;
      return {
        date,
        key: `${date}:${config.citySlug}`,
        citySlug: config.citySlug,
        cityZh: config.cityZh,
        cityEn: config.cityEn,
        forecastMinTempC,
        forecastMaxTempC,
        actualMaxTempC,
        actualTempLabel: record?.actualTempLabel ?? null,
        actualTempBucketKind: record?.actualTempBucketKind ?? null,
        deltaC,
        status: record?.status || "missing",
        eventUrl: record?.eventUrl || null,
        marketTitle: record?.marketTitle || null,
      };
    });
    const positiveOver3Cells = cells.filter((cell) => Number.isFinite(cell.deltaC) && cell.deltaC > 3);
    const maxPositiveDeltaC = cells.reduce((max, cell) => {
      if (!Number.isFinite(cell.deltaC)) {
        return max;
      }
      return Math.max(max, cell.deltaC);
    }, 0);
    return {
      citySlug: config.citySlug,
      cityZh: config.cityZh,
      cityEn: config.cityEn,
      forecastTarget: config.forecastTarget,
      cells,
      positiveOver3Count: positiveOver3Cells.length,
      maxPositiveDeltaC: round(maxPositiveDeltaC, 1) ?? 0,
      positiveOver3Dates: positiveOver3Cells.map((cell) => ({
        date: cell.date,
        deltaC: cell.deltaC,
        actualMaxTempC: cell.actualMaxTempC,
        forecastMaxTempC: cell.forecastMaxTempC,
      })),
    };
  });
  const positiveOver3Ranking = rows
    .filter((row) => row.positiveOver3Count > 0)
    .sort((left, right) => {
      if (right.positiveOver3Count !== left.positiveOver3Count) {
        return right.positiveOver3Count - left.positiveOver3Count;
      }
      return Number(right.maxPositiveDeltaC || 0) - Number(left.maxPositiveDeltaC || 0);
    });
  const allCells = rows.flatMap((row) => row.cells);
  const resolvedCells = allCells.filter((cell) => Number.isFinite(cell.deltaC));
  const maxPositiveDeltaC = resolvedCells.reduce((max, cell) => Math.max(max, cell.deltaC), 0);

  return {
    dates,
    rows,
    positiveOver3Ranking,
    summary: {
      cityCount: rows.length,
      dayCount: dates.length,
      resolvedCells: resolvedCells.length,
      positiveOver3Count: positiveOver3Ranking.reduce(
        (sum, row) => sum + row.positiveOver3Count,
        0,
      ),
      maxPositiveDeltaC: round(maxPositiveDeltaC, 1) ?? 0,
    },
  };
}

async function syncWeatherLiveOrderData(now = new Date()) {
  await ensureDir(DATA_DIR);
  const todayYmd = getLocalDateString(now);
  const liveConfig = await readWeatherLiveConfig();
  const existing = await readJson(LIVE_ORDER_RECORDS_PATH, []);
  const normalizedExisting = (Array.isArray(existing) ? existing : [])
    .map((item) => normalizeLiveOrderRecord(item))
    .filter(Boolean);
  const refreshed = await refreshRecordResolutions(normalizedExisting);
  const storedRecords = sortLiveOrderRecords(
    refreshed.map((item) => normalizeLiveOrderRecord(item)).filter(Boolean),
  );
  await writeJson(LIVE_ORDER_RECORDS_PATH, storedRecords);
  const { activeRecords, summary } = buildLiveOrderSummary(storedRecords, todayYmd);
  const firstTradeDate = activeRecords.length
    ? [...activeRecords].sort(compareRecordChronology)[0]?.date || null
    : null;

  return {
    id: WEATHER_LIVE_STRATEGY_ID,
    label: `天气实盘同城 ${liveConfig.liveSequenceLabel}`,
    records: activeRecords,
    summary,
    startedAt: firstTradeDate,
  };
}

async function readWeatherLiveOrderData(now = new Date()) {
  await ensureDir(DATA_DIR);
  const todayYmd = getLocalDateString(now);
  const liveConfig = await readWeatherLiveConfig();
  const existing = await readJson(LIVE_ORDER_RECORDS_PATH, []);
  const storedRecords = sortLiveOrderRecords(
    (Array.isArray(existing) ? existing : [])
      .map((item) => normalizeLiveOrderRecord(item))
      .filter(Boolean),
  );
  const { activeRecords, summary } = buildLiveOrderSummary(storedRecords, todayYmd);
  const firstTradeDate = activeRecords.length
    ? [...activeRecords].sort(compareRecordChronology)[0]?.date || null
    : null;

  return {
    id: WEATHER_LIVE_STRATEGY_ID,
    label: `天气实盘同城 ${liveConfig.liveSequenceLabel}`,
    records: activeRecords,
    summary,
    startedAt: firstTradeDate,
  };
}

export async function getWeatherDashboardSnapshot(options = {}) {
  const now = new Date();
  const shouldSync = options?.sync !== false;
  const liveConfig = await readWeatherLiveConfig();
  const [baseSnapshot, middayNo95, liveOrders] = shouldSync
    ? await Promise.all([
        syncWeatherPredictionData(now, liveConfig),
        syncWeatherMiddayNo95SimulationData(now),
        syncWeatherLiveOrderData(now),
      ])
    : await Promise.all([
        readWeatherPredictionDataSnapshot(now, liveConfig),
        readWeatherMiddayNo95SimulationData(now),
        readWeatherLiveOrderData(now),
      ]);
  const offsetSimulation = buildWeatherOffsetSimulation(baseSnapshot.records || [], baseSnapshot.localDate, liveConfig);
  return {
    ...baseSnapshot,
    weatherReview: buildWeatherReview(baseSnapshot.records || [], baseSnapshot.localDate),
    middayNo95,
    thresholdSim: offsetSimulation,
    offsetSimulation,
    liveOrders,
    liveConfig,
    serviceStatus: getWeatherServiceStatus(),
  };
}

export async function previewWeatherForecast(citySlug, ymd = getLocalDateString()) {
  const config = WEATHER_CITY_CONFIGS.find((item) => item.citySlug === citySlug);
  if (!config) {
    return null;
  }
  return fetchForecastForCity(config, ymd);
}

export { formatDisplayDate };
