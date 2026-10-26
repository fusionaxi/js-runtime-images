import { describe, expect, test } from 'bun:test'
import { parseCLI } from '../../src/cli.ts'
import { ROOT } from '../../src/config.ts'

describe('Bun CLI', () => {
  test('shows command help without requiring build arguments', () => {
    expect(parseCLI(['build', '--help']).command).toBe('help')
  })
  test('parses exact build options', () => {
    expect(
      parseCLI([
        'build',
        '--runtime',
        'node',
        '--variant=slim',
        '--bun',
        '1.4.3',
        '--node',
        '24.11.1'
      ]).values
    ).toMatchObject({
      runtime: 'node',
      variant: 'slim',
      bun: '1.4.3',
      node: '24.11.1',
      push: false
    })
  })
  test('parses the container executable for builds and promotions', () => {
    expect(
      parseCLI([
        'build',
        '--runtime',
        'node',
        '--variant',
        'alpine',
        '--container-executable',
        'podman'
      ]).values['container-executable']
    ).toBe('podman')
    expect(
      parseCLI([
        'promote',
        '--plan',
        'plan.json',
        '--results',
        'results',
        '--container-executable=docker'
      ]).values['container-executable']
    ).toBe('docker')
  })
  test.each(
    [
      ['matrix', '--runtim', 'node'],
      ['matrix', '--runtime', 'python'],
      ['matrix', '--variant', 'ubuntu'],
      ['build'],
      ['build', '--plan', 'plan.json'],
      ['promote'],
      ['matrix', '--push'],
      ['matrix', '--runtime', 'node', '--deno', '2.5.4'],
      ['build', '--plan', 'plan.json', '--id', 'node-24-slim', '--node', '24.11.1'],
      ['matrix', 'extra'],
      ['build', '--runtime', 'node', '--variant', 'slim', '--id', 'node-24-slim'],
      ['unknown'],
      ['build', '--runtime', 'node', '--variant', 'alpine', '--container-executable', 'invalid'],
      ['matrix', '--container-executable', 'podman']
    ].map((args) => ({ args }))
  )('rejects invalid arguments: %j', ({ args }) => {
    expect(() => parseCLI(args)).toThrow()
  })
  test('prints a valid offline matrix as JSON', async () => {
    const process = Bun.spawn(
      [
        Bun.which('bun')!,
        'src/cli.ts',
        'matrix',
        '--runtime',
        'deno',
        '--bun',
        '1.4.3',
        '--deno',
        '2.5.4'
      ],
      {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe'
      }
    )
    const [output, error, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited
    ])
    expect(error).toBe('')
    expect(code).toBe(0)
    const plan = JSON.parse(output)
    expect(plan.include).toHaveLength(2)
    expect(plan.include[0].image).toStartWith('fusionaxi/bun-deno:')
  })

  test('reports invalid commands with a failing process exit code', async () => {
    const process = Bun.spawn([Bun.which('bun')!, 'src/cli.ts', 'unknown'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [output, error, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited
    ])
    expect(code).toBe(1)
    expect(output).toBe('')
    expect(error).toContain('Unknown command: unknown')
  })
})
