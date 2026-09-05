export interface PreventableQuit {
  preventDefault(): void
}

/** Awaits one cleanup operation before allowing Electron's quit to re-enter. */
export class QuitCoordinator {
  readonly #stop: () => Promise<void>
  readonly #quit: () => void
  readonly #onError: (error: unknown) => void
  #pending: Promise<void> | undefined
  #complete = false

  constructor(stop: () => Promise<void>, quit: () => void, onError: (error: unknown) => void) {
    this.#stop = stop
    this.#quit = quit
    this.#onError = onError
  }

  get quitting(): boolean {
    return this.#pending !== undefined
  }

  handle(event: PreventableQuit): void {
    if (this.#complete) return
    event.preventDefault()
    if (this.#pending !== undefined) return
    this.#pending = this.#stop()
      .catch((error: unknown) => this.#onError(error))
      .finally(() => {
        this.#complete = true
        this.#quit()
      })
  }

  async settled(): Promise<void> {
    await this.#pending
  }
}
