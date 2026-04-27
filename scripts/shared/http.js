const { execFile } = require('child_process')
const { promisify } = require('util')

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

function log(message) {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC')
  console.log(`[${now}] ${message}`)
}

function logProxyFallback(reason) {
  if (didLogProxyFallback) {
    return
  }
  didLogProxyFallback = true
  log(`Using curl fallback for HTTP requests (${reason})`)
}

async function fetchJson(url, label = 'json') {
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

async function fetchText(url, label = 'text') {
  if (process.platform === 'win32' && HAS_PROXY_ENV) {
    logProxyFallback('proxy environment detected on Windows')
    return fetchTextWithCurl(url, label)
  }

  try {
    return await fetchTextWithNode(url, label)
  } catch (error) {
    if (process.platform === 'win32') {
      logProxyFallback(error.code || error.message || 'node request failed')
      return fetchTextWithCurl(url, label)
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
      'user-agent': 'ploymarket-temperature-research/1.0',
    },
  })
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${label}`)
  }
  return response.json()
}

async function fetchTextWithNode(url, label) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'ploymarket-temperature-research/1.0',
    },
  })
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${label}`)
  }
  return response.text()
}

async function fetchJsonWithCurl(url, label) {
  const text = await fetchTextWithCurl(url, label, ['--header', 'accept: application/json'])
  return JSON.parse(text)
}

async function fetchTextWithCurl(url, label, extraArgs = []) {
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
        'cache-control: no-cache',
        '--header',
        'pragma: no-cache',
        '--header',
        'user-agent: ploymarket-temperature-research/1.0',
        ...extraArgs,
        url,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    return stdout
  } catch (error) {
    const details = error.stderr || error.message || String(error)
    throw new Error(`Curl request failed for ${label}: ${details}`)
  }
}

module.exports = {
  fetchJson,
  fetchText,
  log,
}
