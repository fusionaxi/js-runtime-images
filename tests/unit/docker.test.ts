import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { ROOT } from '../../src/config.ts'
import { join } from 'node:path'
import {
  buildFingerprint,
  FINGERPRINT_LABEL,
  reusableDigest,
  releaseImage,
  recordRelease,
  type Capture,
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

  test('copies private build metadata to the requested output', async () => {
    const metadata = join(directory, 'nested', 'results', 'build.json')
    await buildImage(build, { push: true, metadata }, async (command) => {
      const privateMetadata = command[command.indexOf('--metadata-file') + 1]!
      expect(privateMetadata).not.toBe(metadata)
      await Bun.write(privateMetadata, '{}')
      commands.push(command)
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('--push')
    expect(await Bun.file(metadata).text()).toBe('{}')
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

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' })

function registry(options: { fingerprint?: string; platforms?: string[] } = {}): Capture {
  return async (command) => {
    if (command.includes('--raw'))
      return ok(
        JSON.stringify({
          manifests: (options.platforms ?? build.platforms).map((platform) => {
            const [os, architecture] = platform.split('/')
            return { platform: { os, architecture } }
          })
        })
      )
    if (command.includes('--format')) {
      expect(command.at(-1)).toEndWith(`@${digest}`)
      return ok(
        JSON.stringify({
          config: { Labels: { [FINGERPRINT_LABEL]: options.fingerprint ?? 'expected' } }
        })
      )
    }
    return ok(`Name: ${build.image}\nDigest: ${digest}\n`)
  }
}

test('reuses the manifest digest only when platforms and fingerprints match', async () => {
  expect(await reusableDigest(build, 'expected', registry())).toBe(digest)
  expect(await reusableDigest(build, 'changed', registry())).toBeUndefined()
  expect(
    await reusableDigest(build, 'expected', registry({ platforms: ['linux/amd64'] }))
  ).toBeUndefined()
})

test('only explicit missing manifests allow a build; registry failures stop the release', async () => {
  expect(
    await reusableDigest(build, 'x', async () => ({
      code: 1,
      stdout: '',
      stderr: 'manifest unknown'
    }))
  ).toBeUndefined()
  for (const stderr of ['unauthorized', '429 Too Many Requests', 'network timeout']) {
    await expect(
      reusableDigest(build, 'x', async () => ({ code: 1, stdout: '', stderr }))
    ).rejects.toThrow(stderr)
  }
})

test('malformed registry responses fail rather than cause a rebuild', async () => {
  await expect(reusableDigest(build, 'x', async () => ok('invalid'))).rejects.toThrow('digest')
})

test('fingerprints ignore aliases and change with build inputs', async () => {
  const fingerprint = await buildFingerprint(build)
  expect(await buildFingerprint({ ...build, aliases: [] })).toBe(fingerprint)
  expect(await buildFingerprint({ ...build, bunImage: 'oven/bun:other' })).not.toBe(fingerprint)
  expect(buildCommand(build, { fingerprint })).toContain(`${FINGERPRINT_LABEL}=${fingerprint}`)
})

test('legacy images without fingerprints are rebuilt', async () => {
  const execute = registry()
  expect(
    await reusableDigest(build, 'expected', async (command) =>
      command.includes('--format') ? ok('{"config":{}}') : execute(command)
    )
  ).toBeUndefined()
})

test('recognizes Buildx missing-tag responses without hiding inspection failures', async () => {
  expect(
    await reusableDigest(build, 'x', async () => ({
      code: 1,
      stdout: '',
      stderr: `ERROR: docker.io/${build.image}: not found`
    }))
  ).toBeUndefined()
  const execute = registry()
  await expect(
    reusableDigest(build, 'expected', async (command) =>
      command.includes('--raw')
        ? { code: 1, stdout: '', stderr: 'registry unavailable' }
        : execute(command)
    )
  ).rejects.toThrow('registry unavailable')
  await expect(
    reusableDigest(build, 'expected', async (command) =>
      command.includes('--format')
        ? { code: 1, stdout: '', stderr: 'unauthorized' }
        : execute(command)
    )
  ).rejects.toThrow('unauthorized')
})

test('forced release bypasses registry inspection and records the built digest', async () => {
  const directory = await mkdtemp(join(ROOT, '.artifacts-release-force-'))
  const metadata = join(directory, 'result.json')
  try {
    await releaseImage(
      build,
      metadata,
      true,
      async (command) => {
        expect(command).toContain('--push')
        const privateMetadata = command[command.indexOf('--metadata-file') + 1]!
        await Bun.write(privateMetadata, JSON.stringify({ 'containerimage.digest': digest }))
      },
      async () => {
        throw new Error('force must bypass inspection')
      }
    )
    const result = await Bun.file(metadata).json()
    expect(result.status).toBe('built')
    expect(result['containerimage.digest']).toBe(digest)
    expect(result.verified).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reused releases save safe metadata without invoking a builder', async () => {
  const directory = await mkdtemp(join(ROOT, '.artifacts-release-reuse-'))
  const metadata = join(directory, 'nested', 'result.json')
  try {
    const fingerprint = await buildFingerprint(build)
    await releaseImage(
      build,
      metadata,
      false,
      async () => {
        throw new Error('must reuse')
      },
      registry({ fingerprint })
    )
    const result = await Bun.file(metadata).json()
    expect(result).toMatchObject({
      image: build.image,
      status: 'reused',
      fingerprint,
      verified: false,
      'containerimage.digest': digest
    })
    expect(result.platforms).toEqual(build.platforms)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('records validated releases in newly created output directories', async () => {
  const directory = await mkdtemp(join(ROOT, '.artifacts-release-record-'))
  const output = join(directory, 'nested', 'release.json')
  const single = { include: [build] }
  const result = join(directory, `${build.id}.json`)
  try {
    await Bun.write(result, JSON.stringify({ 'containerimage.digest': digest, status: 'reused' }))
    await recordRelease(single, directory, output)
    expect((await Bun.file(output).json()).images[0]).toMatchObject({
      image: build.image,
      'containerimage.digest': digest,
      platforms: build.platforms,
      verified: true
    })
    await Bun.write(result, JSON.stringify({ 'containerimage.digest': 'invalid' }))
    await expect(recordRelease(single, directory, output)).rejects.toThrow('digest')
    await Bun.write(
      result,
      JSON.stringify({ 'containerimage.digest': digest, image: 'wrong/image:tag' })
    )
    await expect(recordRelease(single, directory, output)).rejects.toThrow('does not match')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
