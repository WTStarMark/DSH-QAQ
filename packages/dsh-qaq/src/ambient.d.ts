/**
 * Ambient type for the optional @deepseek-ai/cordis peer dependency.
 *
 * The plugin intentionally has ZERO runtime dependencies (it is mounted into a
 * profile via a junction from outside the DSH tree, where @deepseek-ai is not
 * resolvable), so it cannot import the real package even for types. This module
 * declaration is type-only — erased at build — and mirrors just the subset of
 * the cordis Context API the plugin touches (ctx.get@'loader'?.await, and the
 * optional @'webServer'?.port it reads for the heartbeat).
 */
declare module '@deepseek-ai/cordis' {
  export interface Context {
    /** Read an in-process service/key. Returns undefined when absent. */
    get(key: string): any
    /**
     * Register an event listener (mirrors the cordis Context.on overloads the
     * plugin needs for `session/event`, with the `{ global: true }` option so a
     * profile bundle-layer listener observes every session's feed).
     */
    on(
      event: string,
      listener: (...args: any[]) => void,
      options?: { global?: boolean },
    ): () => void
  }
}
