import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, isRecord } from './config.ts'
import type { Build, Plan } from './matrix.ts'
import { containerExecutable, containerImage, type ContainerExecutable } from './container.ts'
import { outputPath, writeOutput } from './output.ts'

export type Run = (command: string[]) => Promise<void>

/** Run a command from the project root with inherited output, rejecting nonzero exits. */
export async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: ROOT,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const code = await process.exited
  if (code !== 0) throw new Error(`${command[0]} ${command[1]} failed (exit ${code}).`)
}

export interface BuildOptions {
  push?: boolean
  platform?: string
  metadata?: string
  containerExecutable?: ContainerExecutable
}

/** Validate build options and construct the selected container engine's build command. */
export function buildCommand(
  build: Build,
  options: BuildOptions = {},
  manifest?: string
): string[] {
  const executable = containerExecutable(options.containerExecutable)
  const platform =
    options.platform ??
    (options.push
      ? build.platforms.join(',')
      : process.arch === 'arm64'
        ? 'linux/arm64'
        : 'linux/amd64')
  if (
    !platform.split(',').every((item) => build.platforms.includes(item)) ||
    (!options.push && platform.includes(','))
  ) {
    throw new Error(
      'Local builds need one configured platform; push builds may use multiple configured platforms.'
    )
  }
  if (executable === 'podman' && options.metadata && !options.push) {
    throw new Error(
      'Podman build metadata requires --push to record the published manifest digest.'
    )
  }
  return [
    ...(executable === 'docker'
      ? ['docker', 'buildx', 'build', '--pull']
      : ['podman', 'build', '--pull=always']),
    '--file',
    build.dockerfile,
    '--platform',
    platform,
    '--build-arg',
    `BUN_IMAGE=${containerImage(build.bunImage, executable)}`,
    '--build-arg',
    `RUNTIME_IMAGE=${containerImage(build.runtimeImage, executable)}`,
    '--build-arg',
    `INSTALL_GIT=${build.variant === 'alpine-git' ? '1' : '0'}`,
    '--label',
    `org.opencontainers.image.source=${build.source}`,
    '--label',
    `org.opencontainers.image.version=bun-${build.bunVersion}-${build.runtime}-${build.runtimeVersion}`,
    ...(executable === 'podman' && options.push
      ? ['--manifest', manifest ?? containerImage(build.image, executable)]
      : ['--tag', containerImage(build.image, executable)]),
    ...(executable === 'docker' && options.metadata ? ['--metadata-file', options.metadata] : []),
    ...(executable === 'docker'
      ? options.push
        ? ['--sbom=true', '--provenance=mode=max', '--push']
        : ['--load']
      : []),
    '.'
  ]
}

/** Build an image, optionally publishing it and saving metadata to a validated project path. */
export async function buildImage(
  build: Build,
  options: BuildOptions,
  execute: Run = run
): Promise<void> {
  if (options.metadata !== undefined)
    options = { ...options, metadata: await outputPath(options.metadata) }
  // Validate before creating files or starting a container command.
  const command = buildCommand(build, options)
  if (containerExecutable(options.containerExecutable) !== 'podman' || !options.push) {
    if (!options.metadata) {
      await execute(command)
      return
    }
    const directory = await mkdtemp(join(tmpdir(), 'fusionaxi-docker-'))
    const metadata = join(directory, 'metadata.json')
    try {
      await execute(buildCommand(build, { ...options, metadata }))
      await writeOutput(options.metadata, await Bun.file(metadata).bytes())
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'fusionaxi-podman-'))
  const manifest = `localhost/fusionaxi-build-${build.id}:${crypto.randomUUID()}`
  const digestFile = join(directory, 'digest')
  try {
    await execute(buildCommand(build, options, manifest))
    await execute([
      'podman',
      'manifest',
      'push',
      '--all',
      '--digestfile',
      digestFile,
      manifest,
      `docker://${containerImage(build.image, 'podman')}`
    ])
    const digest = metadataDigest({
      'containerimage.digest': (await Bun.file(digestFile).text()).trim()
    })
    if (options.metadata)
      await writeOutput(
        options.metadata,
        `${JSON.stringify({ 'containerimage.digest': digest }, null, 2)}\n`
      )
  } finally {
    try {
      await execute(['podman', 'manifest', 'rm', manifest])
    } catch {
      /* A failed build may not have created the temporary manifest. */
    }
    await rm(directory, { recursive: true, force: true })
  }
}

/** Extract a validated SHA-256 container digest from build metadata. */
export function metadataDigest(metadata: unknown): string {
  if (
    !isRecord(metadata) ||
    typeof metadata['containerimage.digest'] !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata['containerimage.digest'])
  ) {
    throw new Error('Build metadata is missing a valid containerimage.digest.')
  }
  return metadata['containerimage.digest']
}

/** Create an immutable image reference using the build repository and a validated digest. */
export function imageAtDigest(build: Build, digest: string): string {
  return `${build.image.split(':')[0]}@${metadataDigest({ 'containerimage.digest': digest })}`
}

/** Validate build digests and construct commands that publish their floating aliases. */
export function promotionCommands(
  plan: Plan,
  digests: Record<string, string>,
  executable: ContainerExecutable = 'docker'
): string[][] {
  containerExecutable(executable)
  // Validate every result before changing the first alias.
  return plan.include
    .filter((build) => build.aliases.length)
    .flatMap((build) => {
      const source = imageAtDigest(build, digests[build.id] ?? '')
      if (executable === 'docker')
        return [
          [
            'docker',
            'buildx',
            'imagetools',
            'create',
            ...build.aliases.flatMap((alias) => ['--tag', alias]),
            source
          ]
        ]
      const manifest = `localhost/fusionaxi-promote-${build.id}:${crypto.randomUUID()}`
      return [
        [
          'podman',
          'manifest',
          'create',
          '--all',
          manifest,
          `docker://${containerImage(source, executable)}`
        ],
        ...build.aliases.map((alias) => [
          'podman',
          'manifest',
          'push',
          '--all',
          manifest,
          `docker://${containerImage(alias, executable)}`
        ])
      ]
    })
}

/** Validate all saved build results before promoting aliases, cleaning up Podman manifests. */
export async function promote(
  plan: Plan,
  results: string,
  execute: Run = run,
  executable: ContainerExecutable = 'docker'
): Promise<void> {
  const entries = await Promise.all(
    plan.include.map(async (build) => [
      build.id,
      metadataDigest(await Bun.file(join(results, `${build.id}.json`)).json())
    ])
  )
  const commands = promotionCommands(plan, Object.fromEntries(entries), executable)
  const manifests: string[] = []
  try {
    for (const command of commands) {
      if (executable === 'podman' && command[2] === 'create') manifests.push(command[4]!)
      await execute(command)
    }
  } finally {
    for (const manifest of manifests) {
      try {
        await execute(['podman', 'manifest', 'rm', manifest])
      } catch {
        /* Keep the original registry failure if cleanup also fails. */
      }
    }
  }
}
