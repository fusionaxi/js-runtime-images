import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { ROOT } from '../../src/config.ts'
import { join } from 'node:path'
import { main, type CLIServices } from '../../src/cli.ts'
import { createPlan } from '../../src/matrix.ts'
import { config, nodeIndex, schedule, versions } from './fixtures.ts'

describe('CLI command execution', () => {
  let directory: string
  let commands: string[][]
  let messages: string[]
  let services: CLIServices

  beforeEach(async () => {
    directory = await mkdtemp(join(ROOT, '.artifacts-cli-'))
    commands = []
    messages = []
    services = {
      now: new Date('2026-10-20T00:00:00Z'),
      execute: async (command) => {
        commands.push(command)
        const index = command.indexOf('--metadata-file')
        if (index !== -1) await Bun.write(command[index + 1]!, '{}')
      },
      getJSON: async () => {
        throw new Error('Unexpected release feed request')
      },
      log: (message) => {
        messages.push(message)
      }
    }
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('shows help without discovering releases or executing commands', async () => {
    await main(['--help'], services)
    expect(messages[0]).toContain('bun run images build')
    expect(messages[0]).toContain('--push')
    expect(commands).toEqual([])
  })

  test('prints a matrix and saves the same plan to a newly created directory', async () => {
    const output = join(directory, 'nested', 'plan.json')
    await main(
      ['matrix', '--runtime', 'deno', '--bun', '1.4.3', '--deno', '2.5.4', '--output', output],
      services
    )
    const saved = await Bun.file(output).json()
    expect(JSON.parse(messages[0]!)).toEqual(saved)
    expect(saved.include.map((build: { id: string }) => build.id)).toEqual([
      'deno-2-alpine',
      'deno-2-debian'
    ])
    expect(commands).toEqual([])
  })

  test('builds an explicit version locally without network access', async () => {
    await main(
      ['build', '--runtime', 'node', '--variant', 'slim', '--bun', '1.4.3', '--node', '24.11.1'],
      services
    )
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('--load')
    expect(commands[0]).not.toContain('--push')
    expect(commands[0]).toContain('RUNTIME_IMAGE=node:24.11.1-bookworm-slim')
    expect(messages).toEqual(['Built fusionaxi/bun-node:1.4.3-24.11.1-slim'])
  })

  test('passes the selected Podman executable through to the native build', async () => {
    await main(
      [
        'build',
        '--runtime',
        'node',
        '--variant',
        'alpine',
        '--bun',
        '1.4.3',
        '--node',
        '24.11.1',
        '--container-executable',
        'podman'
      ],
      services
    )
    expect(commands).toHaveLength(1)
    expect(commands[0]!.slice(0, 2)).toEqual(['podman', 'build'])
    expect(commands[0]).not.toContain('--load')
  })

  test('uses the environment executable and lets an explicit flag override it', async () => {
    const original = Bun.env.CONTAINER_EXECUTABLE
    try {
      Bun.env.CONTAINER_EXECUTABLE = 'podman'
      const args = [
        'build',
        '--runtime',
        'deno',
        '--variant',
        'alpine',
        '--bun',
        '1.4.3',
        '--deno',
        '2.5.4'
      ]
      await main(args, services)
      await main([...args, '--container-executable', 'docker'], services)
      expect(commands.map((command) => command[0])).toEqual(['podman', 'docker'])
    } finally {
      if (original === undefined) delete Bun.env.CONTAINER_EXECUTABLE
      else Bun.env.CONTAINER_EXECUTABLE = original
    }
  })

  test('passes Podman through to promotion and cleans up its temporary manifest', async () => {
    const plan = createPlan(config, versions, { runtime: 'deno', variant: 'alpine' })
    const entry = plan.include[0]!
    const path = join(directory, 'plan.json')
    await Bun.write(path, JSON.stringify(plan))
    await Bun.write(
      join(directory, `${entry.id}.json`),
      JSON.stringify({ 'containerimage.digest': `sha256:${'d'.repeat(64)}` })
    )
    await main(
      ['promote', '--plan', path, '--results', directory, '--container-executable', 'podman'],
      services
    )
    expect(commands[0]!.slice(0, 4)).toEqual(['podman', 'manifest', 'create', '--all'])
    expect(commands.every((command) => command[0] === 'podman')).toBe(true)
    expect(commands.at(-1)![2]).toBe('rm')
  })

  test('selects the newest LTS for a default Node build rather than Current', async () => {
    services.getJSON = async (url) => (url.endsWith('index.json') ? nodeIndex : schedule)
    await main(['build', '--runtime', 'node', '--variant', 'slim', '--bun', '1.4.3'], services)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('RUNTIME_IMAGE=node:24.11.1-bookworm-slim')
  })

  test('keeps the default LTS when the scheduled transition has no published LTS release', async () => {
    services.now = new Date(schedule.v26.lts)
    services.getJSON = async (url) => (url.endsWith('index.json') ? nodeIndex : schedule)
    await main(['build', '--runtime', 'node', '--variant', 'slim', '--bun', '1.4.3'], services)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('RUNTIME_IMAGE=node:24.11.1-bookworm-slim')
  })

  test('builds the requested saved-plan entry with push, platform, and metadata options', async () => {
    const plan = createPlan(config, versions)
    const path = join(directory, 'plan.json')
    const metadata = join(directory, 'results', 'deno.json')
    await Bun.write(path, JSON.stringify(plan))
    await main(
      [
        'build',
        '--plan',
        path,
        '--id',
        'deno-2-debian',
        '--push',
        '--platform',
        'linux/amd64',
        '--metadata',
        metadata
      ],
      services
    )
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('RUNTIME_IMAGE=denoland/deno:debian-2.5.4')
    expect(commands[0]).toContain('--push')
    expect(commands[0]).toContain('linux/amd64')
    expect(await Bun.file(metadata).text()).toBe('{}')
    expect(messages[0]).toBe('Built fusionaxi/bun-deno:1.4.3-2.5.4-debian')
  })

  test('rejects an unknown plan entry before executing any Docker command', async () => {
    const path = join(directory, 'plan.json')
    await Bun.write(path, JSON.stringify(createPlan(config, versions)))
    await expect(main(['build', '--plan', path, '--id', 'node-99-slim'], services)).rejects.toThrow(
      'Select exactly one build'
    )
    expect(commands).toEqual([])
  })

  test('rejects a tampered plan before executing commands', async () => {
    const plan = createPlan(config, versions)
    plan.include[0]!.dockerfile = 'untrusted/Dockerfile'
    const path = join(directory, 'plan.json')
    await Bun.write(path, JSON.stringify(plan))
    await expect(
      main(['build', '--plan', path, '--id', plan.include[0]!.id], services)
    ).rejects.toThrow('Invalid dockerfile')
    expect(commands).toEqual([])
  })

  test('propagates build failures without reporting success', async () => {
    services.execute = async () => {
      throw new Error('builder unavailable')
    }
    await expect(
      main(
        ['build', '--runtime', 'deno', '--variant', 'debian', '--bun', '1.4.3', '--deno', '2.5.4'],
        services
      )
    ).rejects.toThrow('builder unavailable')
    expect(messages).toEqual([])
  })

  test('promotes saved build digests without discovering releases or rebuilding', async () => {
    const plan = createPlan(config, versions, { runtime: 'deno', variant: 'debian' })
    const build = plan.include[0]!
    const digest = `sha256:${'b'.repeat(64)}`
    const path = join(directory, 'plan.json')
    await Bun.write(path, JSON.stringify(plan))
    await Bun.write(
      join(directory, `${build.id}.json`),
      JSON.stringify({ 'containerimage.digest': digest })
    )
    await main(['promote', '--plan', path, '--results', directory], services)
    expect(commands).toHaveLength(1)
    expect(commands[0]!.slice(0, 4)).toEqual(['docker', 'buildx', 'imagetools', 'create'])
    expect(commands[0]).toContain('fusionaxi/bun-deno:latest')
    expect(commands[0]!.at(-1)).toBe(`fusionaxi/bun-deno@${digest}`)
  })

  test('publishes a forced release through private metadata and records promotion', async () => {
    const plan = createPlan(config, versions, { runtime: 'deno', variant: 'alpine' })
    const build = plan.include[0]!
    const path = join(directory, 'plan.json')
    const metadata = join(directory, `${build.id}.json`)
    const output = join(directory, 'nested', 'release.json')
    const digest = `sha256:${'c'.repeat(64)}`
    await Bun.write(path, JSON.stringify(plan))
    services.execute = async (command) => {
      commands.push(command)
      const index = command.indexOf('--metadata-file')
      if (index !== -1) {
        expect(command[index + 1]).not.toBe(metadata)
        await Bun.write(command[index + 1]!, JSON.stringify({ 'containerimage.digest': digest }))
      }
    }
    services.inspect = async () => {
      throw new Error('forced release must not inspect')
    }
    await main(
      ['release', '--plan', path, '--id', build.id, '--metadata', metadata, '--force-rebuild'],
      services
    )
    expect((await Bun.file(metadata).json()).status).toBe('built')
    const result = await Bun.file(metadata).json()
    expect(result.verified).toBe(false)
    await Bun.write(metadata, JSON.stringify({ ...result, verified: true }))
    await main(['promote', '--plan', path, '--results', directory, '--output', output], services)
    expect(commands).toHaveLength(2)
    expect(commands[1]!.at(-1)).toBe(`fusionaxi/bun-deno@${digest}`)
    expect((await Bun.file(output).json()).images[0].verified).toBe(true)
  })

  test('rejects unsafe promotion output before changing registry aliases', async () => {
    const path = join(directory, 'plan.json')
    await Bun.write(path, JSON.stringify(createPlan(config, versions)))
    await expect(
      main(
        ['promote', '--plan', path, '--results', directory, '--output', '../escape.json'],
        services
      )
    ).rejects.toThrow('inside the project')
    expect(commands).toEqual([])
  })
})
