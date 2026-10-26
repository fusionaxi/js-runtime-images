import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const RUNTIMES = ['node', 'deno'] as const
export type Runtime = (typeof RUNTIMES)[number]
export type Variant = 'alpine' | 'alpine-git' | 'debian' | 'slim'
export const VARIANTS: Record<Runtime, readonly Variant[]> = {
  node: ['alpine', 'alpine-git', 'debian', 'slim'],
  deno: ['alpine', 'debian']
}

export interface ImageConfig {
  name: string
  variants: Variant[]
  defaultVariant: Variant
}

export interface Config {
  namespace: string
  source: string
  platforms: string[]
  images: Record<Runtime, ImageConfig>
}

/** Narrow a value to a non-null object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate image names, runtime variants, platforms, and repository settings. */
export function parseConfig(value: unknown): Config {
  if (!isRecord(value)) throw new Error('Configuration must be an object.')
  if (
    typeof value.namespace !== 'string' ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value.namespace)
  ) {
    throw new Error('namespace must be a Docker Hub namespace, e.g. fusionaxi.')
  }
  if (
    typeof value.source !== 'string' ||
    !URL.canParse(value.source) ||
    new URL(value.source).protocol !== 'https:'
  ) {
    throw new Error('source must be an HTTPS repository URL.')
  }
  if (
    !Array.isArray(value.platforms) ||
    value.platforms.length === 0 ||
    value.platforms.some((platform) => !['linux/amd64', 'linux/arm64'].includes(platform)) ||
    new Set(value.platforms).size !== value.platforms.length
  ) {
    throw new Error('platforms must contain unique linux/amd64 or linux/arm64 entries.')
  }
  if (!isRecord(value.images)) throw new Error('images must define node and deno.')
  for (const runtime of RUNTIMES) {
    const image = value.images[runtime]
    if (
      !isRecord(image) ||
      typeof image.name !== 'string' ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(image.name)
    ) {
      throw new Error(`Invalid ${runtime} image name.`)
    }
    if (
      !Array.isArray(image.variants) ||
      image.variants.length === 0 ||
      image.variants.some((variant) => !VARIANTS[runtime].includes(variant)) ||
      new Set(image.variants).size !== image.variants.length
    ) {
      throw new Error(`Invalid or duplicate variants for ${runtime}.`)
    }
    if (!image.variants.includes(image.defaultVariant)) {
      throw new Error(`defaultVariant must be enabled for ${runtime}.`)
    }
  }
  const node = value.images.node as Record<string, unknown>
  const deno = value.images.deno as Record<string, unknown>
  if (node.name === deno.name) throw new Error('Image names must be distinct.')
  return value as unknown as Config
}

/** Read and validate runtime-images.json from the project root. */
export async function loadConfig(): Promise<Config> {
  return parseConfig(await Bun.file(new URL('../runtime-images.json', import.meta.url)).json())
}
