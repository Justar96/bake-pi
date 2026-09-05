import { describe, expect, test } from "bun:test"
import type { Listing } from "../../store/session-store.ts"
import {
  filterListings,
  isGitMetadataDirectory,
  SHOW_IGNORED_BY_DEFAULT,
} from "./file-tree-visibility.ts"
import { hasWorkspaceFileDrag, WORKSPACE_FILE_DRAG_TYPE } from "./file-drag.ts"

const listings: Record<string, Listing> = {
  root: {
    truncated: false,
    entries: [
      { name: "build", path: "root/build", kind: "directory", ignored: true },
      { name: "src", path: "root/src", kind: "directory", ignored: false },
      { name: "README.md", path: "root/README.md", kind: "file", ignored: false },
    ],
  },
  "root/build": {
    truncated: false,
    entries: [{ name: "bundle.js", path: "root/build/bundle.js", kind: "file", ignored: true }],
  },
  "root/src": {
    truncated: false,
    entries: [{ name: "feature.ts", path: "root/src/feature.ts", kind: "file", ignored: false }],
  },
}

describe("file rail visibility", () => {
  test("shows ignored branches by default and still lets the person hide them", () => {
    expect(SHOW_IGNORED_BY_DEFAULT).toBe(true)
    expect(filterListings(listings, "", false).root?.entries.map((entry) => entry.name)).toEqual([
      "src",
      "README.md",
    ])
    expect(filterListings(listings, "", true).root?.entries.map((entry) => entry.name)).toEqual([
      "build",
      "src",
      "README.md",
    ])
  })

  test("keeps the ancestors of a matching loaded file", () => {
    const visible = filterListings(listings, "feature", false)
    expect(visible.root?.entries.map((entry) => entry.name)).toEqual(["src"])
    expect(visible["root/src"]?.entries.map((entry) => entry.name)).toEqual(["feature.ts"])
  })

  test("treats .git as inert metadata instead of a searchable branch", () => {
    const git = { name: ".git", path: "root/.git", kind: "directory" as const, ignored: false }
    const withGit: Record<string, Listing> = {
      root: { truncated: false, entries: [git] },
      "root/.git": {
        truncated: false,
        entries: [{ name: "config", path: "root/.git/config", kind: "file", ignored: false }],
      },
    }

    expect(isGitMetadataDirectory(git)).toBe(true)
    expect(filterListings(withGit, "", true).root?.entries.map((entry) => entry.name)).toEqual([".git"])
    expect(filterListings(withGit, "config", true).root?.entries).toEqual([])
  })
})

describe("file rail drag payload", () => {
  test("recognizes only Bake Pi's private workspace-file type", () => {
    expect(hasWorkspaceFileDrag(["Files", "text/plain"])).toBe(false)
    expect(hasWorkspaceFileDrag(["text/plain", WORKSPACE_FILE_DRAG_TYPE])).toBe(true)
  })
})
