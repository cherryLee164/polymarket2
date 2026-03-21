import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const SUMMARY_DIR = path.join(DATA_DIR, "summaries");
const ORDERS_DIR = path.join(DATA_DIR, "orders");
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_LOOKBACK_DAYS = 15;
const MONITOR_VARIANT_ORDER = ["5m", "15m", "1h", "4h", "5m-paper", "15m-paper", "15m-paper-35x", "15m-paper-37x", "1h-paper", "4h-paper"];
const DEFAULT_THRESHOLDS = [45, 40, 35, 30];
const PAPER_VARIANTS = {
  "5m-paper": {
    id: "5m-paper",
    label: "5M 下单",
    timeframeLabel: "5 分钟纸面下单",
    summaryPath: path.join(ORDERS_DIR, "paper-5m", "rolling", "summary.json"),
    sessionPath: path.join(ORDERS_DIR, "paper-5m", "rolling", "session.json"),
  },
  "15m-paper": {
    id: "15m-paper",
    label: "15M 下单",
    timeframeLabel: "15 分钟纸面下单",
    summaryPath: path.join(ORDERS_DIR, "paper-15m", "rolling", "summary.json"),
    sessionPath: path.join(ORDERS_DIR, "paper-15m", "rolling", "session.json"),
  },
  "15m-paper-35x": {
    id: "15m-paper-35x",
    label: "15M 下单2",
    timeframeLabel: "15 分钟纸面下单 2",
    summaryPath: path.join(ORDERS_DIR, "paper-15m-35x", "rolling", "summary.json"),
    sessionPath: path.join(ORDERS_DIR, "paper-15m-35x", "rolling", "session.json"),
  },
  "15m-paper-37x": {
    id: "15m-paper-37x",
    label: "15M 涓嬪崟3",
    timeframeLabel: "15 鍒嗛挓绾搁潰涓嬪崟 3",
    summaryPath: path.join(ORDERS_DIR, "paper-15m-37x", "rolling", "summary.json"),
    sessionPath: path.join(ORDERS_DIR, "paper-15m-37x", "rolling", "session.json"),
  },
  "1h-paper": {
    id: "1h-paper",
    label: "1H 下单",
    timeframeLabel: "1 小时纸面下单",
    summaryPath: path.join(ORDERS_DIR, "paper-1h", "rolling", "summary.json"),
    sessionPath: path.join(ORDERS_DIR, "paper-1h", "rolling", "session.json"),
  },
  "4h-paper": {
    id: "4h-paper",
    label: "4H 下单",
    timeframeLabel: "4 小时纸面下单",
    summaryPath: path.join(ORDERS_DIR, "paper-4h", "rolling", "summary.json"),
    sessionPath: path.join(ORDERS_DIR, "paper-4h", "rolling", "session.json"),
  },
};

function buildSummaryDedupKey(summary) {
  return [
    String(summary?.monitorVariant ?? ""),
    String(summary?.eventStart ?? ""),
    String(summary?.eventEnd ?? ""),
    String(summary?.slug ?? ""),
  ].join("|");
}

function compareSummaryQuality(left, right) {
  const leftDuration = Number(left?.durationMinutes ?? 0);
  const rightDuration = Number(right?.durationMinutes ?? 0);
  if (leftDuration !== rightDuration) {
    return rightDuration - leftDuration;
  }

  const leftSamples = Number(left?.sampleCount ?? 0);
  const rightSamples = Number(right?.sampleCount ?? 0);
  if (leftSamples !== rightSamples) {
    return rightSamples - leftSamples;
  }

  const leftCoverage = Number(left?.samplingHealth?.windowCoverageRatio ?? -1);
  const rightCoverage = Number(right?.samplingHealth?.windowCoverageRatio ?? -1);
  if (leftCoverage !== rightCoverage) {
    return rightCoverage - leftCoverage;
  }

  return Number(right?.sortMs ?? 0) - Number(left?.sortMs ?? 0);
}

