// Author: Harsha Gundala
// Authenticated Twilio Media Streams ↔ provider-neutral realtime bridge.

import http from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";

import { verifyTwilioSignature } from "./lib/auth.js";
import { loadBridgeConfig } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { BridgeSession } from "./lib/session.js";

function loopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function rejectUpgrade(socket, statusCode, statusText) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + "Connection: close\r\n"
      + "Cache-Control: no-store\r\n"
      + "Content-Length: 0\r\n\r\n",
    );
  } finally {
    socket.destroy();
  }
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function settleBeforeDeadline(pending, ms) {
  let timer;
  const deadline = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("deadline"), ms);
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

export function createBridgeServer({
  config = loadBridgeConfig(),
  logger = createLogger({ base: { component: "realtime_bridge", instance_id: config.instanceId } }),
  sessionDependencies = {},
  createSession = (options) => new BridgeSession(options),
} = {}) {
  let listening = false;
  let draining = false;
  let startPromise = null;
  let stopPromise = null;
  const sessions = new Set();

  const server = http.createServer({
    maxHeaderSize: 16 * 1024,
    requestTimeout: 10_000,
    headersTimeout: 10_000,
    keepAliveTimeout: 5_000,
  }, (req, res) => {
    if (req.method !== "GET") return jsonResponse(res, 405, { ok: false });
    if (req.url === "/health/live" || req.url === "/health") {
      return jsonResponse(res, 200, { ok: true, status: "live" });
    }
    if (req.url === "/health/ready") {
      const ready = listening && !draining && Boolean(config.providerKeys.openai || config.providerKeys.xai);
      return jsonResponse(res, ready ? 200 : 503, {
        ok: ready,
        status: ready ? "ready" : "not_ready",
        active_sessions: sessions.size,
      });
    }
    return jsonResponse(res, 404, { ok: false });
  });

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: config.limits.twilioMessageBytes,
    perMessageDeflate: false,
  });

  server.on("upgrade", (request, socket, head) => {
    if (draining) return rejectUpgrade(socket, 503, "Service Unavailable");
    if (request.method !== "GET" || request.url !== "/stream") {
      return rejectUpgrade(socket, 404, "Not Found");
    }
    if (sessions.size >= config.limits.maximumConcurrentSessions) {
      return rejectUpgrade(socket, 503, "Service Unavailable");
    }

    const signature = request.headers["x-twilio-signature"];
    let authenticated = config.allowInsecureLocalTests
      ? loopbackAddress(request.socket.remoteAddress)
      : false;
    if (!config.allowInsecureLocalTests) {
      // Validate every configured token even after a match. During an Auth Token
      // rotation Twilio signs with the old primary before promotion and the new
      // primary immediately after promotion; accepting both avoids a deployment
      // race without changing any request-derived authority.
      for (const authToken of [config.twilioAuthToken, config.twilioAuthTokenNext]) {
        if (authToken === null || authToken === undefined) continue;
        const valid = verifyTwilioSignature({
          authToken,
          configuredUrl: config.publicStreamUrl,
          signatureHeader: typeof signature === "string" ? signature : undefined,
        });
        authenticated = valid || authenticated;
      }
    }
    if (!authenticated) {
      logger.warn("bridge_upgrade_rejected", { code: "twilio_signature_invalid" });
      return rejectUpgrade(socket, 401, "Unauthorized");
    }

    wss.handleUpgrade(request, socket, head, (twilioSocket) => {
      let session;
      try {
        session = createSession({
          ...sessionDependencies,
          twilioSocket,
          config,
          logger: logger.child({ transport: "twilio_media_stream" }),
          onClosed: (closedSession) => {
            sessions.delete(closedSession);
            try { sessionDependencies.onClosed?.(closedSession); } catch {}
          },
        });
        sessions.add(session);
        logger.info("bridge_upgrade_accepted", { active_sessions: sessions.size });
      } catch (error) {
        logger.error("bridge_session_constructor_failed", {
          error_code: typeof error?.code === "string" ? error.code : "constructor_failed",
        });
        try { twilioSocket.close(1011, "bridge initialization failed"); }
        catch { twilioSocket.terminate?.(); }
      }
    });
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", (error) => logger.error("bridge_http_error", { code: error.code ?? "http_error" }));

  function start({
    port = config.port,
    host = config.allowInsecureLocalTests ? "127.0.0.1" : "0.0.0.0",
  } = {}) {
    if (listening) return Promise.resolve(server.address());
    if (startPromise) return startPromise;
    if (draining) return Promise.reject(new Error("bridge is draining"));
    startPromise = new Promise((resolvePromise, rejectPromise) => {
      const onError = (error) => {
        server.off("listening", onListening);
        startPromise = null;
        rejectPromise(error);
      };
      const onListening = () => {
        server.off("error", onError);
        listening = true;
        const address = server.address();
        logger.info("bridge_listening", {
          host: typeof address === "object" && address ? address.address : host,
          port: typeof address === "object" && address ? address.port : port,
          insecure_local_tests: config.allowInsecureLocalTests,
        });
        resolvePromise(address);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    return startPromise;
  }

  function stop(reason = "server_shutdown") {
    if (stopPromise) return stopPromise;
    draining = true;
    stopPromise = (async () => {
      wss.close();
      server.closeIdleConnections?.();
      const serverClosed = listening
        ? new Promise((resolvePromise) => server.close(() => resolvePromise("closed")))
        : Promise.resolve("not_listening");
      const sessionShutdowns = [...sessions].map((session) => session.shutdown(reason));
      const result = await settleBeforeDeadline(
        Promise.allSettled([serverClosed, ...sessionShutdowns]).then(() => "drained"),
        config.limits.shutdownMs,
      );
      if (result === "deadline") {
        for (const session of sessions) {
          try { session.twilioSocket?.terminate?.(); } catch {}
          try { session.providerSocket?.terminate?.(); } catch {}
        }
        server.closeAllConnections?.();
      }
      listening = false;
      logger.info("bridge_stopped", { result, active_sessions: sessions.size });
      return Object.freeze({ result, activeSessions: sessions.size });
    })();
    return stopPromise;
  }

  return Object.freeze({
    server,
    wss,
    sessions,
    config,
    start,
    stop,
    get ready() { return listening && !draining; },
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let bridge;
  try {
    bridge = createBridgeServer();
    await bridge.start();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "bridge_start_failed",
      code: typeof error?.code === "string" ? error.code : "invalid_configuration",
    }));
    process.exitCode = 1;
  }
  if (bridge) {
    const shutdown = async (signal) => {
      await bridge.stop(signal.toLowerCase());
    };
    process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
    process.once("SIGINT", () => { void shutdown("SIGINT"); });
  }
}

export const serverInternals = Object.freeze({ loopbackAddress, rejectUpgrade });
