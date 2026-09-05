/**
 * Private drag payload shared by the workspace tree and the composer.
 *
 * A custom type keeps operating-system files and arbitrary page text out of
 * this path: only a row the tree produced can ask the composer to make a
 * workspace mention. The value is the absolute path that came from the host's
 * directory listing; the composer is responsible for presenting it relative
 * to the workspace.
 */
export const WORKSPACE_FILE_DRAG_TYPE = "application/x-bake-pi-workspace-file"

export const hasWorkspaceFileDrag = (types: readonly string[]): boolean =>
  types.includes(WORKSPACE_FILE_DRAG_TYPE)
