import { app, type ProcessMetric } from "electron"
import { appendFile } from "node:fs/promises"

export type ResourceSampleLabel = "ready" | "command" | "runtime" | "shutdown"

export interface ResourceProcessSample {
  pid: number
  creationTime: number
  type: ProcessMetric["type"]
  cpuPercent: number
  workingSetKiB: number
  peakWorkingSetKiB: number
  privateKiB?: number
  name?: string
  serviceName?: string
}

export interface ResourceSample {
  label: ResourceSampleLabel
  elapsedMs: number
  main: Electron.ProcessMemoryInfo
  processes: ResourceProcessSample[]
}

const SAMPLE_INTERVAL_MS = 250

/**
 * Writes opt-in, real-Electron resource samples for `bun run resources`.
 *
 * The output path exists only in the probe process environment. Nothing here
 * reaches the renderer or a user session, and the sample vocabulary is closed:
 * paths, prompts and tool arguments cannot become labels by accident.
 */
export class ResourceProbe {
  readonly #output: string
  #timer: NodeJS.Timeout | undefined
  #writes: Promise<void> = Promise.resolve()

  constructor(output: string) {
    this.#output = output
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.sample("ready")
    this.#timer = setInterval(() => this.sample("runtime"), SAMPLE_INTERVAL_MS)
    this.#timer.unref()
  }

  sample(label: ResourceSampleLabel): void {
    if (!app.isReady()) return
    const elapsedMs = performance.now()
    const processes = app.getAppMetrics().map(projectMetric)
    this.#writes = this.#writes.then(async () => {
      const main = await process.getProcessMemoryInfo()
      const sample: ResourceSample = { label, elapsedMs, main, processes }
      await appendFile(this.#output, `${JSON.stringify(sample)}\n`, "utf8")
    }).catch((error: unknown) => {
      console.error("[main] could not write resource sample", error)
    })
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    this.sample("shutdown")
    await this.#writes
  }
}

const projectMetric = (metric: ProcessMetric): ResourceProcessSample => ({
  pid: metric.pid,
  creationTime: metric.creationTime,
  type: metric.type,
  cpuPercent: metric.cpu.percentCPUUsage,
  workingSetKiB: metric.memory.workingSetSize,
  peakWorkingSetKiB: metric.memory.peakWorkingSetSize,
  ...(metric.memory.privateBytes === undefined ? {} : { privateKiB: metric.memory.privateBytes }),
  ...(metric.name === undefined ? {} : { name: metric.name }),
  ...(metric.serviceName === undefined ? {} : { serviceName: metric.serviceName }),
})
