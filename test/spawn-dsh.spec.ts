/**
 * spawn-dsh readiness regression tests (real child processes):
 *  - a child that exits before the port opens must reject `ready` immediately
 *    (previously it silently waited out the full port timeout);
 *  - a spawn failure (missing command) must reject `ready` instead of hanging.
 */
import { describe, it, expect } from 'vitest'
import { spawnDsh } from '../src/spawn-dsh.ts'

describe('spawn-dsh readiness', () => {
  it('rejects early when the child exits before the port opens', async () => {
    const sup = spawnDsh({ command: ['node', '-e', 'process.exit(3)'], cwd: '.', port: 39990, portTimeoutMs: 10000 })
    await expect(sup.ready).rejects.toThrow(/exited before ready/)
    // The exit promise must also resolve with the real code.
    await expect(sup.exit).resolves.toBe(3)
  })

  it('rejects on a missing command (spawn error) without waiting the full timeout', async () => {
    const sup = spawnDsh({ command: ['definitely-not-a-real-command-xyz'], cwd: '.', port: 39991, portTimeoutMs: 10000 })
    await expect(sup.ready).rejects.toThrow(/failed to spawn/)
  })
})
