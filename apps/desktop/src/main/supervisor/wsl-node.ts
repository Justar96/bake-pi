import { BakePiError } from "@bake-pi/contract"
import { posix } from "node:path"
import { runWsl } from "./wsl-process.ts"

/**
 * Finding the Node the person actually installed inside a WSL distribution.
 *
 * The naive probe — `sh -lc "node -v"` — reports "no Node" on most developer
 * machines that have Node. Every current version manager (fnm, nvm, asdf, mise)
 * installs itself by appending an `eval` to `~/.bashrc` or `~/.zshrc`, and those
 * files are read only by an *interactive* shell: Ubuntu's stock `.bashrc`
 * returns on its second line when `$-` has no `i`, and `.zshrc` is never sourced
 * by a non-interactive zsh at all. A login shell reads `/etc/profile` and
 * `~/.profile`, which is a different file and usually not where the version
 * manager wrote. So the probe asks a shell that never loaded the thing it is
 * asking about, and the person is told to install what they already have.
 *
 * Two passes fix it, cheapest first, and the order is the whole design:
 *
 * 1. A plain `sh -lc` running a constant script that checks `command -v node`
 *    and then the on-disk layout of each version manager directly. This costs
 *    one `wsl.exe` round trip, cannot hang on a prompt, and answers for almost
 *    every machine.
 * 2. Failing that, the person's real login shell, interactive — `$SHELL -ilc`.
 *    This is what VS Code's remote and terminal environment resolution does,
 *    and it is the only pass that covers a version manager we have never heard
 *    of. It is second because an interactive shell can print a banner, source
 *    arbitrary user code, and take a second or more to start.
 *
 * The result is always an **absolute, symlink-resolved** path, and everything
 * downstream spawns that path rather than the bare name. That matters beyond
 * tidiness: fnm puts the `node` on a shell's PATH inside
 * `/run/user/<uid>/fnm_multishells/<pid>_<ts>/bin`, a per-shell directory torn
 * down when the shell that made it exits. Recording the PATH entry would hand
 * the agent host a symlink with a shorter life than the host.
 */

/**
 * Where `wsl-node-install.ts` puts a Node this application brought itself,
 * written in the distribution's own vocabulary because only Linux can expand
 * `$HOME`. Both files need it, so it is stated once here: the installer builds
 * the tree, the probe reads the one name the installer promises is complete.
 */
export const MANAGED_NODE_ROOT = "$HOME/.cache/bake-pi/node"
export const MANAGED_NODE_LINK = `${MANAGED_NODE_ROOT}/current`

/**
 * Prints two lines on success: the version Node reported, then the binary.
 *
 * Exported so `bun run wsl-smoke` can run the real script against a synthetic
 * `HOME`. A candidate list is exactly the kind of thing that rots silently —
 * a path typed wrong still compiles, still passes every unit test, and just
 * never matches — so the smoke plants a file at one of these paths and requires
 * the probe to find it.
 */
export const NODE_PROBE = [
  "set -u",
  "min=$1",
  "shift",
  "check() {",
  "  candidate=${1:-}",
  '  [ -n "$candidate" ] || return 1',
  '  resolved=$(readlink -f -- "$candidate" 2>/dev/null) || resolved=$candidate',
  '  [ -n "$resolved" ] || return 1',
  '  [ -x "$resolved" ] || return 1',
  '  version=$("$resolved" -v 2>/dev/null) || return 1',
  '  case "$version" in v[0-9]*) ;; *) return 1 ;; esac',
  "  major=${version#v}",
  "  major=${major%%.*}",
  '  case "$major" in "" | *[!0-9]*) return 1 ;; esac',
  '  [ "$major" -ge "$min" ] || return 1',
  '  printf "%s\\n%s\\n" "$version" "$resolved"',
  "  exit 0",
  "}",
  // A path this launcher resolved before, so a warm start never pays for the
  // interactive pass. It is re-checked rather than trusted: the version manager
  // may have removed that version since.
  'for hint in "$@"; do check "$hint"; done',
  'check "$(command -v node 2>/dev/null)"',
  // Each version manager's own name for "the default" — the version the
  // person's own shell would have selected.
  "fnm_dir=${FNM_DIR:-$HOME/.local/share/fnm}",
  "nvm_dir=${NVM_DIR:-$HOME/.nvm}",
  'check "$fnm_dir/aliases/default/bin/node"',
  'check "$HOME/.fnm/aliases/default/bin/node"',
  'nvm_default=$(cat "$nvm_dir/alias/default" 2>/dev/null || true)',
  'check "$nvm_dir/versions/node/$nvm_default/bin/node"',
  'check "$nvm_dir/versions/node/v$nvm_default/bin/node"',
  'check "$nvm_dir/current/bin/node"',
  'check "${VOLTA_HOME:-$HOME/.volta}/bin/node"',
  'check "${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims/node"',
  'check "${ASDF_DATA_DIR:-$HOME/.asdf}/shims/node"',
  'check "$HOME/n/bin/node"',
  'check "$HOME/.local/bin/node"',
  "check /usr/local/bin/node",
  "check /usr/bin/node",
  "check /snap/bin/node",
  "check /home/linuxbrew/.linuxbrew/bin/node",
  // Nothing is the declared default, so take the newest installed rather than
  // report a distribution that can plainly run the host as unable to.
  'for dir in "$fnm_dir/node-versions" "$HOME/.fnm/node-versions" "$nvm_dir/versions/node"; do',
  '  [ -d "$dir" ] || continue',
  '  installed=$(ls -1 "$dir" 2>/dev/null | sort -rV 2>/dev/null) || installed=$(ls -1 "$dir" 2>/dev/null | sort -r)',
  "  for entry in $installed; do",
  '    check "$dir/$entry/installation/bin/node"',
  '    check "$dir/$entry/bin/node"',
  "  done",
  "done",
  // Last, and last deliberately. A Node this application installed is a
  // fallback for a distribution that had none; the moment the person has
  // their own, the agent host should share it, because Pi's tools shell out
  // and a project's own `node_modules` binaries expect the project's Node.
  `check "${MANAGED_NODE_LINK}/bin/node"`,
  "exit 1",
].join("\n")

