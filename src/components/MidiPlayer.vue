<template>
    <!-- Responsive MIDI Player: Single row on desktop, two rows on mobile -->
    <div
        class="flex items-center gap-3 bg-[#131712] rounded-lg p-3 border border-[#2d372a] shadow-inner font-sans text-white sm:flex-row flex-col sm:gap-3 gap-2">

        <!-- Main controls row: Play button + Time + Progress + Volume + Time -->
        <div class="flex items-center gap-3 w-full">
            <!-- Play Button -->
            <button ref="playButton"
                class="w-10 h-10 min-w-[40px] rounded-full flex items-center justify-center transition-all duration-200 shadow-md"
                :class="[
                    hasNotes ? 'bg-[#53d22c] hover:bg-[#4bc228] text-[#131712]' : 'bg-[#2d372a] text-white/50 cursor-not-allowed',
                    isPlaying ? 'animate-pulse' : ''
                ]" :disabled="!hasNotes" @mousedown="initOnInteraction" @click="togglePlayback"
                :title="isPlaying ? 'Pause MIDI Playback' : 'Play MIDI Playback'"
                :aria-label="isPlaying ? 'Pause MIDI' : 'Play MIDI'">
                <svg v-show="!isPlaying" class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                </svg>
                <svg v-show="isPlaying" class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
            </button>

            <!-- Current Time (Desktop) -->
            <span class="text-white/70 text-sm font-mono min-w-[45px] text-center hidden sm:block">
                {{ currentTimeFormatted }}
            </span>

            <!-- Progress Bar -->
            <div ref="progressContainer" class="flex-1 h-2 bg-[#2d372a] rounded-full relative cursor-pointer group"
                @mousedown="handleProgressMouseDown" role="slider" :aria-valuenow="progress" aria-valuemin="0"
                aria-valuemax="100" aria-label="MIDI Playback Progress">
                <div class="h-full bg-[#53d22c] rounded-full transition-all duration-75"
                    :style="{ width: `${progress}%` }"></div>
                <div class="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white border-2 border-[#53d22c] shadow-lg transition-opacity duration-200 opacity-0 group-hover:opacity-100"
                    :style="{ left: `${progress}%`, transform: 'translateX(-50%) translateY(-50%)' }"></div>
            </div>

            <!-- Duration Time (Desktop) -->
            <span class="text-white/70 text-sm font-mono min-w-[45px] text-center hidden sm:block">
                {{ durationFormatted }}
            </span>

            <!-- Desktop Volume Controls -->
            <div class="hidden sm:flex items-center gap-2 ml-2">
                <button
                    class="w-6 h-6 flex items-center justify-center text-white/70 hover:text-white transition-colors duration-200"
                    @click="toggleMute" :title="isMuted || volume === 0 ? 'Unmute' : 'Mute'"
                    :aria-label="isMuted || volume === 0 ? 'Unmute MIDI' : 'Mute MIDI'">
                    <svg v-show="isMuted || volume === 0" class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"
                        aria-hidden="true">
                        <path
                            d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    </svg>
                    <svg v-show="!isMuted && volume > 0" class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"
                        aria-hidden="true">
                        <path
                            d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                </button>
                <input v-model="volume"
                    class="w-20 h-2 appearance-none bg-[#2d372a] rounded-full outline-none transition-opacity duration-200 custom-volume-slider"
                    type="range" min="0" max="1" step="0.01" @input="handleVolumeInput" title="Adjust Volume"
                    aria-label="Volume Slider" :aria-valuenow="Math.round(volume * 100)" aria-valuemin="0"
                    aria-valuemax="100">
            </div>

            <!-- Mobile Volume Toggle -->
            <button
                class="w-8 h-8 min-w-[32px] flex items-center justify-center text-white/70 hover:text-white transition-colors duration-200 rounded-full hover:bg-[#2d372a] sm:hidden"
                @click="toggleMute" :title="isMuted || volume === 0 ? 'Unmute' : 'Mute'"
                :aria-label="isMuted || volume === 0 ? 'Unmute MIDI' : 'Mute MIDI'">
                <svg v-show="isMuted || volume === 0" class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"
                    aria-hidden="true">
                    <path
                        d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                </svg>
                <svg v-show="!isMuted && volume > 0" class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"
                    aria-hidden="true">
                    <path
                        d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                </svg>
            </button>
        </div>

        <!-- Mobile-only bottom row: Time info -->
        <div class="flex items-center justify-between w-full text-xs sm:hidden">
            <span class="text-white/70 font-mono">
                {{ currentTimeFormatted }}
            </span>
            <span class="text-white/70 font-mono">
                {{ durationFormatted }}
            </span>
        </div>
    </div>
