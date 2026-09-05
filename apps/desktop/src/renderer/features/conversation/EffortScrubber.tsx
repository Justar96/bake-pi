import { useCallback, useEffect, useRef, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { ChevronDown } from "lucide-react"
import { colors, effects, motion, radius, space, typography } from "../../theme/tokens.stylex.ts"
import { focus } from "../../theme/focus.ts"
import { size } from "../../theme/sizes.stylex.ts"
import { EFFORT_HINTS, THINKING_LABELS, type ThinkingLevel } from "./thinking-level.ts"
import {
  EFFORT_FRAME_PITCH,
  effortFrameForKey,
  effortFrameScale,
  effortPointerPosition,
  effortStripWidth,
  effortTimecode,
  nearestEffortFrame,
  stepEffortSpring,
} from "./effort-scrubber.ts"

const FRAME_LABELS: Record<ThinkingLevel, string> = {
  off: "OF",
  minimal: "MI",
  low: "LO",
  medium: "MD",
  high: "HI",
  xhigh: "XH",
  max: "MX",
}

const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = (): void => { setReduced(query.matches) }
    query.addEventListener("change", update)
    return () => { query.removeEventListener("change", update) }
  }, [])
  return reduced
}

/** Interruptible physical motion for pointer release; tracking itself stays direct. */
const usePlayheadSpring = (initial: number, reduced: boolean): {
  position: number
  current: () => number
  settle: (from: number, target: number, animated: boolean) => void
} => {
  const [position, setPosition] = useState(initial)
  const state = useRef({ position: initial, velocity: 0 })
  const frame = useRef<number | undefined>(undefined)
  const current = useCallback((): number => state.current.position, [])

  const settle = useCallback((from: number, target: number, animated: boolean): void => {
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current)
    frame.current = undefined
    state.current = { position: from, velocity: 0 }
    setPosition(from)

    if (reduced || !animated || Math.abs(from - target) < 0.001) {
      state.current = { position: target, velocity: 0 }
      setPosition(target)
      return
    }

    let previous = performance.now()
    const tick = (now: number): void => {
      const seconds = Math.min((now - previous) / 1000, 0.032)
      previous = now
      const next = stepEffortSpring(state.current, target, seconds)
      state.current = next
      setPosition(next.position)
      if (Math.abs(next.position - target) < 0.001 && Math.abs(next.velocity) < 0.001) {
        state.current = { position: target, velocity: 0 }
        setPosition(target)
        frame.current = undefined
        return
      }
      frame.current = window.requestAnimationFrame(tick)
    }
    frame.current = window.requestAnimationFrame(tick)
  }, [reduced])

  useEffect(() => () => {
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current)
  }, [])

  return { position, current, settle }
}

/**
 * Thinking effort as a discrete filmstrip rather than another dropdown.
 *
 * Pointer movement previews continuously: the playhead follows the pointer and
 * nearby frames swell with transforms, so the row never reflows. Releasing
 * commits the nearest frame and lets the playhead settle with a physical
 * spring. Keyboard steps are deliberately instant — arrow keys are a frequent
 * input path, and motion there would make repeated stepping feel queued.
 */
