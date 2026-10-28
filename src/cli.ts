#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadConfig, RUNTIMES, VARIANTS, type Runtime, type Variant } from './config.ts'
import { resolveVersions, type GetJSON } from './versions.ts'
import { createPlan, parsePlan, type Plan } from './matrix.ts'
import {
  buildImage,
  promote,
  releaseImage,
  recordRelease,
  type Capture,
  type Run
} from './docker.ts'
import { containerExecutable } from './container.ts'

const HELP = `FusionAxi runtime images (Bun required)

  bun run images matrix [--runtime node|deno] [--variant VARIANT] [--output FILE]
  bun run images build --runtime node|deno --variant VARIANT [--push] [--platform PLATFORM]
  bun run images build --plan FILE --id ID [--push] [--metadata FILE]
  bun run images release --plan FILE --id ID --metadata FILE [--force-rebuild]
  bun run images promote --plan FILE --results DIRECTORY [--output FILE]

  --container-executable docker|podman
    Command to start the container engine (docker or podman).
    Defaults to CONTAINER_EXECUTABLE, or docker when unset.

Version overrides: --bun X.Y.Z, --node X.Y.Z, --deno X.Y.Z (stable releases only).
Without overrides, versions come from the official release feeds.
Builds load locally unless --push is explicitly set. Only promote updates floating tags.
`

export function parseCLI(args: string[]) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      runtime: { type: 'string' },
      variant: { type: 'string' },
      bun: { type: 'string' },
      node: { type: 'string' },
      deno: { type: 'string' },
      output: { type: 'string' },
      plan: { type: 'string' },
      id: { type: 'string' },
      platform: { type: 'string' },
      metadata: { type: 'string' },
      results: { type: 'string' },
      push: { type: 'boolean', default: false },
      'force-rebuild': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      'container-executable': { type: 'string' }
    }
  })
  const { values, positionals } = parsed
  if (values.help) return { command: 'help', values }
  const command = positionals[0] ?? 'help'
  if (positionals.length > 1) throw new Error('Expected a single command.')
  if (!['help', 'matrix', 'build', 'promote', 'release'].includes(command))
    throw new Error(`Unknown command: ${command}`)
  if (values['container-executable'] !== undefined)
    containerExecutable(values['container-executable'])
  if (values.runtime && !RUNTIMES.includes(values.runtime as Runtime))
    throw new Error('--runtime must be node or deno.')
  if (
    values.variant &&
    !Object.values(VARIANTS).some((variants) => variants.includes(values.variant as Variant))
  ) {
    throw new Error('Unknown --variant. Use alpine, alpine-git, debian, or slim.')
  }
  if ((values.node && values.runtime === 'deno') || (values.deno && values.runtime === 'node')) {
    throw new Error('Version override does not match --runtime.')
  }
  if (
    values.plan &&
    (values.runtime || values.variant || values.bun || values.node || values.deno)
  ) {
    throw new Error('--plan cannot be combined with runtime, variant, or version overrides.')
  }
  if (command === 'promote' && (!values.plan || !values.results))
    throw new Error('promote requires --plan and --results.')
  if (command === 'build' && values.plan && !values.id)
    throw new Error('Building from a plan requires --id.')
  if (command === 'build' && !values.plan && (!values.runtime || !values.variant)) {
    throw new Error('build requires --runtime and --variant, or --plan and --id.')
  }
  if (command === 'release' && (!values.plan || !values.id || !values.metadata))
    throw new Error('release requires --plan, --id, and --metadata.')
  if (
    command === 'release' &&
    values['container-executable'] &&
    values['container-executable'] !== 'docker'
  )
    throw new Error('release requires Docker.')
  const allowed: Record<string, string[]> = {
    help: ['help'],
    matrix: ['runtime', 'variant', 'bun', 'node', 'deno', 'output', 'help'],
    build: [
      'runtime',
      'variant',
      'bun',
      'node',
      'deno',
      'plan',
      'id',
      'push',
      'platform',
      'metadata',
      'help',
      'container-executable'
    ],
    release: ['plan', 'id', 'metadata', 'force-rebuild', 'help', 'container-executable'],
    promote: ['plan', 'results', 'output', 'help', 'container-executable']
  }
  for (const key of Object.keys(values)) {
    if (key === 'push' && !values.push) continue
    if (!allowed[command]!.includes(key)) throw new Error(`--${key} is not valid for ${command}.`)
  }
  if (values.id && !values.plan) throw new Error('--id requires --plan.')
  return { command, values }
}

export interface CLIServices {
  inspect?: Capture
  execute?: Run
  getJSON?: GetJSON
  now?: Date
  log?: (message: string) => void
}

export async function main(args = Bun.argv.slice(2), services: CLIServices = {}): Promise<void> {
  const log = services.log ?? console.log
  const { command, values } = parseCLI(args)
  if (values.help || command === 'help') {
    log(HELP)
    return
  }
  const executable =
    command === 'matrix' ? undefined : containerExecutable(values['container-executable'])
  const config = await loadConfig()
  let plan: Plan
  if (values.plan) {
    plan = parsePlan(await Bun.file(values.plan).json(), config)
  } else {
    const options = {
      ...values,
      runtime: values.runtime as Runtime | undefined,
      variant: values.variant as Variant | undefined
    }
    const versions = await resolveVersions(options, services.getJSON, services.now)
    if (command === 'build' && options.runtime) {
      versions[options.runtime] = versions[options.runtime].filter((release) => release.default)
    }
    plan = createPlan(config, versions, options)
  }
  if (command === 'matrix') {
    if (values.output) {
      await mkdir(dirname(values.output), { recursive: true })
      await Bun.write(values.output, `${JSON.stringify(plan, null, 2)}\n`)
    }
    log(JSON.stringify(plan))
    return
  }
  if (command === 'promote') {
    await promote(plan, values.results!, services.execute, executable)
    if (values.output) await recordRelease(plan, values.results!, values.output)
    return
  }
  const build = values.id ? plan.include.find((entry) => entry.id === values.id) : plan.include[0]
  if (!build || (!values.id && plan.include.length !== 1))
    throw new Error('Select exactly one build using --id or an exact runtime version.')
  if (command === 'release') {
    if (executable !== 'docker') throw new Error('release requires Docker.')
    await releaseImage(
      build,
      values.metadata!,
      values['force-rebuild'],
      services.execute,
      services.inspect
    )
    return
  }
  await buildImage(
    build,
    {
      push: values.push,
      platform: values.platform,
      metadata: values.metadata,
      containerExecutable: executable
    },
    services.execute
  )
  log(`Built ${build.image}`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