function dedupeSummaries(items) {
  const grouped = new Map();

  for (const item of items) {
    const key = buildSummaryDedupKey(item);
    const existing = grouped.get(key);
    if (!existing || compareSummaryQuality(existing, item) > 0) {
      grouped.set(key, item);
    }
  }

  return Array.from(grouped.values()).sort((left, right) => right.sortMs - left.sortMs);
}

function getMonitorVariantRank(value) {
  const rank = MONITOR_VARIANT_ORDER.indexOf(String(value ?? "").toLowerCase());
  return rank === -1 ? MONITOR_VARIANT_ORDER.length : rank;
}

function listFiles(dirPath, extension) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath)
    .map((name) => path.join(dirPath, name))
    .filter((filePath) => {
      try {
        return (
          fs.statSync(filePath).isFile() &&
          path.extname(filePath).toLowerCase() === extension
        );
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      return rightStat.mtimeMs - leftStat.mtimeMs;
    });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readJsonLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) {
      return [];
    }
    return content
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatCents(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(3));
}

function formatRatio(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeThresholdHits(value) {
  if (!value || typeof value !== "object") {
    return { up: {}, down: {} };
  }
  return {
    up: value.up && typeof value.up === "object" ? value.up : {},
    down: value.down && typeof value.down === "object" ? value.down : {},
  };
}

function normalizeSamplingHealth(value, sampleCount) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    status: typeof value.status === "string" ? value.status : "unknown",
    actualSamples: Number(value.actualSamples ?? sampleCount ?? 0),
    expectedSamplesFullWindow: formatPositiveNumber(value.expectedSamplesFullWindow),
    expectedSamplesObservedSpan: formatPositiveNumber(value.expectedSamplesObservedSpan),
    observedSpanMinutes: formatPositiveNumber(value.observedSpanMinutes),
    windowCoverageRatio: formatRatio(value.windowCoverageRatio),
    continuityRatio: formatRatio(value.continuityRatio),
    longestGapSeconds: formatPositiveNumber(value.longestGapSeconds),
    longestGapMultiple: formatPositiveNumber(value.longestGapMultiple),
    estimatedMissedSamples: Number(value.estimatedMissedSamples ?? 0),
  };
}

function parseThresholdValues(summary) {
  const source = summary?.thresholds?.up ?? {};
  const thresholds = Object.keys(source)
    .map((key) => Number(String(key).replace(/^lt/, "")))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left);
  return thresholds.length ? thresholds : DEFAULT_THRESHOLDS;
}

function estimateMissedSamplesFromGap(gapMs, sampleIntervalMs) {
  if (
    !Number.isFinite(gapMs) ||
    !Number.isFinite(sampleIntervalMs) ||
    sampleIntervalMs <= 0 ||
    gapMs <= sampleIntervalMs * 1.5
  ) {
    return 0;
  }
  const estimatedIntervals = Math.max(1, Math.round(gapMs / sampleIntervalMs));
  return Math.max(0, estimatedIntervals - 1);
}

