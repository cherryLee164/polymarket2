import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data", "orders");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const REDEEMS_DIR = path.join(DATA_DIR, "redeems");
const SETTLEMENT_LOG_PATH = path.join(REDEEMS_DIR, "auto-redeem-log.jsonl");
const SETTLEMENT_STATE_PATH = path.join(REDEEMS_DIR, "auto-redeem-state.json");
const DEFAULT_PAGE_SIZE = 12;
const DEFAULT_DETAIL_PAGE_SIZE = 16;
const DEFAULT_SETTLEMENT_PAGE_SIZE = 20;
const ORDER_VARIANT_ORDER = ["1h", "4h", "5m"];
const LEGACY_RUNTIME_STATE_PATH = path.join(DATA_DIR, "runtime-state.json");

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parsePageNumber(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readJsonLines(filePath, fallback = []) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return fallback;
  }
}

function paginate(items, page, pageSize) {
  const safeItems = Array.isArray(items) ? items : [];
  const safePageSize = Math.max(1, parsePageNumber(pageSize, pageSize));
  const totalItems = safeItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const safePage = Math.min(parsePageNumber(page, 1), totalPages);
  const offset = (safePage - 1) * safePageSize;

  return {
    items: safeItems.slice(offset, offset + safePageSize),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      totalItems,
      totalPages,
      hasPreviousPage: safePage > 1,
      hasNextPage: safePage < totalPages,
    },
  };
}

