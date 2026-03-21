const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const MONITOR_VARIANT = String(process.env.MONITOR_VARIANT || '1h').toLowerCase();
const VARIANT_DEFAULTS = {
  '1h': {
    sampleIntervalMs: 5000,
    windowHours: 1,
    windowMinutes: 60,
    slugMode: 'calendar-et',
    minDurationMinutes: 50,
    eventPrefix: 'bitcoin-up-or-down-',
    eventSuffix: '-et',
  },
  '4h': {
    sampleIntervalMs: 15000,
    windowHours: 4,
    windowMinutes: 240,
    slugMode: 'timestamp-start',
    minDurationMinutes: 210,
    eventPrefix: 'btc-updown-4h-',
    eventSuffix: '',
  },
  '15m': {
    sampleIntervalMs: 5000,
    windowHours: 15 / 60,
    windowMinutes: 15,
    slugMode: 'timestamp-start',
    minDurationMinutes: 13,
    eventPrefix: 'btc-updown-15m-',
    eventSuffix: '',
  },
  '5m': {
    sampleIntervalMs: 3000,
    windowHours: 5 / 60,
    windowMinutes: 5,
    slugMode: 'timestamp-start',
    minDurationMinutes: 4.5,
    eventPrefix: 'btc-updown-5m-',
    eventSuffix: '',
  },
};
const variantDefaults = VARIANT_DEFAULTS[MONITOR_VARIANT] || VARIANT_DEFAULTS['1h'];
const SAMPLE_INTERVAL_MS = Number(
  process.env.SAMPLE_INTERVAL_MS || variantDefaults.sampleIntervalMs
);
const MONITOR_WINDOW_HOURS = Number(
  process.env.MONITOR_WINDOW_HOURS || variantDefaults.windowHours
);
const MONITOR_WINDOW_MINUTES = Number(
  process.env.MONITOR_WINDOW_MINUTES ||
    variantDefaults.windowMinutes ||
    MONITOR_WINDOW_HOURS * 60
);
const MONITOR_SLUG_MODE =
  process.env.MONITOR_SLUG_MODE ||
  variantDefaults.slugMode;
const MIN_DURATION_MINUTES = Number(
  process.env.MIN_DURATION_MINUTES || variantDefaults.minDurationMinutes
);
const LOG_EVERY_SAMPLES = Number(process.env.LOG_EVERY_SAMPLES || 1);
const API_BASE = process.env.API_BASE || 'https://gamma-api.polymarket.com';
const CLOB_BASE = process.env.CLOB_BASE || 'https://clob.polymarket.com';
const EVENT_PREFIX =
  process.env.EVENT_PREFIX || variantDefaults.eventPrefix;
const EVENT_SUFFIX =
  process.env.EVENT_SUFFIX || variantDefaults.eventSuffix;
const TIME_ZONE = process.env.TIME_ZONE || 'America/New_York';
const LOG_TIME_ZONE = 'Asia/Shanghai';
const PRICE_SIDE = String(process.env.PRICE_SIDE || 'BUY').toUpperCase();
const START_RETRY_MS = Number(process.env.START_RETRY_MS || 10000);
const EVENT_MISSING_RETRY_MS = Number(process.env.EVENT_MISSING_RETRY_MS || 30000);
const THRESHOLDS = (process.env.THRESHOLDS || '45,40,35,30')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));
const GLOBAL_RAW_RETENTION_DAYS = parsePositiveNumber(
  process.env.RAW_RETENTION_DAYS,
  null
);
const GLOBAL_SUMMARY_RETENTION_DAYS = parsePositiveNumber(
  process.env.SUMMARY_RETENTION_DAYS,
  null
);
const VARIANT_RETENTION_POLICIES = {
  '5m': {
    rawDays: parsePositiveNumber(
      process.env.RAW_RETENTION_DAYS_5M,
      GLOBAL_RAW_RETENTION_DAYS ?? 7
    ),
    summaryDays: parsePositiveNumber(
      process.env.SUMMARY_RETENTION_DAYS_5M,
      GLOBAL_SUMMARY_RETENTION_DAYS ?? 60
    ),
  },
  '15m': {
    rawDays: parsePositiveNumber(
      process.env.RAW_RETENTION_DAYS_15M,
      GLOBAL_RAW_RETENTION_DAYS ?? 14
    ),
    summaryDays: parsePositiveNumber(
      process.env.SUMMARY_RETENTION_DAYS_15M,
      GLOBAL_SUMMARY_RETENTION_DAYS ?? 90
    ),
  },
  '1h': {
    rawDays: parsePositiveNumber(
      process.env.RAW_RETENTION_DAYS_1H,
      GLOBAL_RAW_RETENTION_DAYS ?? 30
    ),
    summaryDays: parsePositiveNumber(
      process.env.SUMMARY_RETENTION_DAYS_1H,
      GLOBAL_SUMMARY_RETENTION_DAYS ?? 180
    ),
  },
  '4h': {
    rawDays: parsePositiveNumber(
      process.env.RAW_RETENTION_DAYS_4H,
      GLOBAL_RAW_RETENTION_DAYS ?? 60
    ),
    summaryDays: parsePositiveNumber(
      process.env.SUMMARY_RETENTION_DAYS_4H,
      GLOBAL_SUMMARY_RETENTION_DAYS ?? 365
    ),
  },
};
const VARIANT_FILE_PREFIXES = [
  ['5m', 'btc-updown-5m-'],
  ['15m', 'btc-updown-15m-'],
  ['4h', 'btc-updown-4h-'],
  ['1h', 'bitcoin-up-or-down-'],
];

