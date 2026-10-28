import { describe, expect, test } from 'bun:test'
import nodevu from '@nodevu/core'
import {
  compareVersions,
  resolveVersions,
  selectNodeReleases,
  version,
  type GetJSON
} from '../../src/versions.ts'
import { createPlan } from '../../src/matrix.ts'
import { config, nodeIndex, nodeIndexWithNextLts, schedule } from './fixtures.ts'

const nodeData = await nodevu({
  fetch: async (url) => ({ json: async () => (url.endsWith('index.json') ? nodeIndex : schedule) }),
  now: '2026-10-20T00:00:00Z'
})

describe('stable versions', () => {
  test('normalizes the v prefix', () => expect(version('v1.4.3')).toBe('1.4.3'))
  test.each(['latest', 'canary', '1', '1.2', '1.2.3-beta.1', '1.2.3;echo bad', '01.2.3', null])(
    'rejects %j',
    (input) => {
      expect(() => version(input)).toThrow('exact stable version')
    }
  )
  test('compares version parts numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.99.99', '2.0.0')).toBeLessThan(0)
  })
})

describe('Node support policy', () => {
  const now = new Date('2026-10-20T00:00:00Z')
  test('keeps supported majors, picks their newest patch, and prefers LTS over Current', () => {
    expect(selectNodeReleases(nodeData, now)).toEqual([
      { version: '26.0.0', default: false },
      { version: '24.11.1', default: true },
      { version: '22.21.1', default: false }
    ])
  })
  test('treats the EOL date as unsupported', () => {
    const result = selectNodeReleases(nodeData, new Date('2027-04-30'))
    expect(result.some((release) => release.version.startsWith('22.'))).toBe(false)
  })
  test('fails visibly when release data cannot supply an LTS version', () => {
    expect(() => selectNodeReleases({}, now)).toThrow('LTS')
    expect(() => selectNodeReleases([], now)).toThrow('data')
    expect(() => selectNodeReleases({ v24: null }, now)).toThrow('entry')
  })
  test('does not promote a non-LTS release at the scheduled LTS date', () => {
    expect(selectNodeReleases(nodeData, new Date(schedule.v26.lts))).toEqual([
      { version: '26.0.0', default: false },
      { version: '24.11.1', default: true },
      { version: '22.21.1', default: false }
    ])
  })
  test.each([
    { name: 'LTS', index: nodeIndexWithNextLts, expected: '26.1.0' },
    { name: 'non-LTS', index: nodeIndex, expected: '24.11.1' }
  ])(
    'selects the default from the $name feed using release metadata',
    async ({ index, expected }) => {
      const result = await resolveVersions(
        { runtime: 'node', bun: '1.4.3' },
        async (url) => (url.endsWith('index.json') ? index : schedule),
        new Date(schedule.v26.lts)
      )
      expect(result.node.filter((release) => release.default)).toEqual([
        { version: expected, default: true }
      ])
    }
  )
  test('excludes EOL LTS and non-LTS lines while retaining supported Current', () => {
    const result = selectNodeReleases(nodeData, now)
    expect(result).toContainEqual({ version: '26.0.0', default: false })
    expect(result).toContainEqual({ version: '22.21.1', default: false })
    expect(result.some((release) => /^(20|25)\./.test(release.version))).toBe(false)
  })
  test('excludes future patches and ignores lines without a support schedule', () => {
    const data = structuredClone(nodeData) as Record<string, unknown>
    data.v28 = { releases: {} }
    expect(selectNodeReleases(data, new Date('2026-01-15'))).toEqual([
      { version: '25.0.0', default: false },
      { version: '24.9.0', default: true },
      { version: '22.21.1', default: false },
      { version: '20.19.5', default: false }
    ])
  })
  test('builds every supported major and variant from actual nodevu output', () => {
    const plan = createPlan(
      config,
      { bun: '1.4.3', node: selectNodeReleases(nodeData, now), deno: [] },
      { runtime: 'node' }
    )
    expect(plan.include).toHaveLength(12)
    for (const major of [22, 24, 26]) {
      expect(
        plan.include.filter((entry) => entry.runtimeVersion.startsWith(`${major}.`))
      ).toHaveLength(4)
    }
    expect(
      plan.include.filter((entry) => entry.aliases.includes('fusionaxi/bun-node:latest'))
    ).toHaveLength(1)
  })
})

describe('release discovery', () => {
  test('explicit versions work offline and skip the other runtime', async () => {
    const json: GetJSON = async () => {
      throw new Error('Unexpected network call')
    }
    expect(await resolveVersions({ runtime: 'deno', bun: 'v1.4.3', deno: '2.5.4' }, json)).toEqual({
      bun: '1.4.3',
      node: [],
      deno: [{ version: '2.5.4', default: true }]
    })
    expect(
      await resolveVersions({ runtime: 'node', bun: '1.4.3', node: 'v22.21.1' }, json)
    ).toEqual({ bun: '1.4.3', node: [{ version: '22.21.1', default: true }], deno: [] })
  })
  test('reads each upstream feed and resolves both runtimes', async () => {
    const urls: string[] = []
    const json: GetJSON = async (url) => {
      urls.push(url)
      if (url.endsWith('/bun/latest')) return { version: '1.4.3' }
      if (url.endsWith('/index.json')) return nodeIndex
      if (url.endsWith('/schedule.json')) return schedule
      return { tag_name: 'v2.5.4', prerelease: false, draft: false }
    }
    const result = await resolveVersions({}, json, new Date('2026-10-20T00:00:00Z'))
    expect(result.bun).toBe('1.4.3')
    expect(result.node.length).toBeGreaterThan(0)
    expect(result.deno).toEqual([{ version: '2.5.4', default: true }])
    expect(urls).toHaveLength(4)
  })
  test('propagates upstream errors instead of returning an empty matrix', async () => {
    await expect(
      resolveVersions({ runtime: 'node', node: '24.11.1' }, async () => {
        throw new Error('upstream unavailable')
      })
    ).rejects.toThrow('upstream unavailable')
  })
  test('propagates Node feed failures through nodevu', async () => {
    await expect(
      resolveVersions({ runtime: 'node', bun: '1.4.3' }, async () => {
        throw new Error('Node feed unavailable')
      })
    ).rejects.toThrow('Node feed unavailable')
  })
  test('rejects prereleases returned by the stable Deno endpoint', async () => {
    await expect(
      resolveVersions({ runtime: 'deno', bun: '1.4.3' }, async () => ({
        tag_name: 'v2.5.4',
        prerelease: true
      }))
    ).rejects.toThrow('stable Deno')
  })
})
