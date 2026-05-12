import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import { WEATHER_CITY_CONFIGS } from "./weather-data.js";

const require = createRequire(import.meta.url);
const { fetchJson: sharedFetchJson } = require("../scripts/shared/http.js");

const TZ = "Asia/Shanghai";
const DATA_DIR = path.join(process.cwd(), "data", "weather_predictions");
const ROTATION_RECORDS_PATH = path.join(DATA_DIR, "rotation-sim-orders.json");
const STAKE_USD = 1;
const MAX_NO_PRICE = 0.95;
const PRICE_EPSILON = 0.001;
const RESOLUTION_WIN_PRICE = 0.99;
const RESOLUTION_LOSE_PRICE = 0.01;
const CAPTURE_WINDOW_MINUTES = Number(process.env.WEATHER_ROTATION_CAPTURE_WINDOW_MINUTES || 240);

const OVERSEAS_CITIES = [
  {
    citySlug: "nyc",
    cityZh: "纽约",
    cityEn: "NYC",
    eventBaseSlug: "highest-temperature-in-nyc",
    timeZone: "America/New_York",
    latitude: 40.7769,
    longitude: -73.874,
    unit: "f",
    station: "KLGA LaGuardia Airport",
  },
  {
    citySlug: "miami",
    cityZh: "迈阿密",
    cityEn: "Miami",
    eventBaseSlug: "highest-temperature-in-miami",
    timeZone: "America/New_York",
    latitude: 25.7959,
    longitude: -80.287,
    unit: "f",
    station: "KMIA Miami Intl Airport",
  },
  {
    citySlug: "atlanta",
    cityZh: "亚特兰大",
    cityEn: "Atlanta",
    eventBaseSlug: "highest-temperature-in-atlanta",
    timeZone: "America/New_York",
    latitude: 33.6407,
    longitude: -84.4277,
    unit: "f",
    station: "KATL Hartsfield-Jackson",
  },
  {
    citySlug: "toronto",
    cityZh: "多伦多",
    cityEn: "Toronto",
    eventBaseSlug: "highest-temperature-in-toronto",
    timeZone: "America/Toronto",
    latitude: 43.6777,
    longitude: -79.6248,
    unit: "c",
    station: "CYYZ Toronto Pearson",
  },
  {
    citySlug: "chicago",
    cityZh: "芝加哥",
    cityEn: "Chicago",
    eventBaseSlug: "highest-temperature-in-chicago",
    timeZone: "America/Chicago",
    latitude: 41.9742,
    longitude: -87.9073,
    unit: "f",
    station: "KORD O'Hare",
  },
  {
    citySlug: "dallas",
    cityZh: "达拉斯",
    cityEn: "Dallas",
    eventBaseSlug: "highest-temperature-in-dallas",
    timeZone: "America/Chicago",
    latitude: 32.8471,
    longitude: -96.8518,
    unit: "f",
    station: "KDAL Love Field",
  },
  {
    citySlug: "houston",
    cityZh: "休斯顿",
    cityEn: "Houston",
    eventBaseSlug: "highest-temperature-in-houston",
    timeZone: "America/Chicago",
    latitude: 29.6454,
    longitude: -95.2789,
    unit: "f",
    station: "KHOU Hobby",
  },
  {
    citySlug: "austin",
    cityZh: "奥斯汀",
    cityEn: "Austin",
    eventBaseSlug: "highest-temperature-in-austin",
    timeZone: "America/Chicago",
    latitude: 30.1975,
    longitude: -97.6664,
    unit: "f",
    station: "KAUS Austin-Bergstrom",
  },
  {
    citySlug: "buenos-aires",
    cityZh: "布宜诺斯艾利斯",
    cityEn: "Buenos Aires",
    eventBaseSlug: "highest-temperature-in-buenos-aires",
    timeZone: "America/Argentina/Buenos_Aires",
    latitude: -34.8222,
    longitude: -58.5358,
    unit: "c",
    station: "SAEZ Ezeiza",
  },
  {
    citySlug: "sao-paulo",
    cityZh: "圣保罗",
    cityEn: "Sao Paulo",
    eventBaseSlug: "highest-temperature-in-sao-paulo",
    timeZone: "America/Sao_Paulo",
    latitude: -23.4356,
    longitude: -46.4731,
    unit: "c",
    station: "SBGR Guarulhos",
  },
];

