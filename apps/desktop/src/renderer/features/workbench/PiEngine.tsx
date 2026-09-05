import { useCallback, useEffect, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { CircleCheck, Download, RefreshCw, Trash2 } from "lucide-react"
import type { CommandResult } from "@bake-pi/contract"
import { store } from "../../store/session-store.ts"
import { spinners } from "../../theme/spinners.ts"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { SettingsGroupHead } from "./PiSettings.tsx"

/**
 * Choosing which Pi the agent host runs.
 *
 * Bake Pi ships a Pi inside its own archive, and for a long time that was the
 * only Pi it could ever run: the panel could name a newer release and then say
 * nothing more useful than "update Bake Pi too". Upstream publishes far more
 * often than this application does, so that sentence was the answer to a
 * question people were reasonably asking.
 *
 * This section is the answer instead. It installs a version from what upstream
 * published, keeps it beside the bundled copy rather than over it, and restarts
 * the host onto whichever one is selected. Nothing is ever replaced, so the way
 * back is always one button and never a reinstall — which is what makes trying
 * a new Pi a small decision.
 */

/** How often the panel re-reads an install that is still going. */
const POLL_MS = 700

type Runtime = CommandResult<"get_pi_runtime">
type Release = CommandResult<"check_pi_releases">["releases"][number]

export interface PiEngineController {
  runtime: Runtime | undefined
  releases: Release[] | undefined
  /** Whatever the panel is waiting on, or nothing. */
  busy: "loading" | "checking" | "selecting" | "removing" | undefined
  error: string | undefined
  load: () => void
  check: () => void
  install: (version: string) => void
  use: (version: string | undefined) => void
  remove: (version: string) => void
}

const running = (runtime: Runtime | undefined): boolean =>
  runtime?.install !== undefined && ["planning", "downloading", "activating"].includes(runtime.install.phase)

const message = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string") return error.detail
  return error instanceof Error ? error.message : "the request failed"
}

/**
 * One controller for the whole section, polling only while something is moving.
 *
 * An install is owned by main and reported by polling rather than pushed — see
 * `PiInstallState` in the contract for why there is no event for it. The poll
 * exists only for the duration of a run, so a panel sitting open on a settled
 * state issues no traffic at all.
 */
export const usePiEngineController = (enabled: boolean): PiEngineController => {
  const [runtime, setRuntime] = useState<Runtime | undefined>(undefined)
  const [releases, setReleases] = useState<Release[] | undefined>(undefined)
  const [busy, setBusy] = useState<PiEngineController["busy"]>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)

  const load = useCallback((): void => {
    if (inFlight.current) return
    inFlight.current = true
    void store.send("get_pi_runtime", {})
      .then(setRuntime)
      .catch((cause: unknown) => { store.capture(cause); setError(message(cause)) })
      .finally(() => { inFlight.current = false })
  }, [])

  useEffect(() => {
    if (enabled && runtime === undefined) load()
  }, [enabled, runtime, load])

  useEffect(() => {
    if (!enabled || !running(runtime)) return undefined
    const timer = setInterval(load, POLL_MS)
    return () => { clearInterval(timer) }
  }, [enabled, runtime, load])

  const check = useCallback((): void => {
    setBusy("checking")
    setError(undefined)
    void store.send("check_pi_releases", {})
      .then((result) => { setReleases(result.releases) })
      .catch((cause: unknown) => { store.capture(cause); setError(message(cause)) })
      .finally(() => { setBusy(undefined) })
  }, [])

  const act = useCallback((state: NonNullable<PiEngineController["busy"]>, run: () => Promise<unknown>): void => {
    setBusy(state)
    setError(undefined)
    void run()
      .catch((cause: unknown) => { store.capture(cause); setError(message(cause)) })
      .finally(() => {
        setBusy(undefined)
        // Always re-read, including after a failure: `use` restarts the host
        // partway through its own work, and the panel must show what is true
        // now rather than what was asked for.
        load()
      })
  }, [load])

  return {
    runtime,
    releases,
    busy,
    error,
    load,
    check,
    install: (version) => {
      // Not routed through `act`: the command returns as soon as the download
      // has begun, so a spinner tied to its promise would stop a second later
      // and leave the run looking finished. The poll reports it instead.
      setError(undefined)
      void store.send("install_pi", { version })
        .then(load)
        .catch((cause: unknown) => { store.capture(cause); setError(message(cause)) })
    },
    use: (version) => { act("selecting", async () => await store.send("use_pi", version === undefined ? {} : { version })) },
    remove: (version) => { act("removing", async () => await store.send("remove_pi", { version })) },
  }
}

