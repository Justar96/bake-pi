import * as stylex from "@stylexjs/stylex"
import type { FileIconAsset } from "./file-icons.ts"

/**
 * One vscode-icons glyph, shared by the tree, the prompt's file menu, and
 * conversation listings.
 *
 * The body is build-owned path data rather than workspace or model content.
 * Before it loads, the same-size empty slot keeps surrounding text still.
 */
export const FileIcon = ({ icon }: { icon: FileIconAsset | undefined }): React.JSX.Element =>
  icon === undefined ? (
    <span aria-hidden="true" {...stylex.props(styles.icon)} />
  ) : (
    <svg aria-hidden="true" viewBox={icon.viewBox} dangerouslySetInnerHTML={{ __html: icon.body }} {...stylex.props(styles.icon)} />
  )

const styles = stylex.create({
  icon: { flex: "none", width: 16, height: 16 },
})
