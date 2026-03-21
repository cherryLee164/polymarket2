const fs = require('fs')
const path = require('path')
const { Wallet } = require('ethers')
const {
  CLOB_BASE,
  ensureDir,
  fetchLivePrices,
  fetchPublicProfile,
  formatForFilename,
  log,
  parseDate,
  resolveEventForDate,
  sleep,
} = require('./shared/polymarket')

loadEnvFile(path.join(process.cwd(), '.env.order.local'))
loadEnvFile(path.join(process.cwd(), '.env.order'))
loadEnvFile(path.join(process.cwd(), '.env.local'))
loadEnvFile(path.join(process.cwd(), '.env'))

const SAMPLE_INTERVAL_MS = Number(process.env.ORDER_SAMPLE_INTERVAL_MS || 5000)
const START_RETRY_MS = Number(process.env.ORDER_START_RETRY_MS || 10000)
const EVENT_MISSING_RETRY_MS = Number(process.env.ORDER_EVENT_MISSING_RETRY_MS || 30000)
const ORDER_ATTEMPT_COOLDOWN_MS = Number(process.env.ORDER_ATTEMPT_COOLDOWN_MS || 15000)
const FIRST_ENTRY_CENTS = Number(process.env.ORDER_FIRST_ENTRY_CENTS || 35)
const HEDGE_ENTRY_CENTS = Number(process.env.ORDER_HEDGE_ENTRY_CENTS || 40)
const MIN_FIRST_ENTRY_MINUTES_REMAINING = Number(
  process.env.ORDER_MIN_FIRST_ENTRY_MINUTES_REMAINING || 30
)
const BASE_ORDER_USD = Number(process.env.ORDER_BASE_USD || 1)
const ESCALATED_ORDER_USD = Number(process.env.ORDER_ESCALATED_USD || 2)
const MIN_ACCOUNT_BALANCE_USD = Number(process.env.ORDER_MIN_BALANCE_USD || 2)
const MAX_SAMPLES = Number(process.env.ORDER_MAX_SAMPLES || 0)
const ORDER_PRICE_SIDE = String(process.env.ORDER_PRICE_SIDE || 'BUY').toUpperCase()
const ORDER_EXECUTION_TYPE = String(process.env.ORDER_EXECUTION_TYPE || 'FOK').toUpperCase()
const ORDER_DRY_RUN = parseBoolean(process.env.ORDER_DRY_RUN, true)
const ORDER_AUTO_APPROVE = parseBoolean(process.env.ORDER_AUTO_APPROVE, false)
const COVERAGE_SIGNAL_MINUTES = Number(process.env.ORDER_SIGNAL_MIN_DURATION_MINUTES || 50)
const POLY_CHAIN_ID = Number(getFirstEnv(['POLY_CHAIN_ID'], 137))
const POLY_SIGNATURE_TYPE = getOptionalNumber(
  getFirstEnv(['POLY_SIGNATURE_TYPE', 'CLOB_SIGNATURE_TYPE', 'SIGNATURE_TYPE'], '')
)
const POLY_PRIVATE_KEY = getFirstEnv(
  ['POLY_PRIVATE_KEY', 'PORTFOLIO_PRIVATE_KEY', 'PRIVATE_KEY', 'pk'],
  ''
)
const POLY_FUNDER = getFirstEnv(
  ['POLY_FUNDER', 'FUNDER_ADDRESS', 'PROFILE_ADDRESS', 'PROXY_WALLET', 'PORTFOLIO_ADDRESS'],
  ''
)
const POLY_GEO_BLOCK_TOKEN = getFirstEnv(
  ['POLY_GEO_BLOCK_TOKEN', 'FOOTBALL_DATA_TOKEN'],
  undefined
)
const POLY_API_KEY = getFirstEnv(['POLY_API_KEY', 'CLOB_API_KEY'], '')
const POLY_API_SECRET = getFirstEnv(['POLY_API_SECRET', 'CLOB_SECRET'], '')
const POLY_API_PASSPHRASE = getFirstEnv(
  ['POLY_API_PASSPHRASE', 'CLOB_PASS_PHRASE', 'CLOB_PASSPHRASE'],
  ''
)

