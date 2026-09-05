/**
 * Measures the real Electron process tree while the primary journey exercises
 * it, then drives the 10,000-block renderer fixture. This command is not part
 * of CI: it prints the machine it ran on and applies Milestone 3's renderer
 * budgets there, while the ordinary process figures remain observations.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { cpus, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import type { ResourceProcessSample, ResourceSample } from "../apps/desktop/src/main/observability/resources.ts"
import {
  LARGE_SESSION_BLOCKS,
  MAX_DROPPED_FRAME_PERCENT,
  MAX_FRAME_MS,
  MAX_RENDERER_WORKING_SET_KIB,
  summarizeFrames,
  type RendererFrameProbe,
} from "./frame-budget.ts"

const root = join(import.meta.dir, "..")
const temporary = mkdtempSync(join(tmpdir(), "bakepi-resources-"))
const output = join(temporary, "samples.jsonl")
const frameOutput = join(temporary, "renderer-frames.json")

const megabytes = (kibibytes: number): string => `${(kibibytes / 1024).toFixed(1)} MB`
const identity = (sample: ResourceProcessSample): string =>
  sample.name ?? sample.serviceName ?? sample.type

try {
  const journey = Bun.spawn(["bun", "run", "journey"], {
    cwd: root,
    env: {
      ...process.env,
      BAKE_PI_RESOURCE_OUT: output,
      BAKE_PI_RENDERER_BUDGET_OUT: frameOutput,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  const exit = await journey.exited
  if (exit !== 0) throw new Error(`the exercised journey exited ${String(exit)}`)

  const samples = readFileSync(output, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ResourceSample)
  if (samples.length === 0) throw new Error("the application wrote no resource samples")

  const seen = new Set(samples.flatMap((sample) => sample.processes.map((process) => process.type)))
  for (const required of ["Browser", "Tab", "Utility"] as const) {
    if (!seen.has(required)) throw new Error(`no ${required} process appeared in the resource samples`)
  }
  if (!samples.some((sample) => sample.processes.some((process) => process.name === "bake-pi-agent-host"))) {
    const identities = [...new Set(samples.flatMap((sample) => sample.processes
      .filter((process) => process.type === "Utility")
      .map((process) => `${process.name ?? "?"}|${process.serviceName ?? "?"}`)))]
    throw new Error(`the agent host was not identifiable by its utility-process name; saw [${identities.join(", ")}]`)
  }

  const probe = JSON.parse(readFileSync(frameOutput, "utf8")) as RendererFrameProbe
  if (probe.blockCount !== LARGE_SESSION_BLOCKS) {
    throw new Error(`the renderer fixture reported ${String(probe.blockCount)} blocks instead of ${String(LARGE_SESSION_BLOCKS)}`)
  }
  if (probe.lastVirtualIndex < LARGE_SESSION_BLOCKS - 1) {
    throw new Error(`the virtualized timeline reached only row ${String(probe.lastVirtualIndex)}`)
  }
  if (probe.mountedRows >= 200) {
    throw new Error(`virtualization mounted ${String(probe.mountedRows)} rows for ${String(LARGE_SESSION_BLOCKS)} blocks`)
  }
  const loadFrames = summarizeFrames(probe.loadFrameIntervalsMs)
  const frames = summarizeFrames(probe.frameIntervalsMs)

  const idleSample = [...samples].reverse().find((sample) => sample.processes.some((process) => process.type === "Tab"))
  const renderer = idleSample?.processes.find((process) => process.type === "Tab")
  if (renderer === undefined) throw new Error("the large-session idle sample has no renderer process")

  const byProcess = new Map<string, ResourceProcessSample[]>()
  for (const sample of samples) {
    for (const process of sample.processes) {
      const key = `${String(process.pid)}:${String(process.creationTime)}`
      const existing = byProcess.get(key)
      if (existing === undefined) byProcess.set(key, [process])
      else existing.push(process)
    }
  }

  console.log(`resource samples  ${String(samples.length)} over ${((samples.at(-1)?.elapsedMs ?? 0) / 1000).toFixed(1)} s`)
  for (const readings of byProcess.values()) {
    const latest = readings.at(-1)!
    const peakWorking = Math.max(...readings.map((reading) => reading.workingSetKiB))
    const peakPrivate = Math.max(...readings.map((reading) => reading.privateKiB ?? 0))
    const peakCpu = Math.max(...readings.map((reading) => reading.cpuPercent))
    console.log(
      `  ${latest.type.padEnd(7)} ${identity(latest).padEnd(26)} working ${megabytes(peakWorking).padStart(9)}`
      + `  private ${megabytes(peakPrivate).padStart(9)}  cpu ${peakCpu.toFixed(1).padStart(5)}%`,
    )
  }

  const peakTotal = Math.max(...samples.map((sample) =>
    sample.processes.reduce((total, process) => total + process.workingSetKiB, 0),
  ))
  console.log(`  peak process-tree working set  ${megabytes(peakTotal)}`)
  console.log(`renderer budget machine  ${cpus()[0]?.model ?? "unknown CPU"}, ${(totalmem() / 1024 ** 3).toFixed(1)} GiB, ${process.platform}/${process.arch}`)
  console.log(`  ${String(probe.blockCount)} blocks, ${String(probe.mountedRows)} mounted rows, last virtual row ${String(probe.lastVirtualIndex)}`)
  console.log(`  load frames: ${String(loadFrames.dropped)}/${String(loadFrames.frames)} dropped (${loadFrames.droppedPercent.toFixed(2)}%), longest ${loadFrames.longestMs.toFixed(2)} ms`)
  console.log(`  interaction cadence ${frames.cadenceMs.toFixed(2)} ms, ${String(frames.dropped)}/${String(frames.frames)} dropped (${frames.droppedPercent.toFixed(2)}%), longest ${frames.longestMs.toFixed(2)} ms`)
  console.log(`  slowest intervals ${[...probe.frameIntervalsMs].sort((left, right) => right - left).slice(0, 8).map((value) => `${value.toFixed(2)} ms`).join(", ")}`)
  console.log(`  idle renderer working set ${megabytes(renderer.workingSetKiB)}  private ${renderer.privateKiB === undefined ? "n/a" : megabytes(renderer.privateKiB)}`)

  if (frames.droppedPercent >= MAX_DROPPED_FRAME_PERCENT) {
    throw new Error(`renderer dropped ${frames.droppedPercent.toFixed(2)}% of frames; budget is under ${String(MAX_DROPPED_FRAME_PERCENT)}%`)
  }
  const longestFrame = Math.max(loadFrames.longestMs, frames.longestMs)
  if (longestFrame > MAX_FRAME_MS) {
    throw new Error(`renderer longest frame was ${longestFrame.toFixed(2)} ms; budget allows no frame over ${String(MAX_FRAME_MS)} ms`)
  }
  if (renderer.workingSetKiB >= MAX_RENDERER_WORKING_SET_KIB) {
    throw new Error(`idle renderer used ${megabytes(renderer.workingSetKiB)}; budget is under ${megabytes(MAX_RENDERER_WORKING_SET_KIB)}`)
  }
  console.log("renderer budgets ok")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
