export const TTS_SAMPLE_RATE = 24000;

export function pcm16ToWav(samples: number[], sampleRate = TTS_SAMPLE_RATE): Uint8Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0)));
    pcm[i] = sample;
  }

  const data = new Uint8Array(pcm.buffer);
  const wav = new Uint8Array(44 + data.byteLength);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + data.byteLength, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, data.byteLength, true);
  wav.set(data, 44);
  return wav;
}

function writeAscii(buffer: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    buffer[offset + i] = text.charCodeAt(i);
  }
}

export function playableUrl(bytes: Uint8Array, mime = "audio/wav"): string {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  return URL.createObjectURL(blob);
}
