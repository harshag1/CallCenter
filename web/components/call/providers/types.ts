import type { BrowserRealtimeConnection } from "@/lib/realtime/types";

export type RealtimeTransportHandlers = {
  onTranscript: (who: "caller" | "agent", text: string) => void;
  onError: (error: Error) => void;
  onClose: () => void;
};

export type RealtimeTransportStart = {
  connection: BrowserRealtimeConnection;
  mic: MediaStream;
  audioContext: AudioContext;
  recordingDestination: MediaStreamAudioDestinationNode;
  handlers: RealtimeTransportHandlers;
};

export interface BrowserRealtimeTransport {
  start(args: RealtimeTransportStart): Promise<void>;
  stop(): Promise<void>;
}
export function pcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    pcm[index] = Math.max(-32768, Math.min(32767, samples[index] * 32768));
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function playPcm16(
  base64: string,
  context: AudioContext,
  destination: MediaStreamAudioDestinationNode,
  state: { playhead: number; scheduled: AudioBufferSourceNode[] },
  sampleRate = 24000
) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const floats = Float32Array.from(pcm, (value) => value / 32768);
  const buffer = context.createBuffer(1, floats.length, sampleRate);
  buffer.copyToChannel(floats, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.connect(destination);
  state.playhead = Math.max(state.playhead, context.currentTime + 0.05);
  source.start(state.playhead);
  state.playhead += buffer.duration;
  state.scheduled.push(source);
  source.onended = () => { state.scheduled = state.scheduled.filter((candidate) => candidate !== source); };
}

export function interruptPlayback(context: AudioContext, state: { playhead: number; scheduled: AudioBufferSourceNode[] }) {
  for (const source of state.scheduled) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  state.scheduled = [];
  state.playhead = context.currentTime;
}
