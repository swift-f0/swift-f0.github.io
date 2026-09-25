<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, triggerRef, watch, type Ref } from 'vue'
import { ONNXService, WorkerLostError, FMAX, FMIN, FRAME_PERIOD, SAMPLE_RATE } from '@/ONNXService'
import { segmentNotes, type Note } from '@/notes'
import { fitRange, medianPitch, midi, noteName, plotHeight, readout, renderPlot, tiles, voicedPitches, type Frames, type PlotHandle, type Range, type View } from '@/plot'
import { createPlayer, type Source } from '@/play'
import { startCapture, type Capture } from '@/live'
import { baseFileName, createMidiFile, exportJson, pitchTier, triggerDownload } from '@/exports'

const props = defineProps<{ active: boolean }>()
const emit = defineEmits<{ recording: [value: boolean] }>()

/* ---------- reactive state ---------- */
const isRecording = ref(false)
const isStarting = ref(false)
const isProcessing = ref(false)
const isLoadingModel = ref(true)
const modelReady = ref(false)
const showExtendedLoadingMessage = ref(false)
const loadStage = ref<'downloading' | 'preparing'>('downloading')

const error = ref<string | null>(null)

const frames = shallowRef<Frames | null>(null)
const notes = shallowRef<Note[]>([])
const view = ref<View>('notes')
const HOLD_STEPS = [20, 40, 80, 160, 320, 640, 1280]
const HOLD_TICKS = HOLD_STEPS.map(String)
const holdIndex = ref(2)
const pitchHoldMs = computed(() => HOLD_STEPS[holdIndex.value])
const holdOpen = ref(false)
const exportOpen = ref(false)
const exportBox = ref<HTMLDivElement | null>(null)
const exportButton = ref<HTMLButtonElement | null>(null)
const dragging = ref(false)
const holdButton = ref<HTMLButtonElement | null>(null)
const HOLD_PRESETS = [
  { label: 'Fast notes', index: 1 },
  { label: 'Default', index: 2 },
  { label: 'Slow notes', index: 3 },
  { label: 'Long notes', index: 5 },
]
// A preview shows 30 seconds, which is what a sparkline can show.
const PREVIEW_SECONDS = 30
const PREVIEW_WHOLE_SECONDS = 120
// The window shown is the stretch where the settings disagree most, so the sparklines show a
// difference when the recording has one. A take that is cut the same way everywhere says so.
const PREVIEW_WINDOWS = 24
const holdResults = shallowRef<{ frames: Frames; notes: Note[][]; window: { start: number; end: number } | null } | null>(null)
let holdRequest = 0
watch([holdOpen, frames], async () => {
  const f = frames.value
  if (!holdOpen.value || !f || !onnxService || isRecording.value || (holdResults.value?.frames === f && !holdResults.value.window)) return
  const id = ++holdRequest
  const total = f.pitch.length
  const width = Math.round(PREVIEW_SECONDS / FRAME_PERIOD)
  const whole = total * FRAME_PERIOD <= PREVIEW_WHOLE_SECONDS
  const first = whole ? 0 : Math.max(0, Math.min(total - width, Math.round(now.value / FRAME_PERIOD) - width / 2))
  const last = whole ? total : first + width
  const part = (values: ArrayLike<number>) => Array.from({ length: last - first }, (_, i) => values[first + i])
  try {
    const found = await onnxService.segment(part(f.pitch), part(f.conf), part(f.loud), HOLD_PRESETS.map(preset => HOLD_STEPS[preset.index]))
    const offset = first * FRAME_PERIOD
    const shifted = found.map(list => list.map(n => ({ ...n, start: n.start + offset, end: n.end + offset })))
    if (id === holdRequest) holdResults.value = { frames: f, notes: shifted, window: whole ? null : { start: offset, end: last * FRAME_PERIOD } }
  } catch (err) {
    if (id === holdRequest) reportError(getDetailedErrorMessage(err), 'segmentation', err)
  }
})
const previewRange = computed(() => {
  const held = holdResults.value?.frames === frames.value ? holdResults.value : null
  const results = held?.notes
  const f = frames.value
  if (!held || !results || !f) return null
  if (held.window) return held.window
  const total = f.pitch.length * FRAME_PERIOD
  const width = Math.min(total, PREVIEW_SECONDS)
  if (total <= width) return { start: 0, end: total }
  const inside = (found: Note[], start: number) => found.filter(n => n.end > start && n.start < start + width).length
  let best = { start: 0, end: width, spread: -1 }
  for (let i = 0; i <= PREVIEW_WINDOWS; i++) {
    const start = (i * (total - width)) / PREVIEW_WINDOWS
    const spread = inside(results[0], start) - inside(results[2], start)
    if (spread > best.spread) best = { start, end: start + width, spread }
  }
  return best
})

const holdPreviews = computed(() => {
  if (!holdOpen.value) return []
  const results = holdResults.value?.frames === frames.value ? holdResults.value.notes : null
  const range = previewRange.value
  if (!results || !range) return []
  const span = Math.max(FRAME_PERIOD, range.end - range.start)
  return HOLD_PRESETS.map((preset, k) => {
    const shown = results[k].filter(n => n.end > range.start && n.start < range.end)
    const pitches = shown.map(n => midi(n.pitch_hz))
    const lo = pitches.length ? Math.min(...pitches) : 60
    const hi = Math.max(lo + 4, ...pitches)
    return {
      ...preset,
      count: results[k].length,
      scope: holdResults.value?.window ? ` in ${PREVIEW_SECONDS} s` : '',
      bars: shown.map(n => {
        const start = Math.max(n.start, range.start)
        const end = Math.min(n.end, range.end)
        return {
          x: (100 * (start - range.start)) / span,
          w: Math.max(1.2, (100 * (end - start)) / span),
          y: 2 + 13 * (1 - (midi(n.pitch_hz) - lo) / (hi - lo)),
        }
      }),
    }
  })
})

const appliedHold = ref(HOLD_STEPS[2])
const isSegmenting = ref(false)
const holdText = computed(() => `${pitchHoldMs.value} ms${isSegmenting.value ? ' …' : ''}`)
const holdBox = ref<HTMLDivElement | null>(null)
const fmin = ref(FMIN)
const fmax = ref(FMAX)
const rangeOpen = ref(false)
const rangeBox = ref<HTMLDivElement | null>(null)
const rangeButton = ref<HTMLButtonElement | null>(null)
const draftMin = ref(String(FMIN))
const draftMax = ref(String(FMAX))
const rangeNote = ref('')
// The band the frames on screen were computed with, which trails the control while a run is in
// flight and is what the exports report.
const appliedRange = ref<[number, number]>([FMIN, FMAX])
let pendingRange: [number, number] | null = null
const rangeText = computed(() => {
  return `${Math.round(fmin.value)}\u2013${Math.round(fmax.value)} Hz`
})
const RANGE_PRESETS = [
  { label: 'Full range', low: FMIN, high: FMAX },
  { label: 'Speech', low: 75, high: 500 },
  { label: 'Singing', low: 70, high: 1180 },
  { label: 'High instruments', low: 175, high: FMAX },
]

function pickRange(low: number, high: number) {
  draftMin.value = String(low)
  draftMax.value = String(high)
  rangeNote.value = ''
  fmin.value = low
  fmax.value = high
}

const popovers: (() => void)[] = []

function popover(open: Ref<boolean>, box: Ref<HTMLElement | null>, button: Ref<HTMLButtonElement | null>, dismiss = () => {}) {
  const close = (focus = false) => {
    if (!open.value) return
    open.value = false
    if (focus) button.value?.focus()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close(true)
  }
  const onOutside = (event: PointerEvent) => {
    if (!(event.target instanceof Node) || box.value?.contains(event.target)) return
    dismiss()
    close()
  }
  watch(open, isOpen => {
    if (isOpen) {
      document.addEventListener('keydown', onKey)
      document.addEventListener('pointerdown', onOutside)
    } else {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onOutside)
    }
  })
  popovers.push(close)
  const toggle = () => {
    if (open.value) {
      dismiss()
      close()
      return
    }
    for (const other of popovers) other()
    open.value = true
  }
  return { toggle, close }
}

