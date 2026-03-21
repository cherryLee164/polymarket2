const fs = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')

const API_BASE = process.env.API_BASE || 'https://gamma-api.polymarket.com'
const CLOB_BASE = process.env.CLOB_BASE || 'https://clob.polymarket.com'
const EVENT_PREFIX = process.env.EVENT_PREFIX || 'bitcoin-up-or-down-'
const EVENT_SUFFIX = process.env.EVENT_SUFFIX || '-et'
const TIME_ZONE = process.env.TIME_ZONE || 'America/New_York'
const LOG_TIME_ZONE = process.env.LOG_TIME_ZONE || 'Asia/Shanghai'
const DEFAULT_PRICE_SIDE = String(process.env.PRICE_SIDE || 'BUY').toUpperCase()
const CURL_TIMEOUT_SECONDS = Number(process.env.CURL_TIMEOUT_SECONDS || 20)
const HAS_PROXY_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
].some((name) => Boolean(process.env[name]))
const execFileAsync = promisify(execFile)

let didLogProxyFallback = false

const slugFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  hour12: true,
})

const logFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: LOG_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function getPart(parts, type) {
  const match = parts.find((part) => part.type === type)
  if (!match) {
    throw new Error(`Missing date part: ${type}`)
  }
  return match.value
}

function formatLogTimestamp(date) {
  const parts = logFormatter.formatToParts(date)
  const year = getPart(parts, 'year')
  const month = getPart(parts, 'month')
  const day = getPart(parts, 'day')
  const hour = getPart(parts, 'hour')
  const minute = getPart(parts, 'minute')
  const second = getPart(parts, 'second')
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${LOG_TIME_ZONE}`
}

function log(message) {
  const now = new Date()
  console.log(`[${formatLogTimestamp(now)}] ${message}`)
}

function logProxyFallback(reason) {
  if (didLogProxyFallback) {
    return
  }
  didLogProxyFallback = true
  log(`Using curl fallback for Polymarket requests (${reason})`)
}

function slugCandidatesForDate(date) {
  const parts = slugFormatter.formatToParts(date)
  const month = getPart(parts, 'month').toLowerCase()
  const day = getPart(parts, 'day')
  const year = getPart(parts, 'year')
  const hour = getPart(parts, 'hour')
  const dayPeriodRaw = getPart(parts, 'dayPeriod')
  const dayPeriod = dayPeriodRaw.toLowerCase().replace(/[.\s]/g, '')
  const base = `${EVENT_PREFIX}${month}-${day}-${hour}${dayPeriod}${EVENT_SUFFIX}`
  const withYear = `${EVENT_PREFIX}${month}-${day}-${year}-${hour}${dayPeriod}${EVENT_SUFFIX}`
  return Array.from(new Set([withYear, base]))
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (error) {
      return []
    }
  }
  return []
}

function parseDate(value) {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed
}

function formatForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function toCents(value) {
  return Number((value * 100).toFixed(3))
}

function normalizeTickSize(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null
  }
  const normalized = numeric.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return normalized || null
}

function extractOutcomeMap(market) {
  const outcomes = parseJsonArray(market.outcomes)
  const clobTokenIds = parseJsonArray(market.clobTokenIds)
  if (!Array.isArray(outcomes) || outcomes.length < 2) {
    throw new Error('Missing outcomes')
  }
  if (!Array.isArray(clobTokenIds) || clobTokenIds.length !== outcomes.length) {
    throw new Error('Missing clob token ids')
  }
  const entries = outcomes.map((outcome, index) => ({
    outcome: String(outcome),
    tokenId: String(clobTokenIds[index]),
  }))
  let upEntry = entries.find((entry) => entry.outcome.toLowerCase() === 'up')
  let downEntry = entries.find((entry) => entry.outcome.toLowerCase() === 'down')
  if (!upEntry) {
    upEntry = entries[0]
  }
  if (!downEntry) {
    downEntry = entries[upEntry === entries[0] ? 1 : 0]
  }
  if (!upEntry?.tokenId || !downEntry?.tokenId) {
    throw new Error('Missing outcome token ids')
  }
  return {
    outcomes: entries.map((entry) => entry.outcome),
    upTokenId: upEntry.tokenId,
    downTokenId: downEntry.tokenId,
  }
}

async function fetchEvent(slug) {
  const url = `${API_BASE}/events?slug=${encodeURIComponent(slug)}&_ts=${Date.now()}`
  const data = await fetchJson(url, slug)
  if (Array.isArray(data)) {
    return data[0] || null
  }
  if (data && typeof data === 'object') {
    return data
  }
  return null
}

async function fetchPublicProfile(address) {
  if (!address) {
    return null
  }
  const url = `${API_BASE}/public-profile?address=${encodeURIComponent(address)}&_ts=${Date.now()}`
  const data = await fetchJson(url, `public-profile:${address}`)
  if (data && typeof data === 'object') {
    return data
  }
  return null
}

async function fetchClobPrice(tokenId, slug, outcome, priceSide = DEFAULT_PRICE_SIDE) {
  const url =
    `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}` +
    `&side=${encodeURIComponent(priceSide)}`
  const data = await fetchJson(url, `${slug}:${outcome}`)
  const price = Number(data?.price)
  if (!Number.isFinite(price)) {
    throw new Error(`Invalid ${priceSide} price for ${slug}:${outcome}`)
  }
  return price
}

async function fetchLivePrices(state, priceSide = DEFAULT_PRICE_SIDE) {
  const [upPrice, downPrice] = await Promise.all([
    fetchClobPrice(state.upTokenId, state.slug, 'Up', priceSide),
    fetchClobPrice(state.downTokenId, state.slug, 'Down', priceSide),
  ])
  return {
    priceSide,
    upPrice,
    downPrice,
    upCents: toCents(upPrice),
    downCents: toCents(downPrice),
  }
}

async function fetchJson(url, label) {
  if (process.platform === 'win32' && HAS_PROXY_ENV) {
    logProxyFallback('proxy environment detected on Windows')
    return fetchJsonWithCurl(url, label)
  }

  try {
    return await fetchJsonWithNode(url, label)
  } catch (error) {
    if (process.platform === 'win32') {
      logProxyFallback(error.code || error.message || 'node request failed')
      return fetchJsonWithCurl(url, label)
    }
    throw error
  }
}

async function fetchJsonWithNode(url, label) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
    },
  })
  if (!response.ok) {
    log(`Request failed ${response.status} for ${label}`)
    return null
  }
  return response.json()
}

async function fetchJsonWithCurl(url, label) {
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
    )
    return JSON.parse(stdout)
  } catch (error) {
    const details = error.stderr || error.message || String(error)
    throw new Error(`Curl request failed for ${label}: ${details}`)
  }
}

function buildEventMeta(slug, event, market, eventStart, eventEnd) {
  const { upTokenId, downTokenId, outcomes } = extractOutcomeMap(market)
  return {
    slug,
    event,
    market,
    eventId: event?.id ?? null,
    marketId: market?.id ?? null,
    eventStart,
    eventEnd,
    outcomes,
    upTokenId,
    downTokenId,
    tickSize: normalizeTickSize(market?.orderPriceMinTickSize),
    orderMinSize: Number(market?.orderMinSize ?? 0),
    negRisk: Boolean(market?.negRisk ?? event?.negRisk ?? false),
  }
}

async function resolveEventForDate(date) {
  const slugCandidates = slugCandidatesForDate(date)
  let selected = null
  for (const candidate of slugCandidates) {
    const event = await fetchEvent(candidate)
    if (!event || !Array.isArray(event.markets) || event.markets.length === 0) {
      continue
    }
    const market = event.markets[0]
    const eventEnd = parseDate(market.endDate || event.endDate)
    let eventStart = parseDate(market.eventStartTime || market.startDate || event.startDate)
    if (!eventStart && eventEnd) {
      eventStart = new Date(eventEnd.getTime() - 60 * 60 * 1000)
    }
    const meta = buildEventMeta(candidate, event, market, eventStart, eventEnd)
    const targetTime = date.getTime()
    const hasWindow =
      eventStart &&
      eventEnd &&
      targetTime >= eventStart.getTime() &&
      targetTime < eventEnd.getTime()
    if (hasWindow) {
      return meta
    }
    if (!selected) {
      selected = meta
    }
  }
  return selected
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
  API_BASE,
  CLOB_BASE,
  DEFAULT_PRICE_SIDE,
  ensureDir,
  fetchClobPrice,
  fetchEvent,
  fetchLivePrices,
  fetchPublicProfile,
  formatForFilename,
  log,
  parseDate,
  parseJsonArray,
  resolveEventForDate,
  sleep,
  slugCandidatesForDate,
  toCents,
}
