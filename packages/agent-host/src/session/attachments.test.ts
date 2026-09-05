import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_TOTAL_ATTACHMENT_BYTES, processAttachments, promptWithAttachments } from "./attachments.ts"

const temporary: string[] = []
const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bakepi-attachments-"))
  temporary.push(root)
  return root
}

describe("prompt attachments", () => {
  test("an in-workspace text file reaches Pi in the same file block shape as the CLI", async () => {
    const root = workspace()
    const path = join(root, "notes & plan.txt")
    writeFileSync(path, "\ufefffirst\nsecond", "utf8")

    const processed = await processAttachments(root, [
      { path, mediaType: "text/plain", bytes: Buffer.byteLength("\ufefffirst\nsecond") },
    ])

    expect(processed.images).toEqual([])
    expect(promptWithAttachments("question", processed)).toContain(
      `<file name="${realpathSync.native(path).replace("&", "&amp;")}">\nfirst\nsecond\n</file>\n\nquestion`,
    )
  })

  test("a path outside the workspace is refused before its bytes are read", async () => {
    const root = workspace()
    const outside = join(workspace(), "secret.txt")
    writeFileSync(outside, "secret")

    await expect(
      processAttachments(root, [{ path: outside, mediaType: "text/plain", bytes: 6 }]),
    ).rejects.toMatchObject({ code: "path_outside_workspace" })
  })

  test("a changed file and an oversized aggregate are refused", async () => {
    const root = workspace()
    const path = join(root, "changed.txt")
    writeFileSync(path, "changed")
    await expect(
      processAttachments(root, [{ path, mediaType: "text/plain", bytes: 1 }]),
    ).rejects.toMatchObject({ code: "malformed_command", detail: "attachment_changed" })

    const first = join(root, "first.txt")
    const second = join(root, "second.txt")
    const half = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 2) + 1
    writeFileSync(first, Buffer.alloc(half, "a"))
    writeFileSync(second, Buffer.alloc(half, "b"))
    await expect(
      processAttachments(root, [
        { path: first, mediaType: "text/plain", bytes: half },
        { path: second, mediaType: "text/plain", bytes: half },
      ]),
    ).rejects.toMatchObject({ code: "payload_too_large", detail: "attachments" })
  })

  test("a supported image is resized into Pi's prompt image shape", async () => {
    const root = workspace()
    const path = join(root, "pixel.png")
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )
    writeFileSync(path, png)

    const processed = await processAttachments(root, [{ path, mediaType: "image/png", bytes: png.byteLength }])

    expect(processed.images).toHaveLength(1)
    expect(processed.images[0]).toMatchObject({ type: "image", mimeType: expect.stringMatching(/^image\//) })
    expect(processed.images[0]?.data.length).toBeGreaterThan(0)
  })
})

process.on("exit", () => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})