const DATA_DIR = path.join(process.cwd(), 'data');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const SUMMARY_DIR = path.join(DATA_DIR, 'summaries');
const LOCKS_DIR = path.join(DATA_DIR, 'locks');
const PROCESS_LOCK_PATH = path.join(LOCKS_DIR, `monitor-${MONITOR_VARIANT}.lock`);
const CURL_TIMEOUT_SECONDS = Number(process.env.CURL_TIMEOUT_SECONDS || 20);
const HAS_PROXY_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
].some((name) => Boolean(process.env[name]));
const execFileAsync = promisify(execFile);

let didLogProxyFallback = false;

const slugFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  hour12: true,
});

const logFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: LOG_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatLogTimestamp(date) {
  const parts = logFormatter.formatToParts(date);
  const year = getPart(parts, 'year');
  const month = getPart(parts, 'month');
  const day = getPart(parts, 'day');
  const hour = getPart(parts, 'hour');
  const minute = getPart(parts, 'minute');
  const second = getPart(parts, 'second');
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${LOG_TIME_ZONE}`;
}

function log(message) {
  const now = new Date();
  console.log(`[${formatLogTimestamp(now)}] ${message}`);
}

function logProxyFallback(reason) {
  if (didLogProxyFallback) {
    return;
  }
  didLogProxyFallback = true;
  log(`Using curl fallback for Polymarket requests (${reason})`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readLockFile(lockPath) {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireProcessLock(lockPath) {
  ensureDir(path.dirname(lockPath));
  const payload = {
    pid: process.pid,
    monitorVariant: MONITOR_VARIANT,
    startedAt: new Date().toISOString(),
  };

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      const current = readLockFile(lockPath);
      const currentPid = Number(current?.pid);
      if (isProcessRunning(currentPid)) {
        log(
          `Another ${MONITOR_VARIANT.toUpperCase()} monitor is already running ` +
            `(pid ${currentPid}). Exiting.`
        );
        process.exit(0);
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') {
          throw unlinkError;
        }
      }
    }
  }
}

function releaseProcessLock(lockPath) {
  try {
    const current = readLockFile(lockPath);
    const currentPid = Number(current?.pid);
    if (currentPid && currentPid !== process.pid) {
      return;
    }
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (error) {
    log(`Lock release skipped for ${lockPath}: ${error.message}`);
  }
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function detectMonitorVariantFromFileName(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  for (const [variant, prefix] of VARIANT_FILE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return variant;
    }
  }
  return MONITOR_VARIANT;
}

function getRetentionDaysForFile(fileName, retentionType) {
  const variant = detectMonitorVariantFromFileName(fileName);
  const policy =
    VARIANT_RETENTION_POLICIES[variant] || VARIANT_RETENTION_POLICIES['1h'];
  return retentionType === 'summary' ? policy.summaryDays : policy.rawDays;
}

function cleanupOldFiles(dirPath, label, retentionType) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  let deleted = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(dirPath, entry.name);
    try {
      const retentionDays = getRetentionDaysForFile(entry.name, retentionType);
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        continue;
      }
      const stats = fs.statSync(filePath);
      const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      if (stats.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    } catch (error) {
      log(`Cleanup skipped for ${filePath}: ${error.message}`);
    }
  }
  if (deleted > 0) {
    log(`Cleaned ${deleted} old ${label} files`);
  }
}

function getPart(parts, type) {
  const match = parts.find((part) => part.type === type);
  if (!match) {
    throw new Error(`Missing date part: ${type}`);
  }
  return match.value;
}

function slugForDate(date) {
  if (MONITOR_SLUG_MODE === 'timestamp-start') {
    const eventStart = alignToWindowStart(date);
    const slug = `${EVENT_PREFIX}${Math.floor(eventStart.getTime() / 1000)}${EVENT_SUFFIX}`;
    return [slug];
  }
  const parts = slugFormatter.formatToParts(date);
  const month = getPart(parts, 'month').toLowerCase();
  const day = getPart(parts, 'day');
  const year = getPart(parts, 'year');
  const hour = getPart(parts, 'hour');
  const dayPeriodRaw = getPart(parts, 'dayPeriod');
  const dayPeriod = dayPeriodRaw.toLowerCase().replace(/[.\s]/g, '');
  const base = `${EVENT_PREFIX}${month}-${day}-${hour}${dayPeriod}${EVENT_SUFFIX}`;
  const withYear = `${EVENT_PREFIX}${month}-${day}-${year}-${hour}${dayPeriod}${EVENT_SUFFIX}`;
  return [withYear, base];
}

function alignToWindowStart(date) {
  const windowMs = MONITOR_WINDOW_MINUTES * 60 * 1000;
  const alignedMs = Math.floor(date.getTime() / windowMs) * windowMs;
  return new Date(alignedMs);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return [];
    }
  }
  return [];
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function formatForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function toCents(value) {
  return Number((value * 100).toFixed(3));
}

function extractOutcomeMap(market) {
  const outcomes = parseJsonArray(market.outcomes);
  const clobTokenIds = parseJsonArray(market.clobTokenIds);
  if (!Array.isArray(outcomes) || outcomes.length < 2) {
    throw new Error('Missing outcomes');
  }
  if (!Array.isArray(clobTokenIds) || clobTokenIds.length !== outcomes.length) {
    throw new Error('Missing clob token ids');
  }
  const entries = outcomes.map((outcome, index) => ({
    outcome: String(outcome),
    tokenId: String(clobTokenIds[index]),
  }));
  let upEntry = entries.find(
    (entry) => entry.outcome.toLowerCase() === 'up'
  );
  let downEntry = entries.find(
    (entry) => entry.outcome.toLowerCase() === 'down'
  );
  if (!upEntry) {
    upEntry = entries[0];
  }
  if (!downEntry) {
    downEntry = entries[upEntry === entries[0] ? 1 : 0];
  }
  if (!upEntry?.tokenId || !downEntry?.tokenId) {
    throw new Error('Missing outcome token ids');
  }
  return {
    outcomes: entries.map((entry) => entry.outcome),
    upTokenId: upEntry.tokenId,
    downTokenId: downEntry.tokenId,
  };
}

async function fetchEvent(slug) {
  const url = `${API_BASE}/events?slug=${encodeURIComponent(slug)}&_ts=${Date.now()}`;
  const data = await fetchJson(url, slug);
  if (Array.isArray(data)) {
    return data[0] || null;
  }
  if (data && typeof data === 'object') {
    return data;
  }
  return null;
}

async function fetchLivePrices(state) {
  const [upPrice, downPrice] = await Promise.all([
    fetchClobPrice(state.upTokenId, state.slug, 'Up'),
    fetchClobPrice(state.downTokenId, state.slug, 'Down'),
  ]);
  return { upPrice, downPrice };
}

async function fetchClobPrice(tokenId, slug, outcome) {
  const url =
    `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}` +
    `&side=${encodeURIComponent(PRICE_SIDE)}`;
  const data = await fetchJson(url, `${slug}:${outcome}`);
  const price = Number(data?.price);
  if (!Number.isFinite(price)) {
    throw new Error(`Invalid ${PRICE_SIDE} price for ${slug}:${outcome}`);
  }
  return price;
}

async function fetchJson(url, slug) {
  if (process.platform === 'win32' && HAS_PROXY_ENV) {
    logProxyFallback('proxy environment detected on Windows');
    return fetchJsonWithCurl(url, slug);
  }

  try {
    return await fetchJsonWithNode(url, slug);
  } catch (error) {
    if (process.platform === 'win32') {
      logProxyFallback(error.code || error.message || 'node request failed');
      return fetchJsonWithCurl(url, slug);
    }
    throw error;
  }
}

async function fetchJsonWithNode(url, slug) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
    },
  });
  if (!response.ok) {
    log(`Request failed ${response.status} for ${slug}`);
    return null;
  }
  return response.json();
}

async function fetchJsonWithCurl(url, slug) {
  try {
    const { stdout } = await execFileAsync(
      'curl.exe',
      [
        '--silent',
        '--show-error',
        '--fail',
        '--location',
        '--max-time',
        String(CURL_TIMEOUT_SECONDS),
        '--header',
        'accept: application/json',
        url,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    return JSON.parse(stdout);
  } catch (error) {
    const details = error.stderr || error.message || String(error);
    throw new Error(`Curl request failed for ${slug}: ${details}`);
  }
}

function initSummary(slug, event, market, eventStart, eventEnd, runStartedAt) {
  const thresholds = { up: {}, down: {} };
  const firstThresholdHits = { up: {}, down: {} };
  for (const threshold of THRESHOLDS) {
    thresholds.up[`lt${threshold}`] = false;
    thresholds.down[`lt${threshold}`] = false;
    firstThresholdHits.up[`lt${threshold}`] = null;
    firstThresholdHits.down[`lt${threshold}`] = null;
  }
  return {
    slug,
    eventId: event?.id ?? null,
    marketId: market?.id ?? null,
    monitorVariant: MONITOR_VARIANT,
    monitorWindowHours: MONITOR_WINDOW_HOURS,
    monitorWindowMinutes: MONITOR_WINDOW_MINUTES,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    minDurationMinutes: MIN_DURATION_MINUTES,
    priceSource: `clob-${PRICE_SIDE.toLowerCase()}`,
    eventStart: eventStart ? eventStart.toISOString() : null,
    eventEnd: eventEnd ? eventEnd.toISOString() : null,
    runStartedAt: runStartedAt.toISOString(),
    sampleCount: 0,
    minUpCents: null,
    minDownCents: null,
    thresholds,
    firstThresholdHits,
    samplingHealth: null,
  };
}

async function startEvent(date) {
  while (true) {
    try {
      const slugCandidates = slugForDate(date);
      let selected = null;
      for (const candidate of slugCandidates) {
        const event = await fetchEvent(candidate);
        if (!event || !event.markets || event.markets.length === 0) {
          continue;
        }
        const market = event.markets[0];
        const eventEnd = parseDate(market.endDate || event.endDate);
        let eventStart = parseDate(market.eventStartTime || event.startDate);
        if (!eventStart && eventEnd) {
          eventStart = new Date(
            eventEnd.getTime() - MONITOR_WINDOW_MINUTES * 60 * 1000
          );
        }
        const targetTime = date.getTime();
        const hasWindow =
          eventStart &&
          eventEnd &&
          targetTime >= eventStart.getTime() &&
          targetTime < eventEnd.getTime();
        if (hasWindow) {
          selected = { slug: candidate, event, market, eventStart, eventEnd };
          break;
        }
        if (!selected) {
          selected = { slug: candidate, event, market, eventStart, eventEnd };
        }
      }
      if (!selected) {
        log(
          `No event found for ${slugCandidates.join(' / ')}. Retrying in ${Math.round(
            EVENT_MISSING_RETRY_MS / 1000
          )}s.`
        );
        await sleep(EVENT_MISSING_RETRY_MS);
        date = new Date();
        continue;
      }
      const { slug, event, market } = selected;
      let { eventStart, eventEnd } = selected;
      if (!eventEnd) {
        log(
          `Missing end date for ${slug}. Retrying in ${Math.round(
            START_RETRY_MS / 1000
          )}s.`
        );
        await sleep(START_RETRY_MS);
        date = new Date();
        continue;
      }
      const { upTokenId, downTokenId, outcomes } = extractOutcomeMap(market);
      const runStartedAt = new Date();
      const runId = formatForFilename(runStartedAt);
      const fileName =
        `${slug}_${formatForFilename(eventStart || runStartedAt)}` +
        `_run-${runId}.jsonl`;
      const filePath = path.join(EVENTS_DIR, fileName);
      const stream = fs.createWriteStream(filePath, { flags: 'w' });
      const summary = initSummary(
        slug,
        event,
        market,
        eventStart,
        eventEnd,
        runStartedAt
      );
      summary.runId = runId;
      summary.outcomes = outcomes;
      summary.tokens = {
        up: upTokenId,
        down: downTokenId,
      };
      log(
        `Started ${slug} (${MONITOR_VARIANT}, market ${market.id}, ${summary.priceSource}) until ` +
          `${eventEnd.toISOString()}`
      );
      return {
        slug,
        eventId: event.id,
        marketId: market.id,
        eventStart,
        eventEnd,
        filePath,
        stream,
        summary,
        firstSampleAt: null,
        lastSampleAt: null,
        longestGapMs: 0,
        estimatedMissedSamples: 0,
        upTokenId,
        downTokenId,
      };
    } catch (error) {
      const slugCandidates = slugForDate(date);
      log(
        `Start error for ${slugCandidates.join(' / ')}: ${error.message}. ` +
          `Retrying in ${Math.round(START_RETRY_MS / 1000)}s.`
      );
      await sleep(START_RETRY_MS);
      date = new Date();
    }
  }
}

function updateThresholds(summary, upCents, downCents, observedAt) {
  const observedAtIso = observedAt.toISOString();
  for (const threshold of THRESHOLDS) {
    if (upCents <= threshold) {
      summary.thresholds.up[`lt${threshold}`] = true;
      if (!summary.firstThresholdHits.up[`lt${threshold}`]) {
        summary.firstThresholdHits.up[`lt${threshold}`] = observedAtIso;
      }
    }
    if (downCents <= threshold) {
      summary.thresholds.down[`lt${threshold}`] = true;
      if (!summary.firstThresholdHits.down[`lt${threshold}`]) {
        summary.firstThresholdHits.down[`lt${threshold}`] = observedAtIso;
      }
    }
  }
}

function updateMin(currentMin, nextValue) {
  if (currentMin === null || nextValue < currentMin) {
    return nextValue;
  }
  return currentMin;
}

function estimateMissedSamplesFromGap(gapMs) {
  if (!Number.isFinite(gapMs) || gapMs <= SAMPLE_INTERVAL_MS * 1.5) {
    return 0;
  }
  const estimatedIntervals = Math.max(
    1,
    Math.round(gapMs / SAMPLE_INTERVAL_MS)
  );
  return Math.max(0, estimatedIntervals - 1);
}

function buildSamplingHealth(state, durationMs) {
  const actualSamples = Number(state.summary.sampleCount ?? 0);
  const observedSpanMs = Math.max(0, durationMs);
  const expectedSamplesObservedSpan =
    observedSpanMs > 0
      ? Math.floor(observedSpanMs / SAMPLE_INTERVAL_MS) + 1
      : actualSamples > 0
        ? 1
        : 0;
  const fullWindowMs =
    state.eventStart && state.eventEnd
      ? Math.max(0, state.eventEnd.getTime() - state.eventStart.getTime())
      : null;
  const expectedSamplesFullWindow =
    Number.isFinite(fullWindowMs) && fullWindowMs > 0
      ? Math.ceil(fullWindowMs / SAMPLE_INTERVAL_MS)
      : null;
  const windowCoverageRatio =
    expectedSamplesFullWindow && expectedSamplesFullWindow > 0
      ? Number((actualSamples / expectedSamplesFullWindow).toFixed(4))
      : null;
  const continuityRatio =
    expectedSamplesObservedSpan > 0
      ? Number((actualSamples / expectedSamplesObservedSpan).toFixed(4))
      : null;
  const longestGapSeconds =
    state.longestGapMs > 0
      ? Number((state.longestGapMs / 1000).toFixed(2))
      : 0;
  const longestGapMultiple =
    state.longestGapMs > 0
      ? Number((state.longestGapMs / SAMPLE_INTERVAL_MS).toFixed(2))
      : 0;

  let status = 'healthy';
  if (
    (windowCoverageRatio !== null && windowCoverageRatio < 0.85) ||
    longestGapMultiple >= 4
  ) {
    status = 'risky';
  } else if (
    (windowCoverageRatio !== null && windowCoverageRatio < 0.95) ||
    longestGapMultiple >= 2
  ) {
    status = 'watch';
  }

  return {
    status,
    actualSamples,
    expectedSamplesFullWindow,
    expectedSamplesObservedSpan,
    observedSpanMinutes: Number((observedSpanMs / 60000).toFixed(2)),
    windowCoverageRatio,
    continuityRatio,
    longestGapSeconds,
    longestGapMultiple,
    estimatedMissedSamples: Number(state.estimatedMissedSamples ?? 0),
  };
}

async function recordSample(state) {
  try {
    const { upPrice, downPrice } = await fetchLivePrices(state);
    const upCents = toCents(upPrice);
    const downCents = toCents(downPrice);
    const now = new Date();
    if (!state.firstSampleAt) {
      state.firstSampleAt = now;
    }
    if (state.lastSampleAt) {
      const gapMs = now.getTime() - state.lastSampleAt.getTime();
      state.longestGapMs = Math.max(state.longestGapMs, gapMs);
      state.estimatedMissedSamples += estimateMissedSamplesFromGap(gapMs);
    }
    state.lastSampleAt = now;
    state.summary.sampleCount += 1;
    state.summary.minUpCents = updateMin(state.summary.minUpCents, upCents);
    state.summary.minDownCents = updateMin(state.summary.minDownCents, downCents);
    updateThresholds(state.summary, upCents, downCents, now);
    const record = {
      ts: now.toISOString(),
      slug: state.slug,
      marketId: String(state.marketId),
      priceSource: state.summary.priceSource,
      monitorVariant: MONITOR_VARIANT,
      monitorWindowHours: MONITOR_WINDOW_HOURS,
      monitorWindowMinutes: MONITOR_WINDOW_MINUTES,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      priceSide: PRICE_SIDE,
      upTokenId: state.upTokenId,
      downTokenId: state.downTokenId,
      upPrice,
      downPrice,
      upCents,
      downCents,
    };
    state.stream.write(`${JSON.stringify(record)}\n`);
    if (LOG_EVERY_SAMPLES > 0 && state.summary.sampleCount % LOG_EVERY_SAMPLES === 0) {
      log(
        `${MONITOR_VARIANT} Sample ${state.summary.sampleCount} | Up ${upCents.toFixed(
          3
        )}c Down ${downCents.toFixed(3)}c`
      );
    }
  } catch (error) {
    log(`Sample error: ${error.message}`);
  }
}

async function finalizeEvent(state, reason) {
  await new Promise((resolve) => state.stream.end(resolve));
  const durationMs =
    state.firstSampleAt && state.lastSampleAt
      ? state.lastSampleAt.getTime() - state.firstSampleAt.getTime()
      : 0;
  const durationMinutes = durationMs / 60000;
  if (!state.firstSampleAt || !state.lastSampleAt) {
    if (fs.existsSync(state.filePath)) {
      fs.unlinkSync(state.filePath);
    }
    log(`Discarded ${state.slug} (no samples)`);
    return;
  }
  state.summary.samplingHealth = buildSamplingHealth(state, durationMs);
  if (durationMinutes < MIN_DURATION_MINUTES) {
    if (fs.existsSync(state.filePath)) {
      fs.unlinkSync(state.filePath);
    }
    log(
      `Discarded ${state.slug} (${durationMinutes.toFixed(
        2
      )} min < ${MIN_DURATION_MINUTES}, samples ${state.summary.sampleCount})`
    );
    return;
  }
  state.summary.firstSampleAt = state.firstSampleAt.toISOString();
  state.summary.lastSampleAt = state.lastSampleAt.toISOString();
  state.summary.durationMinutes = Number(durationMinutes.toFixed(2));
  state.summary.endReason = reason;
  const summaryPath = path.join(
    SUMMARY_DIR,
    `${path.basename(state.filePath, '.jsonl')}.json`
  );
  fs.writeFileSync(summaryPath, `${JSON.stringify(state.summary, null, 2)}\n`);
  log(`Saved summary ${summaryPath}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(EVENTS_DIR);
  ensureDir(SUMMARY_DIR);
  ensureDir(LOCKS_DIR);
  acquireProcessLock(PROCESS_LOCK_PATH);
  cleanupOldFiles(EVENTS_DIR, 'raw event', 'raw');
  cleanupOldFiles(SUMMARY_DIR, 'summary', 'summary');

  let state = await startEvent(new Date());

  const shutdown = async (signal) => {
    log(`Received ${signal}, shutting down.`);
    if (state) {
      await finalizeEvent(state, signal);
    }
    releaseProcessLock(PROCESS_LOCK_PATH);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  while (true) {
    if (state.eventEnd && Date.now() >= state.eventEnd.getTime()) {
      await finalizeEvent(state, 'complete');
      const nextDate = new Date(state.eventEnd.getTime() + 1000);
      state = await startEvent(nextDate);
      continue;
    }
    await recordSample(state);
    await sleep(SAMPLE_INTERVAL_MS);
  }
}

main().catch((error) => {
  releaseProcessLock(PROCESS_LOCK_PATH);
  log(`Fatal error: ${error.stack || error.message}`);
  process.exit(1);
});
