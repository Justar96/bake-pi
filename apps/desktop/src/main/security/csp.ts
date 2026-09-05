import { session } from "electron"
import { APP_ORIGIN, IMAGE_ORIGIN } from "../protocol.ts"

/**
 * One policy, applied to every response, with no `unsafe-inline` anywhere.
 *
 * StyleX is what makes `style-src` affordable: styles compile to a static
 * atomic stylesheet at build time, so nothing needs to inject a rule at
 * runtime. A design system that injected styles would have forced
 * `'unsafe-inline'` here, and `style-src 'unsafe-inline'` is a meaningful
 * weakening — it is the vector for exfiltration through attribute selectors
 * and for a good deal of UI redressing.
 */
const POLICY = [
  "default-src 'none'",
  `script-src ${APP_ORIGIN}`,
  `style-src ${APP_ORIGIN}`,
  /*
   * `IMAGE_ORIGIN` and nothing wider. It is the only directive naming a second
   * origin, and it earns it: an image block's bytes are served from there by
   * main's protocol handler so they never ride on a snapshot.
   *
   * What this line actually stops is a remote fetch, and `bun run smoke`
   * measures exactly that by loading an `https:` image and requiring the
   * violation. It does *not* stop a fetch of another `bakepi:` host: Chromium
   * exempts a scheme registered through `registerSchemesAsPrivileged` from
   * this directive, which the same probe shows by loading an app-scheme image
   * that no policy admits and seeing no violation at all. The barrier there is
   * `installAppProtocol`, which answers 404 to every hostname but `app` and
   * `image`. The origin is still named here because it is the honest statement
   * of what the renderer may load, and because the day Chromium starts
   * enforcing it, a policy that had omitted it would go blank instead.
   */
  `img-src ${APP_ORIGIN} ${IMAGE_ORIGIN} data:`,
  `font-src ${APP_ORIGIN}`,
  `connect-src ${APP_ORIGIN} ws://127.0.0.1:*`,
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

export const installContentSecurityPolicy = (): void => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [POLICY],
        "X-Content-Type-Options": ["nosniff"],
      },
    })
  })

  // Nothing in this application needs a camera, a microphone, a location, or a
  // notification permission. Denying by default means a future feature has to
  // ask for its permission explicitly rather than inherit one.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}
