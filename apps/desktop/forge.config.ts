import { type FuseConfig, FuseV1Options, FuseVersion } from "@electron/fuses"
import { FusesPlugin } from "@electron-forge/plugin-fuses"
import { MakerDeb } from "@electron-forge/maker-deb"
import { MakerRpm } from "@electron-forge/maker-rpm"
import { MakerSquirrel } from "@electron-forge/maker-squirrel"
import { PublisherGithub } from "@electron-forge/publisher-github"
import type { ForgeConfig } from "@electron-forge/shared-types"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The GitHub repository releases are published to and updates are read from. `src/main/update.ts` names the same one. */
const REPOSITORY = { owner: "Justar96", name: "bake-pi" }

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

/**
 * The fuse wire the package ships with. Exported so `bun run packaged` can
 * read the wire back out of the built executable and compare it to this
 * object rather than to a second copy of the same decisions.
 *
 * `RunAsNode` stays disabled, and the agent host still works.
 * `utilityProcess` is unaffected by this fuse — it is Electron's documented
 * replacement for `ELECTRON_RUN_AS_NODE` and `child_process.fork`. Disabling
 * the fuse removes the ability to invoke the packaged binary as a
 * general-purpose Node interpreter, which is a useful primitive to take away
 * from anything that gets code execution.
 *
 * Asar integrity validation detects a tampered archive at load. Its value
 * depends on the app being signed, so it is a release-build guarantee rather
 * than a development one.
 */
export const FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
} as const satisfies FuseConfig

/**
 * Stages a production copy of the application inside Forge's build directory.
 *
 * Forge packages this directory, and under Bun's hoisted linker this directory
 * has no `node_modules` of its own: every dependency, Pi included, lives at
 * the repository root. A straight copy therefore ships four bundles and no
 * Pi, and the agent host fails its first import. That is the "artifact
 * staging" gate in the roadmap, resolved as its default said: a clean
 * production stage rather than crawling the workspace.
 *
 * The stage is what the running application needs and nothing else. The
 * three of our own bundles that are self-contained need no dependency at all;
 * the agent host keeps Pi external (`build/shared.ts` says why at length), so
 * what that workspace declares is the runtime dependency list. It is read from
 * its manifest rather than restated here, and that is not tidiness: it was
 * restated here, as three hand-picked packages, and the list silently omitted
 * `@earendil-works/pi-server`. Nothing caught it, because a package tested
 * inside this repository resolves anything the stage forgot from the
 * repository's own hoisted `node_modules`, one directory walk up. The first
 * install on a machine that had no such directory died at
 * `ERR_MODULE_NOT_FOUND` before its handshake. `scripts/packaged.ts` now runs
 * the package from outside the tree so the walk has nothing to find.
 *
 * `bun install --production` then lays the list out under the copy the same way
 * the root has it, which is the layout Pi's jiti and WASM path resolution are
 * tested against.
 *
 * `main` and `type` are copied from the manifest rather than restated, so the
 * entry Forge reads is the entry the build wrote.
 */
const stageProduction = (buildPath: string): void => {
  const desktop = readJson(join(import.meta.dirname, "package.json"))
  const host = readJson(join(import.meta.dirname, "../../packages/agent-host/package.json"))
  const hostDependencies = host.dependencies as Record<string, string>
  if (hostDependencies["@earendil-works/pi-coding-agent"] === undefined) {
    throw new Error("agent host does not declare its Pi version")
  }
  // Everything the agent host depends on except the workspaces, which are
  // bundled into `dist` and have no published version to install. A dependency
  // the bundler inlined costs a few unused files here; one left out costs a
  // host that cannot start.
  const runtimeDependencies = Object.fromEntries(
    Object.entries(hostDependencies).filter(([, range]) => !range.startsWith("workspace:")),
  )

  for (const entry of readdirSync(buildPath)) {
    if (entry !== "dist") rmSync(join(buildPath, entry), { recursive: true, force: true })
  }
  writeFileSync(join(buildPath, "package.json"), JSON.stringify({
    name: "bake-pi",
    productName: desktop.productName,
    version: desktop.version,
    license: desktop.license,
    description: "A desktop interface for the Pi coding agent.",
    author: "Justar",
    private: true,
    type: desktop.type,
    main: desktop.main,
    dependencies: runtimeDependencies,
  }, null, 2))

  // The stage discards everything but dist, so carry our own license as well
  // as the notices in the dependencies installed below. RPM also requires the
  // SPDX identifier in the staged manifest, not only the repository manifest.
  copyFileSync(join(import.meta.dirname, "../../LICENSE"), join(buildPath, "LICENSE"))

  const install = spawnSync("bun", ["install", "--production", "--no-summary"], { cwd: buildPath, stdio: "inherit" })
  if (install.status !== 0) throw new Error(`bun install in the package stage exited ${String(install.status)}`)
  // The lockfile Bun wrote is not the repository's and would only confuse a reader of the package.
  rmSync(join(buildPath, "bun.lock"), { force: true })
  // Linux has no executable resource to carry the window icon, so main reads
  // this bitmap at the same relative path it uses in development.
  mkdirSync(join(buildPath, "build"), { recursive: true })
  copyFileSync(join(import.meta.dirname, "build/icon.png"), join(buildPath, "build/icon.png"))
}

