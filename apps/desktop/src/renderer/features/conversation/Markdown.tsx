import * as stylex from "@stylexjs/stylex"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { colors, effects, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { scrollbars } from "../../theme/scrollbars.ts"
import { canRenderMarkdownAsPlainText, markdownDisallowedElements, markdownLinkProps, safeMarkdownUrl } from "./markdown-policy.ts"
import { Code } from "./Code.tsx"

export const Markdown = ({ text }: { text: string }): React.JSX.Element => (
  <div {...stylex.props(styles.root)}>
    {canRenderMarkdownAsPlainText(text) ? (
      <p {...stylex.props(styles.paragraph)}>{text}</p>
    ) : (
      <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      urlTransform={safeMarkdownUrl}
      disallowedElements={markdownDisallowedElements}
      components={{
        a: ({ children, href }) => (
          <a href={href} {...markdownLinkProps} {...stylex.props(focus.ring, styles.link)}>{children}</a>
        ),
        p: ({ children }) => <p {...stylex.props(styles.paragraph)}>{children}</p>,
        h1: ({ children }) => <h2 {...stylex.props(styles.heading)}>{children}</h2>,
        h2: ({ children }) => <h3 {...stylex.props(styles.subheading)}>{children}</h3>,
        h3: ({ children }) => <h4 {...stylex.props(styles.subheading)}>{children}</h4>,
        ul: ({ children }) => <ul {...stylex.props(styles.list)}>{children}</ul>,
        ol: ({ children }) => <ol {...stylex.props(styles.list)}>{children}</ol>,
        blockquote: ({ children }) => <blockquote {...stylex.props(styles.quote)}>{children}</blockquote>,
        // `pre` renders its child `code` directly. react-markdown nests the
        // two, but the highlighted block owns both the frame and the text, and
        // a `pre` inside a `pre` would double the padding and the border.
        pre: ({ children }) => <>{children}</>,
        code: ({ children, className }) =>
          className === undefined
            ? <code {...stylex.props(styles.inlineCode)}>{children}</code>
            : <Code text={String(children).replace(/\n$/, "")} language={/language-(\S+)/.exec(className)?.[1]} />,
        table: ({ children }) => <div {...stylex.props(scrollbars.thin, styles.tableScroll)}><table {...stylex.props(styles.table)}>{children}</table></div>,
        // Rows are striped rather than ruled. The `cell` hairline below is
        // zero everywhere but high contrast, so without a fill the columns of a
        // table would run together — and a fill reads at a glance in a way a
        // one-pixel line at this size does not.
        tr: ({ children }) => <tr {...stylex.props(styles.row)}>{children}</tr>,
        th: ({ children }) => <th {...stylex.props(styles.cell, styles.headerCell)}>{children}</th>,
        td: ({ children }) => <td {...stylex.props(styles.cell)}>{children}</td>,
      }}
    >
      {text}
      </ReactMarkdown>
    )}
  </div>
)

const styles = stylex.create({
  root: { color: colors.text, overflowWrap: "anywhere", minWidth: 0 },
  /**
   * Prose stops at the reading measure; code, tables and diffs do not.
   *
   * The column the conversation sits in is sized for a diff, which is roughly
   * ninety characters of body text — comfortably past where a line stops being
   * easy to return from. Capping the paragraph rather than the column is what
   * lets both be right: a patch keeps every column it needs, and a sentence
   * still ends where the eye expects it to.
   */
  paragraph: { maxWidth: size.measure, marginBlockStart: 0, marginBlockEnd: space.md },
  heading: { marginBlockStart: space.xl, marginBlockEnd: space.md, fontFamily: typography.display, fontSize: typography.title, lineHeight: typography.titleLine, fontWeight: 400, letterSpacing: "-0.008em" },
  subheading: { marginBlockStart: space.lg, marginBlockEnd: space.sm, fontFamily: typography.display, fontSize: typography.subtitle, lineHeight: typography.subtitleLine, fontWeight: 400 },
  list: { maxWidth: size.measure, marginBlock: space.md, paddingInlineStart: space.xl },
  /**
   * A link is body text with a rule under it, not text in another colour.
   *
   * The accent is grey now — the top of the same ladder the body sits on — so
   * colouring a link with it makes it *dimmer* than the paragraph around it,
   * which is the opposite of what a link should say. The underline carries the
   * whole signal instead, drawn in `textFaint` so it reads as an affordance
   * rather than as an underscore, and the hover brightens past body text.
   */
  link: {
    color: { default: colors.text, ":hover": colors.accentHover },
    textDecorationColor: { default: colors.textFaint, ":hover": colors.accentHover },
    textUnderlineOffset: "3px",
    outline: "none",
    borderRadius: radius.sm,
  },
  /**
   * A recess rather than a rule. Every other aside in this interface is told
   * apart from its substrate by a fill, and a quote drawing the one vertical
   * line in the conversation made it read as the only bordered thing on the
   * screen rather than as the quieter passage it is.
   */
  quote: { maxWidth: size.measure, marginInline: 0, marginBlock: space.md, padding: space.md, color: colors.textMuted, backgroundColor: colors.canvasSubtle, borderRadius: radius.md },
  inlineCode: { fontFamily: typography.mono, fontSize: "0.9em", paddingBlock: "2px", paddingInline: space.xs, backgroundColor: colors.sunken, borderRadius: radius.sm },
  tableScroll: { overflowX: "auto", marginBlock: space.md },
  table: { width: "100%", borderCollapse: "collapse", fontSize: typography.caption },
  row: { backgroundColor: { default: "transparent", ":nth-child(even)": colors.canvasSubtle } },
  cell: { padding: space.sm, borderBottomWidth: effects.hairline, borderBottomStyle: "solid", borderBottomColor: colors.border, textAlign: "start" },
  headerCell: { color: colors.textMuted, fontWeight: 600 },
})
