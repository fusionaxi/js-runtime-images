import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, isRecord } from './config.ts'
import type { Build, Plan } from './matrix.ts'
import { containerExecutable, containerImage, type ContainerExecutable } from './container.ts'

export type Run = (command: string[]) => Promise<void>

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
  fingerprint?: string
  platform?: string
  metadata?: string
  containerExecutable?: ContainerExecutable
}

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
    ...(options.fingerprint
      ? ['--label', `io.fusionaxi.build-fingerprint=${options.fingerprint}`]
      : []),
    ...(executable === 'docker' && options.metadata ? ['--metadata-file', options.metadata] : []),
    ...(executable === 'docker'
      ? options.push
        ? ['--sbom=true', '--provenance=mode=max', '--push']
        : ['--load']
      : []),
    '.'
  ]
}

export async function buildImage(
  build: Build,
  options: BuildOptions,
  execute: Run = run
): Promise<void> {
  // Validate before creating files or starting a container command.
  const command = buildCommand(build, options)
  if (options.metadata) await mkdir(join(options.metadata, '..'), { recursive: true })
  if (containerExecutable(options.containerExecutable) !== 'podman' || !options.push) {
    await execute(command)
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
      await Bun.write(
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

export function imageAtDigest(build: Build, digest: string): string {
  return `${build.image.split(':')[0]}@${metadataDigest({ 'containerimage.digest': digest })}`
}

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

export const FINGERPRINT_LABEL = 'io.fusionaxi.build-fingerprint'

// Exclude aliases: changing the default runtime must not rebuild its image.
export async function buildFingerprint(build: Build): Promise<string> {
  const inputs = { ...build, aliases: undefined }
  const files = [
    build.dockerfile,
    'docker/entrypoint.sh',
    'LICENSE',
    'src/docker.ts',
    'src/container.ts'
  ]
  const contents = await Promise.all(files.map((path) => Bun.file(`${ROOT}/${path}`).text()))
  return new Bun.CryptoHasher('sha256')
    .update(
      JSON.stringify({ schema: 1, inputs, files: files.map((path, i) => [path, contents[i]]) })
    )
    .digest('hex')
}

export interface Captured {
  code: number
  stdout: string
  stderr: string
}
export type Capture = (command: string[]) => Promise<Captured>

async function capture(command: string[]): Promise<Captured> {
  const child = Bun.spawn(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  return { code, stdout, stderr }
}

export async function reusableDigest(
  build: Build,
  fingerprint: string,
  execute: Capture = capture
): Promise<string | undefined> {
  const command = ['docker', 'buildx', 'imagetools', 'inspect']
  const inspected = await execute([...command, build.image])
  if (inspected.code !== 0) {
    // Only a registry's explicit missing-manifest response permits building.
    if (
      /manifest unknown|manifest_unknown|no such manifest/i.test(inspected.stderr) ||
      inspected.stderr.includes(`${build.image}: not found`)
    )
      return undefined
    throw new Error(`Cannot inspect ${build.image}: ${inspected.stderr}`)
  }
  const digest = metadataDigest({
    'containerimage.digest': inspected.stdout.match(/^Digest:\s+(sha256:[a-f0-9]{64})\s*$/m)?.[1]
  })
  const source = imageAtDigest(build, digest)
  const raw = await execute([...command, '--raw', source])
  if (raw.code !== 0) throw new Error(`Cannot inspect platforms: ${raw.stderr}`)
  const index: unknown = JSON.parse(raw.stdout)
  if (!isRecord(index) || !Array.isArray(index.manifests)) return undefined
  const platforms = index.manifests.filter(isRecord).map((manifest) => {
    const platform = manifest.platform
    return isRecord(platform) ? `${platform.os}/${platform.architecture}` : ''
  })
  if (!build.platforms.every((platform) => platforms.includes(platform))) return undefined
  for (const platform of build.platforms) {
    const config = await execute([
      ...command,
      '--format',
      `{{json (index .Image ${JSON.stringify(platform)})}}`,
      source
    ])
    if (config.code !== 0) throw new Error(`Cannot inspect image configuration: ${config.stderr}`)
    const image: unknown = JSON.parse(config.stdout)
    if (
      !isRecord(image) ||
      !isRecord(image.config) ||
      !isRecord(image.config.Labels) ||
      image.config.Labels[FINGERPRINT_LABEL] !== fingerprint
    )
      return undefined
  }
  return digest
}

export async function recordRelease(plan: Plan, results: string, output: string): Promise<void> {
  const images = await Promise.all(
    plan.include.map(async (build) => ({
      ...(await Bun.file(join(results, `${build.id}.json`)).json()),
      verified: true
    }))
  )
  await Bun.write(
    output,
    JSON.stringify(
      {
        schema: 1,
        commit: Bun.env.GITHUB_SHA,
        run: `${Bun.env.GITHUB_SERVER_URL}/${Bun.env.GITHUB_REPOSITORY}/actions/runs/${Bun.env.GITHUB_RUN_ID}`,
        publishedAt: new Date().toISOString(),
        images
      },
      null,
      2
    ) + '\n'
  )
}

export async function releaseImage(
  build: Build,
  metadata: string,
  forceRebuild = false,
  execute: Run = run,
  inspect: Capture = capture
): Promise<void> {
  const fingerprint = await buildFingerprint(build)
  await mkdir(join(metadata, '..'), { recursive: true })
  let status = 'failed'
  try {
    const existing = forceRebuild ? undefined : await reusableDigest(build, fingerprint, inspect)
    if (!existing)
      await buildImage(
        build,
        { push: true, metadata, fingerprint, containerExecutable: 'docker' },
        execute
      )
    const digest = existing ?? metadataDigest(await Bun.file(metadata).json())
    status = existing ? 'reused' : 'built'
    await Bun.write(
      metadata,
      JSON.stringify(
        {
          'containerimage.digest': digest,
          image: build.image,
          fingerprint,
          platforms: build.platforms,
          status,
          verified: false
        },
        null,
        2
      ) + '\n'
    )
  } finally {
    if (Bun.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        Bun.env.GITHUB_STEP_SUMMARY,
        `| Image | Build result |\n| --- | --- |\n| ${build.image} | ${status} |\n`
      )
  }
}
