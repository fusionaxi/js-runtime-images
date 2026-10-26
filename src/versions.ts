import nodevu from '@nodevu/core'
import { isRecord, type Runtime } from './config.ts'

export interface Release {
  version: string
  default: boolean
}

export interface Versions {
  bun: string
  node: Release[]
  deno: Release[]
}

interface NodeVersion {
  version: string
  lts: boolean
}

export type GetJSON = (url: string) => Promise<unknown>

export function version(value: unknown): string {
  if (typeof value !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Expected an exact stable version (e.g. 1.4.3), got ${String(value)}.`)
  }
  return value.replace(/^v/, '')
}

export function compareVersions(a: string, b: string): number {
  const left = version(a).split('.').map(Number)
  const right = version(b).split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = left[index]! - right[index]!
    if (difference) return difference
  }
  return 0
}

function releaseDate(value: unknown): number {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(timestamp)) throw new Error('Invalid Node.js release date.')
  return timestamp
}

export function selectNodeReleases(data: unknown, now = new Date()): Release[] {
  if (!isRecord(data)) throw new Error('Invalid Node.js release data.')
  const newest: NodeVersion[] = []
  for (const [major, line] of Object.entries(data)) {
    if (!isRecord(line)) throw new Error('Invalid Node.js release entry.')
    // Historical release lines without an official support schedule are not supported.
    if (!line.support) continue
    if (!isRecord(line.support) || !isRecord(line.support.phases))
      throw new Error('Invalid Node.js support data.')
    const dates = line.support.phases.dates
    if (!isRecord(dates)) throw new Error('Invalid Node.js support dates.')
    const time = now.getTime()
    if (releaseDate(dates.start) > time || time >= releaseDate(dates.end)) continue
    if (!isRecord(line.releases)) throw new Error('Invalid Node.js releases.')
    let latest: string | undefined
    for (const entry of Object.values(line.releases)) {
      if (!isRecord(entry) || !isRecord(entry.semver))
        throw new Error('Invalid Node.js release entry.')
      const normalized = version(entry.semver.raw)
      if (`v${normalized.split('.')[0]}` !== major)
        throw new Error('Node.js release does not match its major.')
      if (releaseDate(entry.releaseDate) > time) continue
      if (!latest || compareVersions(normalized, latest) > 0) latest = normalized
    }
    if (latest) {
      newest.push({
        version: latest,
        lts: typeof dates.lts === 'string' && releaseDate(dates.lts) <= time
      })
    }
  }
  const releases = newest.sort((a, b) => compareVersions(b.version, a.version))
  const preferred = releases.find((release) => release.lts)
  if (!preferred) throw new Error('No supported Node.js LTS release found.')
  return releases.map((release) => ({ version: release.version, default: release === preferred }))
}

export async function getJSON(url: string): Promise<unknown> {
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw new Error('Release feeds must use HTTPS URLs without embedded credentials.')
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'fusionaxi-js-runtime-images'
  }
  if (target.origin === 'https://api.github.com' && Bun.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${Bun.env.GITHUB_TOKEN}`
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      })
    } catch (error) {
      if (attempt === 2) throw new Error(`Cannot fetch ${url}`, { cause: error })
      await Bun.sleep(250 * 2 ** attempt)
      continue
    }
    if (response.ok) return response.json()
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
      throw new Error(`Cannot fetch ${url}: HTTP ${response.status}`)
    }
    await Bun.sleep(250 * 2 ** attempt)
  }
  throw new Error(`Cannot fetch ${url}`)
}

export interface VersionOptions {
  runtime?: Runtime
  bun?: string
  node?: string
  deno?: string
}

export async function resolveVersions(
  options: VersionOptions = {},
  json: GetJSON = getJSON
): Promise<Versions> {
  const bun = options.bun
    ? Promise.resolve(version(options.bun))
    : json('https://registry.npmjs.org/bun/latest').then((data) => {
        if (!isRecord(data)) throw new Error('Invalid Bun release data.')
        return version(data.version)
      })
  const node =
    options.runtime === 'deno'
      ? Promise.resolve([])
      : options.node
        ? Promise.resolve([{ version: version(options.node), default: true }])
        : nodevu({
            // Keep bounded retries, timeouts, and injectable feeds for offline tests.
            fetch: async (url) => ({ json: () => json(url) }),
            now: new Date().toISOString(),
            urls: {
              schedule: 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'
            }
          }).then((data) => selectNodeReleases(data))
  const deno =
    options.runtime === 'node'
      ? Promise.resolve([])
      : options.deno
        ? Promise.resolve([{ version: version(options.deno), default: true }])
        : json('https://api.github.com/repos/denoland/deno/releases/latest').then((data) => {
            if (!isRecord(data) || data.prerelease || data.draft)
              throw new Error('Invalid stable Deno release data.')
            return [{ version: version(data.tag_name), default: true }]
          })
  const [bunVersion, nodeVersions, denoVersions] = await Promise.all([bun, node, deno])
  return { bun: bunVersion, node: nodeVersions, deno: denoVersions }
}
