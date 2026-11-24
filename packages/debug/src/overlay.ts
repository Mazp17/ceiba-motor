import type { Engine, Plugin } from '@ceiba/core'
import type { ChunkId, Streamer, StreamerSnapshot } from '@ceiba/streaming'
import { layoutMap, STATE_COLORS } from './map.ts'
import { countStates, createFrameWindow, formatBytes, lateChunks, SHOWN_STATES, type ShownState } from './stats.ts'

/** Render counters of the last frame. `babylonStats(scene)` from `@ceiba/debug/babylon` provides them. */
export interface RenderStats {
  drawCalls: number
  triangles: number
  activeMeshes: number
}

/** What the streaming panel and the chunk map need. The streamer does not expose its own options, so they are repeated here. */
export interface StreamingDebug {
  streamer: Pick<Streamer, 'origin' | 'snapshot'>
  /** Metres per chunk side: `manifest.chunkSize`. */
  chunkSize: number
  /** The `gpuBudget` given to the streamer, in bytes. */
  gpuBudget: number
  /** The `ramBudget` given to the streamer, in bytes. */
  ramBudget: number
  /** The `loadRadius` given to the streamer. Default 2, the streamer's default. */
  loadRadius?: number
  /** The `unloadRadius` given to the streamer. Default 3, the streamer's default. */
  unloadRadius?: number
  /**
   * The focus, read when the map is drawn: the same scene position (metres relative to the origin) that
   * `streamer.update` receives, plus an optional heading in radians, 0 looking along +z and growing
   * towards +x (a Babylon `rotation.y`).
   */
  focus(): { x: number; z: number; heading?: number }
}

/** Options of `debugPlugin`. Everything is optional: without `renderStats` and `streaming` those panels are left out. */
export interface DebugOptions {
  /** URL query parameter that shows the overlay on install. Default `'debug'` (`?debug`). */
  param?: string
  /** `KeyboardEvent.code` of the key that shows and hides the overlay. Default `'Backquote'`. */
  toggleKey?: string
  /** Called a few times per second, after the frame is rendered. */
  renderStats?: () => RenderStats
  streaming?: StreamingDebug
}

/** The plugin, plus the handle to drive the overlay. */
export interface DebugPlugin extends Plugin {
  /** Whether the overlay is shown. Assign to show or hide it. */
  visible: boolean
  /** Adds a button that calls `run`. Works before and after install. */
  addAction(name: string, run: () => void): void
  /** Removes the systems, the listeners and the overlay element. */
  dispose(): void
}

const TEXT_MS = 250
const MAP_MS = 100
const MAP_SIZE = 220
/** A chunk that has been loading for longer than this is outlined as late. */
const LATE_MS = 1000
/** How long the origin cell stays filled after a shift. */
const FLASH_MS = 2000
const ORIGIN_COLOR = '#ff4dff'
const RADIUS_COLOR = '#5eead4'
const LATE_COLOR = '#ffffff'

/**
 * Creates the debug overlay plugin. Installed, it is hidden unless the URL has the `param` query
 * parameter; the toggle key shows and hides it. While hidden its two systems return after one check
 * and the overlay's DOM is not even created.
 */