function parseDateValue(value) {
  const parsed = new Date(value ?? "");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function detectOrderVariant(input) {
  const text = String(input ?? "").toLowerCase();
  if (text === "4h" || text.startsWith("btc-updown-4h-")) {
    return "4h";
  }
  if (text === "5m" || text.startsWith("btc-updown-5m-")) {
    return "5m";
  }
  if (text === "1h" || text.startsWith("bitcoin-up-or-down-")) {
    return "1h";
  }
  return text || "1h";
}

function getVariantLabel(variant) {
  return detectOrderVariant(variant).toUpperCase();
}

function formatSideLabel(side) {
  if (!side) {
    return "--";
  }
  return String(side).toUpperCase();
}

function buildSettlementStatus(entry) {
  if (entry?.type === "startup") {
    return "startup";
  }
  if (entry?.type === "error") {
    return "error";
  }
  if ((entry?.autoSell?.sold ?? []).some((row) => row?.sold)) {
    return "sold";
  }
  if (entry?.claimed) {
    return "claimed";
  }
  if (entry?.busy) {
    return "watching";
  }
  return "idle";
}

function buildSettlementMessage(entry, status) {
  if (status === "startup") {
    return `空闲扫描 ${Math.round((Number(entry?.intervalMs ?? 0) || 0) / 60000)} 分钟，最多每轮卖 ${entry?.maxSellsPerRun ?? 1} 笔`;
  }
  if (status === "error") {
    return entry?.message ?? "结算任务错误";
  }

  const soldRows = (entry?.autoSell?.sold ?? []).filter((row) => row?.sold);
  if (status === "sold") {
    return soldRows
      .map((row) => `${row?.slug ?? row?.title ?? "position"} ${row?.outcome ?? ""}`.trim())
      .join(" / ");
  }
  if (status === "claimed") {
    const target = entry?.entriesPreview?.[0]?.slug ?? "position";
    return `${target} 已领取`;
  }
  if (status === "claim-error") {
    return (entry?.browserResult?.stderrPreview ?? entry?.browserResult?.stderr ?? "浏览器领取失败").slice(0, 180);
  }
  if (status === "watching") {
    return `卖出候选 ${entry?.autoSell?.candidateCount ?? 0}，可领取 ${entry?.redeemableCount ?? 0}`;
  }
  return "无可卖出、无可领取";
}

function buildSettlementRows(logEntries) {
  const rows = (Array.isArray(logEntries) ? logEntries : []).map((entry, index) => {
    const status = buildSettlementStatus(entry);
    const beforeBalanceUsd = Number(entry?.beforeBalanceUsd ?? NaN);
    const afterBalanceUsd = Number(entry?.afterBalanceUsd ?? NaN);
    const balanceDeltaUsd =
      Number.isFinite(beforeBalanceUsd) && Number.isFinite(afterBalanceUsd)
        ? Number((afterBalanceUsd - beforeBalanceUsd).toFixed(6))
        : null;
    const soldRows = (entry?.autoSell?.sold ?? []).filter((row) => row?.sold);

    return {
      id: `${entry?.loggedAt ?? "log"}-${index}`,
      loggedAt: entry?.loggedAt ?? null,
      type: entry?.type ?? "cycle",
      status,
      message: buildSettlementMessage(entry, status),
      beforeBalanceUsd: Number.isFinite(beforeBalanceUsd) ? beforeBalanceUsd : null,
      afterBalanceUsd: Number.isFinite(afterBalanceUsd) ? afterBalanceUsd : null,
      balanceDeltaUsd,
      busy: Boolean(entry?.busy),
      candidateCount: Number(entry?.autoSell?.candidateCount ?? 0),
      soldCount: soldRows.length,
      claimCount: entry?.claimed ? 1 : 0,
      redeemableCount: Number(entry?.redeemableCount ?? 0),
      trackedSlugCount: Number(entry?.trackedSlugCount ?? 0),
      soldItems: soldRows.map((row) => ({
        slug: row?.slug ?? null,
        title: row?.title ?? null,
        outcome: row?.outcome ?? null,
        shares: row?.shares ?? null,
        sellPrice: row?.sellPrice ?? null,
        pageLikePrice: row?.pageLikePrice ?? null,
        currentValueUsd: row?.currentValueUsd ?? null,
        realizedUsd: row?.realizedUsd ?? null,
        txHash: row?.txHash ?? null,
        orderId: row?.orderId ?? null,
      })),
      claimApiOnly: Boolean(entry?.claimApiOnly),
      claimDisabled: Boolean(entry?.claimDisabled),
      entriesPreview: Array.isArray(entry?.entriesPreview) ? entry.entriesPreview : [],
    };
  });

  return rows
    .filter((row) => row.status === "sold" || row.status === "claimed")
    .sort((left, right) => {
    const leftDate = parseDateValue(left.loggedAt);
    const rightDate = parseDateValue(right.loggedAt);
    return (rightDate?.getTime() ?? 0) - (leftDate?.getTime() ?? 0);
  });
}

function buildSettlementSummary(rows, settleState) {
  const list = Array.isArray(rows) ? rows : [];
  const cycleRows = list.filter((row) => row.type === "cycle");
  const latestCycle = cycleRows[0] ?? null;
  const conditionCount = Object.values(settleState?.conditions ?? {}).filter(
    (record) => record && (record.lastClaimAttemptMs || record.lastClaimAttemptAt),
  ).length;
  const assetCount = Object.values(settleState?.assets ?? {}).filter(
    (record) => record && (record.lastSellAttemptMs || record.lastSellAttemptAt),
  ).length;

  return {
    totalRecords: list.length,
    cycleCount: cycleRows.length,
    busyCycles: cycleRows.filter((row) => row.busy).length,
    soldCycles: cycleRows.filter((row) => row.soldCount > 0).length,
    claimCycles: cycleRows.filter((row) => row.claimCount > 0).length,
    errorCount: list.filter((row) => row.status === "error").length,
    latestLoggedAt: list[0]?.loggedAt ?? null,
    latestBalanceUsd: latestCycle?.afterBalanceUsd ?? latestCycle?.beforeBalanceUsd ?? null,
    trackedConditionCount: conditionCount,
    trackedAssetCount: assetCount,
  };
}

function buildExecutionLedger(hourDetails, orderDetails) {
  const groupedOrders = new Map();

  for (const order of Array.isArray(orderDetails) ? orderDetails : []) {
    if (!order?.hourKey) {
      continue;
    }
    const list = groupedOrders.get(order.hourKey) ?? [];
    list.push(order);
    groupedOrders.set(order.hourKey, list);
  }

  const rows = (Array.isArray(hourDetails) ? hourDetails : []).map((hour) => {
    const orders = [...(groupedOrders.get(hour.hourKey) ?? [])].sort((left, right) => {
      const leftDate = parseDateValue(left.requestedAt ?? left.eventStart);
      const rightDate = parseDateValue(right.requestedAt ?? right.eventStart);
      return (leftDate?.getTime() ?? 0) - (rightDate?.getTime() ?? 0);
    });

    const triggerParts = orders.map((order) => {
      const side = formatSideLabel(order.side);
      const trigger = order.triggerType ?? "manual";
      return `${side} ${trigger}`;
    });
    const directionParts = orders.map((order) => formatSideLabel(order.side));
    const totalSharesBought = orders.reduce(
      (sum, order) => sum + (Number(order.sharesBought) || 0),
      0,
    );
    const totalCostUsd = Number(hour.totalSpentUsd ?? 0);
    const blendedAvgPriceCents =
      totalSharesBought > 0 ? Number(((totalCostUsd / totalSharesBought) * 100).toFixed(3)) : null;
    const firstOrderAt = orders[0]?.requestedAt ?? hour.eventStart ?? null;
    const lastOrderAt = orders.at(-1)?.requestedAt ?? firstOrderAt;

    return {
      hourKey: hour.hourKey,
      slug: hour.slug,
      eventStart: hour.eventStart,
      eventEnd: hour.eventEnd,
      firstOrderAt,
      lastOrderAt,
      directionLabel:
        directionParts.length > 0
          ? Array.from(new Set(directionParts)).join(" / ")
          : (Array.isArray(hour.placedSides) ? hour.placedSides.map(formatSideLabel).join(" / ") : "--"),
      triggerLabel: triggerParts.length > 0 ? triggerParts.join(" / ") : "--",
      orderCount: orders.length || Number(hour.orderCount ?? 0),
      totalSpentUsd: totalCostUsd,
      totalPayoutUsd: Number(hour.totalPayoutUsd ?? 0),
      totalSharesBought: Number(totalSharesBought.toFixed(6)),
      blendedAvgPriceCents,
      settlementStatus: hour.settlementStatus ?? "pending",
      winnerSide: hour.winnerSide ?? null,
      netPnlUsd: hour.netPnlUsd,
      paired: Boolean(hour.paired),
      claimStatus: hour.claimStatus ?? null,
      claimTransactionHash: hour.claimTransactionHash ?? null,
      claimReadyAt: hour.claimReadyAt ?? null,
    };
  });

  return rows.sort((left, right) => {
    const leftDate = parseDateValue(left.eventStart ?? left.firstOrderAt);
    const rightDate = parseDateValue(right.eventStart ?? right.firstOrderAt);
    return (rightDate?.getTime() ?? 0) - (leftDate?.getTime() ?? 0);
  });
}

function buildEmptySummary() {
  return {
    generatedAt: null,
    logTimeZone: "Asia/Shanghai",
    trackedHours: 0,
    hoursWithOrders: 0,
    settledHours: 0,
    unsettledHours: 0,
    pairedHours: 0,
    singleSideHours: 0,
    totalOrders: 0,
    totalSpentUsd: 0,
    totalPayoutUsd: 0,
    totalNetPnlUsd: 0,
    winningHours: 0,
    losingHours: 0,
    flatHours: 0,
    claimedHours: 0,
    pendingClaimHours: 0,
    today: {
      date: null,
      hours: 0,
      spentUsd: 0,
      payoutUsd: 0,
      netPnlUsd: 0,
    },
    yesterday: {
      date: null,
      hours: 0,
      spentUsd: 0,
      payoutUsd: 0,
      netPnlUsd: 0,
    },
    daily: [],
    byVariant: {},
  };
}

function buildEmptyVariantBucket(variant) {
  return {
    variant,
    label: getVariantLabel(variant),
    hoursWithOrders: 0,
    settledHours: 0,
    totalOrders: 0,
    totalSpentUsd: 0,
    totalPayoutUsd: 0,
    totalNetPnlUsd: 0,
    today: {
      date: null,
      hours: 0,
      spentUsd: 0,
      payoutUsd: 0,
      netPnlUsd: 0,
    },
    yesterday: {
      date: null,
      hours: 0,
      spentUsd: 0,
      payoutUsd: 0,
      netPnlUsd: 0,
    },
  };
}

function buildVariantBreakdown(hourDetails, orderDetails, baseSummary) {
  const buckets = new Map();
  const todayKey = baseSummary?.today?.date ?? null;
  const yesterdayKey = baseSummary?.yesterday?.date ?? null;

  for (const variant of ORDER_VARIANT_ORDER) {
    buckets.set(variant, buildEmptyVariantBucket(variant));
  }

  for (const hour of Array.isArray(hourDetails) ? hourDetails : []) {
    const variant = detectOrderVariant(hour?.variant ?? hour?.slug);
    const bucket = buckets.get(variant) ?? buildEmptyVariantBucket(variant);
    bucket.hoursWithOrders += 1;
    if (hour?.settlementStatus === "resolved") {
      bucket.settledHours += 1;
      bucket.totalSpentUsd += Number(hour?.totalSpentUsd ?? 0);
      bucket.totalPayoutUsd += Number(hour?.totalPayoutUsd ?? 0);
      bucket.totalNetPnlUsd += Number(hour?.netPnlUsd ?? 0);

      const eventEnd = parseDateValue(hour?.eventEnd ?? hour?.eventStart);
      const dayKey = eventEnd ? eventEnd.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }) : null;
      if (dayKey && dayKey === todayKey) {
        bucket.today.date = dayKey;
        bucket.today.hours += 1;
        bucket.today.spentUsd += Number(hour?.totalSpentUsd ?? 0);
        bucket.today.payoutUsd += Number(hour?.totalPayoutUsd ?? 0);
        bucket.today.netPnlUsd += Number(hour?.netPnlUsd ?? 0);
      }
      if (dayKey && dayKey === yesterdayKey) {
        bucket.yesterday.date = dayKey;
        bucket.yesterday.hours += 1;
        bucket.yesterday.spentUsd += Number(hour?.totalSpentUsd ?? 0);
        bucket.yesterday.payoutUsd += Number(hour?.totalPayoutUsd ?? 0);
        bucket.yesterday.netPnlUsd += Number(hour?.netPnlUsd ?? 0);
      }
    }
    buckets.set(variant, bucket);
  }

  for (const order of Array.isArray(orderDetails) ? orderDetails : []) {
    const variant = detectOrderVariant(order?.variant ?? order?.slug);
    const bucket = buckets.get(variant) ?? buildEmptyVariantBucket(variant);
    bucket.totalOrders += 1;
    buckets.set(variant, bucket);
  }

  const result = {};
  for (const [variant, bucket] of buckets.entries()) {
    result[variant] = {
      ...bucket,
      totalSpentUsd: Number(bucket.totalSpentUsd.toFixed(6)),
      totalPayoutUsd: Number(bucket.totalPayoutUsd.toFixed(6)),
      totalNetPnlUsd: Number(bucket.totalNetPnlUsd.toFixed(6)),
      today: {
        ...bucket.today,
        spentUsd: Number(bucket.today.spentUsd.toFixed(6)),
        payoutUsd: Number(bucket.today.payoutUsd.toFixed(6)),
        netPnlUsd: Number(bucket.today.netPnlUsd.toFixed(6)),
      },
      yesterday: {
        ...bucket.yesterday,
        spentUsd: Number(bucket.yesterday.spentUsd.toFixed(6)),
        payoutUsd: Number(bucket.yesterday.payoutUsd.toFixed(6)),
        netPnlUsd: Number(bucket.yesterday.netPnlUsd.toFixed(6)),
      },
    };
  }
  return result;
}

