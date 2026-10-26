export const CONTAINER_EXECUTABLES = ['docker', 'podman'] as const
export type ContainerExecutable = (typeof CONTAINER_EXECUTABLES)[number]

/** Resolve the container engine from an explicit value, environment, or Docker default. */
export function containerExecutable(
  value: unknown = Bun.env.CONTAINER_EXECUTABLE ?? 'docker'
): ContainerExecutable {
  if (value !== 'docker' && value !== 'podman') {
    throw new Error('--container-executable must be docker or podman.')
  }
  return value
}

/** Qualify Podman image references to avoid interactive short-name resolution. */
export function containerImage(image: string, executable: ContainerExecutable): string {
  if (executable === 'docker' || image.startsWith('docker.io/')) return image
  return `docker.io/${image.includes('/') ? '' : 'library/'}${image}`
}
