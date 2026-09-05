import { CodeBlock, TokenRun } from "./CodeBlock.tsx"

/**
 * A fenced listing in prose. The thinking-step code-block owns the frame;
 * markdown just names the language.
 */
export const Code = ({ text, language }: { text: string; language: string | undefined }): React.JSX.Element => (
  <CodeBlock
    variant="code"
    text={text}
    {...(language === undefined ? {} : { filename: language, language })}
  />
)

export { TokenRun }
