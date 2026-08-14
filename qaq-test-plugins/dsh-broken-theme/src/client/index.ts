import type { Context } from '@deepseek-ai/cordis'
import { BROKEN_SERVICE } from './constants.ts'
/** Deliberately wait on a service no row provides => fiber stays PENDING forever => red screen. */
export const inject = [BROKEN_SERVICE]
export function apply(_ctx: Context): void {
  // Unreachable while the inject is unsatisfied.
}