const { toggle: toggleHold } = popover(holdOpen, holdBox, holdButton)
const { toggle: toggleRange, close: closeRange } = popover(rangeOpen, rangeBox, rangeButton, () => {
  applyRange()
})
const { toggle: toggleExport, close: closeExport } = popover(exportOpen, exportBox, exportButton)

watch(rangeOpen, open => {
  if (!open) return
  draftMin.value = String(fmin.value)
  draftMax.value = String(fmax.value)
  rangeNote.value = ''
})

function applyRange() {
  if (!String(draftMin.value).trim() || !String(draftMax.value).trim()) {
    rangeNote.value = 'Enter both frequencies.'
    return false
  }
  const low = Math.max(FMIN, Number(draftMin.value))
  const high = Math.min(FMAX, Number(draftMax.value))
  if (Number.isNaN(low) || Number.isNaN(high)) return false
  if (!(high >= low * (FMAX / FMIN) ** (1 / 94))) {
    rangeNote.value = 'The upper limit must be at least 4 % above the lower one.'
    return false
  }
  fmin.value = low
  fmax.value = high
  return true
}

let refocusRange = false

function commitRange() {
  if (!applyRange()) return
  refocusRange = true
  closeRange(true)
}

const sources = ref({ original: true, piano: true })
const hoverTip = ref<{ x: number; y: number; rows: [string, string][] } | null>(null)
const now = ref(0)
const playing = ref(false)
const sourceName = ref<string | null>(null)
const fileStem = ref<string | null>(null)
const sourceChannels = ref<'mono' | 'stereo'>('mono')
const pendingName = ref<string | null>(null)
const takePeak = ref(0)
const plotWidth = ref(0)
const plotBox = ref(0)
const svgRef = ref<SVGSVGElement | null>(null)
const plotRef = ref<HTMLDivElement | null>(null)
const liveSeconds = ref(0)

const modelLoadStartTime = ref<number | null>(null)
const elapsedLoadTime = ref(0)
let loadTimerInterval: ReturnType<typeof setInterval> | null = null
let extendedMessageTimeout: ReturnType<typeof setTimeout> | null = null

let onnxService: ONNXService | null = null
let take: Float32Array | null = null
let capture: Capture | null = null
let liveTimer: ReturnType<typeof setInterval> | null = null
let liveBusy = false
let liveSession = 0
let runId = 0
let loadId = 0
let plot: PlotHandle | null = null
let liveRange: Range | null = null
let liveRangeAt = 0
let recordingCount = 0
let resizeObserver: ResizeObserver | null = null

const player = createPlayer(
  (t) => {
    now.value = t
    plot?.setNow(t)
  },
  () => {
    playing.value = false
  },
)

/* ---------- constants ---------- */
// Two tiers from the measured memory: a 15 minute take peaks near 1 GB with windowed inference,
// while a phone with 4 GB or less dies between 4 and 9 minutes.
const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory
// Firefox and Safari never report the memory, and a touch screen alone says nothing about it,
// so an unknown memory only counts as small when the pointer is coarse and the screen is small.
const smallDevice =
  deviceMemory !== undefined
    ? deviceMemory <= 4
    : window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820
const MAX_AUDIO_DURATION_SECONDS = smallDevice ? 300 : 900
const WARN_AUDIO_DURATION_SECONDS = smallDevice ? 120 : 300
const MAX_READABLE_BYTES = (smallDevice ? 100 : 300) * 1024 * 1024
const MAX_TRUNCATABLE_SECONDS = smallDevice ? 0 : 1800
const LIVE_WINDOW_SECONDS = 6
const LIVE_LOOKAHEAD_FRAMES = 10
const LIVE_LEFT_FRAMES = 11
const LIVE_SPAN_FRAMES = 125
const LIVE_INTERVAL_MS = 100
const LIVE_NOTES_FRAMES = 500

const maxAudioDurationMinutes = computed(() => MAX_AUDIO_DURATION_SECONDS / 60)
const maxFileSizeMB = computed(() => MAX_READABLE_BYTES / 1024 / 1024)
const truncateOffer = ref<{ file: File; duration: number } | null>(null)
const truncatedFrom = ref<number | null>(null)
const analysisProgress = ref(0)
const outOfMemory = ref(false)
const analysisSeconds = ref(0)
const mmss = (seconds: number) => {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
const limitText = computed(() => `The demo handles up to ${maxAudioDurationMinutes.value} minutes${smallDevice ? ' on this device' : ''}.`)

// The header gives the duration without decoding, which is the spike the limit exists to prevent.
function probeDuration(file: File): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const el = new Audio()
    let settled = false
    const done = (value: number | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(value)
    }
    el.preload = 'metadata'
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null)
    el.onerror = () => done(null)
    setTimeout(() => done(null), 5000)
    el.src = url
  })
}

