import { describe, expect, test } from 'bun:test'
import { ROOT } from '../../src/config.ts'

/** Run the entrypoint through the host shell and capture its output and exit code. */
async function entrypoint(args: string[]) {
  const process = Bun.spawn(['sh', 'docker/entrypoint.sh', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ])
  return { stdout: stdout.trim(), stderr, code }
}

describe('container entrypoint', () => {
  test('defaults to Bun when given flags', async () => {
    expect(await entrypoint(['--version'])).toMatchObject({ stdout: Bun.version, code: 0 })
  })
  test('runs an explicit executable with its arguments', async () => {
    expect(
      await entrypoint(['sh', '-c', 'printf \'%s\' "$1"', '--', 'a value; $(not-executed)'])
    ).toMatchObject({
      stdout: 'a value; $(not-executed)',
      code: 0
    })
  })
  test('preserves command failures', async () => {
    expect((await entrypoint(['sh', '-c', 'exit 42'])).code).toBe(42)
  })
  test('runs TypeScript files through Bun', async () => {
    expect(await entrypoint(['tests/fixtures/args.ts', 'hello world'])).toMatchObject({
      stdout: 'hello world',
      code: 0
    })
  })
  test('fails on missing scripts', async () => {
    expect((await entrypoint(['/missing-script.ts'])).code).not.toBe(0)
  })
})
