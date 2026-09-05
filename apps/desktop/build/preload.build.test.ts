import { describe, expect, test } from "bun:test"
import { assertCommonJsSyntax } from "./preload.build.ts"

describe("the preload CommonJS assertion", () => {
  test("accepts CommonJS and dynamic import syntax", () => {
    expect(() => assertCommonJsSyntax('"use strict";const electron=require("electron");import("optional")')).not.toThrow()
  })

  test("rejects minified static imports and exports", () => {
    expect(() => assertCommonJsSyntax('import{x}from"module";x()')).toThrow("CommonJS script syntax")
    expect(() => assertCommonJsSyntax("const x=1;export{x};")).toThrow("CommonJS script syntax")
    expect(() => assertCommonJsSyntax("export default function(){}")).toThrow("CommonJS script syntax")
  })

  test("does not mistake comments or strings for module syntax", () => {
    expect(() => assertCommonJsSyntax('// export { x }\nconst text="import x from y"')).not.toThrow()
  })
})
