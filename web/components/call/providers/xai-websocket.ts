import type { XaiBrowserConnection } from "@/lib/realtime/types";
import {
  interruptPlayback,
  pcm16Base64,
  playPcm16,
  type BrowserRealtimeTransport,
  type RealtimeTransportStart,
} from "./types";

export class XaiWebSocketTransport implements BrowserRealtimeTransport {
  private socket: WebSocket | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playback = { playhead: 0, scheduled: [] as AudioBufferSourceNode[] };

  async start(args: RealtimeTransportStart) {
    const connection = args.connection as XaiBrowserConnection;
    const source = args.audioContext.createMediaStreamSource(args.mic);
    const processor = args.audioContext.createScriptProcessor(2400, 1, 1);
    const mute = args.audioContext.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute).connect(args.audioContext.destination);
    this.processor = processor;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(connection.wsUrl, connection.protocols);
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error("xAI realtime connection timed out")), 15_000);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        socket.send(JSON.stringify(connection.sessionUpdate));
        processor.onaudioprocess = (event) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm16Base64(event.inputBuffer.getChannelData(0)),
          }));
        };
        resolve();
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as { type: string; delta?: string; transcript?: string };
        if ((event.type === "response.output_audio.delta" || event.type === "response.audio.delta") && event.delta) {
          playPcm16(event.delta, args.audioContext, args.recordingDestination, this.playback);
        } else if (event.type === "input_audio_buffer.speech_started") {
          interruptPlayback(args.audioContext, this.playback);
        } else if (event.type === "conversation.item.input_audio_transcription.completed") {
          args.handlers.onTranscript("caller", event.transcript ?? "");
        } else if (event.type === "response.output_audio_transcript.done" || event.type === "response.audio_transcript.done") {
          args.handlers.onTranscript("agent", event.transcript ?? "");
        } else if (event.type === "error") {
          args.handlers.onError(new Error(`xAI realtime error: ${JSON.stringify(event).slice(0, 300)}`));
        }
      };
      socket.onerror = () => args.handlers.onError(new Error("xAI realtime WebSocket failed"));
      socket.onclose = () => args.handlers.onClose();
    });
  }

  async stop() {
    this.processor?.disconnect();
    this.processor = null;
    this.socket?.close();
    this.socket = null;
  }
}
