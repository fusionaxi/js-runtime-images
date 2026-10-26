import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ROOT } from './config.ts'

// Check both the requested path and each existing ancestor before creating files.
export async function outputPath(path: string): Promise<string> {
  const root = await realpath(ROOT)
  const target = resolve(ROOT, path)
  const contained = (candidate: string) => {
    const suffix = relative(root, candidate)
    return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  }
  if (!contained(target)) throw new Error('Output path must be inside the project directory.')
  let ancestor = target
  while (ancestor !== root) {
    try {
      const info = await lstat(ancestor)
      if (info.isSymbolicLink()) throw new Error('Output path must not contain symbolic links.')
      if (ancestor !== target && !info.isDirectory())
        throw new Error('Output parent must be a directory.')
      if (ancestor === target && !info.isFile()) throw new Error('Output must be a regular file.')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    ancestor = dirname(ancestor)
  }
  return target
}
