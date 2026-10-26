import { expect, test } from 'bun:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../../src/config.ts'
import { outputPath } from '../../src/output.ts'
import { main } from '../../src/cli.ts'
import { buildImage } from '../../src/docker.ts'
import { createPlan } from '../../src/matrix.ts'
import { config, versions } from './fixtures.ts'

test('rejects paths outside the project before any CLI or build side effects', async () => {
  for (const path of ['../escape.json', join(tmpdir(), 'escape.json'), ROOT, '']) {
    await expect(outputPath(path)).rejects.toThrow('inside the project')
    await expect(main(['matrix', '--output', path])).rejects.toThrow('inside the project')
    const build = createPlan(config, versions).include[0]!
    await expect(
      buildImage(build, { metadata: path }, async () => {
        throw new Error('Runner must not be called')
      })
    ).rejects.toThrow('inside the project')
  }
})

test('accepts nested output files and rejects symlink parents and destinations', async () => {
  const directory = await mkdtemp(join(ROOT, '.artifacts-output-'))
  try {
    const output = join(directory, 'nested', 'plan.json')
    expect(await outputPath(output)).toBe(output)
    await symlink(tmpdir(), join(directory, 'link'))
    await expect(outputPath(join(directory, 'link', 'escape.json'))).rejects.toThrow(
      'symbolic links'
    )
    await symlink(join(tmpdir(), 'missing-target.json'), join(directory, 'file.json'))
    await expect(outputPath(join(directory, 'file.json'))).rejects.toThrow('symbolic links')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('resolves relative output paths from the caller working directory', async () => {
  const directory = await mkdtemp(join(ROOT, '.artifacts-output-'))
  const cwd = process.cwd()
  try {
    process.chdir(directory)
    expect(await outputPath('nested/plan.json')).toBe(join(directory, 'nested', 'plan.json'))
    expect(await outputPath('../plan.json')).toBe(join(ROOT, 'plan.json'))
    await expect(outputPath('../../escape.json')).rejects.toThrow('inside the project')
  } finally {
    process.chdir(cwd)
    await rm(directory, { recursive: true, force: true })
  }
})
