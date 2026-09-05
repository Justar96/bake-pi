export const credentialLifetimeWarning = "Host-lifetime only: Pi’s public API cannot persist this key. Restarting the agent host removes it."

export const errorTitle = (code: string): string => code === "session_busy"
  ? "Session changed elsewhere"
  : code === "session_file_repaired"
    ? "Session recovered"
    : code === "tool_interrupted"
      ? "Tool interrupted"
      : "Bake Pi needs attention"

export const errorBody = (code: string, detail?: string): string => ({
  session_busy: "The Pi CLI or another process appended to this session. Close and reopen it before continuing.",
  session_file_repaired: "Pi discarded an incomplete final JSONL entry and kept the earlier history.",
  tool_interrupted: "The agent host stopped during a tool. Inspect the workspace before trying again.",
  path_outside_workspace: "Attachments must be inside the open workspace.",
  provider_unauthenticated: "Add a key for the selected provider, then retry.",
  host_unavailable: "The agent host is unavailable. Use Restart host to recover.",
}[code] ?? `The operation failed (${code}${detail === undefined ? "" : `: ${detail}`}). Open diagnostics for more context.`)
