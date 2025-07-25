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

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Filler)

/* ---------- reactive state ---------- */
const isRecording = ref(false)
const isProcessing = ref(false)
const isLoadingModel = ref(true) // New reactive state for model loading
const showExtendedLoadingMessage = ref(false) // NEW: Controls when to show extended message

const error = ref<string | null>(null)
const errorLocation = ref<string | null>(null) // New: To specify where the error occurred

/* Extended type with real timestamps */
const frameData = ref<{
  pitch_hz: Float32Array
  confidence: Float32Array
  timestamps: Float32Array
} | null>(null)

// Reactive variables for metadata
const processedAudioLength = ref<number | null>(null)
const processedFileSizeBytes = ref<number | null>(null)
const processedFileName = ref<string | null>(null)

// --- NEW: Timer related reactive state ---
const modelLoadStartTime = ref<number | null>(null);
const elapsedLoadTime = ref(0);
let loadTimerInterval: ReturnType<typeof setInterval> | null = null;
let extendedMessageTimeout: ReturnType<typeof setTimeout> | null = null; // NEW
// -----------------------------------------


let onnxService: ONNXService | null = null
let recorder: MediaRecorder | null = null
let recordingStartTime = 0

const threshold = ref<number>(0.9) // Explicitly typed as number
const frequencyRange = ref([80, 300])

/* ---------- constants ---------- */
const FREQ_MIN = 46.875
const FREQ_MAX = 2093.75
const SAMPLE_RATE = 16000
const MAX_AUDIO_DURATION_SECONDS = 300 // 5 minutes in seconds
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

// Centralized parameters for the note segmentation algorithm
const SEGMENTATION_PARAMS = {
  splitSemitoneThreshold: 0.8,
  minNoteDuration: 0.05,
  unvoicedGracePeriod: 0.02,
};

// Expose for UI
const maxFileSizeMB = computed(() => MAX_FILE_SIZE_BYTES / 1024 / 1024)
const maxAudioDurationMinutes = computed(() => MAX_AUDIO_DURATION_SECONDS / 60)

/* ---------- computed properties ---------- */
const hasData = computed(() => frameData.value && frameData.value.pitch_hz.length > 0)

const dataStats = computed(() => {
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

  const sorted = [...validPoints].sort((a, b) => a - b) // Create a copy before sorting
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

// Always returns stats object for consistent display
const displayStats = computed(() => {
  if (dataStats.value) return dataStats.value

  return {
    count: null,
    average: null,
    median: null,
    min: null,
    max: null,
    duration: null
  }
})

const recordButtonText = computed(() => {
  if (isRecording.value) return 'Stop Recording';
  return 'Record Audio';
});

// --- Download Handler Functions ---

/**
 * Exports all processed data, including metadata and note segments, to a JSON file.
 */
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
          frequencyRangeHz: frequencyRange.value//,
          //globalMinFrequencyHz: FREQ_MIN,
          //globalMaxFrequencyHz: FREQ_MAX
        },
        noteSegmentationParameters: {
          ...SEGMENTATION_PARAMS
        },
        totalPointsCount: processedFrameData.value.length,
        voicedPointsCount: voicedFlags.value.filter(v => v).length,
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

/**
 * Exports the detected note segments to a standard MIDI file.
 */
const downloadMidi = () => {
  if (!hasData.value || noteSegments.value.length === 0) {
    reportError("No note segments found to export to MIDI.", 'midi_export_no_notes');
    return;
  }

  try {
    // createMidiFile now accepts tempo and velocity for better parity with the Python version
    const midiData = createMidiFile(noteSegments.value, { tempo: 120, velocity: 80 });
    const blob = new Blob([midiData], { type: 'audio/midi' });
    triggerDownload(blob, '.mid');
  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'midi_export_error', err);
  }
};

/**
 * Helper function to trigger a file download in the browser.
 */
