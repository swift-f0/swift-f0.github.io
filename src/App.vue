<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { ONNXService } from '@/ONNXService'
import Slider from '@vueform/slider'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
  type ChartOptions,
  type ChartData
} from 'chart.js'
import MidiPlayer from '@/components/MidiPlayer.vue'

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Filler)

/* ---------- reactive state ---------- */
const isRecording = ref(false)
const processingSource = ref(null)
const isProcessing = ref(false)
const isLoadingModel = ref(true)
const showExtendedLoadingMessage = ref(false)
const activeTab = ref<'pitch' | 'midi'>('pitch')

const error = ref<string | null>(null)
const errorLocation = ref<string | null>(null)

// MIDI Player state
const midiBuffer = ref<ArrayBuffer | null>(null)
const midiInfo = ref<any>(null)
const isGeneratingMidi = ref(false)

/* Extended type with real timestamps */
const frameData = ref<{
  pitch_hz: Float32Array
  confidence: Float32Array
  timestamps: Float32Array
} | null>(null)

const noteSegments = ref<any[]>([]);
const processedFrameData = ref<any[]>([]);

// Reactive variables for metadata
const processedAudioLength = ref<number | null>(null)
const processedFileSizeBytes = ref<number | null>(null)
const processedFileName = ref<string | null>(null)

// Timer related reactive state
const modelLoadStartTime = ref<number | null>(null);
const elapsedLoadTime = ref(0);
let loadTimerInterval: ReturnType<typeof setInterval> | null = null;
let extendedMessageTimeout: ReturnType<typeof setTimeout> | null = null;

let onnxService: ONNXService | null = null
let recorder: MediaRecorder | null = null
let recordingStartTime = 0

const threshold = ref<number>(0.9)

/* ---------- constants ---------- */
const FREQ_MIN = 46.875
const FREQ_MAX = 2093.75
const frequencyRange = ref([FREQ_MIN, FREQ_MAX])
const SAMPLE_RATE = 16000
const MAX_AUDIO_DURATION_SECONDS = 300
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

// Centralized parameters for the note segmentation algorithm
const SEGMENTATION_PARAMS = {
  splitSemitoneThreshold: 0.8,
  minNoteDuration: 0.05,
  unvoicedGracePeriod: 0.02,
};

// Note names for MIDI display
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Expose for UI
const maxFileSizeMB = computed(() => MAX_FILE_SIZE_BYTES / 1024 / 1024)
const maxAudioDurationMinutes = computed(() => MAX_AUDIO_DURATION_SECONDS / 60)

/* ---------- computed properties ---------- */
const hasData = computed(() => frameData.value && frameData.value.pitch_hz.length > 0)

const pitchStats = computed(() => {
  if (!frameData.value) return null

  const validPoints = []
  for (let i = 0; i < frameData.value.pitch_hz.length; i++) {
    const conf = frameData.value.confidence[i]
    const pitch = frameData.value.pitch_hz[i]
    if (conf > threshold.value &&
      pitch >= frequencyRange.value[0] &&
      pitch <= frequencyRange.value[1]) {
      validPoints.push(pitch)
    }
  }

  if (validPoints.length === 0) {
    return {
      count: 0,
      average: null,
      median: null,
      min: null,
      max: null,
      duration: frameData.value.timestamps[frameData.value.timestamps.length - 1] - frameData.value.timestamps[0]
    }
  }

  const sorted = [...validPoints].sort((a, b) => a - b)
  const avg = validPoints.reduce((a, b) => a + b, 0) / validPoints.length
  const median = sorted[Math.floor(sorted.length / 2)]

  return {
    count: validPoints.length,
    average: avg,
    median: median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    duration: frameData.value.timestamps[frameData.value.timestamps.length - 1] - frameData.value.timestamps[0]
  }
})

const midiStats = computed(() => {
  if (!noteSegments.value || noteSegments.value.length === 0) {
    return {
      count: 0,
      average: null,
      median: null,
      min: null,
      max: null,
      range: null
    }
  }

  const midiNotes = noteSegments.value.map(note => note.pitch_midi)
  const sorted = [...midiNotes].sort((a, b) => a - b)
  const avg = midiNotes.reduce((a, b) => a + b, 0) / midiNotes.length
  const median = sorted[Math.floor(sorted.length / 2)]

  return {
    count: noteSegments.value.length,
    average: avg,
    median: median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    range: sorted[sorted.length - 1] - sorted[0]
  }
})

// Helper function to convert MIDI note to name
const midiToNoteName = (midiNote: number): string => {
  const octave = Math.floor(midiNote / 12) - 1
  const noteIndex = midiNote % 12
  return `${NOTE_NAMES[noteIndex]}${octave}`
}

const displayPitchStats = computed(() => {
  if (pitchStats.value) return pitchStats.value
  return {
    count: null,
    average: null,
    median: null,
    min: null,
    max: null,
    duration: null
  }
})

const displayMidiStats = computed(() => {
  if (midiStats.value) return midiStats.value
  return {
    count: null,
    average: null,
    median: null,
    min: null,
    max: null,
    range: null
  }
})

const recordButtonText = computed(() => {
  if (isRecording.value) return 'Stop Recording';
  return 'Record Audio';
});

const hasMidiData = computed(() => midiBuffer.value !== null)
const hasPlayableNotes = computed(() => {
  return noteSegments.value && noteSegments.value.length > 0
})

// --- Download Handler Functions ---

const downloadData = () => {
  if (!hasData.value || !processedFrameData.value || !noteSegments.value) {
    reportError("No processed data available to download.", 'data_export_no_data');
    return;
  }

  try {
    const data = {
      metadata: {
        timestamp: new Date().toISOString(),
        fileName: processedFileName.value,
        audioLengthSeconds: processedAudioLength.value,
        generatedBy: 'SwiftF0',
        voicedParameters: {
          confidenceThreshold: threshold.value,
          frequencyRangeHz: frequencyRange.value
        },
        noteSegmentationParameters: {
          ...SEGMENTATION_PARAMS
        },
        totalFramesCount: processedFrameData.value.length,
        voicedFramesCount: voicedFlags.value.filter(v => v).length,
        noteSegmentsCount: noteSegments.value.length
      },
      frameData: processedFrameData.value,
      noteSegments: noteSegments.value
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    triggerDownload(blob, '.json');
  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'data_export_error', err);
  }
};