function listRuntimeStates() {
  const rows = [];
  try {
    const names = fs.readdirSync(DATA_DIR);
    for (const name of names) {
      if (!/^runtime-state-.*\.json$/i.test(name)) {
        continue;
      }
      const payload = readJsonFile(path.join(DATA_DIR, name), null);
      if (!payload || typeof payload !== "object") {
        continue;
      }
      const variant = detectOrderVariant(payload?.variant ?? name.replace(/^runtime-state-/, "").replace(/\.json$/i, ""));
      rows.push({
        ...payload,
        variant,
        label: getVariantLabel(variant),
      });
    }
  } catch {}

  if (!rows.length) {
    const legacy = readJsonFile(LEGACY_RUNTIME_STATE_PATH, null);
    if (legacy && typeof legacy === "object") {
      rows.push({
        ...legacy,
        variant: detectOrderVariant(legacy?.variant ?? legacy?.slug),
        label: getVariantLabel(legacy?.variant ?? legacy?.slug),
      });
    }
  }

  return rows.sort((left, right) => {
    const leftDate = parseDateValue(left?.eventEnd ?? left?.eventStart ?? left?.runStartedAt);
    const rightDate = parseDateValue(right?.eventEnd ?? right?.eventStart ?? right?.runStartedAt);
    return (rightDate?.getTime() ?? 0) - (leftDate?.getTime() ?? 0);
  });
}

