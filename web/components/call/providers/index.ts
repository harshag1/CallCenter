import type { BrowserRealtimeConnection } from "@/lib/realtime/types";
import { GeminiWebSocketTransport } from "./gemini-websocket";
import { OpenAIWebRtcTransport } from "./openai-webrtc";
import type { BrowserRealtimeTransport } from "./types";
import { XaiWebSocketTransport } from "./xai-websocket";

export function createBrowserRealtimeTransport(connection: BrowserRealtimeConnection): BrowserRealtimeTransport {
  switch (connection.provider) {
    case "xai": return new XaiWebSocketTransport();
    case "openai": return new OpenAIWebRtcTransport();
    case "gemini": return new GeminiWebSocketTransport();
  }
}
