import { useEffect, useState } from "react"
import { DEFAULT_FILE, DEFAULT_FOLDER, DEFAULT_FOLDER_OPENED, getIconForFile, getIconForFolder, getIconForOpenFolder } from "vscode-icons-js"

/** One icon as the build wrote it: a viewBox and the markup inside the `<svg>`. */
export interface FileIconAsset {
  viewBox: string
  body: string
}

export type FileIconSet = Record<string, FileIconAsset>

/**
 * The vscode-icons artwork, fetched once from the renderer's own origin.
 *
 * The build writes `file-icons.json` beside the bundle rather than into it:
 * two megabytes of path data would otherwise sit in the module graph and be
 * parsed before the first frame, for a rail that may never be opened.
 *
 * The promise is kept rather than the set: every surface that draws a file
 * glyph shares one fetch and one parse of those two megabytes, and a caller
 * that arrives while the first is still in flight waits on it instead of
 * starting a second.
 */
let pending: Promise<FileIconSet> | undefined

const loadFileIcons = (): Promise<FileIconSet> => (pending ??= fetchFileIcons())

const fetchFileIcons = async (): Promise<FileIconSet> => {
  const response = await fetch("/file-icons.json")
  if (!response.ok) throw new Error(`file icons: ${String(response.status)}`)
  return (await response.json()) as FileIconSet
}

/**
 * Which icon a row shows, by the extension's own tables.
 *
 * The tables answer in the extension's file names (`file_type_typescript.svg`);
 * the build stored the artwork under Iconify's (`file-type-typescript`), so the
 * name is converted here the same way it was there.
 */
export const fileIconName = (entry: { name: string; kind: "file" | "directory" }, open: boolean): string =>
  toIconifyName(entry.kind === "directory" ? (open ? getIconForOpenFolder(entry.name) : getIconForFolder(entry.name)) : getIconForFile(entry.name) ?? DEFAULT_FILE)

/**
 * The icon for a row, or the kind's default when the set lacks the one the
 * tables named — a handful of the extension's icons never reached the Iconify
 * set. `undefined` only while the set has not loaded.
 */
export const pickFileIcon = (icons: FileIconSet, entry: { name: string; kind: "file" | "directory" }, open: boolean): FileIconAsset | undefined =>
  icons[fileIconName(entry, open)] ?? icons[toIconifyName(entry.kind === "directory" ? (open ? DEFAULT_FOLDER_OPENED : DEFAULT_FOLDER) : DEFAULT_FILE)]

const toIconifyName = (fileName: string): string => fileName.replace(/\.svg$/, "").replace(/_/g, "-")

/**
 * The set, for a component that draws glyphs.
 *
 * Four surfaces want it and each wrote the same effect: the mount-race guard,
 * and the failure policy — a rail that cannot fetch the artwork draws its rows
 * without icons rather than drawing no rows. Both are decisions rather than
 * boilerplate, so they are made once, here, beside the fetch they belong to.
 * The empty set before it resolves is the one `pickFileIcon` already answers
 * `undefined` for.
 */
export const useFileIcons = (): FileIconSet => {
  const [icons, setIcons] = useState<FileIconSet>({})
  useEffect(() => {
    let live = true
    void loadFileIcons().then((set) => { if (live) setIcons(set) }).catch(() => {})
    return () => { live = false }
  }, [])
  return icons
}
