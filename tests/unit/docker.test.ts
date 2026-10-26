import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { ROOT } from '../../src/config.ts'
import { dirname, join } from 'node:path'
import {
  buildCommand,
  buildImage,
  imageAtDigest,
  metadataDigest,
  promote,
  promotionCommands,
  run,
  type Run
} from '../../src/docker.ts'
import { createPlan } from '../../src/matrix.ts'
import { config, versions } from './fixtures.ts'

const digest = `sha256:${'a'.repeat(64)}`
const plan = createPlan(config, versions)
const build = plan.include.find((entry) => entry.id === 'node-24-slim')!

describe('Docker operations', () => {
  test('loads local images without pushing or touching aliases', () => {
    const command = buildCommand(build, { platform: 'linux/arm64' })
    expect(command).toContain('--load')
    expect(command).not.toContain('--push')
    expect(command.filter((arg) => arg === '--tag')).toHaveLength(1)
    expect(command).toContain(build.image)
    expect(command).not.toContain('fusionaxi/bun-node:latest')
    expect(command).toContain('RUNTIME_IMAGE=node:24.11.1-bookworm-slim')
  })
  test('publishes both architectures with attestations and build metadata', () => {
    const command = buildCommand(build, { push: true, metadata: '.artifacts/build.json' })
    expect(command).toContain('linux/amd64,linux/arm64')
    expect(command).toContain('--push')
    expect(command).toContain('--sbom=true')
    expect(command).toContain('--provenance=mode=max')
    expect(command).toContain('--metadata-file')
  })
  test('adds Git only for the Git variant', () => {
    expect(
      buildCommand(plan.include.find((entry) => entry.id === 'node-24-alpine-git')!)
    ).toContain('INSTALL_GIT=1')
    expect(buildCommand(build)).toContain('INSTALL_GIT=0')
  })
  test('rejects unsupported platforms and multiarch loads', () => {
    expect(() => buildCommand(build, { platform: 'linux/arm/v7' })).toThrow('platform')
    expect(() => buildCommand(build, { platform: 'linux/amd64,linux/arm64' })).toThrow('platform')
  })
  test('uses digests for promotion instead of mutable source tags', () => {
    const digests = Object.fromEntries(plan.include.map((entry) => [entry.id, digest]))
    const commands = promotionCommands(plan, digests)
    expect(commands).toHaveLength(plan.include.length)
    expect(commands.every((command) => command.at(-1)?.endsWith(`@${digest}`))).toBe(true)
    expect(commands.flat()).toContain('fusionaxi/bun-node:latest')
    expect(imageAtDigest(build, digest)).toBe(`fusionaxi/bun-node@${digest}`)
  })
  test('rejects incomplete or invalid results before any promotion', () => {
    expect(() => promotionCommands(plan, {})).toThrow('digest')
    expect(() => metadataDigest({ 'containerimage.digest': 'not-a-digest' })).toThrow('digest')
    expect(metadataDigest({ 'containerimage.digest': digest })).toBe(digest)
  })
})

describe('build and promotion execution', () => {
  let directory: string
  let commands: string[][]
  let execute: Run

  beforeEach(async () => {
    directory = await mkdtemp(join(ROOT, '.artifacts-docker-'))
    commands = []
    execute = async (command) => {
      commands.push(command)
    }
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('creates metadata directories before handing the build to the runner', async () => {
    const metadata = join(directory, 'nested', 'results', 'build.json')
    await buildImage(build, { push: true, metadata }, async (command) => {
      expect((await stat(dirname(metadata))).isDirectory()).toBe(true)
      commands.push(command)
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('--push')
    expect(commands[0]).toContain(metadata)
  })

  test('executes builds without requesting a metadata file', async () => {
    await buildImage(build, {}, execute)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('--load')
    expect(commands[0]).not.toContain('--metadata-file')
  })

  test('rejects an invalid platform before starting the build', async () => {
    await expect(buildImage(build, { platform: 'linux/arm/v7' }, execute)).rejects.toThrow(
      'platform'
    )
    expect(commands).toEqual([])
  })

  test('reads all result files and promotes each corresponding digest', async () => {
    const digests = Object.fromEntries(
      plan.include.map((entry, index) => [
        entry.id,
        `sha256:${index.toString(16).padStart(64, '0')}`
      ])
    )
    await Promise.all(
      plan.include.map((entry) =>
        Bun.write(
          join(directory, `${entry.id}.json`),
          JSON.stringify({
            'containerimage.digest': digests[entry.id]
          })
        )
      )
    )
    await promote(plan, directory, execute)
    expect(commands).toHaveLength(plan.include.length)
    for (const [index, entry] of plan.include.entries()) {
      expect(commands[index]!.at(-1)).toBe(imageAtDigest(entry, digests[entry.id]!))
    }
  })

  test('does not promote anything when a late result file is invalid', async () => {
    await Promise.all(
      plan.include.map((entry, index) =>
        Bun.write(
          join(directory, `${entry.id}.json`),
          JSON.stringify({
            'containerimage.digest': index === plan.include.length - 1 ? 'invalid' : digest
          })
        )
      )
    )
    await expect(promote(plan, directory, execute)).rejects.toThrow('digest')
    expect(commands).toEqual([])
  })

  test('does not promote anything when a result file is missing', async () => {
    await expect(promote(plan, directory, execute)).rejects.toThrow()
    expect(commands).toEqual([])
  })

  test('stops promotion on a registry failure', async () => {
    await Promise.all(
      plan.include.map((entry) =>
        Bun.write(
          join(directory, `${entry.id}.json`),
          JSON.stringify({ 'containerimage.digest': digest })
        )
      )
    )
    await expect(
      promote(plan, directory, async (command) => {
        commands.push(command)
        throw new Error('registry unavailable')
      })
    ).rejects.toThrow('registry unavailable')
    expect(commands).toHaveLength(1)
  })

  test('surfaces filesystem failures before executing a build', async () => {
    const file = join(directory, 'file')
    await Bun.write(file, 'not a directory')
    await expect(
      buildImage(build, { metadata: join(file, 'build.json') }, execute)
    ).rejects.toThrow()
    expect(commands).toEqual([])
  })

  test('preserves exit failures from real child processes', async () => {
    await expect(run([process.execPath, '-e', 'process.exit(42)'])).rejects.toThrow('exit 42')
    await expect(run([process.execPath, '-e', 'process.exit(0)'])).resolves.toBeUndefined()
  })

  test('surfaces missing executables', async () => {
    await mkdir(join(directory, 'empty'))
    await expect(run([join(directory, 'empty', 'missing-command')])).rejects.toThrow()
  })
})