const downloadMidi = () => {
  if (!hasData.value || noteSegments.value.length === 0) {
    reportError("No note segments found to export to MIDI.", 'midi_export_no_notes');
    return;
  }

  try {
    const midiData = createMidiFile(noteSegments.value, { tempo: 120, velocity: 80 });
    const blob = new Blob([midiData], { type: 'audio/midi' });
    triggerDownload(blob, '.mid');
  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'midi_export_error', err);
  }
};

const generateMidiForPlayer = async () => {
  if (!hasData.value || noteSegments.value.length === 0) {
    midiInfo.value = null;
    midiBuffer.value = null;
    return;
  }

  isGeneratingMidi.value = true;

  try {
    // Data for MIDI Info Display
    const duration = noteSegments.value.reduce((max, note) => Math.max(max, note.end), 0);
    const totalNotes = noteSegments.value.length;
    midiInfo.value = {
      duration: duration,
      tracks: [{ name: 'Track 1' }],
      totalNotes: totalNotes,
    };

    // Data for MIDI EXPORT Button
    const midiUint8Array = createMidiFile(noteSegments.value, { tempo: 120, velocity: 80 });
    midiBuffer.value = midiUint8Array.buffer.slice(
      midiUint8Array.byteOffset,
      midiUint8Array.byteOffset + midiUint8Array.byteLength
    );

  } catch (err: any) {
    reportError(getDetailedErrorMessage(err), 'data_preparation_error', err);
    midiInfo.value = null;
    midiBuffer.value = null;
  } finally {
    isGeneratingMidi.value = false;
  }
};

const triggerDownload = (blob: Blob, extension: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;

  const baseFileName = processedFileName.value
    ? processedFileName.value.replace(/\.[^/.]+$/, "").replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '')
    : `pitch-data-${new Date().toISOString().split('T')[0]}`;

  a.download = `${baseFileName}${extension}`;
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
};

// --- MIDI Player Event Handlers ---
const onMidiError = (error: any) => {
  console.error('MIDI player error:', error);
  reportError('MIDI playback error: ' + error.message, 'midi_playback_error', error);
};

// --- Core Algorithms & Helpers ---

const median = (arr: number[]) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const segmentNotes = (
  timestamps: Float32Array,
  pitchHz: Float32Array,
  voicing: boolean[],
  params: typeof SEGMENTATION_PARAMS
) => {
  if (timestamps.length === 0) return [];

  const framePeriod = timestamps.length > 1 ? timestamps[1] - timestamps[0] : 0.016;
  const notes = [];
  let currentNoteSegment: any | null = null;
  let unvoicedFramesCount = 0;

  const midiContour = Array.from(pitchHz).map((pitch, i) => {
    if (voicing[i] && pitch > 0) {
      const validPitch = Math.max(pitch, 1e-6);
      return 69 + 12 * Math.log2(validPitch / 440.0);
    }
    return NaN;
  });

  for (let i = 0; i < voicing.length; i++) {
    const t = timestamps[i];
    const isVoiced = voicing[i];
    const midiPitch = midiContour[i];

    if (isVoiced && !isNaN(midiPitch)) {
      unvoicedFramesCount = 0;
      if (currentNoteSegment === null) {
        currentNoteSegment = { start: t, end: t + framePeriod, samples: [midiPitch] };
      } else {
        const currentMedian = median(currentNoteSegment.samples);
        const pitchDeviation = Math.abs(midiPitch - currentMedian);
        if (pitchDeviation >= params.splitSemitoneThreshold) {
          notes.push(currentNoteSegment);
          currentNoteSegment = { start: t, end: t + framePeriod, samples: [midiPitch] };
        } else {
          currentNoteSegment.samples.push(midiPitch);
          currentNoteSegment.end = t + framePeriod;
        }
      }
    } else {
      if (currentNoteSegment !== null) {
        unvoicedFramesCount++;
        const unvoicedDuration = unvoicedFramesCount * framePeriod;
        if (unvoicedDuration >= params.unvoicedGracePeriod) {
          notes.push(currentNoteSegment);
          currentNoteSegment = null;
          unvoicedFramesCount = 0;
        } else {
          currentNoteSegment.end = t + framePeriod;
        }
      }
    }
  }

  if (currentNoteSegment !== null) {
    notes.push(currentNoteSegment);
  }

  if (notes.length === 0) return [];

  const processedNotes = notes
    .map(segment => {
      const duration = segment.end - segment.start;
      if (duration >= params.minNoteDuration && segment.samples.length > 0) {
        const medianPitchMidi = median(segment.samples);
        const medianPitchHz = 440.0 * Math.pow(2, (medianPitchMidi - 69) / 12);
        return {
          start: segment.start,
          end: segment.end,
          pitch_median: medianPitchHz,
          midi_pitch: Math.round(medianPitchMidi),
        };
      }
      return null;
    })
    .filter(Boolean);

  if (processedNotes.length === 0) return [];

  const finalNotes = [processedNotes[0]];
  const epsilon = 1e-9;
  for (let i = 1; i < processedNotes.length; i++) {
    const currentNote = processedNotes[i];
    const previousNote = finalNotes[finalNotes.length - 1];
    const gap = currentNote.start - previousNote.end;

    if (gap <= framePeriod + epsilon && previousNote.midi_pitch === currentNote.midi_pitch) {
      previousNote.end = currentNote.end;
    } else {
      finalNotes.push(currentNote);
    }
  }

  return finalNotes.map(note => ({
    start: parseFloat(note.start.toFixed(4)),
    end: parseFloat(note.end.toFixed(4)),
    pitch_median: parseFloat(note.pitch_median.toFixed(2)),
    pitch_midi: note.midi_pitch,
  }));
};

