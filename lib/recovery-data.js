import fs from "fs";
import path from "path";
import { readRecoveryConfig } from "@/lib/recovery-config";
import { getBtcServiceStatus } from "@/lib/service-control";

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data", "orders_recovery");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const VARIANTS = [{ id: "4h", label: "4小时" }];

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return LOCAL_DATE_FORMATTER.format(date);
}

function dateKeyDaysAgo(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return localDateKey(date);
}

function dateKeyToDate(ymd) {
  const [year, month, day] = String(ymd || "")
    .split("-")
    .map((value) => Number(value));
  if (!year || !month || !day) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function shiftDateKey(ymd, deltaDays) {
  const baseDate = dateKeyToDate(ymd);
  if (!baseDate) {
    return null;
  }
  baseDate.setUTCDate(baseDate.getUTCDate() + deltaDays);
  return localDateKey(baseDate);
}

function buildRecentDateKeys(endKey, count = 7) {
  const keys = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const key = shiftDateKey(endKey, -offset);
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

function eventAccountingDate(row) {
  return localDateKey(row?.finalizedAt || row?.eventEnd || row?.eventStart || row?.sortMs);
}

function buildPnlSummary(eventRows, aggregate) {
  const todayKey = localDateKey();
  const settledRows = eventRows.filter((row) => row?.status === "resolved");
  const recentDateKeys = buildRecentDateKeys(todayKey, 7);
  const sevenDayStartKey = recentDateKeys[0] || dateKeyDaysAgo(6);
  const todayRows = settledRows.filter((row) => eventAccountingDate(row) === todayKey);
  const sevenDayRows = settledRows.filter((row) => {
    const key = eventAccountingDate(row);
    return key && key >= sevenDayStartKey && key <= todayKey;
  });
  const settledByDate = new Map();
  for (const row of sevenDayRows) {
    const key = eventAccountingDate(row);
    if (!key) {
      continue;
    }
    const items = settledByDate.get(key) || [];
    items.push(row);
    settledByDate.set(key, items);
  }
  return {
    totalPnlUsd: number(aggregate.realizedNetPnlUsd),
    todayPnlUsd: todayRows.reduce((sum, row) => sum + number(row.pnlUsd), 0),
    sevenDayPnlUsd: sevenDayRows.reduce((sum, row) => sum + number(row.pnlUsd), 0),
    todayEvents: todayRows.length,
    sevenDayEvents: sevenDayRows.length,
    todayKey,
    sevenDayStartKey,
    dailyBreakdown: recentDateKeys.map((date) => {
      const rows = settledByDate.get(date) || [];
      return {
        date,
        pnlUsd: rows.reduce((sum, row) => sum + number(row.pnlUsd), 0),
        events: rows.length,
      };
    }),
  };
}

function buildEventIdentity(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const variant = row.variant || "unknown";
  const eventKey = row.eventKey || row.slug || row.eventStart || row.sortMs;
  return eventKey ? `${variant}:${eventKey}` : null;
}

function dedupeEventRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const identity = buildEventIdentity(row);
    if (identity && seen.has(identity)) {
      continue;
    }
    if (identity) {
      seen.add(identity);
    }
    deduped.push(row);
  }
  return deduped;
}

function loadVariantSnapshot(variant) {
  const summary =
    readJson(path.join(REPORTS_DIR, `group-summary-${variant.id}.json`), null) || {
      variant: variant.id,
      variantLabel: variant.label,
      startBalanceUsd: 0,
      trancheSizeUsd: 0,
      tranchesUsed: 0,
      maxTranches: 0,
      restartDelayHours: 0,
      profitWithdrawRate: 0,
      withdrawnProfitUsd: 0,
      totalCommittedUsd: 0,
      nextRestartAt: null,
      stoppedAt: null,
      lastTopUpAt: null,
      balanceUsd: 0,
      availableUsd: 0,
      activeExposureUsd: 0,
      realizedNetPnlUsd: 0,
      currentLegUsd: 0,
      baseLegUsd: 0,
      recoveryLegUsd: 0,
      currentLossStreak: 0,
      recoveryTriggerLosses: 0,
      totalEvents: 0,
      tradedEvents: 0,
      skippedEvents: 0,
      winningEvents: 0,
      losingEvents: 0,
      flatEvents: 0,
      recoveryMode: false,
      status: "idle",
      updatedAt: null,
    };
  const runtime =
    readJson(path.join(RUNTIME_DIR, `runtime-state-${variant.id}.json`), null) || {
      variant: variant.id,
      label: variant.label,
      mode: "unknown",
      strategy: null,
      activeEvent: null,
      lastSkipReason: null,
      lastUpdatedAt: null,
    };
  const events = readJson(path.join(REPORTS_DIR, `event-details-${variant.id}.json`), []);
  const trades = readJson(path.join(REPORTS_DIR, `trade-details-${variant.id}.json`), []);
  return {
    variant: variant.id,
    label: variant.label,
    summary,
    runtime,
    activeEvent: runtime.activeEvent ?? null,
    events: Array.isArray(events) ? events : [],
    trades: Array.isArray(trades) ? trades : [],
  };
}

export async function getRecoverySnapshot() {
  const config = await readRecoveryConfig();
  const variants = VARIANTS.map(loadVariantSnapshot);
  const allEvents = dedupeEventRows(
    variants
      .flatMap((item) => item.events)
      .sort((left, right) => number(right?.sortMs) - number(left?.sortMs)),
  );
  const allTrades = variants
    .flatMap((item) => item.trades)
    .sort((left, right) => number(right?.sortMs) - number(left?.sortMs));

  const aggregate = variants.reduce(
    (acc, item) => {
      const summary = item.summary || {};
      acc.startBalanceUsd += number(summary.startBalanceUsd);
      acc.withdrawnProfitUsd += number(summary.withdrawnProfitUsd);
      acc.totalCommittedUsd += number(summary.totalCommittedUsd);
      acc.balanceUsd += number(summary.balanceUsd);
      acc.availableUsd += number(summary.availableUsd);
      acc.activeExposureUsd += number(summary.activeExposureUsd);
      acc.realizedNetPnlUsd += number(summary.realizedNetPnlUsd);
      acc.totalEvents += number(summary.totalEvents);
      acc.tradedEvents += number(summary.tradedEvents);
      acc.skippedEvents += number(summary.skippedEvents);
      acc.winningEvents += number(summary.winningEvents);
      acc.losingEvents += number(summary.losingEvents);
      acc.flatEvents += number(summary.flatEvents);
      return acc;
    },
    {
      startBalanceUsd: 0,
      withdrawnProfitUsd: 0,
      totalCommittedUsd: 0,
      balanceUsd: 0,
      availableUsd: 0,
      activeExposureUsd: 0,
      realizedNetPnlUsd: 0,
      totalEvents: 0,
      tradedEvents: 0,
      skippedEvents: 0,
      winningEvents: 0,
      losingEvents: 0,
      flatEvents: 0,
    },
  );

  const pnlSummary = buildPnlSummary(allEvents, aggregate);
  const serviceStatus = getBtcServiceStatus();

  return {
    generatedAt: new Date().toISOString(),
    config,
    aggregate,
    pnlSummary,
    serviceStatus,
    variants,
    activeEvents: variants
      .map((item) => ({
        variant: item.variant,
        label: item.label,
        event: item.activeEvent,
        runtime: item.runtime,
        summary: item.summary,
      }))
      .filter((item) => item.event),
    eventRows: allEvents.slice(0, 80),
    tradeRows: allTrades.slice(0, 120),
  };
}
