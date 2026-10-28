import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ROOT } from '../../src/config.ts'
import { containerExecutable, containerImage } from '../../src/container.ts'

const image = Bun.env.TEST_IMAGE
const executable = containerExecutable()
const reference = image ? containerImage(image, executable) : undefined
const runtime = Bun.env.TEST_RUNTIME
const platforms = (
  Bun.env.TEST_PLATFORMS ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64')
).split(',')
const fixtures = join(ROOT, 'tests/fixtures')

/** Run the selected container engine with a timeout and capture its output and exit code. */
async function engine(args: string[]) {
  const process = Bun.spawn([executable, ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 110_000
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), code }
}

for (const platform of platforms) {
  describe.skipIf(!image)(`container scenarios: ${runtime} on ${platform}`, () => {
    const cleanup: string[] = []
    /** Run an isolated container for this platform with read-only test fixtures. */
    const run = (...args: string[]) =>
      engine([
        'run',
        '--rm',
        '--platform',
        platform,
        '--network',
        'none',
        '--volume',
        `${fixtures}:/fixtures:ro`,
        reference!,
        ...args
      ])
    /** Assert a container command succeeds and return its trimmed standard output. */
    const succeeds = async (...args: string[]) => {
      const result = await run(...args)
      expect(result, result.stderr).toMatchObject({ code: 0 })
      return result.stdout
    }

    beforeAll(async () => {
      if (runtime !== 'node' && runtime !== 'deno')
        throw new Error('Set TEST_RUNTIME=node or deno when TEST_IMAGE is provided.')
      const result = await engine(['info'])
      if (result.code !== 0) throw new Error(`${executable} must be available: ${result.stderr}`)
    })

    afterAll(async () => {
      for (const name of cleanup) await engine(['rm', '--force', name])
    })

    test('contains the expected Bun version and companion runtime', async () => {
      const bun = await succeeds('bun', '--version')
      const companion = await succeeds(runtime!, '--version')
      expect(bun).toMatch(/^\d+\.\d+\.\d+$/)
      expect(companion).toMatch(runtime === 'node' ? /^v\d+\.\d+\.\d+$/ : /^deno \d+\.\d+\.\d+/)
      if (Bun.env.EXPECTED_BUN) expect(bun).toBe(Bun.env.EXPECTED_BUN)
      if (Bun.env.EXPECTED_RUNTIME) {
        const version = runtime === 'node' ? companion.replace(/^v/, '') : companion.split(/\s+/)[1]
        expect(version).toBe(Bun.env.EXPECTED_RUNTIME)
      }
    })

    test('runs as an unprivileged user with writable working and cache directories', async () => {
      const output = await succeeds(
        'sh',
        '-ec',
        [
          'test "$(id -u)" = 1001',
          'test -w /app',
          'test -w "$BUN_INSTALL_BIN"',
          'if [ -n "${DENO_DIR:-}" ]; then test -w "$DENO_DIR"; test -w "$DENO_INSTALL_ROOT/bin"; fi',
          'echo writable'
        ].join('; ')
      )
      expect(output).toBe('writable')
    })

    test('executes Bun TypeScript and preserves arguments', async () => {
      expect(await succeeds('/fixtures/args.ts', 'hello world', 'literal;value')).toBe(
        'hello world|literal;value'
      )
    })

    test('uses Bun for flag-only commands and exposes bunx', async () => {
      expect(await succeeds('--version')).toMatch(/^\d+\.\d+\.\d+$/)
      expect(await succeeds('sh', '-ec', 'test -x /usr/local/bin/bunx; echo bunx-ok')).toBe(
        'bunx-ok'
      )
    })

    test('runs companion-runtime programs', async () => {
      expect(
        await succeeds(
          runtime!,
          runtime === 'node' ? '--eval' : 'eval',
          "console.log('companion-ok')"
        )
      ).toBe('companion-ok')
    })

    test('installs and runs a local dependency without network access', async () => {
      const output = await succeeds(
        'sh',
        '-ec',
        [
          'cp -R /fixtures /tmp/scenario',
          'cd /tmp/scenario/project',
          'bun install --offline --ignore-scripts --no-progress',
          'bun run verify'
        ].join('; ')
      )
      expect(output).toContain('local-dependency-ok')
    })

    test('supports writable global Bun installs', async () => {
      const output = await succeeds(
        'sh',
        '-ec',
        'bun install --global --offline --ignore-scripts /fixtures/dependency; test -d "$BUN_INSTALL/install/global/node_modules/@fusionaxi/test-dependency"; echo global-ok'
      )
      expect(output).toContain('global-ok')
    })

    test('preserves exit codes', async () => {
      expect((await run('sh', '-c', 'exit 42')).code).toBe(42)
    })

    test.skipIf(Bun.env.TEST_VARIANT !== 'alpine-git')(
      'provides Git and Git LFS in the Git variant',
      async () => {
        expect(await succeeds('git', '--version')).toStartWith('git version ')
        expect(await succeeds('git', 'lfs', 'version')).toStartWith('git-lfs/')
      }
    )

    test('forwards SIGTERM to the running program', async () => {
      const name = `fusionaxi-smoke-${crypto.randomUUID()}`
      cleanup.push(name)
      const started = await engine([
        'run',
        '--detach',
        '--name',
        name,
        '--platform',
        platform,
        '--network',
        'none',
        reference!,
        'bun',
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)"
      ])
      expect(started, started.stderr).toMatchObject({ code: 0 })
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await engine(['logs', name])).stdout.includes('ready')) {
          ready = true
          break
        }
        await Bun.sleep(100)
      }
      expect(ready).toBe(true)
      expect((await engine(['kill', '--signal', 'TERM', name])).code).toBe(0)
      const stopped = await engine(['wait', name])
      expect(stopped).toMatchObject({ code: 0, stdout: '0' })
    })
  })
}