const DATA_DIR = path.join(process.cwd(), 'data', 'orders')
const HOURS_DIR = path.join(DATA_DIR, 'hours')
const LOGS_DIR = path.join(DATA_DIR, 'logs')
const RUNTIME_STATE_PATH = path.join(DATA_DIR, 'runtime-state.json')
const MONITOR_SUMMARIES_DIR = path.join(process.cwd(), 'data', 'summaries')

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return
  }
  const content = fs.readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue
    }
    let value = line.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function getFirstEnv(keys, fallbackValue = '') {
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim()
    }
  }
  return fallbackValue
}

function getOptionalNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    return null
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`)
}

function listJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return []
  }
  return fs
    .readdirSync(dirPath)
    .map((name) => path.join(dirPath, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile() && path.extname(filePath).toLowerCase() === '.json'
      } catch (error) {
        return false
      }
    })
}

function buildHourKey(meta) {
  const anchor =
    meta.eventStart instanceof Date && !Number.isNaN(meta.eventStart.getTime())
      ? meta.eventStart
      : meta.eventEnd instanceof Date && !Number.isNaN(meta.eventEnd.getTime())
        ? meta.eventEnd
        : new Date()
  return `${meta.slug}_${formatForFilename(anchor)}`
}

function createOrderRecord(side) {
  return {
    side,
    placed: false,
    mode: ORDER_DRY_RUN ? 'dry-run' : 'live',
    amountUsd: null,
    triggerType: null,
    thresholdCents: null,
    priceCap: null,
    observedCents: null,
    requestedAt: null,
    attemptCount: 0,
    lastAttemptAt: null,
    orderId: null,
    status: null,
    response: null,
    error: null,
  }
}

function createHourState(meta, carryPlan) {
  const hourKey = buildHourKey(meta)
  return {
    version: 1,
    mode: ORDER_DRY_RUN ? 'dry-run' : 'live',
    slug: meta.slug,
    hourKey,
    eventId: meta.eventId,
    marketId: meta.marketId,
    eventStart: meta.eventStart ? meta.eventStart.toISOString() : null,
    eventEnd: meta.eventEnd ? meta.eventEnd.toISOString() : null,
    runStartedAt: new Date().toISOString(),
    orderUsd: carryPlan.nextOrderUsd,
    carryPlan,
    priceSource: `clob-${ORDER_PRICE_SIDE.toLowerCase()}`,
    tickSize: meta.tickSize || null,
    orderMinSize: Number(meta.orderMinSize || 0),
    negRisk: Boolean(meta.negRisk),
    tokens: {
      up: meta.upTokenId,
      down: meta.downTokenId,
    },
    outcomes: Array.isArray(meta.outcomes) ? meta.outcomes : ['Up', 'Down'],
    firstSampleAt: null,
    lastSampleAt: null,
    sampleCount: 0,
    minUpCents: null,
    minDownCents: null,
    firstEntrySide: null,
    firstEntryPlacedAt: null,
    firstEntryTriggerCents: null,
    firstEntryBlockedLate: false,
    firstEntryBlockedAt: null,
    firstEntryBlockedRemainingMinutes: null,
    pairedAt: null,
    opportunity: {
      upLe35: false,
      downLe35: false,
      upLe40: false,
      downLe40: false,
    },
    orders: {
      up: createOrderRecord('up'),
      down: createOrderRecord('down'),
    },
    lastSample: null,
    finalizedAt: null,
    endReason: null,
    durationMinutes: 0,
    carrySignalQualified: false,
    bothSidesLe40: false,
    nextOrderUsd: null,
  }
}

function getRuntimeState() {
  return readJsonFile(RUNTIME_STATE_PATH)
}

function saveRuntimeState(state) {
  writeJsonFile(RUNTIME_STATE_PATH, state)
}

function clearRuntimeState() {
  if (fs.existsSync(RUNTIME_STATE_PATH)) {
    fs.unlinkSync(RUNTIME_STATE_PATH)
  }
}

function buildLogPath(state) {
  return path.join(LOGS_DIR, `${state.hourKey}.jsonl`)
}

function buildHourSummaryPath(state) {
  return path.join(HOURS_DIR, `${state.hourKey}.json`)
}

function writeHourLog(state, type, details = {}) {
  appendJsonLine(buildLogPath(state), {
    ts: new Date().toISOString(),
    type,
    slug: state.slug,
    hourKey: state.hourKey,
    ...details,
  })
}

function updateMin(currentMin, nextValue) {
  if (currentMin === null || nextValue < currentMin) {
    return nextValue
  }
  return currentMin
}

function updateOpportunityFlags(state, upCents, downCents) {
  if (upCents <= FIRST_ENTRY_CENTS) {
    state.opportunity.upLe35 = true
  }
  if (downCents <= FIRST_ENTRY_CENTS) {
    state.opportunity.downLe35 = true
  }
  if (upCents <= HEDGE_ENTRY_CENTS) {
    state.opportunity.upLe40 = true
  }
  if (downCents <= HEDGE_ENTRY_CENTS) {
    state.opportunity.downLe40 = true
  }
}

function pickFirstEntrySide(state, upCents, downCents) {
  const candidates = []
  if (!state.orders.up.placed && upCents <= FIRST_ENTRY_CENTS) {
    candidates.push({ side: 'up', cents: upCents })
  }
  if (!state.orders.down.placed && downCents <= FIRST_ENTRY_CENTS) {
    candidates.push({ side: 'down', cents: downCents })
  }
  if (!candidates.length) {
    return null
  }
  candidates.sort((left, right) => {
    if (left.cents !== right.cents) {
      return left.cents - right.cents
    }
    return left.side.localeCompare(right.side)
  })
  return candidates[0]
}

function getOppositeSide(side) {
  return side === 'up' ? 'down' : 'up'
}

function shouldRetryOrder(orderRecord, now) {
  if (orderRecord.placed) {
    return false
  }
  if (!orderRecord.lastAttemptAt) {
    return true
  }
  const lastAttemptMs = new Date(orderRecord.lastAttemptAt).getTime()
  return Number.isFinite(lastAttemptMs) && now.getTime() - lastAttemptMs >= ORDER_ATTEMPT_COOLDOWN_MS
}

function getRemainingMinutes(state, now) {
  const eventEnd = parseDate(state.eventEnd)
  if (!eventEnd) {
    return 0
  }
  return (eventEnd.getTime() - now.getTime()) / 60000
}

function buildCarryPlan(nextOrderUsd, source, reason, referenceHourKey = null) {
  return {
    nextOrderUsd,
    source,
    reason,
    referenceHourKey,
  }
}

function extractCarryFromOrderSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return null
  }
  if (!summary.carrySignalQualified) {
    return null
  }
  return buildCarryPlan(
    summary.bothSidesLe40 ? BASE_ORDER_USD : ESCALATED_ORDER_USD,
    'orders',
    summary.bothSidesLe40 ? 'previous-order-hour-both-sides-le40' : 'previous-order-hour-missing-both-sides-le40',
    summary.hourKey ?? null
  )
}

function extractCarryFromMonitorSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return null
  }
  const durationMinutes = Number(summary.durationMinutes || 0)
  if (!Number.isFinite(durationMinutes) || durationMinutes < COVERAGE_SIGNAL_MINUTES) {
    return null
  }
  const up = Boolean(summary?.thresholds?.up?.lt40)
  const down = Boolean(summary?.thresholds?.down?.lt40)
  return buildCarryPlan(
    up && down ? BASE_ORDER_USD : ESCALATED_ORDER_USD,
    'monitor',
    up && down ? 'previous-monitor-hour-both-sides-le40' : 'previous-monitor-hour-missing-both-sides-le40',
    summary.runId ?? summary.fileName ?? null
  )
}

function findLatestCarryPlanBefore(eventStartIso, dirPath, extractor) {
  const eventStart = parseDate(eventStartIso)
  if (!eventStart) {
    return null
  }
  const maxGapMs = 65 * 60 * 1000
  const candidates = listJsonFiles(dirPath)
    .map((filePath) => {
      const summary = readJsonFile(filePath)
      if (!summary || typeof summary !== 'object') {
        return null
      }
      const endIso = summary.eventEnd || summary.lastSampleAt || summary.eventStart
      const endDate = parseDate(endIso)
      if (!endDate) {
        return null
      }
      const deltaMs = eventStart.getTime() - endDate.getTime()
      if (deltaMs < 0 || deltaMs > maxGapMs) {
        return null
      }
      return {
        summary,
        endMs: endDate.getTime(),
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.endMs - left.endMs)
  for (const candidate of candidates) {
    const carryPlan = extractor(candidate.summary)
    if (carryPlan) {
      return carryPlan
    }
  }
  return null
}

function determineCarryPlan(eventStartIso) {
  return (
    findLatestCarryPlanBefore(eventStartIso, HOURS_DIR, extractCarryFromOrderSummary) ||
    findLatestCarryPlanBefore(eventStartIso, MONITOR_SUMMARIES_DIR, extractCarryFromMonitorSummary) ||
    buildCarryPlan(BASE_ORDER_USD, 'default', 'no-qualified-history')
  )
}

function finalizeState(state, reason) {
  const firstSampleAt = parseDate(state.firstSampleAt)
  const lastSampleAt = parseDate(state.lastSampleAt)
  const durationMs =
    firstSampleAt && lastSampleAt ? lastSampleAt.getTime() - firstSampleAt.getTime() : 0
  state.durationMinutes = Number((durationMs / 60000).toFixed(2))
  state.finalizedAt = new Date().toISOString()
  state.endReason = reason
  state.bothSidesLe40 = Boolean(state.opportunity.upLe40 && state.opportunity.downLe40)
  state.carrySignalQualified = state.durationMinutes >= COVERAGE_SIGNAL_MINUTES
  state.nextOrderUsd =
    state.carrySignalQualified && !state.bothSidesLe40 ? ESCALATED_ORDER_USD : BASE_ORDER_USD
  writeJsonFile(buildHourSummaryPath(state), state)
}

function summarizeState(state) {
  const status =
    state.orders.up.placed && state.orders.down.placed
      ? 'paired'
      : state.firstEntrySide
        ? `first:${state.firstEntrySide}`
        : state.firstEntryBlockedLate
          ? 'late-skip'
          : 'waiting'
  return (
    `Sample ${state.sampleCount} | ` +
    `Up ${Number(state.lastSample?.upCents || 0).toFixed(3)}c ` +
    `Down ${Number(state.lastSample?.downCents || 0).toFixed(3)}c | ` +
    `$${state.orderUsd} | ${status}`
  )
}

async function startEvent(date) {
  while (true) {
    try {
      const meta = await resolveEventForDate(date)
      const slugLabel = meta?.slug || 'unknown-hour'
      if (!meta || !meta.eventEnd) {
        log(
          `No event found for ${slugLabel}. Retrying in ${Math.round(
            EVENT_MISSING_RETRY_MS / 1000
          )}s.`
        )
        await sleep(EVENT_MISSING_RETRY_MS)
        date = new Date()
        continue
      }

      const runtimeState = getRuntimeState()
      const hourKey = buildHourKey(meta)
      if (
        runtimeState &&
        runtimeState.hourKey === hourKey &&
        !runtimeState.finalizedAt &&
        parseDate(runtimeState.eventEnd)?.getTime() > Date.now()
      ) {
        log(`Resumed ${runtimeState.slug} from runtime state`)
        return runtimeState
      }

      const carryPlan = determineCarryPlan(meta.eventStart ? meta.eventStart.toISOString() : null)
      const state = createHourState(meta, carryPlan)
      saveRuntimeState(state)
      writeHourLog(state, 'hour-start', {
        orderUsd: state.orderUsd,
        carryPlan,
      })
      log(
        `Started order hour ${state.slug} ($${state.orderUsd}, ${state.mode}, ${state.priceSource}) until ` +
          `${state.eventEnd}`
      )
      return state
    } catch (error) {
      log(`Order start error: ${error.message}. Retrying in ${Math.round(START_RETRY_MS / 1000)}s.`)
      await sleep(START_RETRY_MS)
      date = new Date()
    }
  }
}

async function maybeFinalizeStaleRuntimeState() {
  const runtimeState = getRuntimeState()
  if (!runtimeState || runtimeState.finalizedAt) {
    return
  }
  const eventEnd = parseDate(runtimeState.eventEnd)
  if (eventEnd && eventEnd.getTime() <= Date.now()) {
    finalizeState(runtimeState, 'resume-after-end')
    clearRuntimeState()
    log(`Recovered and finalized stale runtime state for ${runtimeState.slug}`)
  }
}

async function createTrader() {
  if (ORDER_DRY_RUN) {
    log('Order engine is running in dry-run mode')
    return {
      mode: 'dry-run',
      async initialize() {},
      async ensureFunds(requiredUsd) {
        return {
          requiredUsd,
          mode: 'dry-run',
        }
      },
      async placeBuy({ amountUsd, priceCap, tokenId }) {
        return {
          success: true,
          dryRun: true,
          status: 'simulated',
          orderID: `dry-${Date.now()}`,
          amountUsd,
          priceCap,
          tokenId,
        }
      },
    }
  }

  if (!POLY_PRIVATE_KEY) {
    throw new Error(
      'Missing private key. Set POLY_PRIVATE_KEY or PORTFOLIO_PRIVATE_KEY for live trading mode.'
    )
  }

  const sdk = await import('@polymarket/clob-client')
  const { AssetType, ClobClient, OrderType, Side } = sdk
  const signer = new Wallet(POLY_PRIVATE_KEY)
  const signerAddress = await signer.getAddress()

  const baseClient = new ClobClient(
    CLOB_BASE,
    POLY_CHAIN_ID,
    signer,
    undefined,
    POLY_SIGNATURE_TYPE,
    POLY_FUNDER,
    POLY_GEO_BLOCK_TOKEN,
    true,
    undefined,
    undefined,
    true,
    undefined,
    false
  )
  const creds =
    POLY_API_KEY && POLY_API_SECRET && POLY_API_PASSPHRASE
      ? {
          key: POLY_API_KEY,
          secret: POLY_API_SECRET,
          passphrase: POLY_API_PASSPHRASE,
        }
      : await baseClient.createOrDeriveApiKey()

  const resolvedFunder = await resolveFunderAddress(signerAddress)
  const providedCreds =
    POLY_API_KEY && POLY_API_SECRET && POLY_API_PASSPHRASE ? creds : null
  const derivedCreds = providedCreds ? await baseClient.createOrDeriveApiKey() : creds

  const probeResult =
    (await probeAuthenticatedClient({
      AssetType,
      ClobClient,
      creds: providedCreds,
      resolvedFunder,
      signer,
      signerAddress,
    })) ||
    (providedCreds
      ? await probeAuthenticatedClient({
          AssetType,
          ClobClient,
          creds: derivedCreds,
          resolvedFunder,
          signer,
          signerAddress,
          label: 'derived',
        })
      : null)

  const selectedSignatureType = probeResult?.signatureType ?? null
  const selectedClient = probeResult?.client ?? null
  let selectedBalanceSnapshot = probeResult?.snapshot ?? null
  const selectedFunderAddress = probeResult?.funderAddress ?? null

  if (!selectedClient || selectedSignatureType === null) {
    throw new Error(
      'Unable to validate Polymarket credentials. Check private key, profile wallet, and API credentials.'
    )
  }

  return {
    mode: 'live',
    async initialize() {
      log(
        `Live trading client ready for ${signerAddress} ` +
          `(signatureType=${selectedSignatureType}, funder=${selectedFunderAddress})`
      )
    },
    async ensureFunds(requiredUsd) {
      const snapshot =
        selectedBalanceSnapshot ||
        (await selectedClient.getBalanceAllowance({
          asset_type: AssetType.COLLATERAL,
        }))
      selectedBalanceSnapshot = null
      const balance = Number(snapshot?.balance || 0)
      const allowance = Number(snapshot?.allowance || 0)
      if (!Number.isFinite(balance) || balance < MIN_ACCOUNT_BALANCE_USD) {
        throw new Error(
          `Collateral balance ${balance} is below minimum $${MIN_ACCOUNT_BALANCE_USD}. Order skipped.`
        )
      }
      if (!Number.isFinite(balance) || balance < requiredUsd) {
        throw new Error(`Insufficient collateral balance for $${requiredUsd}. Current balance: ${balance}`)
      }
      if (Number.isFinite(allowance) && allowance >= requiredUsd) {
        return {
          balance,
          allowance,
          autoApproved: false,
        }
      }
      if (!ORDER_AUTO_APPROVE) {
        throw new Error(
          `Allowance ${allowance} is below required $${requiredUsd}. Enable ORDER_AUTO_APPROVE or approve manually.`
        )
      }
      await selectedClient.updateBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      })
      const refreshed = await selectedClient.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      })
      const refreshedAllowance = Number(refreshed?.allowance || 0)
      if (!Number.isFinite(refreshedAllowance) || refreshedAllowance < requiredUsd) {
        throw new Error(`Allowance update did not provide enough collateral for $${requiredUsd}`)
      }
      return {
        balance: Number(refreshed?.balance || balance),
        allowance: refreshedAllowance,
        autoApproved: true,
      }
    },
    async placeBuy({ tokenId, amountUsd, priceCap, tickSize, negRisk }) {
      const orderType = ORDER_EXECUTION_TYPE === 'FAK' ? OrderType.FAK : OrderType.FOK
      const options = {}
      if (tickSize) {
        options.tickSize = tickSize
      }
      if (typeof negRisk === 'boolean') {
        options.negRisk = negRisk
      }
      return selectedClient.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: amountUsd,
          price: priceCap,
          side: Side.BUY,
          orderType,
        },
        options,
        orderType
      )
    },
  }
}

async function resolveFunderAddress(signerAddress) {
  if (POLY_FUNDER) {
    return POLY_FUNDER
  }
  const profile = await fetchPublicProfile(signerAddress)
  if (profile?.proxyWallet) {
    return profile.proxyWallet
  }
  return signerAddress
}

async function probeAuthenticatedClient({
  AssetType,
  ClobClient,
  creds,
  resolvedFunder,
  signer,
  signerAddress,
  label = 'configured',
}) {
  const signatureCandidates = POLY_SIGNATURE_TYPE === null ? [2, 1, 0] : [POLY_SIGNATURE_TYPE]
  for (const signatureType of signatureCandidates) {
    const funderAddress = signatureType === 0 ? signerAddress : resolvedFunder
    if (!funderAddress || !creds) {
      continue
    }
    const candidateClient = new ClobClient(
      CLOB_BASE,
      POLY_CHAIN_ID,
      signer,
      creds,
      signatureType,
      funderAddress,
      POLY_GEO_BLOCK_TOKEN,
      true,
      undefined,
      undefined,
      true,
      undefined,
      true
    )
    try {
      const snapshot = await candidateClient.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      })
      if (label === 'derived') {
        log(`Recovered with derived Polymarket API credentials (signatureType=${signatureType})`)
      }
      return {
        signatureType,
        client: candidateClient,
        snapshot,
        funderAddress,
      }
    } catch (error) {
      log(`Signature type ${signatureType} probe failed (${label} creds): ${error.message}`)
    }
  }
  return null
}

async function placeSideOrder(state, trader, side, thresholdCents, triggerType, observedCents, now) {
  const orderRecord = state.orders[side]
  if (!shouldRetryOrder(orderRecord, now)) {
    return false
  }

  orderRecord.attemptCount += 1
  orderRecord.lastAttemptAt = now.toISOString()
  orderRecord.amountUsd = state.orderUsd
  orderRecord.triggerType = triggerType
  orderRecord.thresholdCents = thresholdCents
  orderRecord.priceCap = Number((thresholdCents / 100).toFixed(4))
  orderRecord.observedCents = observedCents
  orderRecord.error = null
  saveRuntimeState(state)

  try {
    await trader.ensureFunds(state.orderUsd)
    const response = await trader.placeBuy({
      tokenId: state.tokens[side],
      amountUsd: state.orderUsd,
      priceCap: Number((thresholdCents / 100).toFixed(4)),
      tickSize: state.tickSize,
      negRisk: state.negRisk,
    })
    orderRecord.placed = true
    orderRecord.requestedAt = now.toISOString()
    orderRecord.response = response
    orderRecord.orderId = response?.orderID ?? response?.orderId ?? null
    orderRecord.status = response?.status ?? 'submitted'
    writeHourLog(state, 'order-placed', {
      side,
      triggerType,
      thresholdCents,
      observedCents,
      amountUsd: state.orderUsd,
      response,
    })
    saveRuntimeState(state)
    log(
      `${ORDER_DRY_RUN ? '[DRY-RUN] ' : ''}Bought ${side.toUpperCase()} $${state.orderUsd} ` +
        `at <= ${thresholdCents}c for ${state.slug}`
    )
    return true
  } catch (error) {
    orderRecord.error = error.message
    orderRecord.response = null
    writeHourLog(state, 'order-error', {
      side,
      triggerType,
      thresholdCents,
      observedCents,
      amountUsd: state.orderUsd,
      error: error.message,
    })
    saveRuntimeState(state)
    log(`Order error for ${state.slug}:${side}: ${error.message}`)
    return false
  }
}

async function maybePlaceHedge(state, trader, prices, now) {
  if (!state.firstEntrySide) {
    return
  }
  const hedgeSide = getOppositeSide(state.firstEntrySide)
  if (state.orders[hedgeSide].placed) {
    return
  }
  const hedgeCents = hedgeSide === 'up' ? prices.upCents : prices.downCents
  if (hedgeCents > HEDGE_ENTRY_CENTS) {
    return
  }
  const didPlace = await placeSideOrder(
    state,
    trader,
    hedgeSide,
    HEDGE_ENTRY_CENTS,
    'hedge',
    hedgeCents,
    now
  )
  if (didPlace && state.orders.up.placed && state.orders.down.placed && !state.pairedAt) {
    state.pairedAt = now.toISOString()
    writeHourLog(state, 'pair-complete', {
      pairedAt: state.pairedAt,
    })
    saveRuntimeState(state)
  }
}

async function recordSample(state, trader) {
  const prices = await fetchLivePrices(
    {
      slug: state.slug,
      upTokenId: state.tokens.up,
      downTokenId: state.tokens.down,
    },
    ORDER_PRICE_SIDE
  )
  const now = new Date()
  if (!state.firstSampleAt) {
    state.firstSampleAt = now.toISOString()
  }
  state.lastSampleAt = now.toISOString()
  state.sampleCount += 1
  state.minUpCents = updateMin(state.minUpCents, prices.upCents)
  state.minDownCents = updateMin(state.minDownCents, prices.downCents)
  state.lastSample = {
    ts: now.toISOString(),
    upCents: prices.upCents,
    downCents: prices.downCents,
  }
  updateOpportunityFlags(state, prices.upCents, prices.downCents)
  writeHourLog(state, 'sample', {
    sampleCount: state.sampleCount,
    upCents: prices.upCents,
    downCents: prices.downCents,
  })

  if (!state.firstEntrySide && !state.firstEntryBlockedLate) {
    const candidate = pickFirstEntrySide(state, prices.upCents, prices.downCents)
    if (candidate) {
      const remainingMinutes = getRemainingMinutes(state, now)
      if (remainingMinutes <= MIN_FIRST_ENTRY_MINUTES_REMAINING) {
        state.firstEntryBlockedLate = true
        state.firstEntryBlockedAt = now.toISOString()
        state.firstEntryBlockedRemainingMinutes = Number(remainingMinutes.toFixed(2))
        writeHourLog(state, 'late-block', {
          remainingMinutes: state.firstEntryBlockedRemainingMinutes,
          candidateSide: candidate.side,
          candidateCents: candidate.cents,
        })
        log(
          `Skipped ${state.slug} first entry because only ${state.firstEntryBlockedRemainingMinutes} minutes remained`
        )
      } else {
        const didPlace = await placeSideOrder(
          state,
          trader,
          candidate.side,
          FIRST_ENTRY_CENTS,
          'first-entry',
          candidate.cents,
          now
        )
        if (didPlace) {
          state.firstEntrySide = candidate.side
          state.firstEntryPlacedAt = now.toISOString()
          state.firstEntryTriggerCents = candidate.cents
        }
      }
    }
  }

  if (state.firstEntrySide) {
    await maybePlaceHedge(state, trader, prices, now)
  }

  saveRuntimeState(state)
  log(summarizeState(state))

  if (MAX_SAMPLES > 0 && state.sampleCount >= MAX_SAMPLES) {
    return 'max-samples'
  }

  return null
}

async function main() {
  ensureDir(DATA_DIR)
  ensureDir(HOURS_DIR)
  ensureDir(LOGS_DIR)

  if (ORDER_PRICE_SIDE !== 'BUY') {
    log(`Warning: ORDER_PRICE_SIDE=${ORDER_PRICE_SIDE}. This strategy is normally designed around BUY prices.`)
  }

  await maybeFinalizeStaleRuntimeState()

  const trader = await createTrader()
  await trader.initialize()

  let state = await startEvent(new Date())

  const shutdown = async (signal) => {
    log(`Received ${signal}, shutting down order engine.`)
    if (state) {
      saveRuntimeState(state)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })

  while (true) {
    const eventEnd = parseDate(state.eventEnd)
    if (eventEnd && Date.now() >= eventEnd.getTime()) {
      finalizeState(state, 'complete')
      clearRuntimeState()
      log(
        `Finalized ${state.slug} | qualified=${state.carrySignalQualified} ` +
          `bothSidesLe40=${state.bothSidesLe40} next=$${state.nextOrderUsd}`
      )
      state = await startEvent(new Date(eventEnd.getTime() + 1000))
      continue
    }

    try {
      const exitReason = await recordSample(state, trader)
      if (exitReason) {
        log(`Stopping because ${exitReason} was reached`)
        return
      }
    } catch (error) {
      writeHourLog(state, 'sample-error', {
        error: error.message,
      })
      log(`Sample error: ${error.message}`)
    }

    await sleep(SAMPLE_INTERVAL_MS)
  }
}

main().catch((error) => {
  log(`Fatal order error: ${error.stack || error.message}`)
  process.exit(1)
})
