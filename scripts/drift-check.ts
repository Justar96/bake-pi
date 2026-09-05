/**
 * Upstream drift check.
 *
 * The plan's bet is that upgrades stay bounded by an automated suite rather
 * than by manual retesting. That bet only pays if drift is noticed early, so
 * this runs weekly in CI and reports how far behind the pin is. It never
 * upgrades anything: a bump is a decision, and a job that makes it silently is
 * a job that eventually ships an untested agent loop.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const TRACKED = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-server", "electron", "@stylexjs/stylex", "react", "typescript"]

const pinned = (name: string): string | undefined => {
  for (const manifest of ["package.json", "apps/desktop/package.json", "packages/agent-host/package.json"]) {
    const json = JSON.parse(readFileSync(join(root, manifest), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const version = json.dependencies?.[name] ?? json.devDependencies?.[name]
    if (version !== undefined) return version
  }
  return undefined
}

const latest = async (name: string): Promise<string> => {
  const response = await fetch(`https://registry.npmjs.org/${name}/latest`)
  if (!response.ok) return "unreachable"
  return ((await response.json()) as { version: string }).version
}

const rows = await Promise.all(
  TRACKED.map(async (name) => {
    const current = pinned(name) ?? "—"
    const available = await latest(name)
    return { name, current, available, behind: current !== available && available !== "unreachable" }
  }),
)

console.log("| Package | Pinned | Latest | Behind |")
console.log("| --- | --- | --- | --- |")
for (const row of rows) {
  console.log(`| \`${row.name}\` | \`${row.current}\` | \`${row.available}\` | ${row.behind ? "yes" : "no"} |`)
}

const behind = rows.filter((row) => row.behind)
if (behind.length > 0) {
  console.log(`\n${behind.length} of ${rows.length} tracked packages have a newer release.`)
}

// Reporting drift is not a failure. Exiting non-zero here would make the weekly
// job red for the normal state of the world, and a permanently red job is one
// nobody reads.
process.exitCode = 0