export function debugPlugin(options: DebugOptions = {}): DebugPlugin {
  const { param = 'debug', toggleKey = 'Backquote', renderStats, streaming } = options
  const actions: [name: string, run: () => void][] = []
  const errors = new Map<string, unknown>()
  const frames = createFrameWindow()
  const loadingSince = new Map<string, number>()
  let engine: Engine | undefined
  let off = () => {}
  let ui: ReturnType<typeof build> | undefined
  let visible = false
  let lastFrame: number | undefined
  let textAt = -Infinity
  let mapAt = -Infinity
  // Fixed steps: in the frame being built, and summed / worst / frame count since the last text update.
  let steps = 0
  let stepSum = 0
  let stepMax = 0
  let frameCount = 0
  let snapshot: StreamerSnapshot | undefined
  let origin: ChunkId | undefined
  let focusChunk: ChunkId | undefined
  let shifts = 0
  let shiftedAt = -Infinity
  let late = 0

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, css = '', text = '') {
    const node = document.createElement(tag)
    node.style.cssText = css
    node.textContent = text
    parent.append(node)
    return node
  }

  function button(parent: HTMLElement, label: string, run: () => void) {
    const node = el('button', parent, 'font:inherit;margin:2px 4px 2px 0;cursor:pointer', label)
    node.type = 'button'
    node.onclick = run
  }

  function swatch(parent: HTMLElement, css: string, label: string) {
    const item = el('span', parent, 'display:inline-flex;align-items:center;gap:4px;margin-right:8px')
    el('span', item, `display:inline-block;box-sizing:border-box;width:10px;height:10px;${css}`)
    return el('span', item, '', label)
  }

  function build() {
    const root = el(
      'div',
      document.body,
      'position:fixed;top:0;left:0;z-index:99999;max-height:100vh;overflow:auto;padding:8px;' +
        'background:rgba(16,18,24,.85);color:#e6e6e6;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace',
    )
    const perf = el('div', root, 'white-space:pre')
    let stream: { budget: HTMLElement; info: HTMLElement; ctx: CanvasRenderingContext2D | null } | undefined
    const counts = {} as Record<ShownState, HTMLElement>
    if (streaming) {
      const budget = el('div', root, 'white-space:pre;margin-top:6px')
      const info = el('div', root, 'white-space:pre')
      const canvas = el('canvas', root, `display:block;width:${MAP_SIZE}px;height:${MAP_SIZE}px;margin:4px 0`)
      canvas.width = canvas.height = MAP_SIZE * devicePixelRatio
      const ctx = canvas.getContext('2d')
      ctx?.scale(devicePixelRatio, devicePixelRatio)
      const states = el('div', root, `max-width:${MAP_SIZE + 60}px`)
      for (const state of SHOWN_STATES) counts[state] = swatch(states, `background:${STATE_COLORS[state]}`, state)
      const marks = el('div', root, `max-width:${MAP_SIZE + 60}px`)
      swatch(marks, `border:2px solid ${ORIGIN_COLOR}`, 'origin')
      swatch(marks, `border:2px solid ${LATE_COLOR}`, `loading > ${LATE_MS / 1000} s`)
      swatch(marks, `border:1px solid ${RADIUS_COLOR}`, 'load radius')
      swatch(marks, `border:1px dashed ${RADIUS_COLOR}`, 'unload radius')
      stream = { budget, info, ctx }
    }
    const errorList = el('div', root)
    const actionList = el('div', root)
    for (const [name, run] of actions) button(actionList, name, run)
    return { root, perf, stream, counts, errorList, actionList }
  }

  function renderErrors() {
    if (!ui) return
    ui.errorList.replaceChildren()
    for (const [name, error] of errors) {
      const row = el('div', ui.errorList, 'color:#ff8a8a;margin-top:4px', `${name} disabled: ${String(error)} `)
      button(row, 're-enable', () => {
        engine?.enableSystem(name)
        errors.delete(name)
        renderErrors()
      })
    }
  }

  function writeText() {
    if (!ui) return
    const { fps, average, worst } = frames.stats()
    const lines = [
      `${fps.toFixed(0)} fps  frame ${average.toFixed(1)} ms avg  ${worst.toFixed(1)} ms worst`,
      `fixed steps/frame ${(stepSum / (frameCount || 1)).toFixed(1)} avg  ${stepMax} max`,
    ]
    stepSum = stepMax = frameCount = 0
    if (renderStats) {
      const { drawCalls, triangles, activeMeshes } = renderStats()
      lines.push(`draw calls ${drawCalls}  triangles ${Math.round(triangles)}  active meshes ${activeMeshes}`)
    }
    // Non-standard, Chromium only.
    const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
    if (heap !== undefined) lines.push(`JS heap ${formatBytes(heap)}`)
    ui.perf.textContent = lines.join('\n')

    if (!ui.stream || !streaming || !snapshot || !origin || !focusChunk) return
    const { budget, info } = ui.stream
    budget.textContent =
      `GPU ${formatBytes(snapshot.gpuBytes)} / ${formatBytes(streaming.gpuBudget)}  ` +
      `RAM ${formatBytes(snapshot.ramBytes)} / ${formatBytes(streaming.ramBudget)}` +
      (snapshot.overBudget ? '  OVER BUDGET' : '')
    budget.style.cssText = `white-space:pre;margin-top:6px;${snapshot.overBudget ? 'background:#ef4444;color:#fff;font-weight:bold' : ''}`
    const ago = ((performance.now() - shiftedAt) / 1000).toFixed(1)
    info.textContent =
      `focus ${focusChunk.cx},${focusChunk.cz}  origin ${origin.cx},${origin.cz}  late ${late}\n` +
      `origin shifts ${shifts}${shifts ? `  last ${ago} s ago` : ''}`
    const counts = countStates(snapshot.chunks)
    for (const state of SHOWN_STATES) ui.counts[state].textContent = `${state} ${counts[state]}`
  }

  function drawMap(now: number) {
    if (!streaming) return
    snapshot = streaming.streamer.snapshot()
    const current = streaming.streamer.origin
    if (origin && (origin.cx !== current.cx || origin.cz !== current.cz)) {
      shifts++
      shiftedAt = now
    }
    origin = current
    const lateKeys = lateChunks(loadingSince, snapshot.chunks, now, LATE_MS)
    late = lateKeys.size
    const { heading, ...position } = streaming.focus()
    const map = layoutMap({
      chunks: snapshot.chunks,
      origin,
      position,
      heading,
      chunkSize: streaming.chunkSize,
      loadRadius: streaming.loadRadius ?? 2,
      unloadRadius: streaming.unloadRadius ?? 3,
      size: MAP_SIZE,
    })
    focusChunk = map.focusChunk
    const ctx = ui?.stream?.ctx
    if (!ctx) return
    const outline = (square: { x: number; y: number; size: number }, color: string, width: number, dash: number[]) => {
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.setLineDash(dash)
      ctx.strokeRect(square.x + width / 2, square.y + width / 2, square.size - width, square.size - width)
    }
    ctx.fillStyle = '#0b0d12'
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE)
    for (const cell of map.cells) {
      ctx.fillStyle = STATE_COLORS[cell.state]
      ctx.fillRect(cell.x + 1, cell.y + 1, cell.size - 2, cell.size - 2)
      if (lateKeys.has(cell.key)) outline(cell, LATE_COLOR, 3, [])
    }
    outline(map.unload, RADIUS_COLOR, 1, [4, 3])
    outline(map.load, RADIUS_COLOR, 1, [])
    if (map.origin) {
      if (now - shiftedAt < FLASH_MS) {
        ctx.fillStyle = ORIGIN_COLOR
        ctx.fillRect(map.origin.x, map.origin.y, map.origin.size, map.origin.size)
      }
      outline(map.origin, ORIGIN_COLOR, 2, [])
    }
    const { x, y, dx, dy } = map.focus
    ctx.setLineDash([])
    ctx.strokeStyle = ctx.fillStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + dx * 14, y + dy * 14)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, 3.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  function setVisible(value: boolean) {
    if (value === visible) return
    visible = value
    if (visible) {
      ui ??= build()
      renderErrors()
      // The time spent hidden is not a frame, and both panels refresh on the next one.
      lastFrame = undefined
      textAt = mapAt = -Infinity
    }
    if (ui) ui.root.hidden = !visible
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.code === toggleKey) setVisible(!visible)
  }

  return {
    name: 'debug',
    get visible() {
      return visible
    },
    set visible(value) {
      setVisible(value)
    },
    install(core) {
      if (engine) throw new Error('@ceiba/debug is already installed')
      engine = core
      core.addSystem({
        name: 'debug:steps',
        phase: 'update',
        update() {
          if (visible) steps++
        },
      })
      core.addSystem({
        name: 'debug:overlay',
        phase: 'render',
        // After the scene is drawn, so the render counters are those of this frame.
        order: 1000,
        update() {
          if (!visible) return
          const now = performance.now()
          if (lastFrame !== undefined) frames.push(now - lastFrame)
          lastFrame = now
          stepSum += steps
          stepMax = Math.max(stepMax, steps)
          steps = 0
          frameCount++
          if (now - mapAt >= MAP_MS) {
            mapAt = now
            drawMap(now)
          }
          if (now - textAt >= TEXT_MS) {
            textAt = now
            writeText()
          }
        },
      })
      // Collected while hidden too, so a system that broke earlier is listed when the overlay opens.
      off = core.events.on('system:error', ({ system, error }) => {
        errors.set(system, error)
        renderErrors()
      })
      window.addEventListener('keydown', onKey)
      if (new URLSearchParams(location.search).has(param)) setVisible(true)
    },
    addAction(name, run) {
      actions.push([name, run])
      if (ui) button(ui.actionList, name, run)
    },
    dispose() {
      if (!engine) return
      engine.removeSystem('debug:steps')
      engine.removeSystem('debug:overlay')
      off()
      window.removeEventListener('keydown', onKey)
      ui?.root.remove()
      ui = undefined
      visible = false
      engine = undefined
    },
  }
}
