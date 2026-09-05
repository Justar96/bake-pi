/**
 * Stands in for the agent host, and only in the way that matters here: it is a
 * real `utilityProcess` running Electron's embedded Node, and it reports what
 * time it thinks it is.
 *
 * Plain CommonJS and no imports beyond the parent port, because the question is
 * about the runtime rather than about anything Bake Pi does. Anything else in
 * here would only add ways for the answer to be wrong for an unrelated reason.
 */

/** The candidate cross-process clock: wall-anchored, but sub-millisecond. */
const wall = () => performance.timeOrigin + performance.now()

/**
 * The smallest non-zero step a clock actually reports.
 *
 * Measured rather than assumed, because it is the floor on every latency this
 * process could ever report: a clock that moves in 1 ms steps cannot describe a
 * 200 µs delay, however carefully it is read.
 */
const resolutionOf = (read) => {
  let smallest = Infinity
  for (let i = 0; i < 50_000; i += 1) {
    const a = read()
    let b = read()
    let spins = 0
    while (b === a && spins < 10_000) {
      b = read()
      spins += 1
    }
    if (b > a) smallest = Math.min(smallest, b - a)
  }
  return smallest
}

process.parentPort.on("message", (event) => {
  if (event.data === "resolution") {
    process.parentPort.postMessage({ wall: resolutionOf(wall), date: resolutionOf(() => Date.now()) })
    return
  }
  // Stamped as early as possible: work before the stamp makes the exchange more
  // asymmetric, widening the uncertainty around the offset estimate.
  process.parentPort.postMessage({ wall: wall(), date: Date.now() })
})
