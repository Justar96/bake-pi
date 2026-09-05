import { useSyncExternalStore } from "react"
import type { ReadableView } from "./readable-view.ts"

/** The only React-specific part of the renderer projection boundary. */
export const useReadableView = <T,>(view: ReadableView<T>): T =>
  useSyncExternalStore(view.subscribe, view.getSnapshot)
