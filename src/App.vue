<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, triggerRef, watch } from 'vue'
import { ONNXService, FRAME_PERIOD, SAMPLE_RATE } from '@/ONNXService'
import { segmentNotes, type Note } from '@/notes'
import { fitRange, medianPitch, midi, noteName, plotHeight, readout, renderPlot, tiles, voicedPitches, type Frames, type PlotHandle, type Range, type View } from '@/plot'
import { createPlayer, type Source } from '@/play'
import { startCapture, type Capture } from '@/live'
import { baseFileName, createMidiFile, exportJson, pitchTier, triggerDownload } from '@/exports'

/* ---------- reactive state ---------- */
const isRecording = ref(false)
const isStarting = ref(false)
const isProcessing = ref(false)
const isLoadingModel = ref(true)
const modelReady = ref(false)
const showExtendedLoadingMessage = ref(false)

const error = ref<string | null>(null)
const errorLocation = ref<string | null>(null)

const frames = shallowRef<Frames | null>(null)
const notes = shallowRef<Note[]>([])
const view = ref<View>('notes')
const sources = ref({ original: true, piano: true })
const hoverTip = ref<{ x: number; y: number; main: string; small: string } | null>(null)
const now = ref(0)
const playing = ref(false)
const sourceName = ref<string | null>(null)
const fileStem = ref<string | null>(null)
const sourceChannels = ref<'mono' | 'stereo'>('mono')
const pendingName = ref<string | null>(null)
const takePeak = ref(0)
const plotWidth = ref(0)
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
const MAX_AUDIO_DURATION_SECONDS = 300
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
const LIVE_WINDOW_SECONDS = 6
const LIVE_CONTEXT_FRAMES = 12
const LIVE_SPAN_FRAMES = 125
const LIVE_INTERVAL_MS = 100
const LIVE_NOTES_FRAMES = 500

const maxFileSizeMB = computed(() => MAX_FILE_SIZE_BYTES / 1024 / 1024)
const maxAudioDurationMinutes = computed(() => MAX_AUDIO_DURATION_SECONDS / 60)

/* ---------- computed properties ---------- */
const hasData = computed(() => !!frames.value && frames.value.pitch.length > 0)
const duration = computed(() => (frames.value ? frames.value.pitch.length * FRAME_PERIOD : 0))
const figures = computed(() => tiles(frames.value ?? { pitch: [], conf: [] }, notes.value))
const liveClock = computed(() => `${Math.floor(liveSeconds.value / 60)}:${(liveSeconds.value % 60).toFixed(1).padStart(4, '0')}`)
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
  if (note) return `${noteName(Math.round(midi(note.pitch_median)))} ${note.pitch_median.toFixed(0)} Hz`
  const i = Math.min(f.pitch.length - 1, Math.floor(now.value / FRAME_PERIOD))
  return i >= 0 && f.conf[i] >= 0.5 && f.pitch[i] > 0 ? `${f.pitch[i].toFixed(0)} Hz` : ''
})
const canExport = computed(() => hasData.value && !isRecording.value && !isProcessing.value)
const inputsBusy = computed(() => isLoadingModel.value || !modelReady.value || isProcessing.value || isStarting.value)
const processingMessage = computed(() => (isProcessing.value ? `Analysing ${pendingName.value ?? 'recording'}...` : null))
const facts = computed(() => {
  if (isRecording.value) return { name: 'Recording', rest: `${liveClock.value} · mono` }
  const f = frames.value
  if (!f || !hasData.value || !sourceName.value) return null
  const level = takePeak.value > 0 ? `peak ${Math.round(20 * Math.log10(takePeak.value))} dBFS` : 'silent'
  return {
    name: sourceName.value,
    rest: `${duration.value.toFixed(2)} s · ${sourceChannels.value} · ${level} · ${Math.round((100 * voicedCount.value) / f.pitch.length)} % voiced`,
  }
})
const emptyMessage = computed(() => {
  if (isRecording.value || isProcessing.value) return null
  if (!hasData.value) {
    return {
      main: 'Record or upload a file to see its pitch here.',
      small: isLoadingModel.value ? `Loading the model (5 MB)${showExtendedLoadingMessage.value ? `, ${elapsedLoadTime.value} s so far` : ''}...` : `up to ${maxFileSizeMB.value} MB or ${maxAudioDurationMinutes.value} minutes`,
    }
  }
  if (voicedCount.value >= 3) return null
  const peakDb = takePeak.value > 0 ? 20 * Math.log10(takePeak.value) : -100
  const small =
    duration.value < 0.5
      ? `too short (${duration.value.toFixed(2)} s)`
      : peakDb < -30
        ? `very quiet (peak ${peakDb.toFixed(0)} dBFS)`
        : 'no periodic signal: noise, chords or silence'
  return { main: `No voiced pitch found in ${sourceName.value ?? 'the recording'}.`, small }
})

