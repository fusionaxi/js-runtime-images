import { loadConfig } from '../../src/config.ts'
import type { Versions } from '../../src/versions.ts'

export const config = await loadConfig()
export const versions: Versions = {
  bun: '1.4.3',
  node: [
    { version: '26.0.0', default: false },
    { version: '24.11.1', default: true },
    { version: '22.21.1', default: false }
  ],
  deno: [{ version: '2.5.4', default: true }]
}

export const nodeIndex = [
  { version: 'v24.9.0', date: '2026-01-01', lts: 'Krypton', files: [] },
  { version: 'v22.21.1', date: '2026-01-01', lts: 'Jod', files: [] },
  { version: 'v24.11.1', date: '2026-02-01', lts: 'Krypton', files: [] },
  { version: 'v26.0.0', date: '2026-05-05', lts: false, files: [] },
  { version: 'v20.19.5', date: '2026-01-01', lts: 'Iron', files: [] },
  { version: 'v27.0.0', date: '2027-04-22', lts: false, files: [] }
]
export const schedule = {
  v20: { start: '2023-04-18', lts: '2023-10-24', maintenance: '2024-10-22', end: '2026-04-30' },
  v22: { start: '2024-04-24', lts: '2024-10-29', maintenance: '2025-10-21', end: '2027-04-30' },
  v24: { start: '2025-05-06', lts: '2025-10-28', maintenance: '2026-10-20', end: '2028-04-30' },
  v26: { start: '2026-05-05', lts: '2026-10-28', maintenance: '2027-10-20', end: '2029-04-30' },
  v27: { start: '2027-04-22', end: '2030-04-30' }
}
