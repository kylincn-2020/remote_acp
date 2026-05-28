import WebSocket from "ws";
import type { Logger } from "./logger.js";
import type { ConnectorRequest, ConnectorResponse, ConnectorStreamSink } from "./service.js";

export type ServerConnectionOptions = {
  serverUrl: string;
  serverToken?: string;
  userId?: string;
  agentInfo?: unknown;
  handleRequest: (request: ConnectorRequest) => Promise<ConnectorResponse>;
  openStream: (request: ConnectorRequest, sink: ConnectorStreamSink) => (() => void) | void;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
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
    info(options, `connecting to app server ${redactToken(socketUrl)}`);
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
      info(options, "connected to app server");
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
        debug(options, `stream close requested ${message.streamId}`);
        streams.get(message.streamId)?.();
        streams.delete(message.streamId);
        return;
      }

      if (message.type !== "http.request") {
        return;
      }

      if (message.path.startsWith("/events")) {
        debug(options, `event stream ${message.method} ${message.path}`);
        proxyEventStream(nextSocket, streams, options, message);
        return;
      }

      debug(options, `request ${message.method} ${message.path}`);
      await proxyHttpRequest(nextSocket, options, message);
    });

    nextSocket.on("error", (error) => {
      // The app server may be down or restarting. Close will schedule a retry.
      warn(options, `app server connection error: ${error.message}`);
    });

    nextSocket.on("close", (code, reason) => {
      if (socket === nextSocket) {
        socket = undefined;
      }
      stopHeartbeat();
      abortStreams();
      warn(options, `app server connection closed (${code}${reason.length ? ` ${reason.toString()}` : ""})`);
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
    debug(options, `response ${message.method} ${message.path} -> ${response.status}`);
    send(socket, {
      type: "http.response",
      requestId: message.requestId,
      status: response.status,
      headers: response.headers,
      body: response.body ?? "",
    });
  } catch (error) {
    logError(
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
        debug(options, `event stream started ${message.path} -> ${response.status}`);
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
        debug(options, `event stream ended ${message.path}`);
        send(socket, { type: "stream.end", streamId: message.requestId });
        streams.delete(message.requestId);
      },
      error(errorMessage) {
        logError(options, `event stream failed ${message.path}: ${errorMessage}`);
        send(socket, {
          type: "stream.error",
          streamId: message.requestId,
          error: errorMessage,
        });
        streams.delete(message.requestId);
      },
    });
    streams.set(message.requestId, cleanup ?? (() => undefined));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logError(options, `event stream failed ${message.path}: ${messageText}`);
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

function debug(options: ServerConnectionOptions, message: string) {
  options.logger?.debug(message);
}

function info(options: ServerConnectionOptions, message: string) {
  options.logger?.info(message);
}

function warn(options: ServerConnectionOptions, message: string) {
  options.logger?.warn(message);
}

function logError(options: ServerConnectionOptions, message: string) {
  options.logger?.error(message);
}

function redactToken(url: string) {
  const parsed = new URL(url);
  if (parsed.searchParams.has("token")) {
    parsed.searchParams.set("token", "<redacted>");
  }
  return parsed.toString();
}
