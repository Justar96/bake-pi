import { join } from "node:path"
import { repoRoot } from "./shared.ts"
import { FileExtensions1ToIcon } from "vscode-icons-js/dist/generated/FileExtensions1ToIcon.js"
import { FileExtensions2ToIcon } from "vscode-icons-js/dist/generated/FileExtensions2ToIcon.js"
import { FileNamesToIcon } from "vscode-icons-js/dist/generated/FileNamesToIcon.js"
import { FolderNamesToIcon } from "vscode-icons-js/dist/generated/FolderNamesToIcon.js"
import { LanguagesToIcon } from "vscode-icons-js/dist/generated/LanguagesToIcon.js"
import { DEFAULT_FILE, DEFAULT_FOLDER, DEFAULT_FOLDER_OPENED } from "vscode-icons-js"

/** One icon as the renderer draws it: a viewBox and the markup inside the `<svg>`. */
export interface FileIconAsset {
  viewBox: string
  body: string
}

interface IconifyIcon {
  body: string
  width?: number
  height?: number
  left?: number
  top?: number
}

interface IconifySet {
  width?: number
  height?: number
  icons: Record<string, IconifyIcon>
  aliases?: Record<string, { parent: string }>
}

/**
 * The file-type icons of the vscode-icons extension, as one JSON the renderer
 * fetches from its own origin.
 *
 * `vscode-icons-js` carries the extension's name → icon tables but none of its
 * artwork; `@iconify-json/vscode-icons` carries the artwork for the whole set,
 * 1.6k icons of which the tables can only ever name 677. Both are build
 * dependencies: what follows the bundle is the intersection, with the light
 * theme variants and everything else unreachable left behind.
 *
 * Every `style="…"` attribute is stripped. The renderer injects an icon's body
 * through `innerHTML`, so the parser creates its attributes and `style-src`
 * judges them — and the policy carries no `'unsafe-inline'`. One icon in the
 * set has such an attribute; its presentation attributes say the same thing.
 */
export const buildFileIcons = async (rendererOut: string): Promise<void> => {
  const set = (await Bun.file(join(repoRoot, "node_modules/@iconify-json/vscode-icons/icons.json")).json()) as IconifySet
  const referenced = new Set(
    [
      ...Object.values(FileExtensions1ToIcon),
      ...Object.values(FileExtensions2ToIcon),
      ...Object.values(FileNamesToIcon),
      ...Object.values(FolderNamesToIcon),
      ...Object.values(LanguagesToIcon),
      DEFAULT_FILE,
      DEFAULT_FOLDER,
      DEFAULT_FOLDER_OPENED,
    ].map(toIconifyName),
  )

  const icons: Record<string, FileIconAsset> = {}
  for (const name of referenced) {
    const icon = set.icons[set.aliases?.[name]?.parent ?? name]
    if (icon === undefined) continue
    icons[name] = {
      viewBox: `${String(icon.left ?? 0)} ${String(icon.top ?? 0)} ${String(icon.width ?? set.width ?? 16)} ${String(icon.height ?? set.height ?? 16)}`,
      body: icon.body.replace(/\s+style="[^"]*"/g, ""),
    }
  }

  for (const required of [DEFAULT_FILE, DEFAULT_FOLDER, DEFAULT_FOLDER_OPENED].map(toIconifyName)) {
    if (icons[required] === undefined) throw new Error(`file icons: the set has no "${required}", which every unmapped row falls back to`)
  }

  await Bun.write(join(rendererOut, "file-icons.json"), JSON.stringify(icons))
  // The Iconify package ships no license file, only `info.json` naming one, so
  // the notice that follows the artwork is written from that.
  const info = (await Bun.file(join(repoRoot, "node_modules/@iconify-json/vscode-icons/info.json")).json()) as {
    name: string
    version: string
    author: { name: string; url: string }
    license: { title: string; url: string }
  }
  await Bun.write(
    join(rendererOut, "file-icons-LICENSE.txt"),
    `${info.name} ${info.version} by ${info.author.name} (${info.author.url})
License: ${info.license.title} — ${info.license.url}
Packaged via @iconify-json/vscode-icons; name tables from vscode-icons-js (MIT).
`,
  )
}

/** `file_type_typescript.svg` → `file-type-typescript`, the same icon under Iconify's naming. */
export const toIconifyName = (fileName: string): string => fileName.replace(/\.svg$/, "").replace(/_/g, "-")