const DOMESTIC_COORDS = {
  beijing: { latitude: 40.08, longitude: 116.58 },
  shanghai: { latitude: 31.14, longitude: 121.8 },
  guangzhou: { latitude: 23.39, longitude: 113.3 },
  shenzhen: { latitude: 22.64, longitude: 113.81 },
  wuhan: { latitude: 30.78, longitude: 114.21 },
  chengdu: { latitude: 30.58, longitude: 103.95 },
  chongqing: { latitude: 29.72, longitude: 106.64 },
  "hong-kong": { latitude: 22.31, longitude: 114.17 },
  taipei: { latitude: 25.07, longitude: 121.55 },
};

const DOMESTIC_CITIES = WEATHER_CITY_CONFIGS.map((city) => ({
  ...city,
  ...DOMESTIC_COORDS[city.citySlug],
  timeZone: "Asia/Shanghai",
  unit: "c",
  station: city.settlementStationName,
})).filter((city) => Number.isFinite(city.latitude) && Number.isFinite(city.longitude));

const LEGS = {
  overseas: {
    id: "overseas",
    label: "海外 18:00",
    hour: 18,
    minute: 0,
    cities: OVERSEAS_CITIES,
    cycleOffsetDays: 0,
  },
  domestic: {
    id: "domestic",
    label: "国内 06:00",
    hour: 6,
    minute: 0,
    cities: DOMESTIC_CITIES,
    cycleOffsetDays: -1,
  },
};

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return Number(Number(value).toFixed(digits));
}

function getFormatterParts(date, timeZone, options) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    ...options,
  });
  return formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
}