const createMidiFile = (noteSegments: any[], { tempo = 120, velocity = 80 } = {}): Uint8Array => {
  const HEADER_CHUNK_TYPE = [0x4d, 0x54, 0x68, 0x64];
  const HEADER_CHUNK_LENGTH = [0x00, 0x00, 0x00, 0x06];
  const FORMAT_TYPE = [0x00, 0x00];
  const NUMBER_OF_TRACKS = [0x00, 0x01];
  const TICKS_PER_QUARTER_NOTE = 480;
  const TIME_DIVISION = [(TICKS_PER_QUARTER_NOTE >> 8) & 0xff, TICKS_PER_QUARTER_NOTE & 0xff];
  const TRACK_CHUNK_TYPE = [0x4d, 0x54, 0x72, 0x6b];

  // CORRECTED: MIDI Variable Length Quantity (VLQ) Encoding
  const encodeVariableLength = (value: number): number[] => {
    if (value < 0) {
      throw new Error("Cannot encode negative values in variable length quantity.");
    }
    if (value === 0) {
      return [0x00];
    }

    const bytes: number[] = [];
    const tempChunks: number[] = [];

    let currentVal = value;
    do {
      tempChunks.push(currentVal & 0x7F);
      currentVal >>= 7;
    } while (currentVal > 0);

    for (let i = tempChunks.length - 1; i >= 0; i--) {
      let byte = tempChunks[i];
      if (i > 0) {
        byte |= 0x80;
      }
      bytes.push(byte);
    }
    return bytes;
  };

  const secondsToTicks = (seconds: number): number => Math.round(seconds * TICKS_PER_QUARTER_NOTE * (tempo / 60));

  const allEvents: any[] = [];
  for (const note of noteSegments) {
    const midiNote = Math.max(0, Math.min(127, note.pitch_midi));
    // Note On event
    allEvents.push({ time: note.start, type: 0x90, note: midiNote, velocity: Math.min(127, velocity) });
    // Note Off event (velocity 0 for standard MIDI practice)
    allEvents.push({ time: note.end, type: 0x80, note: midiNote, velocity: 0x00 });
  }
  allEvents.sort((a, b) => a.time - b.time); // Crucial for correct delta times and event order

  const trackEvents: number[] = [];
  let lastEventTicks = 0;

  // Tempo Event (set at delta time 0 from the start of the track)
  const microSecondsPerBeat = Math.round(60000000 / tempo);
  trackEvents.push(0x00, 0xff, 0x51, 0x03,
    (microSecondsPerBeat >> 16) & 0xff,
    (microSecondsPerBeat >> 8) & 0xff,
    microSecondsPerBeat & 0xff
  );

  for (const event of allEvents) {
    const eventTicks = secondsToTicks(event.time);
    const deltaTicks = eventTicks - lastEventTicks;

    trackEvents.push(...encodeVariableLength(deltaTicks));
    trackEvents.push(event.type, event.note, event.velocity);

    lastEventTicks = eventTicks;
  }

  // End of Track event (delta time 0 from last event)
  trackEvents.push(0x00, 0xff, 0x2f, 0x00);

  const trackLength = trackEvents.length;
  const trackLengthBytes = [
    (trackLength >> 24) & 0xff,
    (trackLength >> 16) & 0xff,
    (trackLength >> 8) & 0xff,
    trackLength & 0xff
  ];

  return new Uint8Array([
    ...HEADER_CHUNK_TYPE,
    ...HEADER_CHUNK_LENGTH,
    ...FORMAT_TYPE,
    ...NUMBER_OF_TRACKS,
    ...TIME_DIVISION,
    ...TRACK_CHUNK_TYPE,
    ...trackLengthBytes,
    ...trackEvents
  ]);
};

// --- Reactive Derived Data (Computed Properties) ---

const voicedFlags = computed(() => {
  if (!hasData.value) return [];
  return Array.from(frameData.value!.pitch_hz).map((pitch, i) => {
    const confidence = frameData.value!.confidence[i];
    return (
      confidence > threshold.value &&
      pitch >= frequencyRange.value[0] &&
      pitch <= frequencyRange.value[1]
    );
  });
});

/* ---------- chart configuration ---------- */
const chartData = ref<ChartData<'line'>>({
  datasets: [{
    label: 'Pitch',
    data: [],
    borderColor: '#50d22c',
    backgroundColor: 'rgba(80, 210, 44, 0.1)',
    fill: true,
    pointRadius: 2,
    pointHoverRadius: 5,
    pointHitRadius: 8,
    pointBackgroundColor: '#50d22c',
    pointBorderColor: '#ffffff',
    pointBorderWidth: 1,
    pointHoverBackgroundColor: '#ffffff',
    pointHoverBorderColor: '#50d22c',
    pointHoverBorderWidth: 2,
    tension: 0.2,
    showLine: true
  }]
})

const chartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 0 },
  interaction: { mode: 'nearest', axis: 'x', intersect: false },
  hover: { mode: 'nearest', intersect: false },
  elements: {
    point: { radius: 2, hoverRadius: 5, hitRadius: 8 },
    line: { tension: 0.2 }
  },
  scales: {
    x: {
      type: 'linear',
      title: {
        display: true,
        text: 'Time (s)',
        color: '#a5b6a0',
        font: { size: 12, weight: 'bold' }
      },
      grid: {
        color: '#2d372a',
        lineWidth: 0.5
      },
      ticks: {
        color: '#a5b6a0',
        maxRotation: 0,
        maxTicksLimit: 10,
        callback: (v: any) => Number(v).toFixed(1)
      },
      min: frameData.value?.timestamps[0] ?? 0,
      max: frameData.value?.timestamps[frameData.value.timestamps.length - 1] ?? 0
    },
    y: {
      title: {
        display: true,
        text: 'Frequency (Hz)',
        color: '#a5b6a0',
        font: { size: 12, weight: 'bold' }
      },
      grid: {
        color: '#2d372a',
        lineWidth: 0.5
      },
      ticks: {
        color: '#a5b6a0',
        maxTicksLimit: 8,
        callback: (v: any) => Number(v).toFixed(0)
      },
      min: frequencyRange.value[0],
      max: frequencyRange.value[1]
    }
  },
  plugins: {
    tooltip: {
      enabled: true,
      backgroundColor: '#1f251d',
      borderColor: '#42513e',
      borderWidth: 1,
      titleColor: '#ffffff',
      bodyColor: '#a5b6a0',
      padding: 12,
      displayColors: false,
      callbacks: {
        title: (items: any) => `Time: ${items[0].parsed.x.toFixed(2)}s`,
        label: (ctx: any) => {
          const conf = (ctx.raw as any).confidence ?? 0
          return [
            `Frequency: ${ctx.parsed.y.toFixed(1)} Hz`,
            `Confidence: ${(conf * 100).toFixed(1)}%`
          ]
        }
      }
    }
  }
}))
/* ---------- centralized error reporting ---------- */
function reportError(message: string, location: string, err: any = null) {
  error.value = message;
  errorLocation.value = location;
  if (err) {
    console.error(`Error at ${location}:`, err);
  } else {
    console.error(`Error at ${location}: ${message}`);
  }
  frameData.value = null;
  processedAudioLength.value = null;
  processedFileSizeBytes.value = null;
  processedFileName.value = null;
  noteSegments.value = [];
  processedFrameData.value = [];
  processingSource.value = null; // --- CORRECTED/ADDED LINE ---
}