export const EffortScrubber = ({ levels, value, onPick }: {
  levels: ThinkingLevel[]
  value: ThinkingLevel
  onPick: (level: ThinkingLevel) => Promise<void>
}): React.JSX.Element => {
  const trigger = useRef<HTMLButtonElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const request = useRef(0)
  const selectedFromProps = Math.max(0, levels.indexOf(value))
  const lastExternal = useRef(selectedFromProps)
  const committedRef = useRef(selectedFromProps)
  const [committed, setCommitted] = useState(selectedFromProps)
  const [preview, setPreview] = useState<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion()
  const spring = usePlayheadSpring(selectedFromProps, reduced)

  useEffect(() => {
    if (open) strip.current?.focus()
  }, [open])

  useEffect(() => {
    if (selectedFromProps === lastExternal.current) return
    lastExternal.current = selectedFromProps
    if (selectedFromProps === committedRef.current) return
    committedRef.current = selectedFromProps
    setCommitted(selectedFromProps)
    setPreview(undefined)
    spring.settle(spring.current(), selectedFromProps, false)
  }, [selectedFromProps, spring.settle])

  /**
   * The strip's left edge, measured once per gesture.
   *
   * `getBoundingClientRect` forces layout, and this ran on every `pointermove`
   * — plain hover included, since a mouse is let through without dragging —
   * interleaving a layout read with the transform writes each frame makes. The
   * strip cannot move while a pointer is down on it, so one measurement per
   * gesture is the same answer for less work. A miss falls back to a fresh
   * read rather than a stale one.
   */
  const stripLeft = useRef<number | undefined>(undefined)

  const measureStrip = (): number | undefined => {
    stripLeft.current = strip.current?.getBoundingClientRect().left
    return stripLeft.current
  }

  const positionAt = (clientX: number): number => {
    const left = stripLeft.current ?? measureStrip()
    return left === undefined ? committedRef.current : effortPointerPosition(clientX, left, levels.length)
  }

  const commit = (position: number, animated: boolean): void => {
    const next = nearestEffortFrame(position, levels.length)
    const level = levels[next]
    if (level === undefined) return
    setPreview(undefined)
    spring.settle(position, next, animated)
    if (next === committedRef.current) return

    const previous = selectedFromProps
    const generation = ++request.current
    committedRef.current = next
    setCommitted(next)
    void onPick(level).catch(() => {
      if (request.current !== generation) return
      committedRef.current = previous
      setCommitted(previous)
      spring.settle(spring.current(), previous, animated)
    })
  }

  const displayed = Math.max(0, Math.min(levels.length - 1, preview ?? spring.position))
  const selectedLevel = levels[committed] ?? value

  return (
    <div
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }}
      {...stylex.props(styles.root)}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Thinking"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${THINKING_LABELS[selectedLevel]} thinking`}
        onClick={() => setOpen((was) => !was)}
        {...stylex.props(focus.ring, styles.trigger, open && styles.triggerOpen)}
      >
        <span {...stylex.props(styles.triggerValue)}>{THINKING_LABELS[selectedLevel]}</span>
        <ChevronDown size={12} aria-hidden="true" {...stylex.props(styles.chevron, open && styles.chevronOpen)} />
      </button>
      {!open ? null : (
        <div role="dialog" aria-label="Thinking effort" {...stylex.props(styles.panel)}>
          <div
            ref={strip}
            role="slider"
        tabIndex={0}
            aria-label="Thinking effort frame"
            aria-valuemin={0}
        aria-valuemax={Math.max(0, levels.length - 1)}
        aria-valuenow={committed}
        aria-valuetext={THINKING_LABELS[selectedLevel]}
        title={`${THINKING_LABELS[selectedLevel]} thinking · ${EFFORT_HINTS[selectedLevel]}`}
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.focus()
          dragging.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
          measureStrip()
          setPreview(positionAt(event.clientX))
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== "mouse" && !dragging.current) return
          setPreview(positionAt(event.clientX))
        }}
        onPointerUp={(event) => {
          const position = positionAt(event.clientX)
          dragging.current = false
          stripLeft.current = undefined
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          commit(position, true)
        }}
        onPointerCancel={() => {
          dragging.current = false
          stripLeft.current = undefined
          const from = preview ?? spring.current()
          setPreview(undefined)
          spring.settle(from, committedRef.current, true)
        }}
        onPointerLeave={() => {
          stripLeft.current = undefined
          if (dragging.current || preview === undefined) return
          const from = preview
          setPreview(undefined)
          spring.settle(from, committedRef.current, true)
        }}
        onKeyDown={(event) => {
          const next = effortFrameForKey(committedRef.current, event.key, levels.length)
          if (next === undefined) return
          event.preventDefault()
          if (next !== committedRef.current) commit(next, false)
        }}
            {...stylex.props(focus.ring, styles.strip(effortStripWidth(levels.length)))}
          >
            {levels.map((level, index) => {
          const scale = reduced ? 1 : effortFrameScale(index, displayed)
          return (
            <span
              key={level}
              title={`${THINKING_LABELS[level]} · ${EFFORT_HINTS[level]}`}
              {...stylex.props(styles.frame, index === committed && styles.frameSelected, scale > 1.001 && styles.frameNear, styles.frameScale(scale))}
            >
              <span aria-hidden="true" {...stylex.props(styles.hole, styles.holeTop)} />
              <span {...stylex.props(styles.frameLabel)}>{FRAME_LABELS[level]}</span>
              <span aria-hidden="true" {...stylex.props(styles.hole, styles.holeBottom)} />
            </span>
          )
            })}
            <span aria-hidden="true" {...stylex.props(styles.playhead, styles.playheadPosition(displayed * EFFORT_FRAME_PITCH))}>
              <span {...stylex.props(styles.playheadLine)} />
            </span>
          </div>
          <output aria-label="Selected effort frame" {...stylex.props(styles.timecode)}>{effortTimecode(committed)}</output>
        </div>
      )}
    </div>
  )
}

