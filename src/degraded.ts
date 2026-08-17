/**
 * qaq-degraded — non-red-screen degradation signals the DOM probe cannot see.
 *
 * The L3 detector reads the real DOM and flags the pinned "Failed to load
 * plugins" red screen. But a UI can render healthy (composer present) while
 * individual ENABLED plugins sit in a FAILED Cordis fiber — a degraded boot
 * that no DOM probe ever catches. The in-process dsh-qaq plugin already pushes
 * the authoritative loader inventory (plugin-inventory.json) with each entry's
 * `enabled` and `fiberPhase`, so this module turns that into an advisory
 * signal: it never counts toward a rollback on its own (a failed fiber may be
 * an irrelevant secondary plugin), it is logged + pushed as an event so an
 * operator sees the degradation.
 */
import { readPluginInventory } from './shared-io.ts'

/** One enabled plugin whose Cordis fiber ended in the failed state. */
export interface DegradedEntry {
  /** Package name (moduleName) or entry id when unnamed. */
  name: string
  entryId: string
  fiberPhase?: string | null
}

/** Enabled plugins in a failed fiber state, from the live dsh-qaq inventory. */
export function detectFailedFibers(home: string): DegradedEntry[] {
  const inv = readPluginInventory(home)
  if (!inv?.entries) return []
  return inv.entries
    .filter((e) => e.enabled && e.fiberPhase === 'failed')
    .map((e) => ({ name: e.moduleName ?? e.entryId, entryId: e.entryId, fiberPhase: e.fiberPhase }))
}
