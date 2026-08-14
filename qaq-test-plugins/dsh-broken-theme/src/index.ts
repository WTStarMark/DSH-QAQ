/**
 * dsh-broken-theme host half: intentionally minimal. It exists so the row is a
 * resolvable host entry and its package.json dsh.client declaration is scanned
 * into window.__DSH_BOOT__. The red screen is caused entirely by the client
 * half's fiber inject.
 */
import type { Context } from '@deepseek-ai/cordis'
export const name = 'broken-theme'
export function apply(_ctx: Context): void {
  // Intentionally empty.
}
