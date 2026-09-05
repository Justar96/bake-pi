import { CodeBlock } from "./CodeBlock.tsx"
import { languageForFile } from "./highlight.ts"
import type { DiffFile } from "./diff-model.ts"
import { listingFromDiffFile } from "./tool-present.ts"

/**
 * A parsed patch, drawn through the same listing the code-block uses.
 *
 * Parsing stays in `diff-model.ts`. This file is only the choice to show that
 * parse as a diff rather than as a transcript.
 */
export const Diff = ({ file }: { file: DiffFile }): React.JSX.Element => (
  <CodeBlock
    variant="diff"
    file={file}
    listing={listingFromDiffFile(file)}
    language={languageForFile(file.name)}
  />
)
