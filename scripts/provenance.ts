/**
 * Generates `docs/reference/pi-upstream.md`.
 *
 * The claim "Bake Pi keeps no private fork and patches no node_modules" is only
 * worth making if it is checkable. This records exactly which upstream packages
 * are installed and at which resolved versions, straight from the lockfile, so
 * an auditor can compare the shipped tree against the registry without taking
 * anyone's word for it.
 */
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const UPSTREAM_SCOPE = "@earendil-works/"

interface Resolved {
  name: string
  version: string
  integrity: string | undefined
}

const readLockfile = async (): Promise<{ packages: Resolved[]; digest: string }> => {
  // Bun writes a text lockfile (`saveTextLockfile`), which is JSONC.
  const text = await Bun.file(join(root, "bun.lock")).text()
  // Normalized so the digest tracks the lockfile's content and not its line
  // endings: `.gitattributes` declares LF, but a checkout that ignored it would
  // otherwise produce a different digest from an identical dependency set.
  const digest = createHash("sha256")
    .update(text.split("\r\n").join("\n"))
    .digest("hex")
    .slice(0, 16)
  const lock = JSON.parse(stripComments(text)) as {
    packages?: Record<string, unknown[]>
  }

  const resolved: Resolved[] = []
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith(UPSTREAM_SCOPE) && !key.includes("photon")) continue
    const descriptor = typeof entry[0] === "string" ? entry[0] : ""
    const integrity = entry.find((part) => typeof part === "string" && part.startsWith("sha512-"))
    const at = descriptor.lastIndexOf("@")
    resolved.push({
      name: at > 0 ? descriptor.slice(0, at) : key,
      version: at > 0 ? descriptor.slice(at + 1) : "unknown",
      integrity: typeof integrity === "string" ? integrity : undefined,
    })
  }
  return { packages: resolved.sort((a, b) => a.name.localeCompare(b.name)), digest }
}

const stripComments = (text: string): string =>
  text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")

const { packages, digest } = await readLockfile()

const document = [
  "# Pi upstream provenance",
  "",
  "- **Generated:** by `bun run provenance`. Do not edit by hand.",
  // Deliberately not a date. CI regenerates this file and fails on any diff, so
  // every field has to be a function of the input alone — a wall-clock stamp
  // made the gate fail on the first run of every day that followed a
  // regeneration, on a tree where no dependency had moved, and the fix for that
  // false positive is to re-commit the date, which teaches everyone to ignore
  // the one signal the gate exists to send. The lockfile digest says what the
  // date was standing in for and says it checkably: same digest, same upstream.
  `- **Source:** \`bun.lock\`, sha256 \`${digest}\`.`,
  "",
  "Bake Pi consumes Pi from the public registry at exact versions. It keeps no",
  "fork, applies no patches, and vendors no upstream source. This file is how",
  "that claim is checked rather than asserted.",
  "",
  "| Package | Version | Integrity |",
  "| --- | --- | --- |",
  ...packages.map(
    (pkg) => `| \`${pkg.name}\` | \`${pkg.version}\` | \`${(pkg.integrity ?? "—").slice(0, 24)}…\` |`,
  ),
  "",
].join("\n")

const output = join(root, "docs", "reference", "pi-upstream.md")
writeFileSync(output, document, "utf8")
console.log(`wrote docs/reference/pi-upstream.md (${packages.length} upstream packages)`)
