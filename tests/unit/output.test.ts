import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../../src/config.ts'
import { outputPath, writeOutput } from '../../src/output.ts'
import { main } from '../../src/cli.ts'
import { buildImage, recordRelease, releaseImage } from '../../src/docker.ts'
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

test('refuses redirected parents and destinations after initial validation', async () => {
  const directory = await mkdtemp(join(ROOT, '.artifacts-output-'))
  const outside = await mkdtemp(join(tmpdir(), 'output-outside-'))
  try {
    const parent = join(directory, 'parent')
    await mkdir(parent)
    const target = await outputPath(join(parent, 'result.json'))
    await rename(parent, join(directory, 'original'))
    await symlink(outside, parent)
    await expect(writeOutput(target, 'unsafe')).rejects.toThrow('symbolic links')
    expect(await Bun.file(join(outside, 'result.json')).exists()).toBe(false)
    const file = await outputPath(join(directory, 'file.json'))
    const victim = join(outside, 'victim.json')
    await Bun.write(victim, 'original')
    await symlink(victim, file)
    await expect(writeOutput(file, 'unsafe')).rejects.toThrow('symbolic links')
    expect(await Bun.file(victim).text()).toBe('original')
    await writeOutput(join(directory, 'nested', 'safe.json'), 'safe')
    expect(await Bun.file(join(directory, 'nested', 'safe.json')).text()).toBe('safe')
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('refuses a parent swapped after write validation and before filesystem use', async () => {
  const directory = await mkdtemp(join(ROOT, '.artifacts-output-'))
  const outside = await mkdtemp(join(tmpdir(), 'output-race-'))
  const parent = join(directory, 'parent')
  await mkdir(parent)
  const open = fs.openSync
  const hook = spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof open>) => {
    const fd = open(...args)
    fs.renameSync(parent, join(directory, 'original'))
    fs.symlinkSync(outside, parent)
    return fd
  })
  try {
    await expect(writeOutput(join(parent, 'result.json'), 'unsafe')).rejects.toThrow(
      'symbolic links'
    )
    expect(await Bun.file(join(outside, 'result.json')).exists()).toBe(false)
  } finally {
    hook.mockRestore()
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('release rejects unsafe metadata before inspecting or building', async () => {
  const directory = await mkdtemp(join(ROOT, '.artifacts-output-'))
  const outside = await mkdtemp(join(tmpdir(), 'release-output-'))
  const build = createPlan(config, versions).include[0]!
  let called = false
  const execute = async () => {
    called = true
  }
  const inspect = async () => {
    called = true
    return { code: 1, stdout: '', stderr: 'manifest unknown' }
  }
  try {
    await symlink(outside, join(directory, 'link'))
    for (const metadata of [join(outside, 'result.json'), join(directory, 'link', 'result.json')]) {
      await expect(releaseImage(build, metadata, false, execute, inspect)).rejects.toThrow()
      await expect(releaseImage(build, metadata, true, execute, inspect)).rejects.toThrow()
    }
    expect(called).toBe(false)
    expect(await Bun.file(join(outside, 'result.json')).exists()).toBe(false)
    await expect(
      recordRelease(createPlan(config, versions), directory, join(outside, 'release.json'))
    ).rejects.toThrow('inside the project')
    await expect(
      recordRelease(
        createPlan(config, versions),
        directory,
        join(directory, 'link', 'release.json')
      )
    ).rejects.toThrow('symbolic links')
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
