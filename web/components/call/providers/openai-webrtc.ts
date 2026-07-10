import type { OpenAIBrowserConnection } from "@/lib/realtime/types";
import type { BrowserRealtimeTransport, RealtimeTransportStart } from "./types";

export class OpenAIWebRtcTransport implements BrowserRealtimeTransport {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;

  async start(args: RealtimeTransportStart) {
    const connection = args.connection as OpenAIBrowserConnection;
    const peer = new RTCPeerConnection();
    this.peer = peer;
    for (const track of args.mic.getTracks()) peer.addTrack(track, args.mic);

    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      const source = args.audioContext.createMediaStreamSource(stream);
      source.connect(args.audioContext.destination);
      source.connect(args.recordingDestination);
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") args.handlers.onError(new Error("OpenAI WebRTC connection failed"));
      if (peer.connectionState === "closed" || peer.connectionState === "disconnected") args.handlers.onClose();
    };

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    channel.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as { type: string; transcript?: string; error?: { message?: string } };
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        args.handlers.onTranscript("caller", event.transcript ?? "");
      } else if (event.type === "response.output_audio_transcript.done" || event.type === "response.audio_transcript.done") {
        args.handlers.onTranscript("agent", event.transcript ?? "");
      } else if (event.type === "error") {
        args.handlers.onError(new Error(event.error?.message ?? "OpenAI realtime error"));
      }
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch(connection.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp ?? "",
    });
    if (!response.ok) throw new Error(`OpenAI WebRTC ${response.status}: ${(await response.text()).slice(0, 300)}`);
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });

    await new Promise<void>((resolve, reject) => {
      if (channel.readyState === "open") {
        resolve();
        return;
      }
      const timeout = window.setTimeout(() => reject(new Error("OpenAI realtime data channel timed out")), 15_000);
      channel.onopen = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      channel.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("OpenAI realtime data channel failed"));
      };
    });
  }

  async stop() {
    this.channel?.close();
    this.peer?.close();
    this.channel = null;
    this.peer = null;
  }
}