function getDetailedErrorMessage(err: any): string {
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
      return 'Microphone constraints could not be satisfied. Your microphone might not support the requested sample rate (16kHz).';
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

    if (message.includes('too many function arguments') ||
      message.includes('maximum call stack') ||
      message.includes('out of memory')) {
      return `Audio file is too large or too long. Please try a shorter file (max ${maxAudioDurationMinutes.value} minutes) or reduce file size (max ${maxFileSizeMB.value}MB).`
    }

    if (message.includes('decode') || message.includes('invalid') || message.includes('bad audio data')) {
      return 'Invalid audio format or corrupt file. Please upload a valid audio file (MP3, WAV, M4A, etc.).'
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
async function handleAudioBuffer(audioBuffer: ArrayBuffer, sourceFileName: string | null = null) {
  if (!onnxService) {
    reportError('ONNX service not initialized. Model might not have loaded correctly.', 'audio_processing_init_error');
    isProcessing.value = false; // --- CORRECTED/ADDED LINE ---
    return
  }

  if (audioBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
    reportError(
      `File too large (${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)}MB). Maximum size is ${maxFileSizeMB.value}MB.`,
      'file_size_limit'
    )
    isProcessing.value = false; // --- CORRECTED/ADDED LINE ---
    return
  }

  // isProcessing.value = true // --- REMOVED (set by calling function) ---
  error.value = null
  errorLocation.value = null
  midiBuffer.value = null;
  midiInfo.value = null;
  noteSegments.value = [];
  processedFrameData.value = [];

  try {
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
    const decoded = await audioCtx.decodeAudioData(audioBuffer)

    if (decoded.duration > MAX_AUDIO_DURATION_SECONDS) {
      reportError(
        `Audio too long (${decoded.duration.toFixed(1)}s). Maximum duration is ${MAX_AUDIO_DURATION_SECONDS}s (${maxAudioDurationMinutes.value} minutes).`,
        'audio_duration_limit'
      )
      isProcessing.value = false; // --- CORRECTED/ADDED LINE ---
      return
    }

    const raw = decoded.getChannelData(0)

    let max = 0;
    for (let i = 0; i < raw.length; i++) {
      const absVal = Math.abs(raw[i]);
      if (absVal > max) max = absVal;
    }
    const normalized = new Float32Array(raw.length);
    if (max > 0) {
      for (let i = 0; i < raw.length; i++) {
        normalized[i] = raw[i] / max;
      }
    }

    const result = await onnxService!.runInference({
      input_audio: Array.from(normalized)
    })

    frameData.value = {
      pitch_hz: new Float32Array(result.pitch_hz),
      confidence: new Float32Array(result.confidence),
      timestamps: new Float32Array(result.timestamps)
    }

    processedAudioLength.value = decoded.duration;
    processedFileSizeBytes.value = audioBuffer.byteLength;
    processedFileName.value = sourceFileName || `processed_audio_${new Date().toISOString().replace(/[:.]/g, '-')}.data`;

    processedFrameData.value = Array.from(frameData.value!.timestamps).map((timestamp, i) => ({
      timestamp: parseFloat(timestamp.toFixed(4)),
      pitch_hz: parseFloat(frameData.value!.pitch_hz[i].toFixed(2)),
      confidence: parseFloat(frameData.value!.confidence[i].toFixed(4)),
      is_voiced: voicedFlags.value[i],
    }));

    noteSegments.value = segmentNotes(
      frameData.value!.timestamps,
      frameData.value!.pitch_hz,
      voicedFlags.value,
      SEGMENTATION_PARAMS
    );

  } catch (err: any) {
    reportError(getDetailedErrorMessage(err), 'audio_processing', err)
    noteSegments.value = [];
    processedFrameData.value = [];
  } finally {
    isProcessing.value = false
    processingSource.value = null; // --- CORRECTED/ADDED LINE ---
  }
}

/* ---------- recording ---------- */
const recordAudio = async () => {
  if (isRecording.value) {
    console.warn("Attempted to start recording while already recording.");
    return;
  }

  error.value = null
  errorLocation.value = null
  frameData.value = null
  processedAudioLength.value = null;
  processedFileSizeBytes.value = null;
  processedFileName.value = null;

  midiBuffer.value = null;
  midiInfo.value = null;
  noteSegments.value = [];
  processedFrameData.value = [];

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false
      }
    })

    isRecording.value = true
    processingSource.value = null // --- CORRECTED/ADDED LINE ---
    recordingStartTime = Date.now()
    const chunks: Blob[] = []

    recorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus'
    })

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    recorder.onstop = async () => {
      isRecording.value = false
      stream.getTracks().forEach(track => track.stop())

      isProcessing.value = true;   // --- CORRECTED/ADDED LINE ---
      processingSource.value = 'record'; // --- CORRECTED/ADDED LINE ---

      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        processedFileName.value = `recorded_audio_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        await handleAudioBuffer(await blob.arrayBuffer(), processedFileName.value)
      } else {
        reportError('No audio data recorded. Please ensure your microphone is working and record for a longer duration.', 'recording_no_data');
        isProcessing.value = false;   // --- CORRECTED/ADDED LINE ---
        processingSource.value = null; // --- CORRECTED/ADDED LINE ---
      }
      recorder = null;
    }

    recorder.onerror = (event) => {
      const err = event.error || new Error("Unknown MediaRecorder error");
      reportError(getDetailedErrorMessage(err), 'recording_error', err);
      isRecording.value = false;
      stream.getTracks().forEach(track => track.stop());
      recorder = null;
      isProcessing.value = false;   // --- CORRECTED/ADDED LINE ---
      processingSource.value = null; // --- CORRECTED/ADDED LINE ---
    };

    recorder.start(100)

  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'microphone_access', err)
    isRecording.value = false
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    isProcessing.value = false;   // --- CORRECTED/ADDED LINE ---
    processingSource.value = null; // --- CORRECTED/ADDED LINE ---
  }
}

const stopRecording = () => {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
    // processingSource.value = 'record' // --- REMOVED (moved to recorder.onstop) ---
  } else {
    console.warn("Attempted to stop recording when recorder was not active.");
    isRecording.value = false;
    processingSource.value = null
  }
}

/* ---------- file upload ---------- */
const uploadAudioFile = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'audio/*'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) {
      error.value = null
      errorLocation.value = null
      frameData.value = null
      processedAudioLength.value = null;
      processedFileSizeBytes.value = null;
      processedFileName.value = file.name;

      midiBuffer.value = null;
      midiInfo.value = null;
      noteSegments.value = [];
      processedFrameData.value = [];

      isProcessing.value = true
      processingSource.value = 'upload'; // --- CORRECTED/ADDED LINE ---
      try {
        const arrayBuffer = await file.arrayBuffer()
        await handleAudioBuffer(arrayBuffer, file.name)
      } catch (err) {
        reportError(getDetailedErrorMessage(err), 'file_upload', err)
        noteSegments.value = [];
        processedFrameData.value = [];
      } finally {
        isProcessing.value = false
        processingSource.value = null // --- CORRECTED/ADDED LINE ---
      }
    }
  }
  input.click()
}

/* ---------- UI helpers ---------- */
const updateThreshold = (e: Event) => {
  threshold.value = parseFloat((e.target as HTMLInputElement).value)
}

/* ---------- initialization ---------- */
onMounted(async () => {
  try {
    if (!onnxService) {
      isLoadingModel.value = true;
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

      onnxService = new ONNXService('model.onnx')
      await onnxService.initializeSession()

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
      isLoadingModel.value = false
    }
  } catch (err: any) {
    reportError(getDetailedErrorMessage(err), 'model_loading', err)
    isLoadingModel.value = false;
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
})

onUnmounted(() => {
  if (loadTimerInterval) {
    clearInterval(loadTimerInterval);
    loadTimerInterval = null;
  }
  if (extendedMessageTimeout) {
    clearTimeout(extendedMessageTimeout);
    extendedMessageTimeout = null;
  }
});

/* ---------- data to chart transformation ---------- */
watch(frameData, (newData) => {
  if (!newData) {
    chartData.value.datasets[0].data = []
    return
  }

  const points: { x: number; y: number | null; confidence: number }[] = []

  for (let i = 0; i < newData.pitch_hz.length; i++) {
    const conf = newData.confidence[i]
    const pitch = newData.pitch_hz[i]
    const time = newData.timestamps[i]

    if (
      conf > threshold.value &&
      pitch >= frequencyRange.value[0] &&
      pitch <= frequencyRange.value[1]
    ) {
      points.push({ x: time, y: pitch, confidence: conf })
    } else {
      points.push({ x: time, y: null, confidence: conf })
    }
  }

  chartData.value = {
    datasets: [{
      ...chartData.value.datasets[0],
      data: points,
      spanGaps: false
    }]
  }
})

/* Refresh chart and auto-update MIDI when parameters change */
watch([frequencyRange, threshold], () => {
  if (frameData.value) {
    // Trigger reactivity by creating new reference
    frameData.value = { ...frameData.value }

    // Auto-update note segments and MIDI when parameters change
    noteSegments.value = segmentNotes(
      frameData.value.timestamps,
      frameData.value.pitch_hz,
      voicedFlags.value,
      SEGMENTATION_PARAMS
    );
  }
}, { deep: true })

/* Auto-generate MIDI when note segments change */
watch(noteSegments, (newSegments) => {
  if (newSegments && newSegments.length > 0) {
    generateMidiForPlayer();
  } else {
    midiInfo.value = null;
    midiBuffer.value = null;
  }
}, { deep: true, immediate: true });
</script>
<template>
  <main class="min-h-screen bg-[#131712] font-['Manrope','Noto_Sans',sans-serif] text-white">
    <div class="container mx-auto px-4 sm:px-6 lg:px-8 xl:px-16 2xl:px-40 py-8 max-w-7xl">

      <header class="mb-10 text-center lg:text-left">
        <h1 class="text-5xl sm:text-6xl lg:text-7xl font-bold leading-tight mb-4 text-[#53d22c]">
          SwiftF0
        </h1>
        <p class="text-white/80 text-lg sm:text-xl leading-relaxed max-w-4xl mx-auto lg:mx-0 mb-6">
          Turn monophonic audio into MIDI. Visualize pitch and adjust settings to improve results.
          Designed for single-note recordings like vocals or solo instruments, not chords or polyphonic music.
        </p>
        <div class="flex flex-wrap justify-center lg:justify-start gap-4 text-sm">
          <a href="https://github.com/lars76/swift-f0" target="_blank" rel="noopener noreferrer"
            class="inline-flex items-center gap-2 px-4 py-2 bg-[#1a1f17] border border-[#2d372a] rounded-lg text-white/70 hover:text-white hover:border-[#53d22c] transition-all duration-200 group shadow-md"
            title="View SwiftF0 source code on GitHub (opens in new tab)">
            <svg class="w-5 h-5 group-hover:scale-110 transition-transform duration-200" fill="currentColor"
              viewBox="0 0 24 24">
              <path
                d="M12,2A10,10 0 0,0 2,12C2,16.42 4.87,20.17 8.84,21.5C9.34,21.58 9.5,21.27 9.5,21C9.5,20.77 9.5,20.14 9.5,19.31C6.73,19.91 6.14,17.97 6.14,17.97C5.68,16.81 5.03,16.5 5.03,16.5C4.12,15.88 5.1,15.9 5.1,15.9C6.1,15.97 6.63,16.93 6.63,16.93C7.5,18.45 8.97,18 9.54,17.76C9.63,17.11 9.89,16.67 10.17,16.42C7.95,16.17 5.62,15.31 5.62,11.5C5.62,10.39 6,9.5 6.65,8.79C6.55,8.54 6.2,7.5 6.75,6.15C6.75,6.15 7.59,5.88 9.5,7.17C10.29,6.95 11.15,6.84 12,6.84C12.85,6.84 13.71,6.95 14.5,7.17C16.41,5.88 17.25,6.15 17.25,6.15C17.8,7.5 17.45,8.54 17.35,8.79C18,9.5 18.38,10.39 18.38,11.5C18.38,15.32 16.04,16.16 13.81,16.41C14.17,16.72 14.5,17.33 14.5,18.26C14.5,19.6 14.5,20.68 14.5,21C14.5,21.27 14.66,21.59 15.17,21.5C19.14,20.16 22,16.42 22,12A10,10 0 0,0 12,2Z" />
            </svg>
            Source Code
          </a>
        </div>
      </header>

      <section v-if="isLoadingModel"
        class="mb-10 bg-[#1a1f17] rounded-xl p-8 border border-[#2d372a] shadow-xl flex flex-col items-center justify-center h-[200px] sm:h-[220px] text-white/70 animate-pulse-fade"
        aria-live="polite" aria-atomic="true">
        <div class="w-16 h-16 border-4 border-[#2d372a] border-t-white rounded-full animate-spin mb-4" role="status"
          aria-label="Loading"></div>
        <span class="font-bold text-2xl mb-2">
          <template v-if="!showExtendedLoadingMessage">
            Loading AI Model...
          </template>
          <template v-else>
            Still loading, almost there... {{ elapsedLoadTime }}s
          </template>
        </span>
        <p class="text-base text-white/60">This may take a moment, especially on first visit.</p>
      </section>

      <section v-else class="mb-10 bg-[#1a1f17] rounded-xl p-8 border border-[#2d372a] shadow-xl">
        <h2 class="text-3xl font-bold mb-6 text-[#53d22c]">Audio Input</h2>

        <div class="flex flex-col sm:flex-row gap-4 mb-4">
          <button @click="isRecording ? stopRecording() : recordAudio()"
            :disabled="isProcessing && processingSource === 'upload'" :class="[
              'w-full sm:flex-1 flex items-center justify-center gap-3 h-14 px-6 rounded-xl font-bold text-lg transition-all duration-200 shadow-md',
              isRecording
                ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse'
                : 'bg-[#53d22c] hover:bg-[#4bc228] text-[#131712]',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            ]" :title="isRecording ? 'Stop Recording' : 'Start Recording Audio'"
            :aria-label="isRecording ? 'Stop Recording' : 'Record Audio'">
            <svg v-if="!isRecording" class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.2-3c0 3.53-2.64 6.4-6.2 6.73V21h3v2H8v-2h3v-3.27c-3.56-.33-6.2-3.2-6.2-6.73H3c0 4.42 3.58 8 8 8v3h2v-3c4.42 0 8-3.58 8-8h-2z" />
            </svg>
            <svg v-else class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
            <template v-if="isRecording">Stop Recording</template>
            <template v-else-if="isProcessing && processingSource === 'record'">Processing...</template>
            <template v-else>Record Audio</template>
          </button>

          <button @click="uploadAudioFile" :disabled="isRecording || (isProcessing && processingSource === 'upload')"
            :class="[
              'w-full sm:flex-1 flex items-center justify-center gap-3 h-14 px-6 rounded-xl font-bold text-lg transition-all duration-200 shadow-md',
              isProcessing && processingSource === 'upload' ? 'bg-[#3d473a] text-white/70 animate-pulse' : 'bg-[#2d372a] hover:bg-[#3d473a] text-white',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            ]" title="Upload an audio file from your device" aria-label="Upload Audio File">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" />
            </svg>
            <template v-if="isProcessing && processingSource === 'upload'">Processing...</template>
            <template v-else>Upload File</template>
          </button>
        </div>

        <div class="mt-4 text-center sm:text-left" role="status" aria-live="polite">
          <p v-if="error"
            class="text-red-400 text-sm flex items-start gap-2 p-2 bg-red-900/20 border border-red-700/50 rounded-lg animate-fade-in">
            <svg class="w-5 h-5 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path fill-rule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clip-rule="evenodd" />
            </svg>
            <span>
              <template v-if="errorLocation">
                <strong class="uppercase">{{ errorLocation.replace(/_/g, ' ') }} ERROR:</strong>
              </template>
              {{ error }}
            </span>
          </p>
          <p v-else class="text-sm text-white/60">
            Max file size: <span class="font-semibold">{{ maxFileSizeMB }}MB</span> •
            Max duration: <span class="font-semibold">{{ maxAudioDurationMinutes }} minutes</span>
          </p>
        </div>
      </section>

      <section class="mb-10 bg-[#1a1f17] rounded-xl p-8 border border-[#2d372a] shadow-xl">
        <h2 class="text-3xl font-bold mb-6 text-[#53d22c]">Analysis Parameters</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-8">

          <div class="bg-[#131712] rounded-lg p-6 border border-[#2d372a]">
            <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
              <label for="confidence-threshold" class="text-white text-base font-semibold flex-shrink-0">
                Confidence Threshold
              </label>
              <span
                class="text-white bg-[#2d372a] px-2 py-1 rounded-md font-mono text-center flex-grow-0 flex-shrink-0 overflow-hidden min-w-0 text-xs"
                aria-live="polite" aria-atomic="true">
                {{ Math.round(threshold * 100) }}%
              </span>
            </div>
            <div class="relative flex items-center h-10 mb-4">
              <div class="h-2 bg-[#2d372a] rounded-full w-full absolute">
                <div class="h-full bg-white rounded-full transition-all duration-150"
                  :style="{ width: `${threshold * 100}%` }"></div>
              </div>
              <input type="range" min="0" max="1" step="0.01" :value="threshold" @input="updateThreshold"
                id="confidence-threshold"
                class="relative z-10 w-full h-full appearance-none bg-transparent cursor-pointer slider-thumb"
                :aria-valuenow="Math.round(threshold * 100)" aria-valuemin="0" aria-valuemax="100"
                aria-label="Confidence Threshold Slider"
                title="Adjust the minimum confidence level for pitch detection.">
            </div>
            <p class="text-white/70 text-sm leading-relaxed">
              Defines the minimum confidence level. Higher values reduce noise but might miss pitches.
              Lower values detect more but can include errors. 90% is a good starting point.
            </p>
          </div>

          <div class="bg-[#131712] rounded-lg p-6 border border-[#2d372a]">
            <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
              <label class="text-white text-base font-semibold flex-shrink-0">Frequency Range</label>
              <span
                class="text-white bg-[#2d372a] px-2 py-1 rounded-md font-mono text-center flex-grow-0 flex-shrink-0 overflow-hidden min-w-0 text-xs"
                aria-live="polite" aria-atomic="true">
                {{ Math.round(frequencyRange[0]) }} Hz – {{ Math.round(frequencyRange[1]) }} Hz
              </span>
            </div>
            <div class="relative h-10 mb-4 flex items-center">
              <Slider v-model="frequencyRange" :min="FREQ_MIN" :max="FREQ_MAX" :step="1" :tooltips="false"
                class="slider-custom w-full" aria-label="Frequency Range Slider"
                :aria-valuetext="`Min: ${Math.round(frequencyRange[0])} Hz, Max: ${Math.round(frequencyRange[1])} Hz`"
                title="Set the minimum and maximum frequencies for pitch detection.">
              </Slider>
            </div>
            <p class="text-white/70 text-sm leading-relaxed">
              Set the frequency range to match your audio. Narrowing it can improve accuracy by reducing background
              noise.
              Voice is typically 80–300 Hz, instruments 60–2000 Hz.
            </p>
          </div>
        </div>
      </section>

      <section v-if="hasData" class="mb-10 bg-[#1a1f17] rounded-xl p-8 border border-[#2d372a] shadow-xl">
        <h2 class="text-3xl font-bold mb-6 text-[#53d22c]">Analysis Results</h2>

        <div class="mb-10 bg-[#131712] rounded-xl p-6 border border-[#2d372a]">
          <h3 class="text-xl font-bold mb-4 text-white/90">Pitch Visualization</h3>
          <div class="h-64 sm:h-80 lg:h-96 w-full" role="img"
            aria-label="Pitch visualization chart showing detected frequencies over time.">
            <Line :data="chartData" :options="chartOptions" class="pitch-chart h-full" />
          </div>
        </div>

        <div v-if="hasPlayableNotes" class="mb-10 bg-[#131712] rounded-xl p-6 border border-[#2d372a]">
          <h3 class="text-xl font-bold mb-4 text-white/90">MIDI Playback</h3>
          <MidiPlayer :notes="noteSegments" :auto-play="false" @error="onMidiError" :accent-color="'#2d372a'"
            aria-label="MIDI playback controls for the detected notes." />
        </div>

        <div class="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div class="bg-[#131712] rounded-xl p-6 border border-[#2d372a]">
            <h3 class="text-xl font-bold mb-6 text-white/90">Pitch Statistics</h3>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-y-4 gap-x-4">
              <div class="stat-item">
                <span class="stat-label">Frames</span>
                <span class="stat-value">
                  {{ displayPitchStats.count !== null ? displayPitchStats.count : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Average Freq</span>
                <span class="stat-value">
                  {{ displayPitchStats.average ? displayPitchStats.average.toFixed(1) + ' Hz' : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Median Freq</span>
                <span class="stat-value">
                  {{ displayPitchStats.median ? displayPitchStats.median.toFixed(1) + ' Hz' : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Freq Range</span>
                <span class="stat-value">
                  {{ displayPitchStats.max !== null && displayPitchStats.min !== null
                    ? (displayPitchStats.max - displayPitchStats.min).toFixed(1) + ' Hz'
                    : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Min Freq</span>
                <span class="stat-value">
                  {{ displayPitchStats.min ? displayPitchStats.min.toFixed(1) + ' Hz' : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Max Freq</span>
                <span class="stat-value">
                  {{ displayPitchStats.max ? displayPitchStats.max.toFixed(1) + ' Hz' : '−' }}
                </span>
              </div>
            </div>
          </div>

          <div class="bg-[#131712] rounded-xl p-6 border border-[#2d372a]">
            <h3 class="text-xl font-bold mb-6 text-white/90">MIDI Statistics</h3>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-y-4 gap-x-4">
              <div class="stat-item">
                <span class="stat-label">Notes</span>
                <span class="stat-value">
                  {{ displayMidiStats.count !== null ? displayMidiStats.count : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Average Note</span>
                <span class="stat-value">
                  {{ displayMidiStats.average ? midiToNoteName(Math.round(displayMidiStats.average)) : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Median Note</span>
                <span class="stat-value">
                  {{ displayMidiStats.median ? midiToNoteName(displayMidiStats.median) : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Note Range</span>
                <span class="stat-value">
                  {{ displayMidiStats.range !== null ? displayMidiStats.range + ' semitones' : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Lowest Note</span>
                <span class="stat-value">
                  {{ displayMidiStats.min ? midiToNoteName(displayMidiStats.min) : '−' }}
                </span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Highest Note</span>
                <span class="stat-value">
                  {{ displayMidiStats.max ? midiToNoteName(displayMidiStats.max) : '−' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="bg-[#131712] rounded-xl p-6 border border-[#2d372a]">
          <h3 class="text-xl font-bold mb-4 text-white/90">Export Options</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button @click="downloadData" :disabled="!hasData" class="export-btn"
              title="Download the raw pitch detection data as a JSON file." aria-label="Export Pitch Data (JSON)">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path fill-rule="evenodd"
                  d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                  clip-rule="evenodd" />
              </svg>
              Export Pitch Data <span class="hidden md:inline">(JSON)</span>
            </button>
            <button @click="downloadMidi" :disabled="!hasData || isProcessing || !hasPlayableNotes" class="export-btn"
              title="Download the detected notes as a MIDI file." aria-label="Export MIDI File">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 1.343-3 3s1.343 3 3 3 3-1.343 3-3V7.82l8-1.6v5.894A4.370 4.370 0 0015 12c-1.657 0-3 1.343-3 3s1.343 3 3 3 3-1.343 3-3V3z" />
              </svg>
              Export MIDI File
            </button>
          </div>
        </div>
      </section>

      <section v-else
        class="bg-[#1a1f17] rounded-xl p-10 border border-[#2d372a] shadow-xl text-center min-h-[300px] flex flex-col items-center justify-center"
        aria-live="polite">
        <div class="w-20 h-20 mx-auto mb-6 rounded-full bg-[#2d372a] flex items-center justify-center">
          <svg class="w-10 h-10 text-[#a5b6a0]" fill="none" stroke="currentColor" viewBox="0 0 24 24"
            aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l6 6-6 6z" />
          </svg>
        </div>
        <h3 class="text-white text-2xl font-bold mb-3">Ready to Analyze Audio?</h3>
        <p class="text-[#a5b6a0] text-base max-w-md mx-auto">
          Start by <strong>recording your voice</strong> or <strong>uploading an audio file</strong>
          in the section above to begin pitch detection and unlock the analysis results.
        </p>
      </section>

    </div>
  </main>
</template>

<style>
/* Import the default theme for @vueform/slider */
@import '@vueform/slider/themes/default.css';

/* Custom slider styling */
.slider-custom {
  --slider-connect-bg: white;
  --slider-bg: #2d372a;
  --slider-tooltip-bg: white;
  --slider-handle-ring-color: transparent;
  --slider-handle-bg: white;
  --slider-height: 10px;
  --slider-handle-width: 20px;
  --slider-handle-height: 20px;
  --slider-handle-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  --slider-handle-shadow-active: 0 4px 8px rgba(0, 0, 0, 0.3);
  --slider-track-radius: 5px;
  --slider-handle-radius: 50%;
  --slider-handle-transition: all 0.2s ease-in-out;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* Range input styling */
.slider-thumb {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
}

.slider-thumb::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 20px;
  height: 20px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  transition: all 0.2s ease-in-out;
  cursor: pointer;
}

.slider-thumb::-webkit-slider-thumb:hover {
  transform: scale(1.1);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
}

.slider-thumb::-moz-range-thumb {
  width: 20px;
  height: 20px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  border: 0;
  cursor: pointer;
  transition: all 0.2s ease-in-out;
}

.slider-thumb::-moz-range-thumb:hover {
  transform: scale(1.1);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
}

/* Statistics styling */
.stat-item {
  display: flex;
  flex-direction: column;
}

.stat-label {
  color: #a5b6a0;
  font-size: 0.875rem;
  text-transform: uppercase;
  display: block;
  margin-bottom: 0.125rem;
}

.stat-value {
  color: white;
  font-size: 1rem;
  font-weight: bold;
}

/* Export button styling */
.export-btn {
  width: 100%;
  height: 3rem;
  padding: 0 1.5rem;
  border-radius: 0.75rem;
  background-color: #2d372a;
  color: white;
  font-weight: bold;
  font-size: 1rem;
  transition: all 0.2s ease-in-out;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border: none;
  cursor: pointer;
}

.export-btn:hover:not(:disabled) {
  background-color: #3d473a;
}

.export-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Chart styling */
.pitch-chart {
  height: 100% !important;
}

/* Fade in animation */
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

/* Add a pulse effect to the loading state background */
@keyframes pulse-fade {
  0% {
    background-color: #2d372a;
  }

  50% {
    background-color: #384236;
  }

  /* Slightly lighter green-gray */
  100% {
    background-color: #2d372a;
  }
}

.animate-pulse-fade {
  animation: pulse-fade 2s infinite ease-in-out;
}

/* Custom scrollbar */
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

/* Responsive adjustments */
@media (max-width: 640px) {
  .stat-item {
    text-align: center;
  }
}
</style>