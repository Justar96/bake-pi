import { describe, expect, test } from "bun:test"
import { APP_SCHEME, IMAGE_HOST, imageUrl, parseImageUrl } from "./image-ref.ts"

/**
 * The builder and the parser are in one module so they cannot disagree; these
 * tests are what say so. A disagreement between them has no error path — the
 * host mints a URL, main answers 404, and the renderer draws a broken image
 * with nothing anywhere saying why.
 */
describe("image URLs", () => {
  test("what the host mints is what main reads back", () => {
    const ref = { sessionId: "session-7", messageIndex: 3, blockIndex: 1 }
    const url = imageUrl(ref)
    expect(url).toBe(`${APP_SCHEME}://${IMAGE_HOST}/session-7/3/1`)
    expect(parseImageUrl(new URL(url).pathname)).toEqual(ref)
  })

  test("a session id that needs escaping survives the round trip", () => {
    // Pi does not mint ids like this, but the parser is the boundary and a
    // boundary that only works on the ids seen so far is not one.
    const ref = { sessionId: "a b/c%d", messageIndex: 0, blockIndex: 0 }
    expect(parseImageUrl(new URL(imageUrl(ref)).pathname)).toEqual(ref)
  })

  test("zero is an index, not a missing one", () => {
    expect(parseImageUrl("/s/0/0")).toEqual({ sessionId: "s", messageIndex: 0, blockIndex: 0 })
  })

  test("anything that is not exactly one address is refused", () => {
    for (const pathname of [
      "/",
      "/s",
      "/s/1",
      "/s/1/2/3",
      "/s/1/2/",
      "//1/2",
      "/s/../2",
      "/s/1/-1",
      "/s/1/+1",
      "/s/1/1e3",
      "/s/1/01",
      "/s/1/1abc",
      "/s/1/ 1",
      "/s/1.5/2",
      "/%/1/2",
      `/${"s".repeat(129)}/1/2`,
    ]) {
      expect(parseImageUrl(pathname)).toBeUndefined()
    }
  })

  test("an index past what a session could hold is refused rather than coerced", () => {
    // Ten digits is the bound, so this is not a number the parser rounds or
    // turns into Infinity — it is a string it declines to read.
    expect(parseImageUrl("/s/99999999999/0")).toBeUndefined()
  })
})