/* ---------- rendering ---------- */
function render() {
  if (!svgRef.value || !plotWidth.value) return
  plot = renderPlot(svgRef.value, {
    frames: frames.value ?? { pitch: [], conf: [] },
    notes: notes.value,
    view: view.value,
    now: now.value,
    live: isRecording.value,
    window: LIVE_WINDOW_SECONDS,
    width: plotWidth.value,
    height: plotHeight(plotWidth.value),
    range: isRecording.value ? liveRange : null,
  })
}

watch([frames, notes, view, plotWidth, isRecording], render, { flush: 'post' })
watch(view, () => {
  liveRange = null
})

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
  await onnxService!.setAudio(samples)
  const result = await onnxService!.run()
  if (id !== runId) return
  player.stop()
  playing.value = false
  frames.value = { pitch: result.pitch_hz, conf: result.confidence }
  notes.value = result.notes
  take = samples
  sourceName.value = name
  fileStem.value = stem
  sourceChannels.value = channels
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  takePeak.value = peak
  now.value = 0
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
  errorLocation.value = location;
  if (workerLost(err)) modelReady.value = false
  if (err) {
    console.error(`Error at ${location}:`, err);
  } else {
    console.error(`Error at ${location}: ${message}`);
  }
  void stopLive().catch(() => {})
}