/* ---------- computed properties ---------- */
const hasData = computed(() => !!frames.value && frames.value.pitch.length > 0)
const duration = computed(() => (frames.value ? frames.value.pitch.length * FRAME_PERIOD : 0))
const figures = computed(() => tiles(frames.value ?? { pitch: [], conf: [], loud: [] }, notes.value))
const liveClock = computed(() => `${Math.floor(liveSeconds.value / 60)}:${(liveSeconds.value % 60).toFixed(1).padStart(4, '0')}`)
const liveCap = computed(() => (liveSeconds.value > MAX_AUDIO_DURATION_SECONDS - 60 ? `stops at ${mmss(MAX_AUDIO_DURATION_SECONDS)}` : null))
const voicedCount = computed(() => (frames.value ? voicedPitches(frames.value).length : 0))
const hasNotes = computed(() => notes.value.length > 0)
const showResults = computed(() => hasData.value && !isRecording.value)
const liveReadout = computed(() => {
  const f = frames.value
  if (!isRecording.value || !f || !f.pitch.length) return { main: '...', small: '', low: true }
  const i = f.pitch.length - 1
  return readout(f.pitch[i], f.conf[i], view.value, medianPitch(f))
})
const playSource = computed<Source>(() => (!hasNotes.value || !sources.value.piano ? 'original' : sources.value.original ? 'both' : 'piano'))
const originalOn = computed(() => sources.value.original || !hasNotes.value)
const canPlay = computed(() => hasData.value && !isRecording.value && !isProcessing.value && (originalOn.value || sources.value.piano))
const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`
const nowText = computed(() => {
  const f = frames.value
  if (!f || !hasData.value) return ''
  const note = notes.value.find((n) => now.value >= n.start && now.value < n.end)
  if (note) return `${noteName(midi(note.pitch_hz))} ${note.pitch_hz.toFixed(0)} Hz`
  const i = Math.min(f.pitch.length - 1, Math.floor(now.value / FRAME_PERIOD))
  return i >= 0 && f.conf[i] >= 0.5 && f.pitch[i] > 0 ? `${f.pitch[i].toFixed(0)} Hz` : ''
})
const canExport = computed(() => hasData.value && !isRecording.value && !isProcessing.value)
const inputsBusy = computed(() => isLoadingModel.value || !modelReady.value || isProcessing.value || isStarting.value)
const loadingMessage = computed(() => `${loadStage.value === 'downloading' ? 'Loading pitch detector' : 'Preparing pitch detector'}${showExtendedLoadingMessage.value ? ` · ${elapsedLoadTime.value} s` : ''}…`)
const processingMessage = computed(() => {
  if (!isProcessing.value) return null
  const name = pendingName.value ?? 'the recording'
  if (analysisProgress.value > 0) return `Analyzing ${name}, ${Math.round(100 * analysisProgress.value)} %`
  if (analysisSeconds.value > WARN_AUDIO_DURATION_SECONDS) {
    const estimate = Math.max(1, Math.round((analysisSeconds.value * (onnxService?.msPerSecond ?? 18)) / 1000))
    return `Analyzing ${name}, ${mmss(analysisSeconds.value)} long. About ${estimate} seconds.`
  }
  return `Analyzing ${name}`
})
const facts = computed(() => {
  if (isRecording.value) return { name: 'Recording', rest: `${liveClock.value} · mono` }
  const f = frames.value
  if (!f || !hasData.value || !sourceName.value) return null
  const level = takePeak.value > 0 ? `peak ${String(Math.round(20 * Math.log10(takePeak.value))).replace('-', '\u2212')} dBFS` : 'silent'
  return {
    name: sourceName.value,
    rest: `${truncatedFrom.value ? `first ${mmss(duration.value)} of ${mmss(truncatedFrom.value)}` : `${duration.value.toFixed(2)} s`} · ${sourceChannels.value} · ${level} · ${Math.round((100 * voicedCount.value) / f.pitch.length)} % voiced`,
  }
})
const emptyMessage = computed(() => {
  if (isRecording.value || isProcessing.value) return null
  if (!hasData.value) {
    return {
      main: 'Record, upload or drop a file here.',
      small: isLoadingModel.value ? loadingMessage.value : `up to ${maxAudioDurationMinutes.value} minutes`,
    }
  }
  if (voicedCount.value > 0) return null
  const peakDb = 20 * Math.log10(takePeak.value)
  const small =
    duration.value < 0.5
      ? `too short (${duration.value.toFixed(2)} s)`
      : takePeak.value === 0
        ? 'silent'
        : peakDb < -30
        ? `very quiet (peak ${peakDb.toFixed(0).replace('-', '\u2212')} dBFS)`
        : appliedRange.value[0] > FMIN || appliedRange.value[1] < FMAX
          ? `no periodic signal inside the range ${Math.round(appliedRange.value[0])}\u2013${Math.round(appliedRange.value[1])} Hz, or noise, chords or silence`
          : 'no periodic signal: noise, chords or silence'
  return { main: `No voiced pitch found in ${sourceName.value ?? 'the recording'}.`, small }
})

/* ---------- rendering ---------- */
function render() {
  if (!props.active || !svgRef.value || plotWidth.value <= 80) return
  plot = renderPlot(svgRef.value, {
    frames: frames.value ?? { pitch: [], conf: [], loud: [] },
    notes: notes.value,
    view: view.value,
    now: now.value,
    live: isRecording.value,
    window: LIVE_WINDOW_SECONDS,
    width: plotWidth.value,
    height: plotBox.value > 160 ? plotBox.value : plotHeight(plotWidth.value),
    range: isRecording.value ? liveRange : null,
  })
}

watch([frames, notes, view, plotWidth, plotBox, isRecording], render, { flush: 'post' })
watch(isRecording, value => emit('recording', value))
watch(() => props.active, async active => {
  if (!active) {
    unhover()
    player.stop()
    playing.value = false
    return
  }
  await nextTick()
  measurePlot()
  render()
})
watch(view, () => {
  liveRange = null
})

// The range is an input to the model, not a view of the result, so it re-runs the search over the
// same audio. The worker does not serialise requests, so a change made during a run waits for the
// run to finish instead of racing it, and the last band asked for is the one that lands.
watch([fmin, fmax], () => {
  liveRange = null
  pendingRange = [fmin.value, fmax.value]
  void drainRange()
})

watch(isProcessing, async busy => {
  if (busy) return
  await drainRange()
  if (!refocusRange || isProcessing.value) return
  refocusRange = false
  await nextTick()
  if (document.activeElement === document.body) rangeButton.value?.focus()
})

watch(isRecording, recording => {
  if (recording) for (const close of popovers) close()
  else void drainRange()
})
let segmentAgain = false
async function resegment() {
  if (isSegmenting.value) {
    segmentAgain = true
    return
  }
  isSegmenting.value = true
  try {
    do {
      segmentAgain = false
      const f = frames.value
      const hold = pitchHoldMs.value
      if (!take || !f || !onnxService || isRecording.value || hold === appliedHold.value) break
      player.stop()
      playing.value = false
      const [found] = await onnxService.segment(f.pitch, f.conf, f.loud, [hold])
      if (frames.value === f) {
        notes.value = found
        appliedHold.value = hold
      } else {
        segmentAgain = true
      }
    } while (segmentAgain)
  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'segmentation', err)
  } finally {
    isSegmenting.value = false
  }
}
watch(pitchHoldMs, () => void resegment())

async function restartPlayback() {
  if (!frames.value) return
  try {
    await player.start(notes.value, duration.value, now.value, take, playSource.value)
  } catch (err) {
    playing.value = false
    reportError(getDetailedErrorMessage(err), 'playback', err)
  }
}

function toggleSource(key: 'original' | 'piano') {
  const other = key === 'original' ? 'piano' : 'original'
  if (!hasNotes.value) return
  if (sources.value[key] && !sources.value[other]) return
  sources.value = { ...sources.value, [key]: !sources.value[key] }
  if (playing.value) void restartPlayback()
}

/* ---------- analysis ---------- */
function resetAnalysis() {
  runId++
  player.stop()
  playing.value = false
  frames.value = null
  notes.value = []
  take = null
  now.value = 0
}

async function analyzeSamples(samples: Float32Array, name: string, stem: string, channels: 'mono' | 'stereo') {
  const id = ++runId
  analysisSeconds.value = samples.length / SAMPLE_RATE
  await onnxService!.setAudio(samples)
  const band: [number, number] = [fmin.value, fmax.value]
  const hold = pitchHoldMs.value
  const result = await onnxService!.run(hold, band[0], band[1], fraction => {
    if (id === runId) analysisProgress.value = fraction
  })
  if (id !== runId) return
  appliedRange.value = band
  player.stop()
  playing.value = false
  frames.value = { pitch: result.pitch_hz, conf: result.confidence, loud: result.loudness_db }
  notes.value = result.notes
  appliedHold.value = hold
  take = samples
  sourceName.value = name
  fileStem.value = stem
  sourceChannels.value = channels
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  takePeak.value = peak
  now.value = 0
  void resegment()
}

async function drainRange() {
  while (pendingRange && take && onnxService && modelReady.value && !isRecording.value && !isProcessing.value) {
    const band = pendingRange
    pendingRange = null
    if (band[0] === appliedRange.value[0] && band[1] === appliedRange.value[1]) continue
    await rerunAnalysis(band)
  }
}

async function rerunAnalysis(band: [number, number]) {
  const id = ++runId
  const samples = take!
  isProcessing.value = true
  pendingName.value = sourceName.value
  analysisProgress.value = 0
  player.stop()
  playing.value = false
  try {
    await onnxService!.setAudio(samples)
    const hold = pitchHoldMs.value
    const result = await onnxService!.run(hold, band[0], band[1], fraction => {
      if (id === runId) analysisProgress.value = fraction
    })
    if (id !== runId) return
    frames.value = { pitch: result.pitch_hz, conf: result.confidence, loud: result.loudness_db }
    notes.value = result.notes
    appliedHold.value = hold
    appliedRange.value = band
    void resegment()
  } catch (err: any) {
    if (id === runId) reportError(getDetailedErrorMessage(err), 'pitch_range', err)
  } finally {
    if (id === runId) {
      isProcessing.value = false
      pendingName.value = null
      analysisProgress.value = 0
    }
  }
}

async function stopLive() {
  if (liveTimer) clearInterval(liveTimer)
  liveTimer = null
  liveSession++
  liveBusy = false
  const finished = capture ? capture.stop() : null
  capture = null
  isRecording.value = false
  return finished
}

function reportError(message: string, location: string, err: any = null) {
  error.value = message;
  // The wasm arena is never returned to the system, so a fresh worker is the only way back.
  if (outOfMemory.value) {
    outOfMemory.value = false
    onnxService?.terminate()
    modelReady.value = false
    void loadModel()
  }
  if (workerLost(err)) modelReady.value = false
  if (err) {
    console.error(`Error at ${location}:`, err);
  } else {
    console.error(`Error at ${location}: ${message}`);
  }
  void stopLive().catch(() => {})
}

function getDetailedErrorMessage(err: any, name: string | null = null, seconds: number | null = null): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return 'Microphone access denied. Please grant microphone permissions and try again. Check your browser settings.';
    }
    if (err.name === 'NotFoundError') {
      return 'No microphone found. Please ensure a microphone is connected and enabled.';
    }
    if (err.name === 'AbortError') {
      return 'Microphone access was aborted. This might happen if the device is already in use.';
    }
    if (err.name === 'OverconstrainedError') {
      return 'Microphone constraints could not be satisfied. Your microphone might not support mono recording.';
    }
    if (err.name === 'InvalidStateError') {
      return 'Recording state error. The recorder might be in an unexpected state. Try refreshing.';
    }
    if (err.name === 'SecurityError') {
      return 'Security error related to microphone access. Ensure you are on a secure context (HTTPS).';
    }
  }

  if (err instanceof Error) {
    const message = err.message.toLowerCase()

    // ONNX Runtime reports an exhausted wasm heap as a bare "Aborted()", which is not a message
    // anyone can act on, so every out-of-memory shape maps to the same advice.
    if (message.includes('maximum call stack') || message.includes('out of memory') || message.includes('memory') || message.includes('aborted') || err instanceof RangeError) {
      outOfMemory.value = true
      const length = seconds !== null ? ` This file is ${mmss(seconds)} long.` : ''
      return `The browser ran out of memory.${length} ${limitText.value} Reload the page to free the memory.`
    }

    if (err.name === 'EncodingError' || message.includes('decode') || message.includes('invalid') || message.includes('bad audio data')) {
      return name ? `Could not read ${name}. Upload a WAV, MP3, M4A, FLAC or OGG file.` : 'Invalid audio format or corrupt file. Please upload a valid audio file (MP3, WAV, M4A, etc.).'
    }

    if (message.includes('network') || message.includes('fetch') || message.includes('failed to load')) {
      return 'Network error. Please check your internet connection and try again.'
    }

    if (message.includes('audio data recorded') || message.includes('empty audio data')) {
      return 'No audio data captured. Please ensure your microphone is working and record for a longer duration. If problem persists, check microphone permissions.'
    }

    return err.message
  }

  return 'An unexpected error occurred. Please try again.'
}

/* ---------- audio processing ---------- */
async function handleAudioBuffer(audioBuffer: ArrayBuffer, sourceFileName: string, limitSeconds: number | null, load: number) {
  if (!onnxService?.ready) {
    reportError('The model is not loaded. Reload it and try again.', 'audio_processing_init_error');
    isProcessing.value = false;
    return
  }

  error.value = null

  let decodedSeconds: number | null = null
  try {
    const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(audioBuffer)
    if (load !== loadId) return
    decodedSeconds = decoded.duration
    if (decoded.sampleRate !== SAMPLE_RATE) {
      throw new Error(`Decoded audio has sample rate ${decoded.sampleRate}, expected ${SAMPLE_RATE}`)
    }

    if (limitSeconds === null && decoded.duration > MAX_AUDIO_DURATION_SECONDS) {
      reportError(`This recording is ${mmss(decoded.duration)} long. ${limitText.value}`, 'audio_duration_limit')
      isProcessing.value = false
      return
    }

    if (decoded.length === 0) {
      reportError(`${sourceFileName} contains no audio.`, 'audio_processing')
      return
    }
    const mono = decoded.getChannelData(0).slice()
    for (let c = 1; c < decoded.numberOfChannels; c++) {
      const channel = decoded.getChannelData(c)
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i]
    }
    if (decoded.numberOfChannels > 1) {
      for (let i = 0; i < mono.length; i++) mono[i] /= decoded.numberOfChannels
    }
    const limited = limitSeconds !== null && decoded.duration > limitSeconds
    truncatedFrom.value = limited ? decoded.duration : null
    const samples = limited ? mono.slice(0, Math.floor(limitSeconds * SAMPLE_RATE)) : mono
    await analyzeSamples(samples, sourceFileName, sourceFileName, decoded.numberOfChannels > 1 ? 'stereo' : 'mono')
  } catch (err: any) {
    if (load === loadId) reportError(getDetailedErrorMessage(err, sourceFileName, decodedSeconds), 'audio_processing', err)
  } finally {
    if (load === loadId) isProcessing.value = false
  }
}

/* ---------- recording ---------- */
async function liveStep() {
  if (capture && isRecording.value && capture.seconds() >= MAX_AUDIO_DURATION_SECONDS) {
    await stopRecording()
    reportError(`Recording stopped at ${mmss(MAX_AUDIO_DURATION_SECONDS)}. ${limitText.value}`, 'recording_duration_limit')
    return
  }
  if (!capture || !onnxService || liveBusy || !frames.value) return
  const session = liveSession
  const totalSamples = Math.floor(capture.seconds() * SAMPLE_RATE)
  const available = Math.floor(totalSamples / 256)
  const finalEnd = available - LIVE_LOOKAHEAD_FRAMES
  const shown = frames.value.pitch.length
  if (finalEnd <= shown) return
  // Include every unseen frame, with left context, even after capture outruns inference.
  const firstFrame = Math.max(0, Math.min(available - LIVE_SPAN_FRAMES, shown - LIVE_LEFT_FRAMES))
  liveBusy = true
  try {
    const result = await onnxService.live(capture.take(firstFrame * 256, available * 256), fmin.value, fmax.value)
    if (session !== liveSession || !frames.value) return
    const pitch = frames.value.pitch as number[]
    const conf = frames.value.conf as number[]
    const loud = frames.value.loud as number[]
    for (let k = shown; k < finalEnd; k++) {
      pitch.push(result.pitch[k - firstFrame])
      conf.push(result.confidence[k - firstFrame])
      loud.push(result.loudness[k - firstFrame])
    }
    liveSeconds.value = finalEnd * FRAME_PERIOD
    const voiced = voicedPitches(frames.value)
    if (!liveRange || performance.now() - liveRangeAt > 1000 || voiced[0] < 2 ** liveRange.lo || voiced[voiced.length - 1] > 2 ** liveRange.hi) {
      liveRange = fitRange(voiced, view.value)
      liveRangeAt = performance.now()
    }
    const tailStart = Math.max(0, finalEnd - LIVE_NOTES_FRAMES)
    const offset = tailStart * FRAME_PERIOD
    notes.value = segmentNotes(pitch.slice(tailStart, finalEnd), conf.slice(tailStart, finalEnd), loud.slice(tailStart, finalEnd), pitchHoldMs.value).map((n) => ({
      ...n,
      start: n.start + offset,
      end: n.end + offset,
    }))
    triggerRef(frames)
  } catch (err: any) {
    if (session === liveSession) {
      resetAnalysis()
      reportError(getDetailedErrorMessage(err), 'recording_error', err)
    }
  } finally {
    if (session === liveSession) liveBusy = false
  }
}

async function recordAudio() {
  if (isRecording.value || isStarting.value || isProcessing.value || !onnxService?.ready) return
  loadId++
  error.value = null
  isStarting.value = true
  try {
    capture = await startCapture(() => {})
  } catch (err) {
    isStarting.value = false
    reportError(getDetailedErrorMessage(err), 'microphone_access', err)
    return
  }
  resetAnalysis()
  sourceName.value = null
  liveSeconds.value = 0
  liveSession++
  liveBusy = false
  liveRange = null
  frames.value = { pitch: [], conf: [], loud: [] }
  notes.value = []
  isRecording.value = true
  isStarting.value = false
  liveTimer = setInterval(liveStep, LIVE_INTERVAL_MS)
}

async function stopRecording() {
  if (!isRecording.value) return
  isProcessing.value = true
  pendingName.value = 'recording'
  try {
    const finished = await stopLive()
    if (!finished || finished.length < 256) {
      throw new Error('No audio data recorded')
    }
    recordingCount++
    truncatedFrom.value = null
    await analyzeSamples(finished, `Recording ${recordingCount}`, `recording_${new Date().toISOString().replace(/[:.]/g, '-')}`, 'mono')
  } catch (err: any) {
    resetAnalysis()
    reportError(getDetailedErrorMessage(err), 'recording_error', err)
  } finally {
    isProcessing.value = false
    pendingName.value = null
  }
}

const uploadAudioFile = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'audio/*'
  input.hidden = true
  document.body.append(input)
  input.onchange = async (e) => {
    input.remove()
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file && !isStarting.value && !isRecording.value) await loadFile(file)
  }
  input.click()
}

async function loadFile(file: File, limitSeconds: number | null = null) {
  error.value = null
  truncateOffer.value = null
  const load = ++loadId
  const seconds = await probeDuration(file)
  if (load !== loadId) return
  if (limitSeconds === null && seconds !== null && seconds > MAX_AUDIO_DURATION_SECONDS) {
    reportError(`This file is ${mmss(seconds)} long. ${limitText.value}`, 'audio_duration_limit')
    if (seconds <= MAX_TRUNCATABLE_SECONDS) truncateOffer.value = { file, duration: seconds }
    return
  }
  if (file.size > MAX_READABLE_BYTES) {
    reportError(`This file is ${Math.round(file.size / 1024 / 1024)} MB. The demo reads files up to ${maxFileSizeMB.value} MB${smallDevice ? ' on this device' : ''}.`, 'file_size_limit')
    return
  }
  pendingName.value = file.name
  analysisSeconds.value = Math.min(seconds ?? 0, limitSeconds ?? Infinity)
  analysisProgress.value = 0
  isProcessing.value = true
  try {
    await stopLive()
    const arrayBuffer = await file.arrayBuffer()
    if (load !== loadId) return
    await handleAudioBuffer(arrayBuffer, file.name, limitSeconds, load)
  } catch (err) {
    if (load === loadId) reportError(getDetailedErrorMessage(err, file.name, seconds), 'file_upload', err)
  } finally {
    if (load === loadId) {
      isProcessing.value = false
      pendingName.value = null
      analysisProgress.value = 0
    }
  }
}

async function onDrop(event: DragEvent) {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file && !isStarting.value && !isRecording.value && !inputsBusy.value) await loadFile(file)
}

function acceptTruncation() {
  const offer = truncateOffer.value
  if (!offer) return
  truncateOffer.value = null
  void loadFile(offer.file, MAX_AUDIO_DURATION_SECONDS)
}

/* ---------- playback ---------- */
async function togglePlay() {
  if (!frames.value || !canPlay.value) return
  if (playing.value) {
    player.stop()
    playing.value = false
    return
  }
  const from = now.value >= duration.value - 0.02 ? 0 : now.value
  playing.value = true
  try {
    await player.start(notes.value, duration.value, from, take, playSource.value)
  } catch (err) {
    playing.value = false
    reportError(getDetailedErrorMessage(err), 'playback', err)
  }
}

function seekTo(t: number) {
  if (!plot || !frames.value || isRecording.value) return
  now.value = Math.max(0, Math.min(duration.value, t))
  if (playing.value) void restartPlayback()
  else plot.setNow(now.value)
}

async function seek(e: MouseEvent) {
  if (!plot || !frames.value || isRecording.value) return
  seekTo(plot.timeAt(e.clientX))
  if (playing.value || !canPlay.value) return
  playing.value = true
  try {
    await player.start(notes.value, duration.value, now.value, take, playSource.value)
  } catch (err) {
    playing.value = false
    reportError(getDetailedErrorMessage(err), 'playback', err)
  }
}

function hover(e: MouseEvent) {
  const f = frames.value
  if (!plot || !f || isRecording.value || !plotRef.value) return
  const t = plot.timeAt(e.clientX)
  const i = Math.floor(t / FRAME_PERIOD)
  if (i < 0 || i >= f.pitch.length) {
    unhover()
    return
  }
  const box = plotRef.value.getBoundingClientRect()
  const pitch = f.pitch[i]
  const conf = f.conf[i]
  const note = notes.value.find((n) => t >= n.start && t < n.end)
  const voiced = conf >= 0.5 && pitch > 0
  const cents = (value: number, r = Math.round(midi(value))) => {
    const m = midi(value)
    const off = Math.round(100 * (m - r))
    return `${noteName(r)} ${off >= 0 ? '+' : ''}${off} c`
  }
  // Every value is labeled, so the note's pitch and the frame under the pointer cannot be read
  // as the same thing.
  const rows: [string, string][] = note
    ? [
        ['Note', cents(note.pitch_hz)],
        ['Pitch', `${note.pitch_hz.toFixed(1)} Hz`],
        ['Length', `${(note.end - note.start).toFixed(2)} s`],
        ['Here', voiced ? `${pitch.toFixed(1)} Hz` : 'unvoiced'],
        ['Time', clock(t)],
      ]
    : [
        ['Here', voiced ? `${pitch.toFixed(1)} Hz` : 'unvoiced'],
        ['Nearest', voiced ? cents(pitch) : '-'],
        ['Time', clock(t)],
        ['Confidence', conf.toFixed(2)],
      ]
  hoverTip.value = {
    x: Math.max(8, Math.min(e.clientX - box.left + 14, box.width - 210)),
    y: Math.max(8, e.clientY - box.top - (note ? 108 : 90)),
    rows,
  }
  plot.setHover(t)
}

function unhover() {
  hoverTip.value = null
  plot?.setHover(null)
}

function plotKey(e: KeyboardEvent) {
  if (!showResults.value) return
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    seekTo(now.value + (e.key === 'ArrowRight' ? 1 : -1))
  } else if (e.key === 'Home') {
    e.preventDefault()
    seekTo(0)
  } else if (e.key === 'End') {
    e.preventDefault()
    seekTo(duration.value)
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    void togglePlay()
  }
}

/* ---------- exports ---------- */
watch(canExport, able => {
  if (!able) closeExport()
})

function download(kind: 'json' | 'midi' | 'pitchtier') {
  if (!frames.value || !canExport.value) return
  try {
    const name = baseFileName(fileStem.value)
    if (kind === 'json') triggerDownload(exportJson(frames.value, notes.value, fileStem.value, appliedHold.value, appliedRange.value[0], appliedRange.value[1]), `${name}.json`)
    else if (kind === 'midi') triggerDownload(new Blob([createMidiFile(notes.value, { tempo: 120, velocity: 80 })], { type: 'audio/midi' }), `${name}.mid`)
    else triggerDownload(pitchTier(frames.value), `${name}.PitchTier`)
  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'export_error', err)
  }
}

/* ---------- initialization ---------- */
function clearLoadTimers() {
  if (loadTimerInterval) {
    clearInterval(loadTimerInterval);
    loadTimerInterval = null;
  }
  if (extendedMessageTimeout) {
    clearTimeout(extendedMessageTimeout);
    extendedMessageTimeout = null;
  }
  modelLoadStartTime.value = null;
  elapsedLoadTime.value = 0;
}

async function loadModel() {
  if (isLoadingModel.value && modelLoadStartTime.value) return
  error.value = null
  isLoadingModel.value = true;
  loadStage.value = 'downloading'
  showExtendedLoadingMessage.value = false
  modelLoadStartTime.value = Date.now();
  elapsedLoadTime.value = 0;
  extendedMessageTimeout = setTimeout(() => {
    showExtendedLoadingMessage.value = true;
  }, 3000);
  loadTimerInterval = setInterval(() => {
    if (modelLoadStartTime.value) {
      elapsedLoadTime.value = Math.floor((Date.now() - modelLoadStartTime.value) / 1000);
    }
  }, 1000);
  try {
    onnxService ??= new ONNXService()
    await onnxService.load(stage => { loadStage.value = stage })
    modelReady.value = true
  } catch (err: any) {
    modelReady.value = false
    reportError(getDetailedErrorMessage(err), 'model_loading', err)
  } finally {
    clearLoadTimers()
    isLoadingModel.value = false
  }
}

function workerLost(err: unknown) {
  return err instanceof WorkerLostError
}

function measurePlot() {
  if (!props.active || !plotRef.value) return
  const style = getComputedStyle(plotRef.value)
  const width = plotRef.value.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  if (width > 80) plotWidth.value = width
  // Measure the space assigned by the layout; the SVG does not size its parent.
  const height = plotRef.value.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  plotBox.value = height > 160 ? height : 0
}

onMounted(() => {
  resizeObserver = new ResizeObserver(measurePlot)
  if (plotRef.value) resizeObserver.observe(plotRef.value)
  measurePlot()
  void loadModel()
})

onUnmounted(() => {
  void stopLive().catch(() => {})
  player.stop()
  resizeObserver?.disconnect()
  onnxService?.terminate()
  onnxService = null
  clearLoadTimers()
});
</script>
<template>
  <section class="card demo" aria-labelledby="pitch-title">
        <h2 id="pitch-title" class="sr-only">Pitch</h2>
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Axis labels">
            <button type="button" :aria-pressed="view === 'hz'" title="Pitch in hertz" @click="view = 'hz'">Hz</button>
            <button type="button" :aria-pressed="view === 'st'" title="Pitch in semitones relative to the median" @click="view = 'st'">Semitones</button>
            <button type="button" :aria-pressed="view === 'notes'" title="Piano-roll lanes with the detected notes" @click="view = 'notes'">Notes</button>
          </div>
          <div ref="rangeBox" class="hold">
            <span class="holdlabel" id="range-label">Range</span>
            <button ref="rangeButton" class="btn compact holdbtn rangebtn" type="button" :disabled="inputsBusy || isRecording" :aria-expanded="rangeOpen" aria-controls="range-sheet" aria-labelledby="range-label rangebtn-value" title="Pitch search band" @click="toggleRange">
              <b id="rangebtn-value">{{ rangeText }}</b>
              <svg class="caret" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div v-if="rangeOpen" id="range-sheet" class="sheet" role="dialog" aria-label="Pitch range">
              <p>Pitches outside this band count as unvoiced. Narrow it to drop pitches far from the voice or instrument.</p>
              <div class="presets">
                <button v-for="preset in RANGE_PRESETS" :key="preset.label" type="button" :disabled="inputsBusy || isRecording" :aria-pressed="fmin === preset.low && fmax === preset.high" @click="pickRange(preset.low, preset.high)">
                  <span>{{ preset.label }}</span>
                  <small>{{ Math.round(preset.low) }}–{{ Math.round(preset.high) }} Hz · {{ noteName(midi(preset.low)) }}–{{ noteName(midi(preset.high)) }}</small>
                </button>
              </div>
              <div class="custom">
                <label>Lowest<input v-model="draftMin" type="number" :min="FMIN" :max="FMAX" step="1" :disabled="inputsBusy || isRecording" @keydown.enter="commitRange"></label>
                <label>Highest<input v-model="draftMax" type="number" :min="FMIN" :max="FMAX" step="1" :disabled="inputsBusy || isRecording" @keydown.enter="commitRange"></label>
              </div>
              <p v-if="rangeNote" class="rangenote">{{ rangeNote }}</p>
            </div>
          </div>
          <div ref="holdBox" class="hold">
            <span class="holdlabel" id="hold-label">Pitch hold</span>
            <button ref="holdButton" class="btn compact holdbtn" type="button" :disabled="isRecording" :aria-expanded="holdOpen" aria-controls="hold-sheet" aria-labelledby="hold-label holdbtn-value" title="How long a new pitch one semitone away must be held before it becomes a note of its own" @click="toggleHold">
              <b id="holdbtn-value">{{ holdText }}</b>
              <svg class="caret" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div v-if="holdOpen" id="hold-sheet" class="sheet" role="dialog" aria-label="Pitch hold">
              <p>How long a new pitch must last before it becomes a new note. Higher values give fewer, longer notes.</p>
              <span class="track">
                <input v-model.number="holdIndex" type="range" min="0" :max="HOLD_STEPS.length - 1" step="1" :aria-valuetext="`${pitchHoldMs} ms`" aria-label="Pitch hold">
                <span class="ticks" aria-hidden="true"><span v-for="t in HOLD_TICKS" :key="t">{{ t }}</span></span>
              </span>
              <div class="presets">
                <button v-for="preset in holdPreviews" :key="preset.label" type="button" :aria-pressed="holdIndex === preset.index" @click="holdIndex = preset.index">
                  <span>{{ preset.label }}<i>{{ HOLD_TICKS[preset.index] + ' ms' }}</i></span>
                  <svg viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
                    <rect v-for="(bar, i) in preset.bars" :key="i" :x="bar.x" :y="bar.y" :width="bar.w" height="3" rx="1" />
                  </svg>
                  <small>{{ preset.count }} note{{ preset.count === 1 ? '' : 's' }}{{ preset.scope }}</small>
                </button>
              </div>
            </div>
          </div>
          <span v-if="!isRecording" class="tdivider bardivider" aria-hidden="true"></span>
          <div v-if="!isRecording" class="tb-right">
            <button class="btn compact rec" :class="{ primary: !hasData }" type="button" :disabled="inputsBusy" title="Record from the microphone. The pitch shows while you speak or play." @click="recordAudio">{{ isStarting ? 'Starting…' : 'Record' }}</button>
            <button class="btn compact" type="button" :disabled="inputsBusy" :title="`Upload an audio file, up to ${maxAudioDurationMinutes} minutes`" @click="uploadAudioFile">Upload</button>
          </div>
        </div>
        <p class="facts" title="Duration, channels, peak level and share of frames with a voiced pitch"><template v-if="facts"><b>{{ facts.name }}</b> · {{ facts.rest }}</template><template v-else>No audio loaded</template></p>
        <div ref="plotRef" class="plot" :class="{ dragging }" @dragenter.prevent="dragging = true" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
          <svg ref="svgRef" :role="showResults ? 'slider' : 'img'" :aria-label="showResults ? 'Playback position. Use the arrow keys to seek.' : 'Pitch trace'" :aria-valuemin="showResults ? 0 : undefined" :aria-valuemax="showResults ? duration : undefined" :aria-valuenow="showResults ? now : undefined" :aria-valuetext="showResults ? `${clock(now)} of ${clock(duration)}` : undefined" :tabindex="showResults ? 0 : undefined" :class="{ busy: isProcessing && hasData, seekable: showResults }" @click="seek" @keydown="plotKey" @mousemove="hover" @mouseleave="unhover"></svg>
          <div v-if="hoverTip" class="tip" :style="{ left: hoverTip.x + 'px', top: hoverTip.y + 'px' }">
            <template v-for="row in hoverTip.rows" :key="row[0]"><span>{{ row[0] }}</span><b>{{ row[1] }}</b></template>
          </div>
          <p v-if="error" class="error animate-fade-in" role="alert">
            <span class="dot" aria-hidden="true"></span>
            <span>{{ error }}</span>
            <button v-if="truncateOffer" class="link retry" type="button" @click="acceptTruncation">Analyze the first {{ maxAudioDurationMinutes }} minutes</button>
            <button v-if="!modelReady && !isLoadingModel" class="link retry" type="button" @click="loadModel">Try again</button>
          </p>
          <div v-if="processingMessage" class="msg" role="status"><span>{{ processingMessage }}</span></div>
          <button v-else-if="emptyMessage && !hasData" class="msg drop" type="button" :disabled="inputsBusy" @click="uploadAudioFile">
            <b>{{ emptyMessage.main }}</b><span v-if="emptyMessage.small"><i v-if="isLoadingModel" class="spin" aria-hidden="true"></i>{{ emptyMessage.small }}</span>
          </button>
          <div v-else-if="emptyMessage" class="msg" role="status">
            <b>{{ emptyMessage.main }}</b><span v-if="emptyMessage.small"><i v-if="isLoadingModel" class="spin" aria-hidden="true"></i>{{ emptyMessage.small }}</span>
          </div>
        </div>
        <div v-if="isRecording" class="transport">
          <span class="dot" aria-hidden="true"></span>
          <span class="clock">{{ liveClock }}<small v-if="liveCap"> · {{ liveCap }}</small></span>
          <span class="readout" :class="{ low: liveReadout.low }">
            {{ liveReadout.main }}<small v-if="liveReadout.small">{{ liveReadout.small }}</small>
          </span>
          <button class="stopbtn" type="button" title="Stop recording and analyse the whole take" @click="stopRecording">Stop</button>
        </div>
        <div v-else class="transport" :class="{ idle: !showResults }">
          <button class="playbtn" type="button" :disabled="!canPlay" :aria-label="playing ? 'Pause' : 'Play'" :title="playing ? 'Pause' : 'Play from the playhead'" @click="togglePlay">
            <svg v-if="playing" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="4" y="3" width="4" height="14" fill="currentColor"/><rect x="12" y="3" width="4" height="14" fill="currentColor"/></svg>
            <svg v-else viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><polygon points="5,3 17,10 5,17" fill="currentColor"/></svg>
          </button>
          <span class="clock">{{ clock(now) }} <small>/ {{ clock(duration) }}</small></span>
          <span v-if="nowText" class="nowplaying">{{ nowText }}</span>
          <div class="sources">
            <button class="toggle" type="button" :aria-pressed="originalOn" title="Play the recording" @click="toggleSource('original')"><i></i>Original</button>
            <button class="toggle" type="button" :disabled="!hasNotes" :aria-pressed="sources.piano && hasNotes" :title="hasNotes ? 'Play the detected notes on a piano' : 'No notes to play'" @click="toggleSource('piano')"><i></i>Piano</button>
          </div>
          <span class="tdivider" aria-hidden="true"></span>
          <div ref="exportBox" class="exportbox">
            <button ref="exportButton" class="btn compact iconbtn" type="button" :disabled="!canExport" :aria-expanded="exportOpen" aria-controls="export-sheet" aria-label="Download" title="Download the pitch, the notes or a Praat PitchTier" @click="toggleExport">
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 1.5v8m0 0 3-3m-3 3-3-3M2.5 12.5h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <i aria-hidden="true">▾</i>
            </button>
            <div v-if="exportOpen" id="export-sheet" class="sheet" role="menu">
              <button type="button" role="menuitem" title="Every frame with pitch and confidence, plus the notes" @click="download('json'); exportOpen = false">JSON</button>
              <button type="button" role="menuitem" :disabled="!hasNotes" title="The detected notes as a MIDI file" @click="download('midi'); exportOpen = false">MIDI</button>
              <button type="button" role="menuitem" title="The voiced pitch as a Praat PitchTier" @click="download('pitchtier'); exportOpen = false">Praat PitchTier</button>
            </div>
          </div>
        </div>
        <div class="figures">
          <div v-for="tile in figures" :key="tile.label">
            <span>{{ tile.label }}</span><b>{{ tile.value }}</b><small>{{ tile.detail || '\u00a0' }}</small>
          </div>
        </div>
      
  </section>
</template>
<style>
.hold {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-size: 14px;
  color: var(--muted);
}

.holdlabel {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.holdbtn {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 38px;
  width: 112px;
  padding: 0 10px 0 12px;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 500;
  border-radius: 9px;
}

.holdbtn.rangebtn {
  width: auto;
  min-width: 112px;
}

.holdbtn b {
  white-space: nowrap;
  font-family: var(--mono);
  font-weight: 600;
  font-size: 13.5px;
  color: var(--ink);
}

.holdbtn i,
.iconbtn i {
  font-style: normal;
  font-size: 9px;
  line-height: 1;
  color: var(--muted);
}

.holdbtn .caret {
  flex: none;
  color: var(--muted);
}

.holdbtn[aria-expanded="true"] .caret {
  transform: rotate(180deg);
}

.tdivider {
  width: 1px;
  height: 22px;
  background: var(--line);
}

.iconbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 10px;
  border-radius: 9px;
}

.iconbtn:disabled {
  opacity: 0.5;
}

.hold .sheet {
  position: absolute;
  z-index: 6;
  top: calc(100% + 8px);
  right: 0;
  width: 300px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 12px 34px rgb(0 0 0 / 34%);
}

.hold .sheet p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted);
}

.hold .track {
  display: flex;
  flex-direction: column;
}

.hold input[type="range"] {
  accent-color: var(--green);
  width: 100%;
  margin: 0;
}

.hold .ticks {
  display: flex;
  justify-content: space-between;
  padding-inline: 7px;
  font-family: var(--mono);
  font-size: 10px;
  line-height: 1;
  color: var(--muted);
}

.hold .ticks span {
  width: 0;
  display: flex;
  justify-content: center;
  white-space: nowrap;
}

.hold .presets {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.hold .presets button {
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 8px;
  text-align: left;
  background: var(--inset);
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color var(--tap), border-color var(--tap), color var(--tap);
}

@media (hover: hover) {
  .hold .presets button:hover {
    background: color-mix(in oklab, var(--inset), var(--ink) 8%);
    border-color: var(--muted);
    color: var(--ink);
  }
}

.hold .presets button:active {
  background: color-mix(in oklab, var(--inset), var(--ink) 14%);
}

.hold + .hold {
  margin-left: 0;
}

.hold .rangenote {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--warn, #e0b341);
}

.hold .custom {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.hold .custom label {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}

.hold .custom input {
  font: inherit;
  font-size: 14px;
  height: 40px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--inset);
  color: var(--ink);
}

.hold .presets button[aria-pressed="true"] {
  border-color: var(--green);
  color: var(--ink);
}

.hold .presets span {
  display: flex;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.hold .presets i {
  font-style: normal;
  font-family: var(--mono);
  font-weight: 400;
  color: var(--muted);
}

.hold .presets svg {
  width: 100%;
  height: 18px;
}

.hold .presets rect {
  fill: var(--green);
  fill-opacity: 0.75;
}

.hold .presets small {
  font-size: 11px;
  color: var(--muted);
}

.tb-right {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.btn {
  --bg: var(--raised);
  --bd: var(--line);
  --fg: var(--ink);
  font: inherit;
  font-weight: 700;
  font-size: 17px;
  height: 56px;
  border-radius: 12px;
  border: 1px solid var(--bd);
  background: var(--bg);
  color: var(--fg);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  transition: background-color var(--tap), border-color var(--tap), color var(--tap), transform var(--tap);
}

.btn.primary {
  --bg: var(--green);
  --bd: var(--green);
  --fg: var(--green-ink);
}

.btn.recording {
  --bg: var(--danger);
  --bd: var(--danger);
  --fg: #fff;
}

.btn.holdbtn {
  --bg: var(--inset);
}

.btn.iconbtn {
  --bg: var(--inset);
  --fg: var(--ink-soft);
}

@media (hover: hover) {
  .btn:hover:not(:disabled) {
    background: color-mix(in oklab, var(--bg), var(--fg) 12%);
    border-color: color-mix(in oklab, var(--bd), var(--fg) 34%);
    color: var(--ink);
  }

  .btn.primary:hover:not(:disabled),
  .btn.recording:hover:not(:disabled) {
    color: var(--fg);
  }
}

.btn:active:not(:disabled) {
  background: color-mix(in oklab, var(--bg), var(--fg) 22%);
  transform: translateY(1px);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn.compact {
  height: 38px;
  font-size: 13.5px;
  font-weight: 600;
  padding: 0 14px;
  border-radius: 9px;
  gap: 8px;
}

.btn.compact.rec::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.facts {
  line-height: 20px;
  min-width: 0;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--muted);
  margin: 10px 2px 14px;
  overflow-wrap: anywhere;
}

.facts b {
  color: var(--ink);
  font-weight: 500;
}

.error {
  position: absolute;
  z-index: 3;
  left: 12px;
  right: 12px;
  top: 12px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 10px 12px;
  font-size: 14px;
  color: #ffb4a5;
  background: color-mix(in oklab, var(--panel), transparent 8%);
  border: 1px solid rgb(185 28 28 / 55%);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgb(0 0 0 / 34%);
}

.error > span {
  flex: 1;
  min-width: 180px;
  overflow-wrap: anywhere;
}

.error .dot {
  width: 7px;
  min-width: 7px;
  height: 7px;
  flex: none;
  animation: none;
  border-radius: 50%;
  background: #ff6b4a;
}

.spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--line);
  border-top-color: var(--ink-soft);
  border-radius: 50%;
  vertical-align: -2px;
  margin-right: 6px;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Keep the primary actions together and reserve plot space while the detector loads. */
.toolbar {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px 20px;
}

.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--inset);
}

.seg button:first-child {
  border-radius: 8px 0 0 8px;
}

.seg button:last-child {
  border-radius: 0 8px 8px 0;
}

.seg button {
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  height: 38px;
  padding: 0 16px;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  min-height: 44px;
  transition: background-color var(--tap), color var(--tap);
}

@media (hover: hover) {
  .seg button:hover {
    background: rgb(255 255 255 / 6%);
    color: var(--ink);
  }
}

.seg button:active {
  background: rgb(255 255 255 / 11%);
}

.seg button[aria-pressed="true"] {
  background: var(--raised);
  color: var(--ink);
}

@media (hover: hover) {
  .seg button[aria-pressed="true"]:hover {
    background: color-mix(in oklab, var(--raised), var(--ink) 8%);
  }
}

.transport.idle {
  opacity: 0.45;
  pointer-events: none;
}

.transport {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 12px 14px;
  margin-top: 10px;
  background: var(--inset);
  border: 1px solid var(--line);
  border-radius: 12px;
}

.playbtn {
  width: 44px;
  height: 44px;
  min-width: 44px;
  min-height: 44px;
  border-radius: 50%;
  border: 0;
  background: var(--green);
  color: var(--green-ink);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background-color var(--tap), transform var(--tap);
}

@media (hover: hover) {
  .playbtn:hover:not(:disabled) {
    background: color-mix(in oklab, var(--green), white 16%);
  }
}

.playbtn:active:not(:disabled) {
  background: color-mix(in oklab, var(--green), black 12%);
  transform: scale(0.94);
}

.playbtn:disabled {
  opacity: 0.4;
  cursor: default;
}

.clock {
  font-family: var(--mono);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.clock small {
  color: var(--muted);
  font-size: 14px;
}

.nowplaying {
  font-family: var(--mono);
  font-size: 14px;
  color: var(--green);
}

.sources {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.toggle {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 7px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  transition: background-color var(--tap), border-color var(--tap), color var(--tap);
}

@media (hover: hover) {
  .toggle:hover:not(:disabled) {
    background: rgb(255 255 255 / 6%);
    border-color: var(--muted);
    color: var(--ink);
  }
}

.toggle[aria-pressed="true"] {
  border-color: var(--green);
  color: var(--ink);
  background: color-mix(in oklab, var(--green), transparent 88%);
}

@media (hover: hover) {
  .toggle[aria-pressed="true"]:hover:not(:disabled) {
    background: color-mix(in oklab, var(--green), transparent 78%);
    border-color: var(--green);
  }
}

@media (hover: hover) {
  .toggle:hover:not(:disabled) i {
    background: var(--muted);
  }

  .toggle[aria-pressed="true"]:hover:not(:disabled) i {
    background: var(--green);
  }
}

.toggle:disabled {
  opacity: 0.4;
  cursor: default;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--danger);
  margin: 0 6px 0 8px;
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in oklab, var(--danger), transparent 55%);
  }

  50% {
    box-shadow: 0 0 0 6px color-mix(in oklab, var(--danger), transparent 100%);
  }
}

.stopbtn {
  margin-left: auto;
  font: inherit;
  font-weight: 700;
  font-size: 14px;
  padding: 8px 18px;
  border-radius: 999px;
  border: 0;
  min-height: 44px;
  background: var(--danger);
  color: #fff;
  cursor: pointer;
  transition: background-color var(--tap), transform var(--tap);
}

@media (hover: hover) {
  .stopbtn:hover {
    background: color-mix(in oklab, var(--danger), white 14%);
  }
}

.stopbtn:active {
  background: color-mix(in oklab, var(--danger), black 14%);
  transform: translateY(1px);
}

.toggle i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line);
}

.toggle[aria-pressed="true"] i {
  background: var(--green);
}

.tip {
  position: absolute;
  pointer-events: none;
  display: grid;
  grid-template-columns: auto auto;
  gap: 2px 14px;
  align-items: baseline;
  background: #0f130e;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 11px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  white-space: nowrap;
  box-shadow: 0 6px 20px rgb(0 0 0 / 40%);
}

.tip span {
  font-family: var(--sans);
  font-size: 11px;
  color: var(--muted);
}

.tip b {
  font-weight: 500;
  justify-self: end;
}

.readout {
  font-family: var(--mono);
  font-size: 20px;
  font-weight: 500;
  color: var(--ink);
  min-width: 120px;
}

.readout.low {
  color: var(--muted);
}

.readout small {
  font-size: 13px;
  color: var(--muted);
  margin-left: 8px;
}

.demo {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.plot {
  position: relative;
  background: var(--inset);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 10px 6px;
  flex: 1;
  min-height: 240px;
  overflow-y: auto;
  transition: border-color var(--tap), background-color var(--tap);
}

.plot svg {
  position: absolute;
  top: 12px;
  left: 10px;
  display: block;
  width: calc(100% - 20px);
  height: calc(100% - 18px);
}

.plot svg.seekable {
  cursor: pointer;
}

.plot.dragging {
  border-color: var(--green);
}

@media (hover: hover) {
  .plot:has(button.msg.drop:hover:not(:disabled)) {
    border-color: color-mix(in oklab, var(--line), var(--green) 55%);
    background: color-mix(in oklab, var(--inset), var(--green) 4%);
  }
}

.plot svg.busy {
  opacity: 0.4;
}

.msg {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
  padding: 20px;
  pointer-events: none;
}

button.msg {
  pointer-events: auto;
  width: 100%;
  font: inherit;
  background: none;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
}

button.msg:disabled {
  cursor: default;
}

@media (hover: hover) {
  button.msg:hover:not(:disabled) b {
    color: var(--green);
  }
}

.msg b {
  display: block;
  max-width: 36ch;
  margin-inline: auto;
  font-weight: 600;
  font-size: 16px;
  color: var(--ink);
}

.msg span {
  display: block;
  margin-top: 4px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
}

.msg .spin {
  margin-right: 8px;
}

.tick {
  font-family: var(--mono);
  font-size: 12px;
  fill: var(--muted);
}

.name {
  font-family: var(--mono);
  font-size: 11px;
  fill: var(--ink);
  paint-order: stroke;
  stroke: var(--inset);
  stroke-width: 3px;
  stroke-linejoin: round;
}

.figures {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
  color: var(--muted);
}

.figures > div {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 11px;
  background: var(--inset);
  border: 1px solid var(--line);
  border-radius: 10px;
  min-width: 0;
}

.figures span {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.figures b {
  font-family: var(--mono);
  font-weight: 500;
  font-size: 16px;
  color: var(--ink);
  overflow-wrap: anywhere;
}

.figures small {
  font-size: 11.5px;
  overflow-wrap: anywhere;
}

.exportbox {
  position: relative;
}

.exportbox .sheet {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 6;
  display: flex;
  flex-direction: column;
  min-width: 170px;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 12px 34px rgb(0 0 0 / 34%);
}

.exportbox .sheet button {
  padding: 8px 10px;
  text-align: left;
  background: none;
  border: 0;
  border-radius: 7px;
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
  transition: background-color var(--tap);
}

@media (hover: hover) {
  .exportbox .sheet button:hover:not(:disabled) {
    background: color-mix(in oklab, var(--inset), var(--ink) 10%);
  }
}

.exportbox .sheet button:active:not(:disabled) {
  background: color-mix(in oklab, var(--inset), var(--ink) 16%);
}

.exportbox .sheet button:disabled {
  color: var(--muted);
  cursor: default;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.error .retry {
  margin-left: auto;
  font: inherit;
  font-weight: 600;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.plot svg:focus-visible {
  border-radius: 6px;
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-fade-in {
  animation: fade-in 0.3s ease-out;
}

@media (max-width: 640px) {
  .sources {
    margin-left: 0;
  }
  .transport .tdivider { display: none; }
  .exportbox { margin-left: auto; }
}

@media (max-width: 700px) {
  .plot { min-height: 220px; }
}
@media (max-width: 900px) {
  .bardivider { display: none; }
}
@media (max-width: 540px) {
  .toolbar { gap: 12px; }
  .hold { margin-left: 0; }
  .tb-right { order: -1; display: grid; grid-template-columns: 1fr 1fr; width: 100%; margin-left: 0; }
  .seg { justify-self: stretch; width: 100%; }
  .seg button { flex: 1; padding-inline: 10px; }
  .hold { position: static; }
  .hold .sheet { left: 0; right: 0; width: auto; }
  .msg b { font-size: 15px; }
  .figures { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .figures b { font-size: 15px; }
  .tip { max-width: calc(100% - 16px); white-space: normal; }
}
</style>
