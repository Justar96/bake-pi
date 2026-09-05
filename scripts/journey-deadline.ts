/**
 * Bounds a driver operation even when the renderer keeps its socket open but
 * never answers. The polling deadline cannot help while a single evaluation
 * is pending; this timer belongs to Bun rather than the page it is observing.
 *
 * A deadline is a failure, not a retry. Cancel its losing timer on either
 * outcome so a successful journey cannot stay alive waiting for its watchdogs.
 */
export const withJourneyDeadline = async <T>(work: Promise<T>, milliseconds: number, operation: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} did not finish within ${String(milliseconds)} ms`)), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
