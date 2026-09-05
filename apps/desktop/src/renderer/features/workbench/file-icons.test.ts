import { describe, expect, test } from "bun:test"
import { fileIconName, pickFileIcon, type FileIconSet } from "./file-icons.ts"

const asset = (name: string) => ({ viewBox: "0 0 32 32", body: `<path id="${name}"/>` })

describe("fileIconName", () => {
  test("names a file's icon by its extension, in Iconify's form", () => {
    expect(fileIconName({ name: "FileRail.tsx", kind: "file" }, false)).toBe("file-type-reactts")
    expect(fileIconName({ name: "package.json", kind: "file" }, false)).toBe("file-type-npm")
    expect(fileIconName({ name: "bash", kind: "file" }, false)).toBe("file-type-shell")
  })

  test("falls back to the default file icon for an unknown extension or none", () => {
    expect(fileIconName({ name: "notes.zzz", kind: "file" }, false)).toBe("default-file")
    expect(fileIconName({ name: "LICENSE-ish", kind: "file" }, false)).toBe("default-file")
  })

  test("tells an open folder from a closed one", () => {
    expect(fileIconName({ name: "src", kind: "directory" }, false)).toBe("folder-type-src")
    expect(fileIconName({ name: "src", kind: "directory" }, true)).toBe("folder-type-src-opened")
    expect(fileIconName({ name: "whatever", kind: "directory" }, true)).toBe("default-folder-opened")
  })
})

describe("pickFileIcon", () => {
  const icons: FileIconSet = {
    "default-file": asset("default-file"),
    "default-folder": asset("default-folder"),
    "default-folder-opened": asset("default-folder-opened"),
    "file-type-npm": asset("file-type-npm"),
  }

  test("returns the named icon when the set has it", () => {
    expect(pickFileIcon(icons, { name: "package.json", kind: "file" }, false)).toBe(icons["file-type-npm"])
  })

  test("returns the kind's default when the set lacks the named icon", () => {
    expect(pickFileIcon(icons, { name: "a.pdf", kind: "file" }, false)).toBe(icons["default-file"])
    expect(pickFileIcon(icons, { name: "src", kind: "directory" }, false)).toBe(icons["default-folder"])
    expect(pickFileIcon(icons, { name: "src", kind: "directory" }, true)).toBe(icons["default-folder-opened"])
  })

  test("returns nothing before the set has loaded", () => {
    expect(pickFileIcon({}, { name: "package.json", kind: "file" }, false)).toBeUndefined()
  })
})