</template>

<style scoped>
/* Custom Volume Slider Styles (to match the range input style from the main app) */
.custom-volume-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    /* Slightly larger for better interaction */
    height: 16px;
    /* Slightly larger for better interaction */
    border-radius: 50%;
    background: white;
    /* Thumb color to match other sliders */
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    /* Shadow for visual depth */
    transition: all 0.2s ease-in-out;
}

.custom-volume-slider::-webkit-slider-thumb:hover {
    transform: scale(1.1);
    /* Subtle hover effect */
}

.custom-volume-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    border: 0;
}

.custom-volume-slider:hover {
    opacity: 1;
    /* Keep this to make it more interactive on hover */
}
</style>

<script>
import { markRaw } from 'vue';

// Optimized sampler - 4 samples cover most musical ranges efficiently
const SAMPLER_URLS = {
    C3: 'C3.mp3',
    C4: 'C4.mp3',
    C5: 'C5.mp3',
    C6: 'C6.mp3'
};
const SAMPLER_BASE_URL = '/';
const SAMPLER_LOAD_TIMEOUT = 8000;

export default {
    name: 'MidiPlayer',
    props: {
        midiData: {
            type: [ArrayBuffer, Blob, String],
            default: null
        },
        notes: {
            type: Array,
            default: null
        },
        autoPlay: {
            type: Boolean,
            default: false
        }
    },
    data() {
        return {
            _Tone: null,
            processedNotes: [],
            piano: null,
            part: null,
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            volume: 0.8,
            previousVolume: 0.8,
            isMuted: false,
            progress: 0,
            isDragging: false,
            raf: null,
            audioInitialized: false,
            userGesturePerformed: false,
        }
    },
    computed: {
        currentTimeFormatted() {
            return this.formatTime(this.currentTime);
        },
        durationFormatted() {
            return this.formatTime(this.duration);
        },
        hasNotes() {
            return this.processedNotes?.length > 0;
        },
        isReadyToPlay() {
            return this.hasNotes && this.audioInitialized && this.userGesturePerformed;
        }
    },
    watch: {
        midiData: {
            handler: 'loadMidiData',
            immediate: true
        },
        notes: {
            handler: 'loadNotes',
            immediate: true,
            deep: true
        },
        volume(newVolume) {
            // When volume is manually set to 0, treat it as muted
            if (newVolume === 0 && !this.isMuted) {
                // Don't change isMuted state, but save the previous volume if it was > 0
                if (this.previousVolume === 0) {
                    this.previousVolume = 0.8; // Default fallback
                }
            } else if (newVolume > 0 && this.volume !== newVolume) {
                // If volume is increased from 0, save it as previous volume
                this.previousVolume = newVolume;
                // If we were muted and volume is now > 0, unmute
                if (this.isMuted) {
                    this.isMuted = false;
                }
            }
        }
    },
    beforeUnmount() {
        this.cleanup();
    },
    methods: {
        async loadToneJs() {
            if (this._Tone) return;

            try {
                const toneModule = await import('tone');
                this._Tone = toneModule;
                this._Tone.Transport.off('ended', this.handlePlaybackEnd);
                this._Tone.Transport.on('ended', this.handlePlaybackEnd);
            } catch (error) {
                this.$emit('error', new Error('Failed to load audio library'));
                throw error;
            }
        },

        async createSampler() {
            await this.loadToneJs();
            const Tone = this._Tone;

            if (!Tone || (this.piano && this.audioInitialized)) return;

            try {
                if (Tone.context.state !== 'running') {
                    await Tone.start();
                }

                if (this.piano) {
                    this.piano.dispose();
                    this.piano = null;
                }

                const sampler = await new Promise((resolve, reject) => {
                    const s = new Tone.Sampler({
                        urls: SAMPLER_URLS,
                        release: 1.5,
                        baseUrl: SAMPLER_BASE_URL,
                        volume: Tone.gainToDb(this.volume),
                        onload: () => resolve(s),
                        onerror: reject
                    });

                    s.toDestination();
                    setTimeout(() => reject(new Error('Sampler loading timeout')), SAMPLER_LOAD_TIMEOUT);
                });

                if (!sampler.loaded) {
                    throw new Error('Sampler failed to load');
                }

                this.piano = markRaw(sampler);
                this.updateVolume();
                this.audioInitialized = true;

            } catch (error) {
                this.audioInitialized = false;
                if (this.piano) {
                    this.piano.dispose();
                    this.piano = null;
                }
                if (Tone?.context?.state === 'running') {
                    await Tone.context.rawContext.suspend().catch(() => { });
                }
                this.$emit('error', error);
                throw error;
            }
        },

        async initOnInteraction() {
            if (this.userGesturePerformed || !this.hasNotes) return;

            this.userGesturePerformed = true;
            this.createSampler().catch(error => this.$emit('error', error));
        },

        async loadNotes() {
            if (!this.notes?.length) {
                if (!this.midiData) this.cleanupAndReset();
                return;
            }

            this.cleanupAndReset();
            await this.loadToneJs();

            this.processedNotes = this.notes.map(note => ({
                time: note.start,
                duration: note.end - note.start,
                name: this._Tone ? this._Tone.Frequency(note.pitch_midi, "midi").toNote() : `midi${note.pitch_midi}`,
                velocity: 0.9
            }));

            this.duration = Math.max(...this.notes.map(note => note.end));
            this.$emit('loaded', { notes: this.processedNotes, duration: this.duration });

            if (this.autoPlay) {
                this.$nextTick(async () => {
                    if (this.userGesturePerformed) {
                        await this.createSampler();
                    }
                    if (this.isReadyToPlay) {
                        this.togglePlayback();
                    }
                });
            }
        },

        async loadMidiData() {
            if (!this.midiData) return;

            this.cleanupAndReset();

            try {
                let buffer;
                if (this.midiData instanceof ArrayBuffer) {
                    buffer = this.midiData;
                } else if (this.midiData instanceof Blob) {
                    buffer = await this.midiData.arrayBuffer();
                } else if (typeof this.midiData === 'string') {
                    const response = await fetch(this.midiData);
                    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                    buffer = await response.arrayBuffer();
                } else {
                    throw new Error('Unsupported MIDI data format');
                }

                await this.loadToneJs();
                const { Midi } = await import('@tonejs/midi');
                const midi = new Midi(buffer);

                this.processedNotes = midi.tracks.flatMap(track =>
                    track.notes.map(note => ({
                        time: note.time,
                        duration: note.duration,
                        name: this._Tone ? this._Tone.Frequency(note.midi, "midi").toNote() : `midi_${note.midi}`,
                        velocity: note.velocity
                    }))
                );

                this.duration = midi.duration;
                this.$emit('loaded', midi);

                if (this.autoPlay) {
                    this.$nextTick(async () => {
                        if (this.userGesturePerformed) {
                            await this.createSampler();
                        }
                        if (this.isReadyToPlay) {
                            this.togglePlayback();
                        }
                    });
                }
            } catch (error) {
                this.$emit('error', error);
            }
        },

        _createPart(startTime = 0) {
            const Tone = this._Tone;
            if (!Tone || !this.isReadyToPlay || !this.piano) return;

            if (this.part) {
                this.part.dispose();
                this.part = null;
            }

            if (Tone.Transport.state !== 'stopped') {
                Tone.Transport.stop();
                Tone.Transport.cancel();
            }

            const validNotes = this.processedNotes.filter(note =>
                note?.time >= 0 &&
                note?.duration > 0 &&
                note?.name?.length > 0
            );

            if (!validNotes.length) return;

            try {
                this.part = new Tone.Part((time, note) => {
                    if (!this.piano || Tone.context.state !== 'running' || note.duration <= 0) return;

                    this.piano.triggerAttackRelease(
                        note.name,
                        note.duration,
                        time,
                        note.velocity || 0.9
                    );
                }, validNotes);

                this.part.loop = false;
                this.part.loopEnd = this.duration;

            } catch (error) {
                if (this.part) {
                    this.part.dispose();
                    this.part = null;
                }
                this.$emit('error', new Error('Failed to create audio part'));
            }
        },

        async togglePlayback() {
            const Tone = this._Tone;
            if (!Tone || !this.hasNotes) return;

            if (Tone.context.state !== 'running') {
                try {
                    await Tone.start();
                } catch (e) {
                    this.$emit('error', e);
                    return;
                }
            }

            if (!this.audioInitialized) {
                await this.createSampler();
                if (!this.audioInitialized) return;
            }

            try {
                if (!this.isPlaying) {
                    // If we're at the end, restart from the beginning
                    if (this.currentTime >= this.duration - 0.01) {
                        Tone.Transport.stop();
                        Tone.Transport.cancel();
                        Tone.Transport.seconds = 0;
                        this.currentTime = 0;
                        this.progress = 0;

                        // Clean up existing part and create new one
                        if (this.part) {
                            this.part.dispose();
                            this.part = null;
                        }
                    }

                    // Create or recreate the part if needed
                    if (!this.part) {
                        this._createPart();
                        if (!this.part) return;
                        this.part.start(0);
                    }

                    // Set transport to current time position
                    Tone.Transport.seconds = this.currentTime;

                    if (this.piano) {
                        // Ensure volume is set correctly based on mute state and slider value
                        this.piano.volume.value = (this.isMuted || this.volume === 0) ? -Infinity : Tone.gainToDb(this.volume);
                    }

                    Tone.Transport.start();

                    this.isPlaying = true;
                    this.raf = requestAnimationFrame(this.updateLoop);
                    this.$emit('play');

                } else {
                    // Pause - keep current position
                    Tone.Transport.pause();
                    this.isPlaying = false;
                    if (this.raf) {
                        cancelAnimationFrame(this.raf);
                        this.raf = null;
                    }
                    this.$emit('pause');
                }
            } catch (error) {
                this.isPlaying = false;
                if (this.raf) {
                    cancelAnimationFrame(this.raf);
                    this.raf = null;
                }
                this.$emit('error', error);
            }
        },

        updateLoop() {
            const Tone = this._Tone;
            if (!Tone || !this.isPlaying) {
                if (this.raf) {
                    cancelAnimationFrame(this.raf);
                    this.raf = null;
                }
                return;
            }

            this.currentTime = Tone.Transport.seconds;
            this.updateProgress();

            if (this.currentTime < this.duration - 0.01) {
                this.raf = requestAnimationFrame(this.updateLoop);
            } else {
                this.handlePlaybackEnd();
            }
        },

        handlePlaybackEnd() {
            if (!this.isPlaying && this.currentTime >= this.duration) return;

            const Tone = this._Tone;
            if (Tone) {
                Tone.Transport.stop();
                Tone.Transport.seconds = this.duration;
            }

            this.isPlaying = false;
            if (this.raf) {
                cancelAnimationFrame(this.raf);
                this.raf = null;
            }

            this.currentTime = this.duration;
            this.progress = 100;

            // Clean up the part so next play starts fresh
            if (this.part) {
                this.part.dispose();
                this.part = null;
            }

            this.$emit('ended');
        },

        updateProgress() {
            this.progress = this.duration > 0 ? (this.currentTime / this.duration) * 100 : 0;
        },

        async seekTo(event) {
            if (!this.hasNotes || !this.$refs.progressContainer) return;

            if (!this.userGesturePerformed) {
                await this.initOnInteraction();
            }
            if (!this.isReadyToPlay) return;

            const Tone = this._Tone;
            if (!Tone) return;

            if (Tone.context.state !== 'running') {
                try {
                    await Tone.context.resume();
                } catch (err) {
                    return;
                }
            }

            const rect = this.$refs.progressContainer.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const percentage = Math.max(0, Math.min(1, x / rect.width));
            const newTime = percentage * this.duration;

            // If we're seeking and currently have a part, we need to recreate it
            // because Tone.js Part doesn't handle seeking well with scheduled events
            const wasPlaying = this.isPlaying;

            if (this.isPlaying) {
                Tone.Transport.pause();
                this.isPlaying = false;
                if (this.raf) {
                    cancelAnimationFrame(this.raf);
                    this.raf = null;
                }
            }

            // Clean up existing part
            if (this.part) {
                this.part.dispose();
                this.part = null;
            }

            Tone.Transport.stop();
            Tone.Transport.cancel();
            Tone.Transport.seconds = newTime;
            this.currentTime = newTime;
            this.progress = this.duration > 0 ? (newTime / this.duration) * 100 : 0;

            // If we were playing, resume playback from new position
            if (wasPlaying) {
                this._createPart();
                if (this.part) {
                    this.part.start(0);
                    Tone.Transport.start();
                    this.isPlaying = true;
                    this.raf = requestAnimationFrame(this.updateLoop);
                }
            }

            this.$emit('seek', newTime);
        },

        handleProgressMouseDown(e) {
            if (!this.hasNotes) return;

            this.isDragging = true;
            this.seekTo(e);

            const handleMouseMove = (event) => {
                if (this.isDragging) this.seekTo(event);
            };

            const handleMouseUp = () => {
                this.isDragging = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        },

        handleVolumeInput(event) {
            const newVolume = parseFloat(event.target.value);
            const oldVolume = this.volume;

            // Save previous volume when sliding to 0
            if (newVolume === 0 && oldVolume > 0) {
                this.previousVolume = oldVolume;
            } else if (newVolume > 0) {
                this.previousVolume = newVolume;
                // Auto-unmute when volume is increased
                if (this.isMuted) {
                    this.isMuted = false;
                }
            }

            this.volume = newVolume;
            this.updateVolume();
        },

        updateVolume() {
            if (this.piano && this._Tone) {
                // Apply muted state OR volume = 0 as muted
                const newVolume = (this.isMuted || this.volume === 0) ? -Infinity : this._Tone.gainToDb(this.volume);
                this.piano.volume.value = newVolume;
            }
            // Emit the volume change. If muted or volume is 0, report 0 volume to parent.
            this.$emit('volume-change', (this.isMuted || this.volume === 0) ? 0 : this.volume);
        },

        toggleMute() {
            if (this.isMuted || this.volume === 0) {
                // Unmuting: restore previous volume
                this.isMuted = false;
                if (this.volume === 0) {
                    this.volume = this.previousVolume > 0 ? this.previousVolume : 0.8;
                }
            } else {
                // Muting: save current volume and mute
                if (this.volume > 0) {
                    this.previousVolume = this.volume;
                }
                this.isMuted = true;
            }
            this.updateVolume();
        },

        formatTime(seconds) {
            if (!isFinite(seconds) || seconds < 0) return '0:00';

            // Display milliseconds for very short durations if needed, adjust threshold as desired
            if (seconds > 0 && seconds < 1) {
                const ms = Math.floor(seconds * 100);
                return `0:00.${ms.toString().padStart(2, '0')}`;
            }

            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        },

        cleanupAndReset() {
            this.cleanup();
            this.processedNotes = [];
            this.duration = 0;
            this.currentTime = 0;
            this.progress = 0;
            this.userGesturePerformed = false;
        },

        async cleanup() {
            if (this.raf) {
                cancelAnimationFrame(this.raf);
                this.raf = null;
            }

            if (this._Tone) {
                const Tone = this._Tone;

                if (Tone.Transport.state !== 'stopped') {
                    Tone.Transport.stop();
                }
                Tone.Transport.cancel();
                Tone.Transport.seconds = 0;
                Tone.Transport.off('ended', this.handlePlaybackEnd);

                if (this.part) {
                    this.part.dispose();
                    this.part = null;
                }

                if (this.piano) {
                    this.piano.dispose();
                    this.piano = null;
                }

                // Suspend audio context only if it's currently running
                if (Tone.context.state === 'running') {
                    await Tone.context.rawContext.suspend().catch(() => { });
                }
            }

            this.isPlaying = false;
            this.audioInitialized = false;
        },
    }
}
</script>