const formatDate = (iso: string): string => {
  if (iso === "") return ""
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export const PiEngineSettings = ({ controller }: { controller: PiEngineController }): React.JSX.Element => {
  const { runtime, releases, busy } = controller
  const install = runtime?.install
  const active = runtime?.activeVersion
  const installed = runtime?.installed ?? []
  const inProgress = running(runtime)
  const installedVersions = new Set(installed.map((entry) => entry.version))
  const newest = releases?.[0]

  return (
    <div aria-busy={busy !== undefined || inProgress} {...stylex.props(styles.stack)}>
      <SettingsGroupHead title="Running" description="Which Pi the agent host loaded" />
      <div {...stylex.props(styles.current)}>
        <span {...stylex.props(styles.currentVersion)}>Pi {active ?? runtime?.bundledVersion ?? "…"}</span>
        <span {...stylex.props(styles.currentSource)}>
          {active === undefined ? "bundled with this build of Bake Pi" : "installed from upstream"}
        </span>
        {runtime?.pending === true ? (
          /*
            The one state the panel must not gloss over. A selection is on disk
            and the host is still on the previous Pi, so saying "running" here
            without qualification would be false for the minute it takes someone
            to press the button.
          */
          <span role="status" {...stylex.props(styles.pending)}>
            The host is still on the previous Pi. Selecting it again restarts onto this one.
          </span>
        ) : null}
      </div>

      {install === undefined ? null : (
        <div role="status" {...stylex.props(styles.progress, install.phase === "failed" && styles.progressFailed)}>
          <span {...stylex.props(styles.progressTitle)}>
            {install.phase === "planning" ? `Reading what upstream published for Pi ${install.version}…`
              : install.phase === "downloading" ? `Installing Pi ${install.version}`
              : install.phase === "activating" ? `Finishing Pi ${install.version}…`
              : install.phase === "done" ? `Pi ${install.version} is installed`
              : `Pi ${install.version} could not be installed`}
          </span>
          {install.phase === "downloading" ? (
            <>
              <progress max={install.total} value={install.completed} {...stylex.props(styles.bar)} />
              <span {...stylex.props(styles.progressDetail)}>{install.completed} of {install.total} packages</span>
            </>
          ) : null}
          {install.error === undefined ? null : <span {...stylex.props(styles.progressDetail)}>{install.error}</span>}
        </div>
      )}

      <SettingsGroupHead title="Upstream" description="Releases published by the Pi project" />
      <div {...stylex.props(styles.row)}>
        <button
          type="button"
          onClick={controller.check}
          disabled={busy !== undefined || inProgress}
          {...stylex.props(focus.control, styles.secondary)}
        >
          <RefreshCw size={14} aria-hidden="true" {...stylex.props(busy === "checking" && spinners.rotate)} />
          {busy === "checking" ? "Checking…" : releases === undefined ? "Check for releases" : "Check again"}
        </button>
        {newest !== undefined && newest.version === (active ?? runtime?.bundledVersion) ? (
          <span {...stylex.props(styles.current_)}>
            <CircleCheck size={14} aria-hidden="true" />
            This is the newest release
          </span>
        ) : null}
      </div>

      {releases === undefined ? null : releases.length === 0 ? (
        <p {...stylex.props(styles.empty)}>Upstream published no releases this check could read.</p>
      ) : (
        <ul {...stylex.props(styles.list)}>
          {releases.map((release) => {
            const already = installedVersions.has(release.version)
            return (
              <li key={release.version} {...stylex.props(styles.item)}>
                <span {...stylex.props(styles.itemText)}>
                  <span {...stylex.props(styles.itemTitle)}>Pi {release.version}</span>
                  <span {...stylex.props(styles.itemDetail)}>
                    {formatDate(release.publishedAt)}
                    {release.version === runtime?.bundledVersion ? " · bundled with this build" : ""}
                    {already ? " · installed" : ""}
                  </span>
                </span>
                {already ? (
                  <button
                    type="button"
                    onClick={() => { controller.use(release.version) }}
                    disabled={busy !== undefined || inProgress || (active === release.version && runtime?.pending === false)}
                    {...stylex.props(focus.control, styles.secondary)}
                  >
                    {active === release.version && runtime?.pending === false ? "In use" : "Use"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { controller.install(release.version) }}
                    disabled={busy !== undefined || inProgress}
                    {...stylex.props(focus.control, styles.primary)}
                  >
                    <Download size={14} aria-hidden="true" />
                    Install
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <SettingsGroupHead title="Installed" description="Kept on this machine, beside the bundled copy" />
      <ul {...stylex.props(styles.list)}>
        <li {...stylex.props(styles.item)}>
          <span {...stylex.props(styles.itemText)}>
            <span {...stylex.props(styles.itemTitle)}>Pi {runtime?.bundledVersion ?? "…"}</span>
            <span {...stylex.props(styles.itemDetail)}>bundled · always available</span>
          </span>
          <button
            type="button"
            onClick={() => { controller.use(undefined) }}
            disabled={busy !== undefined || inProgress || active === undefined}
            {...stylex.props(focus.control, styles.secondary)}
          >
            {active === undefined ? "In use" : "Use"}
          </button>
        </li>
        {installed.map((entry) => (
          <li key={entry.version} {...stylex.props(styles.item)}>
            <span {...stylex.props(styles.itemText)}>
              <span {...stylex.props(styles.itemTitle)}>Pi {entry.version}</span>
              <span {...stylex.props(styles.itemDetail)}>
                {entry.packages} packages{formatDate(entry.installedAt) === "" ? "" : ` · installed ${formatDate(entry.installedAt)}`}
              </span>
            </span>
            <button
              type="button"
              onClick={() => { controller.use(entry.version) }}
              disabled={busy !== undefined || inProgress || (active === entry.version && runtime?.pending === false)}
              {...stylex.props(focus.control, styles.secondary)}
            >
              {active === entry.version && runtime?.pending === false ? "In use" : "Use"}
            </button>
            <button
              type="button"
              onClick={() => { controller.remove(entry.version) }}
              disabled={busy !== undefined || inProgress || active === entry.version}
              aria-label={`Remove Pi ${entry.version}`}
              {...stylex.props(focus.control, styles.quiet)}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const styles = stylex.create({
  stack: { display: "flex", flexDirection: "column", gap: space.md },
  current: { display: "flex", flexDirection: "column", gap: "2px", padding: space.md, backgroundColor: colors.sunken, borderRadius: radius.lg },
  currentVersion: { color: colors.text, fontSize: typography.body, lineHeight: typography.bodyLine, fontWeight: 700 },
  currentSource: { color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  pending: { marginBlockStart: space.xs, color: colors.warning, fontSize: typography.caption, lineHeight: typography.captionLine },
  progress: { display: "flex", flexDirection: "column", gap: space.xs, padding: space.md, backgroundColor: colors.surfaceRaised, borderRadius: radius.lg, boxShadow: effects.lift },
  progressFailed: { color: colors.danger, backgroundColor: colors.dangerSoft },
  progressTitle: { color: colors.text, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600 },
  progressDetail: { color: colors.textMuted, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine },
  bar: { width: "100%", height: "6px", accentColor: colors.accent },
  row: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  current_: { display: "inline-flex", alignItems: "center", gap: space.xs, color: colors.success, fontSize: typography.caption, lineHeight: typography.captionLine },
  empty: { margin: 0, color: colors.textMuted, fontSize: typography.caption, lineHeight: typography.captionLine },
  list: { display: "flex", flexDirection: "column", gap: space.xs, margin: 0, padding: 0, listStyle: "none" },
  item: { display: "flex", alignItems: "center", gap: space.sm, padding: space.sm, backgroundColor: colors.surface, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.border, borderRadius: radius.md },
  itemText: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1px" },
  itemTitle: { color: colors.text, fontSize: typography.label, lineHeight: typography.labelLine, fontWeight: 600 },
  itemDetail: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.textFaint, fontSize: typography.micro, lineHeight: typography.microLine },
  primary: {
    flex: "none", minHeight: size.controlMicro, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.xs,
    paddingInline: space.sm, color: colors.accentOn, backgroundColor: { default: colors.accent, ":hover": colors.accentHover },
    borderWidth: 0, borderRadius: radius.sm, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.6 },
    transitionProperty: "background-color", transitionDuration: motion.fast, transitionTimingFunction: motion.settle,
    fontFamily: typography.ui, fontSize: typography.caption, lineHeight: typography.captionLine, fontWeight: 700,
  },
  secondary: {
    flex: "none", minHeight: size.controlMicro, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.xs,
    paddingInline: space.sm, color: colors.text, backgroundColor: { default: colors.surfaceRaised, ":hover": colors.surface },
    borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.sm,
    cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.5 },
    fontFamily: typography.ui, fontSize: typography.caption, lineHeight: typography.captionLine, fontWeight: 600,
  },
  quiet: {
    flex: "none", width: size.controlMicro, height: size.controlMicro, display: "grid", placeItems: "center", padding: 0,
    color: { default: colors.textFaint, ":hover": colors.danger }, backgroundColor: { default: "transparent", ":hover": colors.dangerSoft },
    borderWidth: 0, borderRadius: radius.sm, cursor: { default: "pointer", ":disabled": "not-allowed" }, opacity: { default: 1, ":disabled": 0.4 },
  },
})
