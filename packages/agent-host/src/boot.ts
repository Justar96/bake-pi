import { PI_ROOT_ENV } from "@bake-pi/contract/pi-runtime"
import { installPiResolution } from "./pi-resolution.ts"

/**
 * The host's entry point, and nothing more than the two lines below.
 *
 * A separate bundle from the host itself, because a resolve hook is worth
 * exactly nothing after the imports it redirects have run. Were this file's
 * body inside `index.ts`, the bundler would hoist that file's static Pi imports
 * above the registration and the managed install would never be consulted.
 * Kept apart, this evaluates alone and reaches the host only afterwards.
 */
/*
  The contract's leaf module rather than its barrel. Importing the package root
  pulls TypeBox and every schema in the project into this bundle, which took a
  one-kilobyte stub to a hundred and seventy — all of it evaluated before the
  hook it exists to register.
*/
installPiResolution(process.env[PI_ROOT_ENV])

/*
  A computed specifier, so the bundler cannot inline the host into this file and
  undo the separation above. At runtime it is simply the sibling `index.js`.
*/
await import(new URL("./index.js", import.meta.url).href)
