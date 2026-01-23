/**
 * Audio player for TTS output
 * Based on jax-js implementation
 */

const SAMPLE_RATE = 24000;

export interface AudioPlayer {
  playChunk(samples: Float32Array): void;
  close(): void;
  toWav(): Blob;
  context: AudioContext;
}

/**
 * Convert float samples to WAV format
 */
export function samplesToWav(samples: Float32Array): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, "WAVE");

  // fmt subchunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // subchunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data subchunk
  writeString(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Write samples as 16-bit PCM
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample * 32767, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Create a streaming audio player
 */
export function createStreamingPlayer(): AudioPlayer {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const chunks: Float32Array[] = [];
  let nextTime = 0;

  return {
    context,

    playChunk(samples: Float32Array): void {
      chunks.push(samples);

      // Create buffer for this chunk
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
      buffer.getChannelData(0).set(samples);

      // Create source and schedule playback
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      // Schedule to play immediately or after previous chunk
      const now = context.currentTime;
      if (nextTime < now) {
        nextTime = now;
      }
      source.start(nextTime);
      nextTime += buffer.duration;
    },

    close(): void {
      context.close();
    },

    toWav(): Blob {
      // Concatenate all chunks
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const allSamples = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        allSamples.set(chunk, offset);
        offset += chunk.length;
      }
      return samplesToWav(allSamples);
    },
  };
}

/**
 * Create audio player that just accumulates samples without playing
 */
export function createSilentPlayer(): {
  playChunk(samples: Float32Array): void;
  toWav(): Blob;
  getSamples(): Float32Array;
} {
  const chunks: Float32Array[] = [];

  return {
    playChunk(samples: Float32Array): void {
      chunks.push(samples);
      console.log(`Audio chunk ${chunks.length}: ${samples.length} samples`);
    },

    toWav(): Blob {
      const samples = this.getSamples();
      console.log(`Converting ${chunks.length} chunks (${samples.length} total samples) to WAV`);
      return samplesToWav(samples);
    },

    getSamples(): Float32Array {
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const allSamples = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        allSamples.set(chunk, offset);
        offset += chunk.length;
      }
      return allSamples;
    },
  };
}