function getLocalDateString(date = new Date(), timeZone = TZ) {
  const parts = getFormatterParts(date, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getLocalDayMinute(date = new Date(), timeZone = TZ) {
  const parts = getFormatterParts(date, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function localDateStringToDate(ymd) {
  const [year, month, day] = String(ymd || "").split("-").map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function shiftDateString(ymd, deltaDays) {
  const date = localDateStringToDate(ymd);
  if (!date) {
    return null;
  }
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return getLocalDateString(date, TZ);
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
  const [year, month, day] = String(ymd).split("-").map(Number);
  return `${baseSlug}-on-${monthName(month - 1)}-${day}-${year}`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function fetchJson(url, label) {
  return sharedFetchJson(url, label);
}

async function fetchEvent(eventSlug) {
  return fetchJson(`https://gamma-api.polymarket.com/events/slug/${eventSlug}`, `event:${eventSlug}`);
}

async function fetchForecastMax(city, ymd) {
  const params = new URLSearchParams({
    latitude: String(city.latitude),
    longitude: String(city.longitude),
    daily: "temperature_2m_max",
    timezone: city.timeZone,
    start_date: ymd,
    end_date: ymd,
  });
  if (city.unit === "f") {
    params.set("temperature_unit", "fahrenheit");
  }
  const payload = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, `forecast:${city.citySlug}`);
  const value = Number(payload?.daily?.temperature_2m_max?.[0]);
  if (!Number.isFinite(value)) {
    throw new Error(`missing forecast max for ${city.citySlug}`);
  }
  return Math.round(value);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getNoPrice(market) {
  const outcomes = parseJsonArray(market?.outcomes);
  const prices = parseJsonArray(market?.outcomePrices).map(Number);
  const noIndex = outcomes.findIndex((item) => String(item).toLowerCase() === "no");
  if (noIndex < 0 || noIndex >= prices.length || !Number.isFinite(prices[noIndex])) {
    return null;
  }
  return prices[noIndex];
}

function getResolvedOutcome(market) {
  if (market?.closed !== true && market?.resolved !== true) {
    return null;
  }
  const outcomes = parseJsonArray(market?.outcomes);
  const prices = parseJsonArray(market?.outcomePrices).map(Number);
  const yesIndex = outcomes.findIndex((item) => String(item).toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((item) => String(item).toLowerCase() === "no");
  if (yesIndex < 0 || noIndex < 0) {
    return null;
  }
  if (prices[yesIndex] >= RESOLUTION_WIN_PRICE && prices[noIndex] <= RESOLUTION_LOSE_PRICE + PRICE_EPSILON) {
    return "yes";
  }
  if (prices[noIndex] >= RESOLUTION_WIN_PRICE && prices[yesIndex] <= RESOLUTION_LOSE_PRICE + PRICE_EPSILON) {
    return "no";
  }
  return null;
}

function parseMarketBucket(market) {
  const slug = String(market?.slug || "");
  const token = slug.split("-").at(-1) || "";
  let match = token.match(/^(-?\d+)([cf])?orbelow$/);
  if (match) {
    return { kind: "below", min: -Infinity, max: Number(match[1]), unit: match[2] || null };
  }
  match = token.match(/^(-?\d+)([cf])?orhigher$/);
  if (match) {
    return { kind: "higher", min: Number(match[1]), max: Infinity, unit: match[2] || null };
  }
  match = token.match(/^(-?\d+)-(-?\d+)([cf])$/);
  if (match) {
    return { kind: "range", min: Number(match[1]), max: Number(match[2]), unit: match[3] };
  }
  match = token.match(/^(-?\d+)([cf])$/);
  if (match) {
    const value = Number(match[1]);
    return { kind: "exact", min: value, max: value, unit: match[2] };
  }
  return null;
}

function bucketDistance(bucket, target) {
  if (!bucket) {
    return Infinity;
  }
  if (target >= bucket.min && target <= bucket.max) {
    return 0;
  }
  if (target < bucket.min) {
    return bucket.min - target;
  }
  return target - bucket.max;
}

function chooseMarketForForecast(markets, forecastMax) {
  const candidates = (markets || [])
    .map((market) => ({ market, bucket: parseMarketBucket(market) }))
    .filter((item) => item.bucket);
  candidates.sort((left, right) => {
    const distance = bucketDistance(left.bucket, forecastMax) - bucketDistance(right.bucket, forecastMax);
    if (distance !== 0) {
      return distance;
    }
    return String(left.market?.slug || "").localeCompare(String(right.market?.slug || ""));
  });
  return candidates[0] || null;
}

function createRecord({ leg, city, ymd, cycleDate, event, eventSlug, forecastMax, selected }) {
  const noPrice = getNoPrice(selected.market);
  const base = {
    key: `${cycleDate}:${leg.id}:${ymd}:${city.citySlug}:${selected.market.slug}`,
    strategyId: "weather-rotation-sim",
    strategyLabel: "国内海外轮动模拟",
    legId: leg.id,
    legLabel: leg.label,
    cycleDate,
    date: ymd,
    simulatedAt: new Date().toISOString(),
    stakeUsd: STAKE_USD,
    citySlug: city.citySlug,
    cityZh: city.cityZh,
    cityEn: city.cityEn,
    timeZone: city.timeZone,
    station: city.station,
    unit: city.unit,
    eventSlug,
    eventUrl: `https://polymarket.com/zh/event/${eventSlug}`,
    eventTitle: event?.title || null,
    marketSlug: selected.market.slug,
    marketQuestion: selected.market.question,
    marketTitle: selected.market.question,
    forecastMax,
    bucket: selected.bucket,
    buyNoPrice: round(noPrice, 6),
  };
  if (!Number.isFinite(noPrice) || noPrice <= 0) {
    return {
      ...base,
      status: "skipped",
      skipReason: "missing-no-price",
      estimatedNoWinPnlUsd: null,
      accountingPnlUsd: null,
    };
  }
  if (noPrice > MAX_NO_PRICE) {
    return {
      ...base,
      status: "skipped",
      skipReason: "no-price-above-limit",
      skipLimitNoPrice: MAX_NO_PRICE,
      estimatedNoWinPnlUsd: null,
      accountingPnlUsd: null,
    };
  }
  const shares = STAKE_USD / noPrice;
  return applyResolution({
    ...base,
    status: "pending",
    sharesBought: round(shares, 6),
    estimatedNoWinPnlUsd: round(shares - STAKE_USD, 6),
    accountingPnlUsd: null,
  }, selected.market);
}

function applyResolution(record, market) {
  const resolvedOutcome = getResolvedOutcome(market);
  if (!resolvedOutcome || record.status === "skipped") {
    if (record.status !== "resolved") {
      return record;
    }
    return {
      ...record,
      status: "pending",
      resolvedOutcome: null,
      accountingPnlUsd: null,
      resolvedAt: null,
    };
  }
  const pnl = resolvedOutcome === "no" ? Number(record.estimatedNoWinPnlUsd || 0) : -Number(record.stakeUsd || 0);
  return {
    ...record,
    status: "resolved",
    resolvedOutcome,
    accountingPnlUsd: round(pnl, 6),
    resolvedAt: new Date().toISOString(),
  };
}

async function buildSimulationRecord(leg, city, ymd, cycleDate) {
  const forecastMax = await fetchForecastMax(city, ymd);
  const eventSlug = buildEventSlug(city.eventBaseSlug, ymd);
  const event = await fetchEvent(eventSlug);
  const selected = chooseMarketForForecast(event?.markets || [], forecastMax);
  if (!selected) {
    throw new Error(`no matching market for ${city.citySlug} ${ymd}`);
  }
  return createRecord({ leg, city, ymd, cycleDate, event, eventSlug, forecastMax, selected });
}

function getActiveLeg(now = new Date(), forcedLeg = process.env.WEATHER_ROTATION_FORCE_LEG) {
  if (forcedLeg && LEGS[forcedLeg]) {
    return LEGS[forcedLeg];
  }
  const dayMinute = getLocalDayMinute(now, TZ);
  return Object.values(LEGS).find((leg) => {
    const start = leg.hour * 60 + leg.minute;
    return dayMinute >= start && dayMinute < start + CAPTURE_WINDOW_MINUTES;
  }) || null;
}

async function syncLegRecords(records, leg, now) {
  const ymd = getLocalDateString(now, TZ);
  const cycleDate = shiftDateString(ymd, leg.cycleOffsetDays) || ymd;
  const activeCitySlugs = new Set(leg.cities.map((city) => city.citySlug));
  const retryableRecords = records.filter(
    (record) =>
      !(
        record.status === "error" &&
        record.legId === leg.id &&
        record.date === ymd &&
        activeCitySlugs.has(record.citySlug)
      ),
  );
  const existingKeys = new Set(retryableRecords.map((record) => record.key));
  const completedCityKeys = new Set(
    retryableRecords
      .filter((record) => record.legId === leg.id && record.date === ymd && record.status !== "error")
      .map((record) => record.citySlug),
  );
  const additions = [];
  for (const city of leg.cities) {
    if (completedCityKeys.has(city.citySlug)) {
      continue;
    }
    try {
      const record = await buildSimulationRecord(leg, city, ymd, cycleDate);
      if (!existingKeys.has(record.key)) {
        additions.push(record);
        existingKeys.add(record.key);
        completedCityKeys.add(city.citySlug);
      }
    } catch (error) {
      const eventSlug = buildEventSlug(city.eventBaseSlug, ymd);
      const key = `${cycleDate}:${leg.id}:${ymd}:${city.citySlug}:error`;
      if (!existingKeys.has(key) && !completedCityKeys.has(city.citySlug)) {
        additions.push({
          key,
          strategyId: "weather-rotation-sim",
          strategyLabel: "国内海外轮动模拟",
          legId: leg.id,
          legLabel: leg.label,
          cycleDate,
          date: ymd,
          simulatedAt: new Date().toISOString(),
          stakeUsd: STAKE_USD,
          citySlug: city.citySlug,
          cityZh: city.cityZh,
          cityEn: city.cityEn,
          timeZone: city.timeZone,
          station: city.station,
          unit: city.unit,
          eventSlug,
          eventUrl: `https://polymarket.com/zh/event/${eventSlug}`,
          status: "error",
          error: String(error?.message || error),
          accountingPnlUsd: null,
        });
        existingKeys.add(key);
      }
    }
  }
  return { records: retryableRecords, additions };
}

async function refreshRecordResolution(record) {
  if (!record?.eventSlug || !record?.marketSlug || ["skipped", "error"].includes(record.status)) {
    return record;
  }
  try {
    const event = await fetchEvent(record.eventSlug);
    const market = (event?.markets || []).find((item) => item.slug === record.marketSlug);
    return market ? applyResolution(record, market) : record;
  } catch {
    return record;
  }
}

function summarize(records) {
  const settled = records.filter((record) => record.status === "resolved");
  const stake = settled.reduce((sum, record) => sum + Number(record.stakeUsd || 0), 0);
  const pnl = settled.reduce((sum, record) => sum + Number(record.accountingPnlUsd || 0), 0);
  return {
    records: records.length,
    settled: settled.length,
    pending: records.filter((record) => record.status === "pending").length,
    skipped: records.filter((record) => record.status === "skipped").length,
    errors: records.filter((record) => record.status === "error").length,
    wins: settled.filter((record) => Number(record.accountingPnlUsd) > 0).length,
    losses: settled.filter((record) => Number(record.accountingPnlUsd) < 0).length,
    stakeUsd: round(stake, 6) || 0,
    pnlUsd: round(pnl, 6) || 0,
    roi: stake > 0 ? round(pnl / stake, 6) : null,
  };
}

function buildSummary(records, todayYmd) {
  const byLeg = Object.fromEntries(
    Object.keys(LEGS).map((legId) => [legId, summarize(records.filter((record) => record.legId === legId))]),
  );
  const byCycle = [...new Set(records.map((record) => record.cycleDate).filter(Boolean))]
    .sort()
    .reverse()
    .slice(0, 14)
    .map((cycleDate) => ({
      cycleDate,
      records: records.filter((record) => record.cycleDate === cycleDate),
    }))
    .map((item) => ({
      cycleDate: item.cycleDate,
      summary: summarize(item.records),
      overseas: summarize(item.records.filter((record) => record.legId === "overseas")),
      domestic: summarize(item.records.filter((record) => record.legId === "domestic")),
    }));
  return {
    overall: summarize(records),
    today: summarize(records.filter((record) => record.date === todayYmd)),
    byLeg,
    byCycle,
  };
}

export async function syncWeatherRotationSimulationData(options = {}) {
  const now = options.now || new Date();
  const records = await readJson(ROTATION_RECORDS_PATH, []);
  const refreshed = await Promise.all((Array.isArray(records) ? records : []).map(refreshRecordResolution));
  const activeLeg = getActiveLeg(now, options.forceLeg);
  const syncResult = activeLeg
    ? await syncLegRecords(refreshed, activeLeg, now)
    : { records: refreshed, additions: [] };
  const nextRecords = [...syncResult.records, ...syncResult.additions].sort((left, right) => {
    const dateCompare = String(right.date || "").localeCompare(String(left.date || ""));
    if (dateCompare !== 0) {
      return dateCompare;
    }
    return String(left.legId || "").localeCompare(String(right.legId || ""));
  });
  if (syncResult.additions.length || JSON.stringify(nextRecords) !== JSON.stringify(records)) {
    await writeJson(ROTATION_RECORDS_PATH, nextRecords);
  }
  return nextRecords;
}

export async function getWeatherRotationSimulationSnapshot(options = {}) {
  const now = options.now || new Date();
  const todayYmd = getLocalDateString(now, TZ);
  const records = options.sync === false
    ? await readJson(ROTATION_RECORDS_PATH, [])
    : await syncWeatherRotationSimulationData(options);
  const activeLeg = getActiveLeg(now, options.forceLeg);
  return {
    strategyId: "weather-rotation-sim",
    label: "国内海外轮动模拟",
    stakeUsd: STAKE_USD,
    maxNoPrice: MAX_NO_PRICE,
    localDate: todayYmd,
    activeLeg: activeLeg ? { id: activeLeg.id, label: activeLeg.label } : null,
    nextWindows: [
      { id: "domestic", label: "国内 06:00 BJT", cityCount: DOMESTIC_CITIES.length },
      { id: "overseas", label: "海外 18:00 BJT", cityCount: OVERSEAS_CITIES.length },
    ],
    cities: {
      overseas: OVERSEAS_CITIES.map(({ latitude, longitude, ...city }) => city),
      domestic: DOMESTIC_CITIES.map(({ latitude, longitude, ...city }) => city),
    },
    records,
    summary: buildSummary(records, todayYmd),
  };
}