const triggerDownload = (blob, extension) => {
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


// --- Core Algorithms & Helpers ---

/**
 * Calculates the median of an array of numbers.
 */
const median = (arr) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * Segments a pitch contour into discrete musical notes, ported from the Python implementation.
 */
const segmentNotes = (timestamps, pitchHz, voicing, params) => {
  if (timestamps.length === 0) return [];

  const framePeriod = timestamps.length > 1 ? timestamps[1] - timestamps[0] : 0.016;
  const notes = [];
  let currentNoteSegment = null;
  let unvoicedFramesCount = 0;

  const midiContour = pitchHz.map((pitch, i) => {
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
    } else { // Unvoiced frame
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
      previousNote.end = currentNote.end; // Merge notes
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

/**
 * Creates a raw MIDI file (as a Uint8Array) from note segments.
 */
const createMidiFile = (noteSegments, { tempo = 120, velocity = 80 } = {}) => {
  const HEADER_CHUNK_TYPE = [0x4d, 0x54, 0x68, 0x64]; // "MThd"
  const HEADER_CHUNK_LENGTH = [0x00, 0x00, 0x00, 0x06];
  const FORMAT_TYPE = [0x00, 0x00]; // Format 0 (single track)
  const NUMBER_OF_TRACKS = [0x00, 0x01];
  const TICKS_PER_QUARTER_NOTE = 480;
  const TIME_DIVISION = [(TICKS_PER_QUARTER_NOTE >> 8) & 0xff, TICKS_PER_QUARTER_NOTE & 0xff];
  const TRACK_CHUNK_TYPE = [0x4d, 0x54, 0x72, 0x6b]; // "MTrk"

  const encodeVariableLength = (value) => {
    let buffer = value & 0x7f;
    while ((value >>= 7) > 0) {
      buffer <<= 8;
      buffer |= (value & 0x7f) | 0x80;
    }
    const bytes = [];
    while (true) {
      bytes.push(buffer & 0xff);
      if (buffer & 0x80) buffer >>= 8;
      else break;
    }
    return bytes;
  };

  const secondsToTicks = (seconds) => Math.round(seconds * TICKS_PER_QUARTER_NOTE * (tempo / 60));

  const trackEvents = [];
  let lastEventTicks = 0;

  // Tempo Event (microseconds per quarter note)
  const microSecondsPerBeat = Math.round(60000000 / tempo);
  trackEvents.push(0x00, 0xff, 0x51, 0x03,
    (microSecondsPerBeat >> 16) & 0xff,
    (microSecondsPerBeat >> 8) & 0xff,
    microSecondsPerBeat & 0xff
  );

  const sortedNotes = [...noteSegments].sort((a, b) => a.start - b.start);

  for (const note of sortedNotes) {
    const startTicks = secondsToTicks(note.start);
    const endTicks = secondsToTicks(note.end);
    const midiNote = Math.max(0, Math.min(127, note.pitch_midi));

    // Note On event
    const onDelta = startTicks - lastEventTicks;
    trackEvents.push(...encodeVariableLength(onDelta), 0x90, midiNote, Math.min(127, velocity));
    lastEventTicks = startTicks;

    // Note Off event
    const offDelta = endTicks - lastEventTicks;
    trackEvents.push(...encodeVariableLength(offDelta), 0x80, midiNote, Math.min(127, velocity));
    lastEventTicks = endTicks;
  }

  // End of Track event
  trackEvents.push(...encodeVariableLength(0), 0xff, 0x2f, 0x00);

  const trackLength = trackEvents.length;
  const trackLengthBytes = [
    (trackLength >> 24) & 0xff, (trackLength >> 16) & 0xff,
    (trackLength >> 8) & 0xff, trackLength & 0xff
  ];

  return new Uint8Array([
    ...HEADER_CHUNK_TYPE, ...HEADER_CHUNK_LENGTH, ...FORMAT_TYPE, ...NUMBER_OF_TRACKS, ...TIME_DIVISION,
    ...TRACK_CHUNK_TYPE, ...trackLengthBytes, ...trackEvents
  ]);
};

// --- Reactive Derived Data (Computed Properties) ---

/**
 * Computes a boolean array indicating if each frame is voiced based on current settings.
 * This is reactive and will update automatically if the threshold or frequency range changes.
 */
const voicedFlags = computed(() => {
  if (!hasData.value) return [];
  // FIX: Convert Float32Array to a standard array before mapping to ensure it returns booleans.
  return Array.from(frameData.value!.pitch_hz).map((pitch, i) => {
    const confidence = frameData.value!.confidence[i];
    return (
      confidence > threshold.value &&
      pitch >= frequencyRange.value[0] &&
      pitch <= frequencyRange.value[1]
    );
  });
});

/**
 * Computes the final note segments using the segmentation algorithm.
 * This is also reactive and depends on the raw frame data and voicedFlags.
 */
const noteSegments = computed(() => {
  if (!hasData.value) return [];
  return segmentNotes(
    frameData.value!.timestamps,
    frameData.value!.pitch_hz,
    voicedFlags.value,
    SEGMENTATION_PARAMS
  );
});

/**
 * Computes the full frame-by-frame data for JSON export.
 * This combines the raw data with the calculated `is_voiced` status.
 */
const processedFrameData = computed(() => {
  if (!hasData.value) return [];
  // FIX: Convert Float32Array to a standard array before mapping to ensure it returns objects.
  return Array.from(frameData.value!.timestamps).map((timestamp, i) => ({
    timestamp: parseFloat(timestamp.toFixed(4)),
    pitch_hz: parseFloat(frameData.value!.pitch_hz[i].toFixed(2)),
    confidence: parseFloat(frameData.value!.confidence[i].toFixed(4)),
    is_voiced: voicedFlags.value[i],
  }));
});

// -----------------------------------------------------

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
  // console.error for internal debugging
  if (err) {
    console.error(`Error at ${location}:`, err);
  } else {
    console.error(`Error at ${location}: ${message}`);
  }
  // Clear data related to the failed operation
  frameData.value = null;
  processedAudioLength.value = null;
  processedFileSizeBytes.value = null;
  processedFileName.value = null;
}

/* ---------- improved error message generation ---------- */
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
    // For MediaRecorder specific DOMExceptions
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
    return
  }

  // Check file size
  if (audioBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
    reportError(
      `File too large (${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)}MB). Maximum size is ${maxFileSizeMB.value}MB.`,
      'file_size_limit'
    )
    return
  }

  isProcessing.value = true
  error.value = null // Clear previous errors
  errorLocation.value = null

  try {
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
    const decoded = await audioCtx.decodeAudioData(audioBuffer)

    // Check duration
    if (decoded.duration > MAX_AUDIO_DURATION_SECONDS) {
      reportError(
        `Audio too long (${decoded.duration.toFixed(1)}s). Maximum duration is ${MAX_AUDIO_DURATION_SECONDS}s (${maxAudioDurationMinutes.value} minutes).`,
        'audio_duration_limit'
      )
      return
    }

    const raw = decoded.getChannelData(0)

    // FIXED NORMALIZATION: Replace spread operator with efficient loop to prevent stack overflow
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
    } else {
      // If max is 0 (e.g., silence), normalized remains all zeros, which is correct
    }


    const result = await onnxService.runInference({
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

  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'audio_processing', err)
  } finally {
    isProcessing.value = false // Ensure processing state is always reset
  }
}

/* ---------- recording ---------- */
const recordAudio = async () => {
  if (isRecording.value) {
    console.warn("Attempted to start recording while already recording.");
    return;
  }

  error.value = null // Clear previous errors
  errorLocation.value = null
  frameData.value = null // Clear data immediately on new recording attempt
  processedAudioLength.value = null; // Reset
  processedFileSizeBytes.value = null; // Reset
  processedFileName.value = null; // Reset
  processedFileName.value = `recorded_audio_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;

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
    recordingStartTime = Date.now()
    const chunks: Blob[] = []

    recorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus'
    })

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    recorder.onstop = async () => {
      isRecording.value = false // Set recording to false immediately after stop event
      stream.getTracks().forEach(track => track.stop()) // Stop all tracks from the stream

      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        await handleAudioBuffer(await blob.arrayBuffer(), processedFileName.value || 'recorded_audio.webm')
      } else {
        reportError('No audio data recorded. Please ensure your microphone is working and record for a longer duration.', 'recording_no_data');
      }
      recorder = null; // Clean up recorder instance
    }

    recorder.onerror = (event) => {
      // Accessing event.error for MediaRecorder errors
      const err = event.error || new Error("Unknown MediaRecorder error");
      reportError(getDetailedErrorMessage(err), 'recording_error', err);
      isRecording.value = false; // Ensure state is reset on error
      stream.getTracks().forEach(track => track.stop()); // Stop tracks on error
      recorder = null; // Clean up recorder instance
    };

    recorder.start(100) // Collect data every 100ms

  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'microphone_access', err)
    isRecording.value = false // Ensure recording state is reset on error
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop(); // Attempt to stop if it somehow started
    }
  }
}

const stopRecording = () => {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
  } else {
    console.warn("Attempted to stop recording when recorder was not active.");
    // If for some reason recorder.state is 'inactive' but isRecording is true (desync)
    if (isRecording.value) {
      isRecording.value = false; // Force reset UI state
      reportError('Recording stopped unexpectedly or was already inactive.', 'recording_state_desync');
    }
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
      error.value = null // Clear previous errors
      errorLocation.value = null
      frameData.value = null // Clear data immediately on new upload attempt
      processedAudioLength.value = null; // Reset
      processedFileSizeBytes.value = null; // Reset
      processedFileName.value = null; // Reset
      isProcessing.value = true // Set processing state immediately for upload
      try {
        const arrayBuffer = await file.arrayBuffer()
        processedFileName.value = file.name; // Set file name here for uploaded files
        await handleAudioBuffer(arrayBuffer, file.name)
      } catch (err) {
        reportError(getDetailedErrorMessage(err), 'file_upload', err)
      } finally {
        isProcessing.value = false // ENSURE isProcessing is reset here!
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
      // Start timer when model loading begins
      isLoadingModel.value = true;
      modelLoadStartTime.value = Date.now();
      elapsedLoadTime.value = 0;

      // NEW: Show extended message after 3 seconds
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

      // Stop and clear timer when model loading ends
      if (loadTimerInterval) {
        clearInterval(loadTimerInterval);
        loadTimerInterval = null;
      }
      if (extendedMessageTimeout) { // NEW: Clear timeout if model loaded quickly
        clearTimeout(extendedMessageTimeout);
        extendedMessageTimeout = null;
      }
      modelLoadStartTime.value = null;
      elapsedLoadTime.value = 0;
      isLoadingModel.value = false
    }
  } catch (err) {
    reportError(getDetailedErrorMessage(err), 'model_loading', err)
    isLoadingModel.value = false;
    if (loadTimerInterval) {
      clearInterval(loadTimerInterval);
      loadTimerInterval = null;
    }
    if (extendedMessageTimeout) { // NEW: Clear timeout on error
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
  }
  if (extendedMessageTimeout) {
    clearTimeout(extendedMessageTimeout);
  }
});

/* ---------- data to chart transformation ---------- */
watch(frameData, (newData) => {
  if (!newData) {
    chartData.value.datasets[0].data = []
    return
  }

  const points: { x: number; y: number | null; confidence: number }[] = [] // y can now be null

  for (let i = 0; i < newData.pitch_hz.length; i++) {
    const conf = newData.confidence[i]
    const pitch = newData.pitch_hz[i]
    const time = newData.timestamps[i]

    // Check if the point is "voiced" based on threshold and frequency range
    if (
      conf > threshold.value &&
      pitch >= frequencyRange.value[0] &&
      pitch <= frequencyRange.value[1]
    ) {
      points.push({ x: time, y: pitch, confidence: conf })
    } else {
      // If unvoiced, push a null value for 'y' to create a gap in the line
      points.push({ x: time, y: null, confidence: conf })
    }
  }

  chartData.value = {
    datasets: [{
      ...chartData.value.datasets[0],
      data: points,
      spanGaps: false // Explicitly set to false (it's the default, but good for clarity)
    }]
  }
})

/* Refresh chart when parameters change */
watch([frequencyRange, threshold], () => {
  if (frameData.value) {
    // Trigger reactivity by creating new reference
    frameData.value = { ...frameData.value }
  }
}, { deep: true })
</script>

<template>
  <main class="min-h-screen bg-[#131712] font-['Manrope','Noto_Sans',sans-serif]">
    <div class="container mx-auto px-4 sm:px-6 lg:px-8 xl:px-16 2xl:px-40 py-6 max-w-7xl">

      <div class="mb-8">
        <h1 class="text-white text-2xl sm:text-3xl lg:text-4xl font-bold leading-tight mb-3">
          SwiftF0
        </h1>
        <p class="text-white/80 text-sm sm:text-base leading-relaxed mb-4">
          Analyze pitch from audio or files. Adjust frequency range to improve accuracy: typical human voices fall
          between <strong>80–300 Hz</strong>. For instruments, middle C is <strong>261.6 Hz</strong>, low guitar E is
          <strong>82.4 Hz</strong>. Confidence threshold ranges from 0–100%; around <strong>90%</strong> works best in
          clean recordings. Narrowing the frequency range and tuning confidence can reduce noise and improve detection.
        </p>

        <div class="flex flex-wrap gap-3 text-sm">
          <a href="https://github.com/lars76/swift-f0" target="_blank" rel="noopener noreferrer"
            class="inline-flex items-center gap-2 px-3 py-1.5 bg-[#1a1f17] border border-[#2d372a] rounded-lg text-white/80 hover:text-white hover:border-[#53d22c] transition-all duration-200">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path
                d="M12,2A10,10 0 0,0 2,12C2,16.42 4.87,20.17 8.84,21.5C9.34,21.58 9.5,21.27 9.5,21C9.5,20.77 9.5,20.14 9.5,19.31C6.73,19.91 6.14,17.97 6.14,17.97C5.68,16.81 5.03,16.5 5.03,16.5C4.12,15.88 5.1,15.9 5.1,15.9C6.1,15.97 6.63,16.93 6.63,16.93C7.5,18.45 8.97,18 9.54,17.76C9.63,17.11 9.89,16.67 10.17,16.42C7.95,16.17 5.62,15.31 5.62,11.5C5.62,10.39 6,9.5 6.65,8.79C6.55,8.54 6.2,7.5 6.75,6.15C6.75,6.15 7.59,5.88 9.5,7.17C10.29,6.95 11.15,6.84 12,6.84C12.85,6.84 13.71,6.95 14.5,7.17C16.41,5.88 17.25,6.15 17.25,6.15C17.8,7.5 17.45,8.54 17.35,8.79C18,9.5 18.38,10.39 18.38,11.5C18.38,15.32 16.04,16.16 13.81,16.41C14.17,16.72 14.5,17.33 14.5,18.26C14.5,19.6 14.5,20.68 14.5,21C14.5,21.27 14.66,21.59 15.17,21.5C19.14,20.16 22,16.42 22,12A10,10 0 0,0 12,2Z" />
            </svg>
            Source Code
          </a>
        </div>
      </div>

      <section class="mb-8">
        <h2 class="text-white text-lg sm:text-xl font-bold mb-4">Audio Input</h2>
        <div v-if="isLoadingModel"
          class="p-4 bg-[#1a1f17] rounded-lg border border-[#2d372a] text-white/80 flex items-center justify-center">
          <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none"
            viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z">
            </path>
          </svg>
          <span>
            <template v-if="!showExtendedLoadingMessage">
              Loading AI Model...
            </template>
            <template v-else>
              Still loading, almost there... {{ elapsedLoadTime }} seconds
            </template>
          </span>
        </div>
        <div v-else class="flex flex-col sm:flex-row gap-3">
          <button @click="isRecording ? stopRecording() : recordAudio()" :disabled="isProcessing" :class="[
            'w-full sm:w-auto min-w-[140px] h-11 px-6 rounded-lg font-bold text-sm transition-all duration-200',
            isRecording
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-[#53d22c] hover:bg-[#4bc228] text-[#131712]',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          ]">
            {{ recordButtonText }}
          </button>

          <button @click="uploadAudioFile" :disabled="isProcessing || isRecording"
            class="w-full sm:w-auto min-w-[140px] h-11 px-6 rounded-lg bg-[#2d372a] hover:bg-[#3d473a] text-white font-bold text-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed">
            {{ isProcessing && !isRecording ? 'Processing...' : 'Upload File' }}
          </button>
        </div>

        <div class="mt-3 text-xs text-white/60">
          Maximum file size: {{ maxFileSizeMB }}MB • Maximum duration: {{ maxAudioDurationMinutes }} minutes
        </div>

        <div v-if="error" class="mt-4 p-4 bg-red-900/20 border border-red-700/50 rounded-lg">
          <p class="text-red-400 text-sm flex items-start gap-2">
            <svg class="w-4 h-4 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clip-rule="evenodd" />
            </svg>
            <span>
              <template v-if="errorLocation">
                **{{ errorLocation.replace(/_/g, ' ').toUpperCase() }} ERROR:**
              </template>
              {{ error }}
            </span>
          </p>
        </div>
      </section>

      <section class="mb-8">
        <h2 class="text-white text-lg sm:text-xl font-bold mb-4">Parameters</h2>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

          <div class="bg-[#1a1f17] rounded-lg p-4 border border-[#2d372a]">
            <div class="flex items-center justify-between mb-4">
              <label class="text-white text-base font-medium">Confidence Threshold</label>
              <span class="text-white text-sm bg-[#2d372a] px-2 py-1 rounded">
                {{ Math.round(threshold * 100) }}%
              </span>
            </div>
            <div class="relative">
              <div class="h-1 bg-[#42513e] rounded-full">
                <div class="h-full bg-white rounded-full transition-all duration-150"
                  :style="{ width: `${threshold * 100}%` }"></div>
              </div>
              <input type="range" min="0" max="1" step="0.01" :value="threshold" @input="updateThreshold"
                class="absolute inset-0 w-full h-full opacity-0 cursor-pointer">
              <div class="absolute -top-1.5 w-4 h-4 bg-white rounded-full transition-all duration-150"
                :style="{ left: `calc(${threshold * 100}% - 8px)` }"></div>
            </div>
          </div>

          <div class="bg-[#1a1f17] rounded-lg p-4 border border-[#2d372a]">
            <div class="flex items-center justify-between mb-4">
              <label class="text-white text-base font-medium">Frequency Range</label>
            </div>
            <div class="space-y-3">
              <Slider v-model="frequencyRange" :min="FREQ_MIN" :max="FREQ_MAX" :step="1" :tooltips="false"
                class="slider-custom" />
              <div class="flex justify-between text-white text-sm font-mono">
                <span>{{ Math.round(frequencyRange[0]) }} Hz</span>
                <span>{{ Math.round(frequencyRange[1]) }} Hz</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="mb-8">
        <h2 class="text-white text-lg sm:text-xl font-bold mb-4">Statistics</h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div class="bg-[#1a1f17] rounded-lg p-4 border border-[#2d372a]">
            <div class="text-[#a5b6a0] text-xs uppercase tracking-wide mb-1">Points</div>
            <div class="text-white text-lg font-bold">
              {{ displayStats.count !== null ? displayStats.count : '-' }}
            </div>
          </div>
          <div class="bg-[#1a1f17] rounded-lg p-4 border border-[#2d372a]">
            <div class="text-[#a5b6a0] text-xs uppercase tracking-wide mb-1">Average</div>
            <div class="text-white text-lg font-bold">
              {{ displayStats.average ? displayStats.average.toFixed(1) + 'Hz' : '-' }}
            </div>
          </div>
          <div class="bg-[#1a1f17] rounded-lg p-4 border border-[#2d372a]">
            <div class="text-[#a5b6a0] text-xs uppercase tracking-wide mb-1">Median</div>
            <div class="text-white text-lg font-bold">
              {{ displayStats.median ? displayStats.median.toFixed(1) + 'Hz' : '-' }}
            </div>
          </div>
          <div class="bg-[#1a1f17] rounded-lg p-4 border border-[#2d372a]">
            <div class="text-[#a5b6a0] text-xs uppercase tracking-wide mb-1">Range</div>
            <div class="text-white text-lg font-bold">
              {{ displayStats.min !== null && displayStats.max !== null
                ? (displayStats.max - displayStats.min).toFixed(1) + 'Hz'
                : '-' }}
            </div>
          </div>
          <div class="bg-[#1a1f17] rounded-lg p-4 border border-[#2d372a]">
            <div class="text-[#a5b6a0] text-xs uppercase tracking-wide mb-1">Min</div>
            <div class="text-white text-lg font-bold">
              {{ displayStats.min ? displayStats.min.toFixed(1) + 'Hz' : '-' }}
            </div>
          </div>
          <div class="bg-[#1a1f17] rounded-lg p-4 border border-[#2d372a]">
            <div class="text-[#a5b6a0] text-xs uppercase tracking-wide mb-1">Max</div>
            <div class="text-white text-lg font-bold">
              {{ displayStats.max ? displayStats.max.toFixed(1) + 'Hz' : '-' }}
            </div>
          </div>
        </div>
      </section>

      <section class="mb-8">
        <h2 class="text-white text-lg sm:text-xl font-bold mb-4">Visualization</h2>
        <div class="bg-[#1a1f17] rounded-lg border border-[#2d372a] p-6">
          <div class="h-64 sm:h-80 lg:h-96">
            <div v-if="hasData" class="h-full">
              <Line :data="chartData" :options="chartOptions" class="pitch-chart h-full" />
            </div>
            <div v-else class="h-full flex items-center justify-center">
              <div class="text-center">
                <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-[#2d372a] flex items-center justify-center">
                  <svg class="w-8 h-8 text-[#a5b6a0]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l6 6-6 6z" />
                  </svg>
                </div>
                <h3 class="text-white text-lg font-bold mb-2">No Data Available</h3>
                <p class="text-[#a5b6a0] text-sm">Record or upload audio to begin pitch detection</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="flex flex-col sm:flex-row gap-3">
          <button @click="downloadMidi" :disabled="!hasData || isProcessing"
            class="w-full sm:w-auto min-w-[140px] h-11 px-6 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm transition-all duration-200 flex items-center justify-center gap-2">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path
                d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 1.343-3 3s1.343 3 3 3 3-1.343 3-3V7.82l8-1.6v5.894A4.37 4.37 0 0015 12c-1.657 0-3 1.343-3 3s1.343 3 3 3 3-1.343 3-3V3z" />
            </svg>
            Export MIDI
          </button>
          <button @click="downloadData" :disabled="!hasData"
            class="w-full sm:w-auto min-w-[140px] h-11 px-6 rounded-lg bg-[#2d372a] hover:bg-[#3d473a] disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm transition-all duration-200">
            Export JSON
          </button>
        </div>
      </section>
    </div>
  </main>
</template>

<style>
@import '@vueform/slider/themes/default.css';

.slider-custom {
  --slider-connect-bg: white;
  --slider-tooltip-bg: #53d22c;
  --slider-handle-ring-color: transparent;
  --slider-handle-bg: white;
  --slider-bg: #42513e;
  --slider-height: 4px;
  --slider-handle-width: 16px;
  --slider-handle-height: 16px;
  --slider-handle-shadow: none;
  --slider-handle-shadow-active: none;
}

.pitch-chart {
  height: 100% !important;
}

/* Custom scrollbar for better visual consistency */
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
</style>