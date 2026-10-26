import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../../src/config.ts'
import { config } from './fixtures.ts'

describe('project configuration', () => {
  test('uses distinct FusionAxi image repositories', () => {
    expect(parseConfig(config).namespace).toBe('fusionaxi')
    expect(config.images.node.name).toBe('bun-node')
    expect(config.images.deno.name).toBe('bun-deno')
  })

  test.each([null, [], 'config'].map((input) => ({ input })))(
    'rejects nonobjects: %j',
    ({ input }) => {
      expect(() => parseConfig(input)).toThrow('object')
    }
  )

  test.each(['FusionAxi', 'fusionaxi/name', 'fusionaxi;echo bad', ''])(
    'rejects namespace %s',
    (namespace) => {
      expect(() => parseConfig({ ...config, namespace })).toThrow('namespace')
    }
  )

  test.each(
    [[], ['linux/arm/v7'], ['linux/amd64', 'linux/amd64']].map((platforms) => ({ platforms }))
  )('rejects invalid platforms: %j', ({ platforms }) => {
    expect(() => parseConfig({ ...config, platforms })).toThrow('platforms')
  })

  test('requires a secure source URL', () => {
    expect(() => parseConfig({ ...config, source: 'http://example.com' })).toThrow('HTTPS')
  })

  test('rejects unsupported distro combinations', () => {
    const modified = structuredClone(config)
    modified.images.deno.variants.push('slim')
    expect(() => parseConfig(modified)).toThrow('variants')
  })

  test('requires an enabled default variant', () => {
    const modified = structuredClone(config)
    modified.images.node.defaultVariant = 'alpine'
    modified.images.node.variants = ['slim']
    expect(() => parseConfig(modified)).toThrow('defaultVariant')
  })

  test('rejects overlapping repository names', () => {
    const modified = structuredClone(config)
    modified.images.deno.name = modified.images.node.name
    expect(() => parseConfig(modified)).toThrow('distinct')
  })

  test.each([null, [], 'images'].map((images) => ({ images })))(
    'requires an image catalog: %j',
    ({ images }) => {
      expect(() => parseConfig({ ...config, images })).toThrow('images must define')
    }
  )

  test.each([undefined, null, { name: 'invalid/name' }].map((node) => ({ node })))(
    'rejects missing or malformed image definitions: %j',
    ({ node }) => {
      expect(() => parseConfig({ ...config, images: { ...config.images, node } })).toThrow(
        'Invalid node image name'
      )
    }
  )

  test('rejects duplicate variants', () => {
    const modified = structuredClone(config)
    modified.images.node.variants = ['slim', 'slim']
    expect(() => parseConfig(modified)).toThrow('duplicate variants')
  })
})