function getDetailedErrorMessage(err: any, name: string | null = null): string {
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

    if (message.includes('maximum call stack') || message.includes('out of memory')) {
      return `Audio file is too large or too long. Please try a shorter file (max ${maxAudioDurationMinutes.value} minutes) or reduce file size (max ${maxFileSizeMB.value}MB).`
    }

    if (message.includes('decode') || message.includes('invalid') || message.includes('bad audio data')) {
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
async function handleAudioBuffer(audioBuffer: ArrayBuffer, sourceFileName: string) {
  if (!onnxService?.ready) {
    reportError('The model is not loaded. Reload it and try again.', 'audio_processing_init_error');
    isProcessing.value = false;
    return
  }

  if (audioBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
    reportError(
      `File too large (${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)}MB). Maximum size is ${maxFileSizeMB.value}MB.`,
      'file_size_limit'
    )
    isProcessing.value = false;
    return
  }

  error.value = null
  errorLocation.value = null

  try {
    const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(audioBuffer)
    if (decoded.sampleRate !== SAMPLE_RATE) {
      throw new Error(`Decoded audio has sample rate ${decoded.sampleRate}, expected ${SAMPLE_RATE}`)
    }

    if (decoded.duration > MAX_AUDIO_DURATION_SECONDS) {
      reportError(
        `Audio too long (${decoded.duration.toFixed(1)}s). Maximum duration is ${MAX_AUDIO_DURATION_SECONDS}s (${maxAudioDurationMinutes.value} minutes).`,
        'audio_duration_limit'
      )
      isProcessing.value = false;
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
    await analyzeSamples(mono, sourceFileName, sourceFileName, decoded.numberOfChannels > 1 ? 'stereo' : 'mono')
  } catch (err: any) {
    reportError(getDetailedErrorMessage(err, sourceFileName), 'audio_processing', err)
  } finally {
    isProcessing.value = false
  }
}

/* ---------- recording ---------- */
async function liveStep() {
  if (!capture || !onnxService || liveBusy || !frames.value) return
  const session = liveSession
  const totalSamples = Math.floor(capture.seconds() * SAMPLE_RATE)
  const available = Math.floor(totalSamples / 256)
  const finalEnd = available - LIVE_CONTEXT_FRAMES
  const shown = frames.value.pitch.length
  if (finalEnd <= shown) return
  // Include every unseen frame, with left context, even after capture outruns inference.
  const firstFrame = Math.max(0, Math.min(available - LIVE_SPAN_FRAMES, shown - LIVE_CONTEXT_FRAMES))
  liveBusy = true
  try {
    const result = await onnxService.live(capture.take(firstFrame * 256, available * 256))
    if (session !== liveSession || !frames.value) return
    const pitch = frames.value.pitch as number[]
    const conf = frames.value.conf as number[]
    for (let k = shown; k < finalEnd; k++) {
      pitch.push(result.pitch[k - firstFrame])
      conf.push(result.confidence[k - firstFrame])
    }
    liveSeconds.value = finalEnd * FRAME_PERIOD
    if (!liveRange || performance.now() - liveRangeAt > 1000) {
      liveRange = fitRange(voicedPitches(frames.value), view.value)
      liveRangeAt = performance.now()
    }
    const tailStart = Math.max(0, finalEnd - LIVE_NOTES_FRAMES)
    const offset = tailStart * FRAME_PERIOD
    notes.value = segmentNotes(capture.take(tailStart * 256, finalEnd * 256), pitch.slice(tailStart, finalEnd), conf.slice(tailStart, finalEnd)).map((n) => ({
      ...n,
      start: n.start + offset,
      end: n.end + offset,
    }))
    triggerRef(frames)
    if (liveSeconds.value >= MAX_AUDIO_DURATION_SECONDS) await stopRecording()
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
  error.value = null
  errorLocation.value = null
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
  frames.value = { pitch: [], conf: [] }
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
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file && !isStarting.value) {
      error.value = null
      errorLocation.value = null
      pendingName.value = file.name
      isProcessing.value = true
      try {
        await stopLive()
        const arrayBuffer = await file.arrayBuffer()
        await handleAudioBuffer(arrayBuffer, file.name)
      } catch (err) {
        reportError(getDetailedErrorMessage(err, file.name), 'file_upload', err)
      } finally {
        isProcessing.value = false
        pendingName.value = null
      }
    }
  }
  input.click()
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
  let main = 'unvoiced'
  let small = `${clock(t)}   confidence ${conf.toFixed(2)}`
  if (note) {
    const m = midi(note.pitch_median)
    const r = Math.round(m)
    const cents = Math.round(100 * (m - r))
    main = `${noteName(r)} ${cents >= 0 ? '+' : ''}${cents}c   ${(note.end - note.start).toFixed(2)} s   ${note.pitch_median.toFixed(1)} Hz`
    small = conf >= 0.5 && pitch > 0 ? `${pitch.toFixed(1)} Hz at ${clock(t)}   confidence ${conf.toFixed(2)}` : `unvoiced at ${clock(t)}`
  } else if (conf >= 0.5 && pitch > 0) {
    const m = midi(pitch)
    const r = Math.round(m)
    const cents = Math.round(100 * (m - r))
    const st = 12 * Math.log2(pitch / medianPitch(f))
    main = `${pitch.toFixed(1)} Hz   ${noteName(r)} ${cents >= 0 ? '+' : ''}${cents}c   ${st >= 0 ? '+' : ''}${st.toFixed(1)} st`
  }
  hoverTip.value = {
    x: Math.min(e.clientX - box.left + 14, box.width - 300),
    y: e.clientY - box.top - 52,
    main,
    small,
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
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    void togglePlay()
  }
}

/* ---------- exports ---------- */
function download(kind: 'json' | 'midi' | 'pitchtier') {
  if (!frames.value || !canExport.value) return
  try {
    const name = baseFileName(fileStem.value)
    if (kind === 'json') triggerDownload(exportJson(frames.value, notes.value, fileStem.value), `${name}.json`)
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
  errorLocation.value = null
  isLoadingModel.value = true;
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
    await onnxService.load()
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
  return err instanceof Error && /Worker (is not initialized|error|terminated)|Model loading timed out/.test(err.message)
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (plotRef.value) plotWidth.value = plotRef.value.clientWidth - 20
  })
  void loadModel()
})