/** Shared by the deb and rpm makers: what the desktop entry and the package index say. */
const LINUX_PACKAGE = {
  name: "bake-pi",
  productName: "Bake Pi",
  genericName: "Coding agent interface",
  description: "A desktop interface for the Pi coding agent.",
  categories: ["Development"] as ["Development"],
  icon: join(import.meta.dirname, "build/icon.png"),
  homepage: `https://github.com/${REPOSITORY.owner}/${REPOSITORY.name}`,
  maintainer: "Justar",
}

/**
 * Packaging, and the decisions in it that are not defaults.
 */
const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      /**
       * The WASM image codec is unpacked.
       *
       * Pi loads it by path, and path-based or streaming WebAssembly
       * instantiation is the classic asar failure: `fs` reads are transparent
       * through the archive, but anything that hands a real filesystem path to
       * the operating system is not. Unpacking one file costs nothing and
       * removes an entire class of "works in development, fails when packaged".
       */
      unpack: "**/photon_rs_bg.wasm",
    },
    name: "Bake Pi",
    executableName: "bake-pi",
    appBundleId: "works.earendil.bakepi",
    /**
     * `build/icon` without an extension: the packager appends `.ico` on
     * Windows and `.icns` on macOS. Both files are rendered from
     * `assets/app-icon` by `bun run app-icon` and committed, so a package
     * needs no image tooling. There is no `.icns` yet, which is fine until
     * there is a macOS maker.
     */
    icon: join(import.meta.dirname, "build/icon"),
    appCopyright: "Copyright © 2026 Justar",
    // Only `dist` survives into the package; `stageProduction` removes the
    // rest and installs what the bundles need. Ignoring here keeps the copy
    // small and keeps a previous `out` from being copied into the next one.
    ignore: [/^\/src/, /^\/build/, /^\/out/, /^\/tsconfig.*\.json$/, /^\/forge\.config\.ts$/],
    /**
     * The Windows executable declares per-monitor DPI awareness v2.
     *
     * Electron's own manifest declares v1, under which Windows sizes the
     * native frame at the primary display's DPI while Chromium insets the
     * client area by the current display's. On a display at another scale
     * that shows as a band of frame colour inside the hairline on three
     * sides. The manifest replaces Electron's wholesale, so it carries the
     * rest of Electron's entries too; `scripts/manifest.ts` stamps the same
     * file into the development binary, and `bun run frame` checks the
     * result on every display.
     */
    win32metadata: {
      // Without these the executable keeps the stock binary's "GitHub, Inc."
      CompanyName: "Justar",
      "application-manifest": join(import.meta.dirname, "build/windows.manifest"),
    },
  },

  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      stageProduction(buildPath)
    },
  },

  makers: [
    /**
     * Squirrel.Windows rather than MSI or NSIS, because it is the installer
     * Electron's own `autoUpdater` knows how to update: `Setup.exe` installs
     * per user with no elevation prompt, and every later release is a
     * `.nupkg` the running app fetches and stages itself. The trade is that a
     * first launch after install or update happens through
     * `electron-squirrel-startup` (see `src/main/index.ts`), which is how the
     * Start menu shortcut gets made.
     *
     * `name` is the NuGet package id. It has to be a bare identifier, so it is
     * not the scoped workspace name, and it is part of the AppUserModelID the
     * shortcut carries — main sets the same one so the taskbar groups the
     * window under the shortcut's icon rather than beside it.
     */
    new MakerSquirrel({
      name: "BakePi",
      authors: "Justar",
      description: "A desktop interface for the Pi coding agent.",
      setupIcon: join(import.meta.dirname, "build/icon.ico"),
      setupExe: "BakePi-Setup.exe",
      // The icon Add/Remove Programs shows; Squirrel wants a URL, not a file.
      iconUrl: `https://raw.githubusercontent.com/${REPOSITORY.owner}/${REPOSITORY.name}/main/apps/desktop/build/icon.ico`,
      noMsi: true,
    }),
    // No ZIP maker: its `cross-zip` calls an `fs.rmdir` option Node 26 has
    // removed, and the `.nupkg` beside the installer is already an archive of
    // the packaged directory for anyone who wants to inspect one.
    /**
     * Debian and RPM packages for Linux. Neither needs a signature to install
     * or run, and both configure the SUID `chrome_sandbox` helper the renderer
     * sandbox needs, which a bare archive cannot. There is no in-app updater
     * on Linux — Electron's `autoUpdater` has no Linux implementation — so a
     * distribution package, which the system's own package manager can
     * upgrade, is the honest format rather than an AppImage that cannot.
     */
    new MakerDeb({ options: LINUX_PACKAGE }),
    new MakerRpm({ options: LINUX_PACKAGE }),
  ],

  publishers: [
    /**
     * A draft GitHub Release per tag. Draft so a maintainer reads the
     * generated notes and looks at the artifacts before anything is
     * published — the moment a release goes public, `update.electronjs.org`
     * starts serving it to every installed copy.
     */
    new PublisherGithub({
      repository: REPOSITORY,
      draft: true,
      // A beta tag must not become the stable updater's latest release when
      // the draft is published. Derive the channel from the packaged version.
      prerelease: String(readJson(join(import.meta.dirname, "package.json")).version).includes("-"),
      generateReleaseNotes: true,
    }),
  ],

  plugins: [new FusesPlugin(FUSES)],
}

export default config
