import type { OpenAIBrowserConnection } from "@/lib/realtime/types";
import { BrowserCapabilityGateway } from "./capability-gateway";
import { OpenAICompatibleBrowserToolLoop } from "./openai-compatible-tools";
import {
  BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT,
  boundedSpeechResponseId,
  finalizeQuarantinedSpeech,
} from "./outbound-speech";
import {
  BROWSER_REALTIME_LIMITS,
  boundedProviderEventType,
  boundedProviderText,
  interruptPlayback,
  parseBoundedProviderEvent,
  readBoundedResponseText,
  utf8Bytes,
  type BrowserRealtimeTransport,
  type RealtimeTransportStart,
} from "./types";

const MAX_REMOTE_AUDIO_TRACKS = 4;
const GUARDED_CAPTURE_BUFFER_SAMPLES = 2_048;
const GUARDED_CAPTURE_TAIL_MS = 100;

function safeError(error: unknown): Error {
  return error instanceof Error ? new Error(error.message.slice(0, 2_000)) : new Error("OpenAI WebRTC protocol error");
}

function validatedConnection(value: RealtimeTransportStart["connection"]): OpenAIBrowserConnection {
  if (value.provider !== "openai" || value.transport !== "webrtc"
    || typeof value.endpoint !== "string" || !/^https:\/\//.test(value.endpoint)
    || typeof value.token !== "string" || !value.token
    || typeof value.toolProxyUrl !== "string" || typeof value.toolProxyToken !== "string") {
    throw new Error("OpenAI browser connection is invalid");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function openAiResponseId(event: Record<string, unknown>, fallback?: string): string {
  const response = record(event.response);
  return boundedSpeechResponseId(event.response_id ?? response.id ?? fallback, "OpenAI speech response id");
}

function openAiTerminalStatus(event: Record<string, unknown>): "completed" | "cancelled" | "failed" | "incomplete" {
  const status = record(event.response).status ?? event.status;
  if (status === "completed" || status === "cancelled" || status === "failed" || status === "incomplete") {
    return status;
  }
  throw new Error("OpenAI speech response had an unknown terminal status");
}

function pcm16FromFloat32(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
  }
  return bytes;
}

function sendBoundedDataChannelJson(channel: RTCDataChannel, value: unknown, label: string): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new Error(`${label} is not JSON serializable`); }
  const bytes = utf8Bytes(encoded);
  if (bytes > BROWSER_REALTIME_LIMITS.outboundFrameBytes) {
    throw new Error(`${label} exceeded the outbound frame limit`);
  }
  if (channel.readyState !== "open") throw new Error(`${label} data channel is not open`);
  if (!Number.isFinite(channel.bufferedAmount) || channel.bufferedAmount < 0) {
    throw new Error(`${label} data channel reported an invalid buffer size`);
  }
  if (channel.bufferedAmount + bytes > BROWSER_REALTIME_LIMITS.websocketBufferedBytes) {
    throw new Error(`${label} data channel is backpressured`);
  }
  channel.send(encoded);
}

export class OpenAIWebRtcTransport implements BrowserRealtimeTransport {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private remoteSources: MediaStreamAudioSourceNode[] = [];
  private remoteProcessors: ScriptProcessorNode[] = [];
  private remoteMutes: GainNode[] = [];
  private audioContext: AudioContext | null = null;
  private playback = { playhead: 0, scheduled: [] as AudioBufferSourceNode[] };
  private gateway: BrowserCapabilityGateway | null = null;
  private toolLoop: OpenAICompatibleBrowserToolLoop | null = null;
  private negotiationAbort: AbortController | null = null;
  private cancelPendingStart: ((error: Error) => void) | null = null;
  private starting = false;
  private stopped = false;
  private closeReported = false;
  private activeSpeechResponseId: string | null = null;
  private speechFinalizationTail: Promise<void> = Promise.resolve();
  private gatedSpeechTranscripts = new Map<string, string>();

  readonly outboundSpeechGateSupport = BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT.openai;