watch(plotRef, (el) => {
  if (el && resizeObserver) {
    resizeObserver.observe(el)
    plotWidth.value = el.clientWidth - 20
  }
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
  <main class="min-h-screen bg-[#131712] text-white">
    <div class="wrap">

      <header class="mb-10 text-center lg:text-left">
        <h1 class="text-5xl sm:text-6xl lg:text-7xl font-bold leading-tight mb-4 text-[#53d22c]">
          SwiftF0
        </h1>
        <p class="text-white/80 text-lg sm:text-xl leading-relaxed max-w-4xl mx-auto lg:mx-0 mb-6">
          Pitch from any monophonic recording, in the browser. Read it in hertz, semitones or notes;
          export it for Praat or as MIDI.
        </p>
        <nav class="links">
          <a href="https://github.com/lars76/swift-f0" target="_blank" rel="noopener noreferrer">Source code</a>
          <a href="https://github.com/lars76/pitch-benchmark" target="_blank" rel="noopener noreferrer">Benchmark</a>
          <a href="http://arxiv.org/abs/2508.18440" target="_blank" rel="noopener noreferrer">arXiv paper</a>
        </nav>
      </header>

      <section class="card">
        <h2>Pitch</h2>
        <p v-if="facts" class="facts" title="Duration, channels, peak level and share of frames with a voiced pitch"><b>{{ facts.name }}</b> · {{ facts.rest }}</p>
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Axis labels">
            <button type="button" :aria-pressed="view === 'hz'" title="Pitch in hertz" @click="view = 'hz'">Hz</button>
            <button type="button" :aria-pressed="view === 'st'" title="Pitch in semitones relative to the median" @click="view = 'st'">Semitones</button>
            <button type="button" :aria-pressed="view === 'notes'" title="Piano-roll lanes with the detected notes" @click="view = 'notes'">Notes</button>
          </div>
          <div v-if="!isRecording" class="tb-right">
            <button class="btn compact rec" :class="{ primary: !hasData }" type="button" :disabled="inputsBusy" title="Record from the microphone; the pitch shows while you speak or play" @click="recordAudio">Record</button>
            <button class="btn compact" type="button" :disabled="inputsBusy" :title="`Upload an audio file, up to ${maxFileSizeMB} MB or ${maxAudioDurationMinutes} minutes`" @click="uploadAudioFile">Upload</button>
          </div>
        </div>
        <p v-if="error" class="error animate-fade-in" role="alert">
          <svg class="w-5 h-5 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path fill-rule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
              clip-rule="evenodd" />
          </svg>
          <span>{{ error }}</span>
          <button v-if="!modelReady && !isLoadingModel" class="link retry" type="button" @click="loadModel">Reload the model</button>
        </p>
        <div ref="plotRef" class="plot">
          <svg ref="svgRef" :role="showResults ? 'slider' : 'img'" aria-label="Pitch trace; click or use the arrow keys to play from a point" :tabindex="showResults ? 0 : undefined" :class="{ busy: isProcessing && hasData }" @click="seek" @keydown="plotKey" @mousemove="hover" @mouseleave="unhover"></svg>
          <div v-if="hoverTip" class="tip" :style="{ left: hoverTip.x + 'px', top: hoverTip.y + 'px' }">
            {{ hoverTip.main }}<small>{{ hoverTip.small }}</small>
          </div>
          <div v-if="processingMessage" class="msg"><span>{{ processingMessage }}</span></div>
          <div v-else-if="emptyMessage" class="msg" role="status">
            <b>{{ emptyMessage.main }}</b><span v-if="emptyMessage.small"><i v-if="isLoadingModel" class="spin" aria-hidden="true"></i>{{ emptyMessage.small }}</span>
          </div>
        </div>
        <div v-if="isRecording" class="transport">
          <span class="dot" aria-hidden="true"></span>
          <span class="clock">{{ liveClock }}</span>
          <span class="readout" :class="{ low: liveReadout.low }">
            {{ liveReadout.main }}<small v-if="liveReadout.small">{{ liveReadout.small }}</small>
          </span>
          <button class="stopbtn" type="button" title="Stop recording and analyse the whole take" @click="stopRecording">Stop</button>
        </div>
        <div v-else-if="showResults" class="transport">
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
        </div>
        <div v-if="showResults" class="figures">
          <div v-for="tile in figures" :key="tile.label" :title="tile.hint">
            <span>{{ tile.label }}</span><b>{{ tile.value }}</b>
          </div>
        </div>
        <p v-if="showResults" class="dl">
          Download as <button class="link" type="button" :disabled="!canExport" title="Every frame with pitch and confidence, plus the notes" @click="download('json')">JSON</button>,
          <button v-if="hasNotes" class="link" type="button" :disabled="!canExport" title="The detected notes as a MIDI file" @click="download('midi')">MIDI</button><span v-else class="off" title="No notes to export">MIDI</span>
          or <button class="link" type="button" :disabled="!canExport" title="The voiced pitch as a Praat PitchTier" @click="download('pitchtier')">Praat PitchTier</button>.
        </p>
      </section>
    </div>
  </main>
</template>

<style>
:root {
  --ground: #131712;
  --panel: #1a1f17;
  --inset: #131712;
  --line: #2d372a;
  --ink: #ffffff;
  --ink-soft: rgba(255, 255, 255, 0.72);
  --muted: rgba(255, 255, 255, 0.55);
  --green: #53d22c;
  --green-ink: #131712;
  --sans: "Manrope", "Noto Sans", "Segoe UI", Helvetica, Arial, sans-serif;
  --mono: "JetBrains Mono", Consolas, monospace;
}

body {
  font-family: var(--sans);
}

.wrap {
  max-width: 1120px;
  margin: 0 auto;
  padding-inline: clamp(16px, 4vw, 40px);
  padding-block: 40px 80px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 22px;
  margin-bottom: 40px;
  font-size: 15px;
}

@media (min-width: 1024px) {
  .links {
    justify-content: flex-start;
  }
}

.links a {
  color: var(--muted);
  text-decoration: none;
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
}

.links a:hover {
  color: var(--ink);
  border-bottom-color: var(--green);
}

section.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: clamp(20px, 3vw, 32px);
  margin-bottom: 28px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
}

section.card h2 {
  font-size: 24px;
  font-weight: 700;
  color: var(--ink);
  margin: 0 0 20px;
}

.tb-right {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.btn {
  font: inherit;
  font-weight: 700;
  font-size: 17px;
  height: 56px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: #2d372a;
  color: var(--ink);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.btn.primary {
  background: var(--green);
  color: var(--green-ink);
  border-color: var(--green);
}

.btn.recording {
  background: #d1442f;
  border-color: #d1442f;
  color: #fff;
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn.compact {
  height: 40px;
  font-size: 14px;
  padding: 0 16px;
  border-radius: 10px;
  gap: 8px;
}

.btn.compact.rec::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.btn:focus-visible,
.dl .link:focus-visible,
.seg button:focus-visible,
.playbtn:focus-visible,
.stopbtn:focus-visible,
.toggle:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 2px;
}

.facts {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--muted);
  margin: -12px 0 18px;
  overflow-wrap: anywhere;
}

.facts b {
  color: var(--ink);
  font-weight: 500;
}

.error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 14px;
  padding: 8px 10px;
  font-size: 14px;
  color: #f87171;
  background: rgba(127, 29, 29, 0.2);
  border: 1px solid rgba(185, 28, 28, 0.5);
  border-radius: 8px;
}

.error svg {
  width: 20px;
  height: 20px;
  flex: none;
  margin-top: 1px;
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

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  margin-bottom: 14px;
}

.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--inset);
}

