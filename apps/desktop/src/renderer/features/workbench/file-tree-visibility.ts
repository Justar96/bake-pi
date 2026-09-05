import type { Listing } from "../../store/session-store.ts"

/** Ignored files are useful context in an agent workspace, so hiding is opt-in. */
export const SHOW_IGNORED_BY_DEFAULT = true

/**
 * Git owns this directory, not the person or the agent.
 *
 * It remains named in the tree so the missing branch is explained, but it is a
 * leaf there: opening repository internals is noise at best and an invitation
 * to edit Git's database at worst.
 */
export const isGitMetadataDirectory = (entry: Listing["entries"][number]): boolean =>
  entry.kind === "directory" && entry.name === ".git"

/**
 * Builds the visible projection of every directory already loaded into the
 * rail in one pass. A matching descendant keeps its ancestors visible, but an
 * unread descendant cannot match: this remains a filter over what the person
 * opened, not a workspace search with a very different filesystem cost.
 */
export const filterListings = (
  listings: Record<string, Listing>,
  query: string,
  showIgnored: boolean,
): Record<string, Listing> => {
  const survival = new Map<string, boolean>()
  const survives = (entry: Listing["entries"][number]): boolean => {
    const known = survival.get(entry.path)
    if (known !== undefined) return known
    const visible = (showIgnored || !entry.ignored) && (
      query === ""
      || entry.name.toLowerCase().includes(query)
      || (entry.kind === "directory"
        && !isGitMetadataDirectory(entry)
        && (listings[entry.path]?.entries ?? []).some(survives))
    )
    survival.set(entry.path, visible)
    return visible
  }

  return Object.fromEntries(
    Object.entries(listings).map(([path, listing]) => [
      path,
      { ...listing, entries: listing.entries.filter(survives) },
    ]),
  )
}