const styles = stylex.create({
  root: { position: "relative", height: size.controlDense, flex: "none", display: "flex", alignItems: "center", whiteSpace: "nowrap" },
  trigger: { height: size.controlDense, maxWidth: "132px", display: "inline-flex", alignItems: "center", gap: space.xs, paddingInline: space.sm, color: { default: colors.text, ":hover": colors.text }, backgroundColor: { default: "transparent", ":hover": colors.surfaceOverlay }, borderWidth: 0, borderRadius: radius.md, boxShadow: { default: "none", ":hover": effects.lift, ":focus-visible": effects.focusState }, outline: "none", fontFamily: typography.ui, fontSize: typography.label, fontWeight: 500, cursor: "pointer" },
  triggerOpen: { boxShadow: { default: effects.liftRaised, ":focus-visible": effects.focusState } },
  triggerValue: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  chevron: { flex: "none", color: colors.textFaint, transitionProperty: "transform", transitionDuration: motion.fast, transitionTimingFunction: motion.settle },
  chevronOpen: { transform: "rotate(180deg)" },
  panel: { position: "absolute", insetInlineStart: 0, insetBlockEnd: `calc(100% + ${space.sm})`, zIndex: 3, display: "flex", alignItems: "center", gap: space.sm, padding: space.sm, color: colors.text, backgroundColor: colors.surfaceOverlay, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.lg, boxShadow: effects.liftOverlay },
  strip: (width: number) => ({ position: "relative", width, height: size.controlDense, boxSizing: "border-box", flex: "none", display: "flex", alignItems: "center", gap: "2px", padding: 0, color: colors.text, backgroundColor: colors.sunken, borderWidth: effects.hairline, borderStyle: "solid", borderColor: colors.borderStrong, borderRadius: radius.md, boxShadow: "none", outline: "none", cursor: "ew-resize", touchAction: "none", userSelect: "none" }),
  frame: { position: "relative", width: "22px", height: "20px", flex: "none", display: "grid", placeItems: "center", color: colors.textFaint, backgroundColor: colors.canvasSubtle, borderRadius: radius.sm, transformOrigin: "center", transitionProperty: "color, background-color", transitionDuration: motion.fast, transitionTimingFunction: motion.settle, willChange: "transform" },
  frameSelected: { color: colors.text, backgroundColor: colors.surfaceOverlay },
  frameNear: { zIndex: 1 },
  frameScale: (scale: number) => ({ transform: `scale(${String(scale)})` }),
  frameLabel: { fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  hole: { position: "absolute", insetInlineStart: "50%", width: "6px", height: "2px", transform: "translateX(-50%)", backgroundColor: colors.canvas, borderRadius: radius.sm },
  holeTop: { insetBlockStart: "1px" },
  holeBottom: { insetBlockEnd: "1px" },
  playhead: { pointerEvents: "none", position: "absolute", insetInlineStart: 0, insetBlockStart: "-2px", width: "22px", height: "32px", zIndex: 2, display: "grid", placeItems: "center", willChange: "transform" },
  playheadPosition: (offset: number) => ({ transform: `translateX(${String(offset)}px)` }),
  playheadLine: { width: "2px", height: "100%", backgroundColor: colors.accent, boxShadow: effects.liftRaised },
  timecode: { width: "64px", flex: "none", color: colors.text, fontFamily: typography.mono, fontSize: typography.micro, lineHeight: typography.microLine, fontVariantNumeric: "tabular-nums" },
})
