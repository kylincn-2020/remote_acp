import WebSocket from "ws";
import type { ConnectorRequest, ConnectorResponse, ConnectorStreamSink } from "./service.js";

export type ServerConnectionOptions = {
  serverUrl: string;
  serverToken?: string;
  userId?: string;
  agentInfo?: unknown;
  handleRequest: (request: ConnectorRequest) => Promise<ConnectorResponse>;
  openStream: (request: ConnectorRequest, sink: ConnectorStreamSink) => (() => void) | void;
  logger?: (message: string) => void;
};

type ServerHttpRequest = {
  type: "http.request";
  requestId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
};

type ServerStreamClose = {
  type: "stream.close";
  streamId: string;
};

type ServerMessage = ServerHttpRequest | ServerStreamClose;

export type ServerConnectionHandle = {
  close(): void;
};

export function connectToAppServer(options: ServerConnectionOptions): ServerConnectionHandle {
  const streams = new Map<string, () => void>();
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let reconnectDelayMs = 1000;
  let awaitingPong = false;
  let closed = false;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, reconnectDelayMs);
    reconnectTimer.unref();
    reconnectDelayMs = Math.min(reconnectDelayMs * 1.5, 10000);
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    awaitingPong = false;
  };

  const abortStreams = () => {
    for (const cleanup of streams.values()) {
      cleanup();
    }
    streams.clear();
  };

  const open = () => {
    const socketUrl = toConnectorSocketUrl(options.serverUrl, options.serverToken, options.userId);
    log(options, `connecting to app server ${redactToken(socketUrl)}`);
    const nextSocket = new WebSocket(toConnectorSocketUrl(options.serverUrl, options.serverToken, options.userId), {
      headers: options.serverToken
        ? {
            Authorization: `Bearer ${options.serverToken}`,
          }
        : undefined,
    });
    socket = nextSocket;

    nextSocket.on("open", () => {
      reconnectDelayMs = 1000;
      awaitingPong = false;
      log(options, "connected to app server");
      send(nextSocket, {
        type: "connector.ready",
        agentInfo: options.agentInfo,
      });
      heartbeatTimer = setInterval(() => {
        if (nextSocket.readyState !== WebSocket.OPEN) {
          return;
        }
        if (awaitingPong) {
          nextSocket.terminate();
          return;
        }
        awaitingPong = true;
        nextSocket.ping();
      }, 15000);
      heartbeatTimer.unref();
    });

    nextSocket.on("pong", () => {
      awaitingPong = false;
    });

    nextSocket.on("message", async (data) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "stream.close") {
        log(options, `stream close requested ${message.streamId}`);
        streams.get(message.streamId)?.();
        streams.delete(message.streamId);
        return;
      }

      if (message.type !== "http.request") {
        return;
      }

      if (message.path.startsWith("/events")) {
        log(options, `event stream ${message.method} ${message.path}`);
        proxyEventStream(nextSocket, streams, options, message);
        return;
      }

      log(options, `request ${message.method} ${message.path}`);
      await proxyHttpRequest(nextSocket, options, message);
    });

    nextSocket.on("error", (error) => {
      // The app server may be down or restarting. Close will schedule a retry.
      log(options, `app server connection error: ${error.message}`);
    });

    nextSocket.on("close", (code, reason) => {
      if (socket === nextSocket) {
        socket = undefined;
      }
      stopHeartbeat();
      abortStreams();
      log(options, `app server connection closed (${code}${reason.length ? ` ${reason.toString()}` : ""})`);
      scheduleReconnect();
    });
  };

  open();

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      stopHeartbeat();
      abortStreams();
      socket?.close();
      socket = undefined;
    },
  };
}

async function proxyHttpRequest(
  socket: WebSocket,
  options: ServerConnectionOptions,
  message: ServerHttpRequest,
) {
  try {
    const response = await options.handleRequest({
      method: message.method,
      path: message.path,
      headers: requestHeaders(message.headers),
      body: shouldSendBody(message.method) ? message.body ?? "" : undefined,
    });
    log(options, `response ${message.method} ${message.path} -> ${response.status}`);
    send(socket, {
      type: "http.response",
      requestId: message.requestId,
      status: response.status,
      headers: response.headers,
      body: response.body ?? "",
    });
  } catch (error) {
    log(
      options,
      `request failed ${message.method} ${message.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    send(socket, {
      type: "http.response",
      requestId: message.requestId,
      status: 502,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        error: "connector_request_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}

function proxyEventStream(
  socket: WebSocket,
  streams: Map<string, () => void>,
  options: ServerConnectionOptions,
  message: ServerHttpRequest,
) {
  try {
    const cleanup = options.openStream({
      method: "GET",
      path: message.path,
      headers: requestHeaders(message.headers),
    }, {
      start(response) {
        log(options, `event stream started ${message.path} -> ${response.status}`);
        send(socket, {
          type: "stream.start",
          streamId: message.requestId,
          status: response.status,
          headers: response.headers,
        });
      },
      chunk(text) {
        send(socket, {
          type: "stream.chunk",
          streamId: message.requestId,
          chunk: text,
        });
      },
      end() {
        log(options, `event stream ended ${message.path}`);
        send(socket, { type: "stream.end", streamId: message.requestId });
        streams.delete(message.requestId);
      },
      error(error) {
        log(options, `event stream failed ${message.path}: ${error}`);
        send(socket, {
          type: "stream.error",
          streamId: message.requestId,
          error,
        });
        streams.delete(message.requestId);
      },
    });
    streams.set(message.requestId, cleanup ?? (() => undefined));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    log(options, `event stream failed ${message.path}: ${messageText}`);
    send(socket, {
      type: "stream.error",
      streamId: message.requestId,
      error: messageText,
    });
    streams.delete(message.requestId);
  }
}

function requestHeaders(incoming?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (incoming?.["content-type"]) {
    headers["content-type"] = incoming["content-type"];
  }
  if (incoming?.accept) {
    headers.accept = incoming.accept;
  }
  if (incoming?.["last-event-id"]) {
    headers["last-event-id"] = incoming["last-event-id"];
  }
  return headers;
}

function shouldSendBody(method: string) {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function toConnectorSocketUrl(serverUrl: string, token?: string, userId = "default") {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/connector";
  if (token) {
    url.searchParams.set("token", token);
  }
  url.searchParams.set("userId", userId);
  return url.toString();
}

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function log(options: ServerConnectionOptions, message: string) {
  options.logger?.(`[server-connection] ${message}`);
}

function redactToken(url: string) {
  const parsed = new URL(url);
  if (parsed.searchParams.has("token")) {
    parsed.searchParams.set("token", "<redacted>");
  }
  return parsed.toString();
}
