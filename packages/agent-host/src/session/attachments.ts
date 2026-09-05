import { readFile, stat } from "node:fs/promises"
import type { CommandParams } from "@bake-pi/contract"
import { BakePiError } from "@bake-pi/contract"
import {
  detectSupportedImageMimeTypeFromFile,
  resizeImage,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent"
import { canonicalize, isInside } from "../policy/paths.ts"

type Attachment = CommandParams<"prompt">["attachments"][number]
type PromptImage = NonNullable<PromptOptions["images"]>[number]

/** Bound the real reads, not the renderer's claims. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 20_971_520

export interface ProcessedAttachments {
  text: string
  images: PromptImage[]
}

/**
 * Reads renderer-referenced attachments into the two inputs Pi accepts.
 *
 * This intentionally mirrors Pi CLI semantics without reaching through a deep
 * import the package does not export: image files become `PromptOptions.images`
 * and other files become `<file>` blocks ahead of the user's text. Every path
 * is canonicalized first, so a symlink cannot turn an apparently in-workspace
 * attachment into arbitrary host-file disclosure to a provider.
 */
export const processAttachments = async (
  workspaceRoot: string,
  attachments: readonly Attachment[],
): Promise<ProcessedAttachments> => {
  const root = canonicalize(workspaceRoot)
  const images: PromptImage[] = []
  let text = ""
  let totalBytes = 0

  for (const attachment of attachments) {
    const path = canonicalize(attachment.path)
    if (!isInside(root, path)) {
      throw new BakePiError("path_outside_workspace", { detail: path })
    }

    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch (error) {
      throw new BakePiError("resource_not_found", { detail: path, cause: error })
    }
    if (!info.isFile()) throw new BakePiError("resource_not_found", { detail: path })
    if (info.size !== attachment.bytes) {
      throw new BakePiError("malformed_command", { detail: "attachment_changed" })
    }
    totalBytes += info.size
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new BakePiError("payload_too_large", { detail: "attachments" })
    }
    if (info.size === 0) continue

    const imageMime = await detectSupportedImageMimeTypeFromFile(path)
    if (imageMime !== null) {
      if (!sameImageMime(attachment.mediaType, imageMime)) {
        throw new BakePiError("malformed_command", { detail: "attachment_media_type" })
      }
      const resized = await resizeImage(await readFile(path), imageMime)
      if (resized === null) throw new BakePiError("malformed_command", { detail: "attachment_image" })
      images.push({ type: "image", data: resized.data, mimeType: resized.mimeType })
      text += `<file name="${xmlAttribute(path)}"></file>\n`
      continue
    }

    if (attachment.mediaType.toLowerCase().startsWith("image/")) {
      throw new BakePiError("malformed_command", { detail: "attachment_media_type" })
    }
    let content: string
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path))
    } catch (error) {
      throw new BakePiError("malformed_command", { detail: "attachment_text", cause: error })
    }
    if (content.includes("\0")) throw new BakePiError("malformed_command", { detail: "attachment_text" })
    content = stripBom(content)
    text += `<file name="${xmlAttribute(path)}">\n${content}\n</file>\n`
  }

  return { text, images }
}

export const promptWithAttachments = (prompt: string, attachments: ProcessedAttachments): string =>
  attachments.text.length === 0 ? prompt : `${attachments.text}\n${prompt}`

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

const xmlAttribute = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const sameImageMime = (declared: string, detected: string): boolean => {
  const normalized = declared.split(";", 1)[0]?.trim().toLowerCase()
  return normalized === detected || (normalized === "image/jpg" && detected === "image/jpeg")
}