const LOGIN_SHELL = 'getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7'

/**
 * Shells whose `-c` runs the POSIX probe and whose `-i` is safe to ask for.
 * fish and nushell are absent deliberately: neither would parse the script, so
 * a second pass in one of them has nothing to add over the first.
 */
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "ksh93", "mksh", "dash", "ash", "busybox"])

const DIRECT_PROBE_TIMEOUT_MS = 15_000
const INTERACTIVE_PROBE_TIMEOUT_MS = 20_000

export interface WslNode {
  /** Exactly what `node -v` printed, for the handshake and for error copy. */
  version: string
  /** Absolute and symlink-resolved, so it outlives the shell that found it. */
  path: string
}

const remembered = new Map<string, WslNode>()

/** The directory to put on PATH so `npm`, `npx` and Pi's tools agree with the host. */
export const nodeBinDir = (node: WslNode): string => posix.dirname(node.path)

export const parseNodeProbe = (stdout: string): WslNode | undefined => {
  const lines = stdout.split("\n").map((line) => line.trim())
  const version = lines[0]
  const path = lines[1]
  if (version === undefined || path === undefined) return undefined
  if (nodeMajor(version) === undefined) return undefined
  if (!posix.isAbsolute(path) || path.includes("\0")) return undefined
  return { version, path }
}

export const nodeMajor = (output: string): number | undefined => {
  const match = /^v(\d+)(?:\.|$)/u.exec(output.trim())
  if (match?.[1] === undefined) return undefined
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : undefined
}

export const parseLoginShell = (stdout: string): string | undefined => {
  const shell = stdout.trim()
  if (!posix.isAbsolute(shell) || shell.includes("\0")) return undefined
  return POSIX_SHELLS.has(posix.basename(shell)) ? shell : undefined
}

export const discoverWslNode = async (distro: string, minimumMajor: number): Promise<WslNode> => {
  const hint = remembered.get(distro)
  const args = [String(minimumMajor), ...(hint === undefined ? [] : [hint.path])]

  let direct
  try {
    direct = await runWsl(distro, ["sh", "-lc", NODE_PROBE, "sh", ...args], undefined, DIRECT_PROBE_TIMEOUT_MS)
  } catch (cause) {
    // Only this first call distinguishes "no WSL" from "no Node". Once it has
    // answered at all, a later failure is the distribution's, not wsl.exe's.
    throw new BakePiError("host_unavailable", { detail: "wsl_unavailable", retryable: false, cause })
  }
  const found = direct.code === 0 ? parseNodeProbe(direct.stdout) : undefined
  if (found !== undefined) {
    remembered.set(distro, found)
    return found
  }

  const shell = await loginShell(distro)
  if (shell !== undefined) {
    const interactive = await runWsl(
      distro,
      [shell, "-ilc", NODE_PROBE, "probe", ...args],
      undefined,
      INTERACTIVE_PROBE_TIMEOUT_MS,
    ).catch(() => undefined)
    const late = interactive === undefined || interactive.code !== 0
      ? undefined
      : parseNodeProbe(interactive.stdout)
    if (late !== undefined) {
      remembered.set(distro, late)
      return late
    }
  }

  remembered.delete(distro)
  throw new BakePiError("host_unavailable", { detail: "node_missing", retryable: false })
}

const loginShell = async (distro: string): Promise<string | undefined> => {
  const result = await runWsl(distro, ["sh", "-lc", LOGIN_SHELL], undefined, 10_000).catch(() => undefined)
  if (result === undefined || result.code !== 0) return undefined
  return parseLoginShell(result.stdout)
}