export function getOrderSnapshot(options = {}) {
  const rawSummary = readJsonFile(
    path.join(REPORTS_DIR, "summary.json"),
    buildEmptySummary(),
  );
  const hourDetails = readJsonFile(path.join(REPORTS_DIR, "hour-details.json"), []);
  const orderDetails = readJsonFile(
    path.join(REPORTS_DIR, "order-details.json"),
    [],
  );
  const settleState = readJsonFile(SETTLEMENT_STATE_PATH, { conditions: {}, assets: {} });
  const settlementLogs = readJsonLines(SETTLEMENT_LOG_PATH, []);
  const settlementRows = buildSettlementRows(settlementLogs);
  const settlementSummary = buildSettlementSummary(settlementRows, settleState);
  const runtimeStates = listRuntimeStates();
  const runtimeState =
    runtimeStates.find((state) => detectOrderVariant(state?.variant) === "1h") ??
    runtimeStates[0] ??
    null;
  const executionLedger = buildExecutionLedger(hourDetails, orderDetails);
  const summary = {
    ...buildEmptySummary(),
    ...(rawSummary ?? {}),
    byVariant: buildVariantBreakdown(hourDetails, orderDetails, rawSummary ?? buildEmptySummary()),
  };

  return {
    dataDir: DATA_DIR,
    reportsDir: REPORTS_DIR,
    runtimeState,
    runtimeStates,
    settleState,
    settlementSummary,
    summary,
    hourPage: paginate(
      hourDetails,
      options.hourPage,
      options.hourPageSize ?? DEFAULT_PAGE_SIZE,
    ),
    orderPage: paginate(
      orderDetails,
      options.orderPage,
      options.orderPageSize ?? DEFAULT_DETAIL_PAGE_SIZE,
    ),
    settlementPage: paginate(
      settlementRows,
      options.settlePage,
      options.settlePageSize ?? DEFAULT_SETTLEMENT_PAGE_SIZE,
    ),
    ledgerPage: paginate(
      executionLedger,
      options.orderPage,
      options.orderPageSize ?? DEFAULT_DETAIL_PAGE_SIZE,
    ),
    latestHour: hourDetails[0] ?? null,
    latestOrder: orderDetails[0] ?? null,
    latestSettlement: settlementRows[0] ?? null,
  };
}
