import { RUNTIMES, type Config, type Runtime, type Variant } from './config.ts'
import { version, type Versions } from './versions.ts'

export interface Build {
  id: string
  runtime: Runtime
  variant: Variant
  bunVersion: string
  runtimeVersion: string
  bunImage: string
  runtimeImage: string
  dockerfile: string
  image: string
  aliases: string[]
  platforms: string[]
  source: string
}

export interface Plan {
  include: Build[]
}
export interface MatrixOptions {
  runtime?: Runtime
  variant?: Variant
}

export function createPlan(config: Config, versions: Versions, options: MatrixOptions = {}): Plan {
  const include: Build[] = []
  const bunVersion = version(versions.bun)
  for (const runtime of options.runtime ? [options.runtime] : RUNTIMES) {
    const image = config.images[runtime]
    if (options.variant && !image.variants.includes(options.variant)) {
      throw new Error(`${runtime} does not support variant ${options.variant}.`)
    }
    const releases = versions[runtime]
    if (!releases.length || releases.filter((release) => release.default).length !== 1) {
      throw new Error(`${runtime} must have releases with exactly one default.`)
    }
    for (const release of releases) {
      const runtimeVersion = version(release.version)
      const major = runtimeVersion.split('.')[0]!
      for (const variant of options.variant ? [options.variant] : image.variants) {
        const alpine = variant.startsWith('alpine')
        const suffix =
          runtime === 'node'
            ? alpine
              ? 'alpine'
              : variant === 'slim'
                ? 'bookworm-slim'
                : 'bookworm'
            : variant
        const repository = `${config.namespace}/${image.name}`
        const tag = `${bunVersion}-${runtimeVersion}-${variant}`
        const aliases = [`${major}-${variant}`, `${runtimeVersion}-${variant}`]
        if (release.default) {
          aliases.push(variant)
          if (variant === image.defaultVariant) aliases.push('latest')
        }
        include.push({
          id: `${runtime}-${major}-${variant}`,
          runtime,
          variant,
          bunVersion,
          runtimeVersion,
          bunImage: `oven/bun:${bunVersion}-${alpine ? 'alpine' : 'debian'}`,
          runtimeImage:
            runtime === 'node'
              ? `node:${runtimeVersion}-${suffix}`
              : `denoland/deno:${suffix}-${runtimeVersion}`,
          dockerfile: `docker/bun-${runtime}/Dockerfile`,
          image: `${repository}:${tag}`,
          aliases: [...new Set(aliases)].map((alias) => `${repository}:${alias}`),
          platforms: [...config.platforms],
          source: config.source
        })
      }
    }
  }
  assertUniqueTags(include)
  if (include.length > 256)
    throw new Error("Build plan exceeds GitHub Actions' 256-job matrix limit.")
  return { include }
}

function assertUniqueTags(builds: Build[]): void {
  const ids = new Set<string>()
  const tags = new Set<string>()
  for (const build of builds) {
    if (ids.has(build.id)) throw new Error(`Duplicate build id: ${build.id}`)
    ids.add(build.id)
    for (const tag of [build.image, ...build.aliases]) {
      if (tags.has(tag)) throw new Error(`Conflicting image tag: ${tag}`)
      tags.add(tag)
    }
  }
}

// Recreate every derived field before trusting a plan from disk.
export function parsePlan(input: unknown, config: Config): Plan {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('include' in input) ||
    !Array.isArray(input.include) ||
    !input.include.length
  ) {
    throw new Error('Plan must contain a nonempty include array.')
  }
  const builds: Build[] = []
  for (const value of input.include) {
    if (typeof value !== 'object' || value === null || !RUNTIMES.includes(value.runtime)) {
      throw new Error('Invalid runtime in build plan.')
    }
    const runtime = value.runtime as Runtime
    const variant = value.variant as Variant
    if (!config.images[runtime].variants.includes(variant) || !Array.isArray(value.aliases))
      throw new Error('Invalid variant or aliases in build plan.')
    const expected = createPlan(
      config,
      {
        bun: version(value.bunVersion),
        node: [],
        deno: [],
        [runtime]: [{ version: version(value.runtimeVersion), default: true }]
      },
      { runtime, variant }
    ).include[0]!
    const allowedAliases = new Set(expected.aliases)
    const aliases = value.aliases as unknown[]
    if (
      aliases.some((alias) => typeof alias !== 'string' || !allowedAliases.has(alias)) ||
      new Set(aliases).size !== aliases.length
    ) {
      throw new Error('Unexpected aliases in build plan.')
    }
    const actual = { ...expected, aliases: aliases as string[] }
    for (const key of Object.keys(actual) as (keyof Build)[]) {
      if (JSON.stringify(value[key]) !== JSON.stringify(actual[key]))
        throw new Error(`Invalid ${key} in build plan.`)
    }
    builds.push(actual)
  }
  assertUniqueTags(builds)
  return { include: builds }
}
