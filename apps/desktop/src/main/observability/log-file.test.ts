import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogSink } from "./log-file.ts"

const scratch = (): string => mkdtempSync(join(tmpdir(), "bake-pi-log-"))

describe("the diagnostic log", () => {
  test("writes its banner and every later line into one file", () => {
    const directory = scratch()
    try {
      const sink = createLogSink(directory, "bake-pi 0.0.0-test")
      sink.write("host.stderr", "Error: the host could not start")

      const written = readFileSync(sink.path, "utf8").split("\n").filter((line) => line !== "")

      expect(sink.path).toBe(join(directory, "bake-pi.log"))
      expect(written).toHaveLength(2)
      expect(written[0]).toContain("log bake-pi 0.0.0-test")
      expect(written[1]).toContain("host.stderr Error: the host could not start")
      // Every line is datable, because the question asked of this file is
      // always "what happened just before it stopped".
      for (const line of written) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("keeps appending across runs, so a crash and the relaunch after it stay together", () => {
    const directory = scratch()
    try {
      createLogSink(directory, "first run").write("host.stdout", "before the crash")
      const second = createLogSink(directory, "second run")

      expect(readFileSync(second.path, "utf8")).toContain("before the crash")
      expect(readFileSync(second.path, "utf8")).toContain("second run")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rotates a log that grew past its ceiling rather than letting it grow forever", () => {
    const directory = scratch()
    try {
      const target = join(directory, "bake-pi.log")
      writeFileSync(target, "x".repeat(4 * 1024 * 1024 + 1))

      createLogSink(directory, "after rotation")

      expect(readFileSync(target, "utf8")).not.toContain("xxx")
      expect(readFileSync(target, "utf8")).toContain("after rotation")
      // The previous generation is kept: a crash loop would otherwise erase the
      // first failure, which is the one that explains the rest.
      expect(readFileSync(`${target}.1`, "utf8")).toContain("xxx")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
