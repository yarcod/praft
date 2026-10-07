export type PraftBases = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    praft: {
      /** Base ref set by `/praft <base>`, per branch; wins over the draft's `<!-- base: -->` line. */
      bases: PraftBases
      /** Branch shown in the pane; '' follows the checked-out branch. */
      viewing: string
      /** Full SHA of the expanded commit (at most one). */
      expanded: string[]
      /** Bumped when the draft or HEAD may have changed, to redraw an open pane. */
      rev: number
    }
  }
}
