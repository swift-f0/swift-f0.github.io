import type { Note } from './notes'
import type { Frames } from './plot'
import { FMAX, FMIN, FRAME_PERIOD, MODEL_VERSION, SAMPLE_RATE } from './ONNXService'

export const createMidiFile = (noteSegments: Note[], { tempo = 120, velocity = 80 } = {}): Uint8Array<ArrayBuffer> => {
  const HEADER_CHUNK_TYPE = [0x4d, 0x54, 0x68, 0x64];
  const HEADER_CHUNK_LENGTH = [0x00, 0x00, 0x00, 0x06];
  const FORMAT_TYPE = [0x00, 0x00];
  const NUMBER_OF_TRACKS = [0x00, 0x01];
  const TICKS_PER_QUARTER_NOTE = 480;
  const TIME_DIVISION = [(TICKS_PER_QUARTER_NOTE >> 8) & 0xff, TICKS_PER_QUARTER_NOTE & 0xff];
  const TRACK_CHUNK_TYPE = [0x4d, 0x54, 0x72, 0x6b];

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
  allEvents.sort((a, b) => secondsToTicks(a.time) - secondsToTicks(b.time) || a.type - b.type); // Crucial for correct delta times and event order

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

export function exportJson(frames: Frames, notes: Note[], source: string | null) {
  const rows = []
  for (let i = 0; i < frames.pitch.length; i++) {
    rows.push({
      timestamp: parseFloat((i * FRAME_PERIOD).toFixed(4)),
      pitch_hz: parseFloat(frames.pitch[i].toFixed(2)),
      confidence: parseFloat(frames.conf[i].toFixed(4)),
      is_voiced: frames.conf[i] >= 0.5 && frames.pitch[i] > 0,
    })
  }
  const data = {
    generator: 'SwiftF0',
    model_version: MODEL_VERSION,
    source,
    sample_rate: SAMPLE_RATE,
    frame_period: FRAME_PERIOD,
    settings: {
      voiced_threshold: 0.5,
      fmin: FMIN,
      fmax: FMAX,
      segmentation: { lam: 250, min_note_duration: 0.05, detect_repeated_notes: true },
    },
    frames: rows,
    notes: notes.map((n) => ({
      start: parseFloat(n.start.toFixed(4)),
      end: parseFloat(n.end.toFixed(4)),
      pitch_median: parseFloat(n.pitch_median.toFixed(2)),
      pitch_midi: n.pitch_midi,
    })),
  }
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
}

export function pitchTier(frames: Frames) {
  const points: string[] = []
  for (let i = 0; i < frames.pitch.length; i++) {
    if (frames.conf[i] >= 0.5 && frames.pitch[i] > 0) {
      points.push((i * FRAME_PERIOD).toFixed(3), frames.pitch[i].toFixed(3))
    }
  }
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "PitchTier"',
    '',
    '0',
    (frames.pitch.length * FRAME_PERIOD).toFixed(3),
    String(points.length / 2),
    ...points,
    '',
  ]
  return new Blob([lines.join('\n')], { type: 'text/plain' })
}

export function baseFileName(source: string | null) {
  const stem = source ? source.replace(/\.[^/.]+$/, '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '') : ''
  return stem || `pitch-data-${new Date().toISOString().split('T')[0]}`
}

export function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.style.display = 'none'
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}