function deriveMonitorDetailsFromRaw(summary, filePath) {
  const rawPath = path.join(EVENTS_DIR, `${path.basename(filePath, ".json")}.jsonl`);
  const records = readJsonLines(rawPath);
  if (!records.length) {
    return null;
  }

  const thresholds = parseThresholdValues(summary);
  const firstThresholdHits = { up: {}, down: {} };
  for (const threshold of thresholds) {
    const key = `lt${threshold}`;
    firstThresholdHits.up[key] = null;
    firstThresholdHits.down[key] = null;
  }

  for (const record of records) {
    const upCents = Number(record.upCents);
    const downCents = Number(record.downCents);
    const observedAt = typeof record.ts === "string" ? record.ts : null;
    if (!observedAt) {
      continue;
    }
    for (const threshold of thresholds) {
      const key = `lt${threshold}`;
      if (Number.isFinite(upCents) && upCents <= threshold && !firstThresholdHits.up[key]) {
        firstThresholdHits.up[key] = observedAt;
      }
      if (Number.isFinite(downCents) && downCents <= threshold && !firstThresholdHits.down[key]) {
        firstThresholdHits.down[key] = observedAt;
      }
    }
  }

  const firstSampleAt = new Date(records[0]?.ts ?? "");
  const lastSampleAt = new Date(records[records.length - 1]?.ts ?? "");
  const sampleIntervalMs = Number(
    summary?.sampleIntervalMs ??
      records[records.length - 1]?.sampleIntervalMs ??
      records[0]?.sampleIntervalMs ??
      0,
  );
  let longestGapMs = 0;
  let estimatedMissedSamples = 0;

  for (let index = 1; index < records.length; index += 1) {
    const previous = new Date(records[index - 1]?.ts ?? "");
    const current = new Date(records[index]?.ts ?? "");
    if (Number.isNaN(previous.getTime()) || Number.isNaN(current.getTime())) {
      continue;
    }
    const gapMs = current.getTime() - previous.getTime();
    longestGapMs = Math.max(longestGapMs, gapMs);
    estimatedMissedSamples += estimateMissedSamplesFromGap(gapMs, sampleIntervalMs);
  }

  const durationMs =
    Number.isNaN(firstSampleAt.getTime()) || Number.isNaN(lastSampleAt.getTime())
      ? 0
      : Math.max(0, lastSampleAt.getTime() - firstSampleAt.getTime());
  const expectedSamplesObservedSpan =
    durationMs > 0 && sampleIntervalMs > 0
      ? Math.floor(durationMs / sampleIntervalMs) + 1
      : records.length > 0
        ? 1
        : 0;
  const eventStart = new Date(summary?.eventStart ?? "");
  const eventEnd = new Date(summary?.eventEnd ?? "");
  const fullWindowMs =
    !Number.isNaN(eventStart.getTime()) && !Number.isNaN(eventEnd.getTime())
      ? Math.max(0, eventEnd.getTime() - eventStart.getTime())
      : null;
  const expectedSamplesFullWindow =
    Number.isFinite(fullWindowMs) && fullWindowMs > 0 && sampleIntervalMs > 0
      ? Math.ceil(fullWindowMs / sampleIntervalMs)
      : null;
  const windowCoverageRatio =
    expectedSamplesFullWindow && expectedSamplesFullWindow > 0
      ? Number((records.length / expectedSamplesFullWindow).toFixed(4))
      : null;
  const continuityRatio =
    expectedSamplesObservedSpan > 0
      ? Number((records.length / expectedSamplesObservedSpan).toFixed(4))
      : null;
  const longestGapMultiple =
    longestGapMs > 0 && sampleIntervalMs > 0
      ? Number((longestGapMs / sampleIntervalMs).toFixed(2))
      : 0;

  let status = "healthy";
  if (
    (windowCoverageRatio !== null && windowCoverageRatio < 0.85) ||
    longestGapMultiple >= 4
  ) {
    status = "risky";
  } else if (
    (windowCoverageRatio !== null && windowCoverageRatio < 0.95) ||
    longestGapMultiple >= 2
  ) {
    status = "watch";
  }

  return {
    firstThresholdHits,
    samplingHealth: {
      status,
      actualSamples: records.length,
      expectedSamplesFullWindow,
      expectedSamplesObservedSpan,
      observedSpanMinutes: Number((durationMs / 60000).toFixed(2)),
      windowCoverageRatio,
      continuityRatio,
      longestGapSeconds: Number((longestGapMs / 1000).toFixed(2)),
      longestGapMultiple,
      estimatedMissedSamples,
    },
  };
}

