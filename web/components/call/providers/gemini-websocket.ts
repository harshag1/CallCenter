import type { GeminiBrowserConnection } from "@/lib/realtime/types";
import {
  interruptPlayback,
  pcm16Base64,
  playPcm16,
  type BrowserRealtimeTransport,
  type RealtimeTransportStart,
} from "./types";

type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

async function mcp(url: string, token: string, method: string, params?: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, ...(params ? { params } : {}) }),
  });
  if (!response.ok) throw new Error(`tool gateway ${response.status}`);
  const json = await response.json() as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "tool gateway error");
  return json.result;
}

export class GeminiWebSocketTransport implements BrowserRealtimeTransport {
  private socket: WebSocket | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playback = { playhead: 0, scheduled: [] as AudioBufferSourceNode[] };

  async start(args: RealtimeTransportStart) {
    const connection = args.connection as GeminiBrowserConnection;
    await mcp(connection.toolProxyUrl, connection.toolProxyToken, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "callcenter-browser", version: "1" } });
    const listed = await mcp(connection.toolProxyUrl, connection.toolProxyToken, "tools/list") as { tools?: McpTool[] };
    const setup = structuredClone(connection.setup) as { setup: { tools: unknown[] } };
    setup.setup.tools = [{
      functionDeclarations: (listed.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      })),
    }];

    const source = args.audioContext.createMediaStreamSource(args.mic);
    const processor = args.audioContext.createScriptProcessor(2400, 1, 1);
    const mute = args.audioContext.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute).connect(args.audioContext.destination);
    this.processor = processor;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(connection.wsUrl);
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error("Gemini Live connection timed out")), 15_000);
      socket.onopen = () => socket.send(JSON.stringify(setup));
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as {
          setupComplete?: unknown;
          serverContent?: {
            interrupted?: boolean;
            inputTranscription?: { text?: string };
            outputTranscription?: { text?: string };
            modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
          };
          toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
          error?: { message?: string };
        };
        if (event.setupComplete) {
          window.clearTimeout(timeout);
          processor.onaudioprocess = (audio) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify({
              realtimeInput: {
                audio: { data: pcm16Base64(audio.inputBuffer.getChannelData(0)), mimeType: `audio/pcm;rate=${args.audioContext.sampleRate}` },
              },
            }));
          };
          resolve();
        }
        const server = event.serverContent;
        if (server?.interrupted) interruptPlayback(args.audioContext, this.playback);
        if (server?.inputTranscription?.text) args.handlers.onTranscript("caller", server.inputTranscription.text);
        if (server?.outputTranscription?.text) args.handlers.onTranscript("agent", server.outputTranscription.text);
        for (const part of server?.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) playPcm16(part.inlineData.data, args.audioContext, args.recordingDestination, this.playback);
        }
        if (event.toolCall?.functionCalls?.length) {
          void Promise.all(event.toolCall.functionCalls.map(async (call) => {
            try {
              const result = await mcp(connection.toolProxyUrl, connection.toolProxyToken, "tools/call", { name: call.name, arguments: call.args ?? {} });
              const content = (result as { content?: { text?: string }[] })?.content?.[0]?.text;
              return { id: call.id, name: call.name, response: { result: content ? JSON.parse(content) : result } };
            } catch (error) {
              return { id: call.id, name: call.name, response: { error: (error as Error).message } };
            }
          })).then((functionResponses) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
          });
        }
        if (event.error) args.handlers.onError(new Error(event.error.message ?? "Gemini Live error"));
      };
      socket.onerror = () => args.handlers.onError(new Error("Gemini Live WebSocket failed"));
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