.seg button {
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  padding: 8px 16px;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.seg button[aria-pressed="true"] {
  background: #2d372a;
  color: var(--ink);
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
  border-radius: 50%;
  border: 0;
  background: var(--green);
  color: var(--green-ink);
  cursor: pointer;
  display: grid;
  place-items: center;
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
}

.toggle[aria-pressed="true"] {
  border-color: var(--green);
  color: var(--ink);
  background: rgba(83, 210, 44, 0.12);
}

.toggle:disabled {
  opacity: 0.4;
  cursor: default;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #d1442f;
  margin: 0 6px 0 8px;
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(209, 68, 47, 0.45);
  }

  50% {
    box-shadow: 0 0 0 6px rgba(209, 68, 47, 0);
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
  background: #d1442f;
  color: #fff;
  cursor: pointer;
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
  background: #0f130e;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 10px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  white-space: pre;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
}

.tip small {
  display: block;
  color: var(--muted);
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

.plot {
  position: relative;
  background: var(--inset);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 10px 6px;
}

.plot svg {
  display: block;
  max-width: 100%;
  cursor: pointer;
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
  padding: 0 40px;
  pointer-events: none;
}

.msg b {
  display: block;
  font-weight: 600;
  font-size: 16px;
  color: var(--ink);
}

.msg span {
  display: block;
  margin-top: 4px;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--muted);
}

.msg .spin {
  margin-right: 8px;
}

.tick {
  font-family: var(--mono);
  font-size: 11.5px;
  fill: var(--muted);
}

.name {
  font-family: var(--mono);
  font-size: 10.5px;
  fill: var(--ink);
  paint-order: stroke;
  stroke: #131712;
  stroke-width: 3px;
  stroke-linejoin: round;
}

.figures {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 28px;
  margin-top: 20px;
  padding: 0 4px;
}

.figures span {
  display: block;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 2px;
}

.figures b {
  font-family: var(--mono);
  font-weight: 500;
  font-size: 18px;
  color: var(--ink);
}

.dl {
  margin: 18px 0 0;
  padding: 0 4px;
  font-size: 14px;
  color: var(--muted);
}

.dl .link {
  font: inherit;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  text-decoration: underline;
  text-decoration-color: var(--line);
  text-underline-offset: 4px;
  cursor: pointer;
}

.dl .link:hover {
  text-decoration-color: var(--green);
}

.dl .link:disabled {
  color: var(--muted);
  cursor: default;
}

.dl .off {
  color: var(--muted);
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
  outline: 2px solid var(--green);
  outline-offset: 2px;
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

::-webkit-scrollbar {
  width: 8px;
}

::-webkit-scrollbar-track {
  background: #2d372a;
}

::-webkit-scrollbar-thumb {
  background: #42513e;
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: #52614e;
}

@media (max-width: 640px) {
  .sources {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