function buildActiveRun(filePath, sampleLimit = 10) {
  const records = readJsonLines(filePath);
  if (records.length === 0) {
    return null;
  }
  const latestSample = records[records.length - 1];
  const monitorWindowHours = Number(
    latestSample?.monitorWindowHours ?? latestSample?.windowHours ?? 1,
  );
  const monitorVariant =
    latestSample?.monitorVariant ??
    `${Number.isFinite(monitorWindowHours) ? monitorWindowHours : 1}h`;

  return {
    fileName: path.basename(filePath),
    filePath,
    sampleCount: records.length,
    latestSample,
    recentSamples: records.slice(-sampleLimit).reverse(),
    firstSampleAt: records[0]?.ts ?? null,
    lastSampleAt: latestSample?.ts ?? null,
    slug: latestSample?.slug ?? null,
    priceSource: latestSample?.priceSource ?? "unknown",
    monitorVariant,
    monitorWindowHours,
  };
}

function getActiveRuns(sampleLimit = 10) {
  const files = listFiles(EVENTS_DIR, ".jsonl");
  const found = new Map();

  for (const filePath of files) {
    const activeRun = buildActiveRun(filePath, sampleLimit);
    if (!activeRun) {
      continue;
    }
    const key = activeRun.monitorVariant;
    if (!found.has(key)) {
      found.set(key, activeRun);
    }
  }

  return Array.from(found.values()).sort((left, right) => {
    const rankDiff =
      getMonitorVariantRank(left.monitorVariant) -
      getMonitorVariantRank(right.monitorVariant);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return new Date(right.lastSampleAt ?? 0).getTime() - new Date(left.lastSampleAt ?? 0).getTime();
  });
}

function normalizeSummary(summary, filePath) {
  if (!summary || typeof summary !== "object") {
    return null;
  }

  const derivedDetails =
    summary.firstThresholdHits && summary.samplingHealth
      ? null
      : deriveMonitorDetailsFromRaw(summary, filePath);

  const sortIso =
    summary.eventStart ??
    summary.lastSampleAt ??
    summary.eventEnd ??
    summary.runStartedAt ??
    new Date(fs.statSync(filePath).mtimeMs).toISOString();
  const sortMs = new Date(sortIso).getTime();

  return {
    ...summary,
    fileName: path.basename(filePath),
    minUpCents: formatCents(summary.minUpCents),
    minDownCents: formatCents(summary.minDownCents),
    durationMinutes: Number(summary.durationMinutes ?? 0),
    sampleCount: Number(summary.sampleCount ?? 0),
    monitorWindowHours: Number(summary.monitorWindowHours ?? 1),
    monitorVariant:
      summary.monitorVariant ??
      `${Number(summary.monitorWindowHours ?? 1) || 1}h`,
    firstThresholdHits: normalizeThresholdHits(
      summary.firstThresholdHits ?? derivedDetails?.firstThresholdHits,
    ),
    samplingHealth: normalizeSamplingHealth(
      summary.samplingHealth ?? derivedDetails?.samplingHealth,
      summary.sampleCount,
    ),
    sortIso,
    sortMs: Number.isFinite(sortMs) ? sortMs : 0,
  };
}

function parsePageNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function parseDateBoundary(value, endOfDay = false) {
  if (!value) {
    return null;
  }
  const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const parsed = new Date(`${value}${suffix}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDefaultStartDate(endDate) {
  return new Date(endDate.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

function buildThresholdAggregate(items) {
  const totalSummaries = items.length;
  const createBucket = () => ({
    totalSummaries,
    ...Object.fromEntries(
      DEFAULT_THRESHOLDS.map((threshold) => [
        `lt${threshold}`,
        {
          threshold,
          count: 0,
          ratio: 0,
        },
      ]),
    ),
  });

  const stats = {
    totalSummaries,
    both: createBucket(),
    missingEither: createBucket(),
  };

  if (!totalSummaries) {
    return stats;
  }

  for (const summary of items) {
    for (const threshold of DEFAULT_THRESHOLDS) {
      const key = `lt${threshold}`;
      const upHit = Boolean(summary?.thresholds?.up?.[key]);
      const downHit = Boolean(summary?.thresholds?.down?.[key]);
      if (upHit && downHit) {
        stats.both[key].count += 1;
      } else {
        stats.missingEither[key].count += 1;
      }
    }
  }

  for (const side of ["both", "missingEither"]) {
    for (const threshold of DEFAULT_THRESHOLDS) {
      const key = `lt${threshold}`;
      stats[side][key].ratio = Number(
        (stats[side][key].count / totalSummaries).toFixed(4),
      );
    }
  }

  return stats;
}

function buildPaperSummaryPage(monitorVariant) {
  const config = PAPER_VARIANTS[monitorVariant];
  const summary = config ? readJsonFile(config.summaryPath) : null;
  const session = config ? readJsonFile(config.sessionPath) : null;
  const ranking = Array.isArray(summary?.ranking) ? summary.ranking : [];
  const fallbackStrategies = Array.isArray(summary?.strategies) ? summary.strategies : [];
  const rows = ranking.length ? ranking : fallbackStrategies;

  return {
    mode: "paper",
    paperSummary: {
      variant: config?.id ?? monitorVariant,
      label: config?.label ?? monitorVariant,
      timeframeLabel: config?.timeframeLabel ?? monitorVariant,
      summary: summary ?? null,
      session: session ?? null,
      rows,
      bestStrategy: rows[0] ?? null,
      worstStrategy: rows.length ? rows[rows.length - 1] : null,
      filePath: config?.summaryPath ?? null,
    },
    items: [],
    thresholdAggregate: buildThresholdAggregate([]),
    pagination: {
      page: 1,
      pageSize: rows.length || DEFAULT_PAGE_SIZE,
      totalItems: rows.length,
      totalPages: 1,
      hasPreviousPage: false,
      hasNextPage: false,
    },
    filters: {
      startDate: "",
      endDate: "",
      monitorVariant: monitorVariant || "",
    },
  };
}

function buildSummaryPage({
  startDate,
  endDate,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  monitorVariant,
}) {
  if (monitorVariant && PAPER_VARIANTS[monitorVariant]) {
    return buildPaperSummaryPage(monitorVariant);
  }

  const effectiveEndDate = parseDateBoundary(endDate, true) ?? new Date();
  const effectiveStartDate =
    parseDateBoundary(startDate, false) ?? getDefaultStartDate(effectiveEndDate);

  const normalizedPage = parsePageNumber(page);
  const normalizedPageSize = Math.max(1, parsePageNumber(pageSize));

  const items = dedupeSummaries(
    listFiles(SUMMARY_DIR, ".json")
    .map((filePath) => normalizeSummary(readJsonFile(filePath), filePath))
    .filter(Boolean)
    .filter((summary) => {
      if (!summary.sortMs) {
        return false;
      }
      if (monitorVariant && summary.monitorVariant !== monitorVariant) {
        return false;
      }
      return (
        summary.sortMs >= effectiveStartDate.getTime() &&
        summary.sortMs <= effectiveEndDate.getTime()
      );
    })
    .sort((left, right) => right.sortMs - left.sortMs),
  );

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / normalizedPageSize));
  const safePage = Math.min(normalizedPage, totalPages);
  const offset = (safePage - 1) * normalizedPageSize;

  return {
    mode: "monitor",
    paperSummary: null,
    items: items.slice(offset, offset + normalizedPageSize),
    thresholdAggregate: buildThresholdAggregate(items),
    pagination: {
      page: safePage,
      pageSize: normalizedPageSize,
      totalItems,
      totalPages,
      hasPreviousPage: safePage > 1,
      hasNextPage: safePage < totalPages,
    },
    filters: {
      startDate: effectiveStartDate.toISOString().slice(0, 10),
      endDate: effectiveEndDate.toISOString().slice(0, 10),
      monitorVariant: monitorVariant || "",
    },
  };
}

export function getMonitorSnapshot(options = {}) {
  const activeRuns = getActiveRuns();
  return {
    dataDir: DATA_DIR,
    eventsDir: EVENTS_DIR,
    summariesDir: SUMMARY_DIR,
    activeRun: activeRuns[0] ?? null,
    activeRuns,
    summaryPage: buildSummaryPage(options),
  };
}
