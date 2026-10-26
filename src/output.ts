import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ROOT } from './config.ts'
import { dlopen } from 'bun:ffi'
import { closeSync, constants, fstatSync, ftruncateSync, openSync, writeFileSync } from 'node:fs'

// openat/mkdirat keep each lookup relative to an already opened directory.
const native = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  // Darwin arm64 passes openat's variadic mode on the stack (the ninth slot).
  // Other supported ABIs read the fourth slot; supply the mode in both places.
  openat: {
    args: ['i32', 'cstring', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32', 'i32'],
    returns: 'i32'
  },
  mkdirat: { args: ['i32', 'cstring', 'i32'], returns: 'i32' }
}).symbols

/** Write without following a destination or parent symlink, including after validation. */
export async function writeOutput(path: string, data: string | Uint8Array): Promise<void> {
  const target = await outputPath(path)
  const root = await realpath(ROOT)
  const parts = relative(root, target).split(sep)
  const name = parts.pop()!
  let directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  /** Encode a filesystem path component as a null-terminated string for native calls. */
  const cstring = (value: string) => Buffer.from(`${value}\0`)
  try {
    for (const part of parts) {
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      let next = native.openat(directory, cstring(part), flags, 0, 0, 0, 0, 0, 0)
      if (next < 0) {
        // A concurrent creator is safe: the next open still refuses symlinks.
        native.mkdirat(directory, cstring(part), 0o755)
        next = native.openat(directory, cstring(part), flags, 0, 0, 0, 0, 0, 0)
      }
      if (next < 0) throw new Error('Cannot open output parent without symbolic links.')
      closeSync(directory)
      directory = next
    }
    const file = native.openat(
      directory,
      cstring(name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o666,
      0,
      0,
      0,
      0,
      0o666
    )
    if (file < 0) throw new Error('Cannot open output without symbolic links.')
    try {
      if (!fstatSync(file).isFile()) throw new Error('Output must be a regular file.')
      ftruncateSync(file, 0)
      writeFileSync(file, data)
    } finally {
      closeSync(file)
    }
  } finally {
    closeSync(directory)
  }
}

/**
 * Resolve an output file inside the canonical project root.
 * Reject paths outside the project, symbolic links, and incompatible existing file types.
 */
export async function outputPath(path: string): Promise<string> {
  const root = await realpath(ROOT)
  const target = resolve(process.cwd(), path)
  /** Check whether a canonical absolute path is a strict descendant of the project root. */
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
