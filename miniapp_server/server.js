import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const host = process.env.MINIAPP_SERVER_HOST ?? "127.0.0.1";
const port = process.env.MINIAPP_SERVER_PORT ? Number(process.env.MINIAPP_SERVER_PORT) : 17892;
const token = process.env.MINIAPP_SERVER_TOKEN ?? "";
const defaultUserId =
  process.env.MINIAPP_SERVER_DEFAULT_USER_ID ?? "default";
const miniappRoot = resolve(import.meta.dirname, "../miniapp/src");
const vendorRoot = resolve(import.meta.dirname, "../miniapp/node_modules");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};
const staticFiles = new Map([
  ["/vendor/marked.esm.js", resolve(vendorRoot, "marked/lib/marked.esm.js")],
  ["/vendor/purify.es.mjs", resolve(vendorRoot, "dompurify/dist/purify.es.mjs")],
]);
const apiPrefixes = [
  "/health",
  "/capabilities",
  "/permissions",
  "/elicitations",
  "/projects",
  "/sessions",
  "/events",
];

const connectors = new Map();

const server = createServer(async (request, response) => {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (isApiPath(url.pathname)) {
    await forwardApiRequest(request, response, url);
    return;
  }

  await serveStatic(response, url.pathname);
});

const wss = new WebSocketServer({ server, path: "/connector" });
wss.on("connection", (socket, request) => {
  if (!isAuthorized(request.url ?? "/", request.headers.authorization)) {
    socket.close(1008, "unauthorized");
    return;
  }

  const userId = userIdFromUrl(new URL(request.url ?? "/", `http://${host}:${port}`));
  const existing = connectors.get(userId);
  existing?.socket.close(1012, "replaced");

  const connector = {
    userId,
    socket,
    agentInfo: {},
    pendingResponses: new Map(),
    pendingStreams: new Map(),
    isAlive: true,
  };
  socket.connector = connector;
  connectors.set(userId, connector);

  socket.on("pong", () => {
    connector.isAlive = true;
  });

  socket.on("message", (data) => handleConnectorMessage(socket, data.toString()));
  socket.on("close", () => {
    if (connectors.get(userId)?.socket === socket) {
      connectors.delete(userId);
    }
    failAllPending(connector, "connector_disconnected");
  });
});

const connectorHeartbeat = setInterval(() => {
  for (const connector of connectors.values()) {
    if (connector.socket.readyState !== WebSocket.OPEN) {
      continue;
    }
    if (connector.isAlive === false) {
      connector.socket.terminate();
      continue;
    }
    connector.isAlive = false;
    connector.socket.ping();
  }
}, 15000);

connectorHeartbeat.unref();

server.listen(port, host, () => {
  console.log(`Miniapp server listening on http://${host}:${port}`);
});

async function serveStatic(response, pathname) {
  try {
    const path = pathname === "/" ? "/index.html" : pathname;
    const vendorPath = staticFiles.get(path);
    const filePath = vendorPath ?? resolve(miniappRoot, `.${decodeURIComponent(path)}`);
    if (!vendorPath && filePath !== miniappRoot && !filePath.startsWith(`${miniappRoot}\\`) && !filePath.startsWith(`${miniappRoot}/`)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
}

async function forwardApiRequest(request, response, url) {
  const userId = userIdFromRequest(request, url);
  const connector = connectors.get(userId);
  if (!connector || connector.socket.readyState !== WebSocket.OPEN) {
    sendJson(response, 503, {
      error: "connector_unavailable",
      message: `No connector is connected for user: ${userId}.`,
    });
    return;
  }

  const requestId = randomUUID();
  const path = `${url.pathname}${url.search}`;
  const body = await readBody(request);
  const headers = pickHeaders(request.headers);

  if (url.pathname === "/events") {
    openForwardedStream(request, response, connector, requestId, path, headers);
    return;
  }

  const timer = setTimeout(() => {
    connector.pendingResponses.delete(requestId);
    sendJson(response, 504, {
      error: "connector_timeout",
      message: "Connector did not respond before the request timeout.",
    });
  }, 120000);

  connector.pendingResponses.set(requestId, { response, timer });
  connector.socket.send(JSON.stringify({
    type: "http.request",
    requestId,
    method: request.method ?? "GET",
    path,
    headers,
    body,
  }));
}

function openForwardedStream(request, response, connector, streamId, path, headers) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  });

  connector.pendingStreams.set(streamId, response);
  request.on("close", () => {
    connector.pendingStreams.delete(streamId);
    sendToConnector(connector, {
      type: "stream.close",
      streamId,
    });
  });

  sendToConnector(connector, {
    type: "http.request",
    requestId: streamId,
    method: "GET",
    path,
    headers,
  });
}

function handleConnectorMessage(socket, raw) {
  const connector = socket.connector;
  if (!connector) {
    return;
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "connector.ready") {
    connector.agentInfo = message.agentInfo ?? {};
    return;
  }

  if (message.type === "http.response") {
    const pending = connector.pendingResponses.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    connector.pendingResponses.delete(message.requestId);
    pending.response.writeHead(message.status ?? 502, normalizeHeaders(message.headers));
    pending.response.end(message.body ?? "");
    return;
  }

  if (message.type === "stream.start") {
    const response = connector.pendingStreams.get(message.streamId);
    if (!response) return;
    if (!response.headersSent) {
      response.writeHead(message.status ?? 200, normalizeHeaders(message.headers));
    }
    return;
  }

  if (message.type === "stream.chunk") {
    connector.pendingStreams.get(message.streamId)?.write(message.chunk ?? "");
    return;
  }

  if (message.type === "stream.end" || message.type === "stream.error") {
    const response = connector.pendingStreams.get(message.streamId);
    if (response && message.type === "stream.error") {
      response.write(`event: error\n`);
      response.write(`data: ${JSON.stringify({ error: message.error })}\n\n`);
    }
    response?.end();
    connector.pendingStreams.delete(message.streamId);
    return;
  }

  if (message.type === "connector.info") {
    connector.agentInfo = message.agentInfo ?? connector.agentInfo;
  }
}

function failAllPending(connector, reason) {
  for (const [requestId, pending] of connector.pendingResponses) {
    clearTimeout(pending.timer);
    pending.response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    pending.response.end(JSON.stringify({ error: reason }));
    connector.pendingResponses.delete(requestId);
  }
  for (const [streamId, response] of connector.pendingStreams) {
    response.end();
    connector.pendingStreams.delete(streamId);
  }
}

function sendToConnector(connector, message) {
  if (connector.socket.readyState === WebSocket.OPEN) {
    connector.socket.send(JSON.stringify(message));
  }
}

function userIdFromRequest(request, url) {
  const header = request.headers["x-remote-acp-user-id"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  return userIdFromUrl(url);
}

function userIdFromUrl(url) {
  return url.searchParams.get("userId")?.trim() || defaultUserId;
}

function isApiPath(pathname) {
  return apiPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isAuthorized(rawUrl, authorization) {
  if (!token) return true;
  const queryToken = new URL(rawUrl, `http://${host}:${port}`).searchParams.get("token");
  return authorization === `Bearer ${token}` || queryToken === token;
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-remote-acp-user-id");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function pickHeaders(headers) {
  const picked = {};
  for (const key of ["accept", "content-type", "last-event-id"]) {
    const value = headers[key];
    if (typeof value === "string") {
      picked[key] = value;
    }
  }
  return picked;
}

function normalizeHeaders(headers) {
  const normalized = {};
  if (!headers || typeof headers !== "object") {
    normalized["Content-Type"] = "application/json; charset=utf-8";
    return normalized;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}