  async start(args: RealtimeTransportStart) {
    if (this.starting || this.peer || this.channel || this.gateway) {
      throw new Error("OpenAI WebRTC transport is already started");
    }
    const connection = validatedConnection(args.connection);
    const gateway = new BrowserCapabilityGateway({
      provider: "openai",
      url: connection.toolProxyUrl,
      token: connection.toolProxyToken,
      rotation: connection.toolProxyRotation,
      activeCatalogDigest: connection.activeCatalogAuthority.catalogDigest,
      activeCatalogEpoch: connection.activeCatalogAuthority.capabilityEpoch,
      activeRuntimeDigest: connection.activeCatalogAuthority.runtimeDigest,
      activeStateRevision: connection.activeCatalogAuthority.stateRevision,
    });
    this.starting = true;
    this.audioContext = args.audioContext;
    this.gateway = gateway;
    this.stopped = false;
    let cancelStartup!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancelStartup = reject; });
    this.cancelPendingStart = cancelStartup;
    const duringStartup = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled]);
    let peer: RTCPeerConnection | null = null;
    try {
      await duringStartup(gateway.initialize());
      if (this.stopped || this.gateway !== gateway) throw new Error("OpenAI WebRTC transport was stopped during startup");
      peer = new RTCPeerConnection();
      this.peer = peer;
      this.closeReported = false;
      const reportClose = () => {
        if (!this.stopped && !this.closeReported) {
          this.closeReported = true;
          args.handlers.onClose();
        }
      };
      const tracks = args.mic.getTracks();
      if (tracks.length < 1 || tracks.length > 8 || tracks.some((track) => track.kind !== "audio")) {
        throw new Error("OpenAI WebRTC requires one to eight microphone audio tracks");
      }
      for (const track of tracks) peer.addTrack(track, args.mic);

      peer.ontrack = (event) => {
        if (this.stopped || this.peer !== peer) return;
        try {
          if (event.track.kind !== "audio") throw new Error("OpenAI WebRTC returned a non-audio track");
          if (this.remoteSources.length >= MAX_REMOTE_AUDIO_TRACKS) {
            throw new Error(`OpenAI WebRTC exceeded ${MAX_REMOTE_AUDIO_TRACKS} remote audio tracks`);
          }
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          const source = args.audioContext.createMediaStreamSource(stream);
          this.remoteSources.push(source);
          if (args.outboundSpeechGate) {
            if (this.remoteProcessors.length > 0) {
              throw new Error("OpenAI guarded WebRTC received overlapping remote audio tracks");
            }
            if (
              typeof args.audioContext.createScriptProcessor !== "function"
              || typeof args.audioContext.createGain !== "function"
            ) {
              throw new Error("OpenAI guarded WebRTC PCM capture is unavailable");
            }
            const processor = args.audioContext.createScriptProcessor(
              GUARDED_CAPTURE_BUFFER_SAMPLES,
              1,
              1,
            );
            const mute = args.audioContext.createGain();
            mute.gain.value = 0;
            processor.onaudioprocess = (audio) => {
              if (this.stopped || this.peer !== peer) return;
              const responseId = this.activeSpeechResponseId;
              if (!responseId) return;
              try {
                const samples = audio.inputBuffer.getChannelData(0);
                args.outboundSpeechGate!.gate.pushAudio("openai", responseId, {
                  encoding: "pcm16",
                  sampleRateHz: args.audioContext.sampleRate,
                  channels: 1,
                  data: pcm16FromFloat32(samples),
                });
              } catch (error) {
                args.handlers.onError(safeError(error));
                closeProtocol();
              }
            };
            source.connect(processor);
            processor.connect(mute).connect(args.audioContext.destination);
            this.remoteProcessors.push(processor);
            this.remoteMutes.push(mute);
          } else {
            source.connect(args.audioContext.destination);
            if (args.recordingDestination) source.connect(args.recordingDestination);
          }
        } catch (error) {
          args.handlers.onError(safeError(error));
          if (args.outboundSpeechGate) {
            gateway.close();
            try { peer?.close(); } catch { /* peer is already closed */ }
          }
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer?.connectionState === "failed") args.handlers.onError(new Error("OpenAI WebRTC connection failed"));
        if (!this.stopped && (peer?.connectionState === "closed" || peer?.connectionState === "disconnected")) {
          reportClose();
        }
      };

      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      const closeProtocol = () => {
        try { channel.close(); } catch { /* channel is already closed */ }
        try { peer?.close(); } catch { /* peer is already closed */ }
      };
      this.toolLoop = new OpenAICompatibleBrowserToolLoop({
        gateway,
        sendJson: (value, label) => sendBoundedDataChannelJson(channel, value, label),
        onError: args.handlers.onError,
        closeProtocol,
      });
      channel.onmessage = (message) => {
        if (this.stopped || this.channel !== channel) return;
        try {
          const event = parseBoundedProviderEvent(message.data, "OpenAI realtime");
          const type = boundedProviderEventType(event.type, "OpenAI realtime");
          if (type === "conversation.item.input_audio_transcription.completed") {
            const transcript = boundedProviderText(event.transcript, "OpenAI input transcript");
            if (transcript !== undefined) args.handlers.onTranscript("caller", transcript);
          } else if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
            const transcript = boundedProviderText(event.transcript, "OpenAI output transcript");
            if (transcript !== undefined) {
              if (args.outboundSpeechGate) {
                const responseId = openAiResponseId(event, this.activeSpeechResponseId ?? undefined);
                args.outboundSpeechGate.gate.pushProviderTranscript("openai", responseId, transcript, true);
                this.gatedSpeechTranscripts.set(responseId, transcript);
              } else {
                args.handlers.onTranscript("agent", transcript);
              }
            }
          } else if (type === "error") {
            // Provider error text is untrusted and may echo prompts, caller PII, or bearer material.
            // Keep the browser-facing signal stable and content-free.
            args.handlers.onError(new Error("OpenAI realtime provider error"));
          }
          if (args.outboundSpeechGate) {
            if (type === "response.created") {
              const responseId = openAiResponseId(event);
              if (this.activeSpeechResponseId && this.activeSpeechResponseId !== responseId) {
                throw new Error("OpenAI started overlapping guarded speech responses");
              }
              args.outboundSpeechGate.gate.beginResponse("openai", responseId);
              this.activeSpeechResponseId = responseId;
            } else if (type === "response.done") {
              const responseId = openAiResponseId(event, this.activeSpeechResponseId ?? undefined);
              const terminalStatus = openAiTerminalStatus(event);
              if (responseId !== this.activeSpeechResponseId) {
                throw new Error("OpenAI completed a non-active guarded speech response");
              }
              const pending = this.speechFinalizationTail.then(async () => {
                // The WebRTC media graph and data channel are ordered
                // independently. Keep the source muted for one bounded render
                // tail so decoded samples already in the browser graph enter
                // quarantine before sealing the response.
                await new Promise<void>((resolve) => window.setTimeout(resolve, GUARDED_CAPTURE_TAIL_MS));
                if (this.activeSpeechResponseId !== responseId) {
                  throw new Error("OpenAI guarded response identity changed during PCM capture tail");
                }
                this.activeSpeechResponseId = null;
                const evidence = await finalizeQuarantinedSpeech({
                  config: args.outboundSpeechGate!,
                  provider: "openai",
                  responseId,
                  terminalStatus,
                  audioContext: args.audioContext,
                  recordingDestination: args.recordingDestination,
                  playback: this.playback,
                  isTransportActive: () => !this.stopped && this.peer === peer,
                });
                const transcript = this.gatedSpeechTranscripts.get(responseId);
                this.gatedSpeechTranscripts.delete(responseId);
                if (evidence.decision.action === "release" && transcript !== undefined) {
                  args.handlers.onTranscript("agent", transcript);
                }
              });
              this.speechFinalizationTail = pending.catch(() => undefined);
              void pending.catch((error) => {
                if (this.stopped || this.peer !== peer) return;
                args.handlers.onError(safeError(error));
                closeProtocol();
              });
            } else if (type === "input_audio_buffer.speech_started") {
              interruptPlayback(args.audioContext, this.playback);
            }
          }
          this.toolLoop?.observe(event);
        } catch (error) {
          args.handlers.onError(safeError(error));
          this.toolLoop?.close();
          gateway.close();
          closeProtocol();
        }
      };

      const offer = await duringStartup(peer.createOffer());
      const offerSdp = offer.sdp ?? "";
      if (!offerSdp || utf8Bytes(offerSdp) > BROWSER_REALTIME_LIMITS.sdpBytes) {
        throw new Error("OpenAI WebRTC offer SDP is empty or oversized");
      }
      await duringStartup(peer.setLocalDescription(offer));
      const controller = new AbortController();
      this.negotiationAbort = controller;
      const negotiationTimeout = window.setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await duringStartup(fetch(connection.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "Content-Type": "application/sdp",
          },
          body: offerSdp,
          signal: controller.signal,
          redirect: "error",
          referrerPolicy: "no-referrer",
        }));
      } catch (error) {
        window.clearTimeout(negotiationTimeout);
        if (this.stopped) throw new Error("OpenAI WebRTC transport was stopped during startup");
        if (controller.signal.aborted) throw new Error("OpenAI WebRTC negotiation timed out");
        throw error;
      }
      let answer: string;
      try {
        if (response.redirected) throw new Error("OpenAI WebRTC negotiation redirects are forbidden");
        answer = await duringStartup(readBoundedResponseText(
          response,
          BROWSER_REALTIME_LIMITS.sdpBytes,
          "OpenAI WebRTC answer SDP",
        ));
      } catch (error) {
        if (this.stopped) throw new Error("OpenAI WebRTC transport was stopped during startup");
        if (controller.signal.aborted) throw new Error("OpenAI WebRTC negotiation timed out");
        throw error;
      } finally {
        window.clearTimeout(negotiationTimeout);
        if (this.negotiationAbort === controller) this.negotiationAbort = null;
      }
      if (!response.ok) {
        throw new Error(`OpenAI WebRTC negotiation failed with status ${response.status}`);
      }
      if (!answer.startsWith("v=0")) throw new Error("OpenAI WebRTC returned an invalid SDP answer");
      await duringStartup(peer.setRemoteDescription({ type: "answer", sdp: answer }));

      await duringStartup(new Promise<void>((resolve, reject) => {
        const installReadyHandlers = () => {
          channel.onerror = () => {
            if (!this.stopped && this.channel === channel) {
              args.handlers.onError(new Error("OpenAI realtime data channel failed"));
            }
          };
          channel.onclose = () => {
            if (!this.stopped && this.channel === channel) reportClose();
          };
        };
        if (channel.readyState === "open") {
          installReadyHandlers();
          resolve();
          return;
        }
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("OpenAI realtime data channel timed out"));
        }, 15_000);
        channel.onopen = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          installReadyHandlers();
          resolve();
        };
        channel.onerror = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error("OpenAI realtime data channel failed"));
        };
        channel.onclose = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error("OpenAI realtime data channel closed before readiness"));
        };
      }));
      if (this.stopped || this.peer !== peer || this.channel !== channel || this.gateway !== gateway) {
        throw new Error("OpenAI WebRTC transport was stopped during startup");
      }
    } catch (error) {
      await this.stop();
      throw safeError(error);
    } finally {
      if (this.cancelPendingStart === cancelStartup) this.cancelPendingStart = null;
      this.starting = false;
    }
  }

  async stop() {
    this.stopped = true;
    this.cancelPendingStart?.(new Error("OpenAI WebRTC transport was stopped during startup"));
    this.cancelPendingStart = null;
    this.negotiationAbort?.abort();
    this.negotiationAbort = null;
    this.toolLoop?.close();
    this.toolLoop = null;
    this.gateway?.close();
    this.gateway = null;
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
    }
    for (const source of this.remoteSources) {
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    for (const processor of this.remoteProcessors) {
      processor.onaudioprocess = null;
      try { processor.disconnect(); } catch { /* already disconnected */ }
    }
    for (const mute of this.remoteMutes) {
      try { mute.disconnect(); } catch { /* already disconnected */ }
    }
    if (this.audioContext) interruptPlayback(this.audioContext, this.playback);
    this.audioContext = null;
    this.remoteSources = [];
    this.remoteProcessors = [];
    this.remoteMutes = [];
    this.activeSpeechResponseId = null;
    this.gatedSpeechTranscripts.clear();
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onerror = null;
      this.channel.onclose = null;
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.peer?.close();
    this.channel = null;
    this.peer = null;
  }

  async drainToolCalls(timeoutMs: number) {
    return this.gateway?.drainAndClose(timeoutMs) ?? {
      settledNativeCallIds: [],
      unresolvedNativeCallIds: [],
    };
  }
}
