import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from "@agentclientprotocol/sdk";
import { loadConnectorServerConfig } from "./config.js";
import { ElicitationQueue } from "./elicitations.js";
import { createAcpConnector, type AcpConnectorOptions } from "./index.js";
import { PermissionQueue } from "./permissions.js";
import {
  readProjects,
  removeProject,
  upsertProject,
  writeProjects,
  type ConnectorProject,
} from "./projects.js";

export type AcpHttpServerOptions = AcpConnectorOptions & {
  host?: string;
  port?: number;
  token?: string;
};

type EventClient = {
  response: ServerResponse;
  sessionId?: string;
};

type JsonObject = Record<string, unknown>;
type HistoryCapture = {
  sessionId: string;
  updates: unknown[];
};

export async function startAcpHttpServer(options: AcpHttpServerOptions) {
  const clients = new Set<EventClient>();
  const historyCaptures = new Set<HistoryCapture>();
  const permissionQueue = new PermissionQueue((permission) => {
    broadcastEvent(clients, "permission_request", permission, permission.request.sessionId);
  });
  const elicitationQueue = new ElicitationQueue((elicitation) => {
    broadcastEvent(clients, "elicitation_request", elicitation, getElicitationSessionId(elicitation.request));
  });
  const connector = await createAcpConnector({
    ...options,
    clientCapabilities: {
      ...options.clientCapabilities,
      elicitation: options.clientCapabilities?.elicitation ?? {
        form: {},
        url: {},
      },
    },
    onCreateElicitation:
      options.onCreateElicitation ?? ((request) => elicitationQueue.request(request)),
    onPermissionRequest: options.onPermissionRequest ?? ((request) => permissionQueue.request(request)),
    onSessionUpdate: async (notification) => {
      await options.onSessionUpdate?.(notification);
      for (const capture of historyCaptures) {
        if (capture.sessionId === notification.sessionId) {
          capture.updates.push(notification.update);
        }
      }
      broadcastEvent(clients, "session_update", notification, notification.sessionId);
    },
  });

  const server = createServer(async (request, response) => {
    try {
      setCorsHeaders(response);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");
      const path = trimTrailingSlash(url.pathname);

      if (!isAuthorized(request, options.token, url)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, {
          ok: true,
          agentInfo: connector.initializeResult.agentInfo,
        });
        return;
      }

      if (request.method === "GET" && path === "/capabilities") {
        sendJson(response, 200, connector.initializeResult);
        return;
      }

      if (request.method === "GET" && path === "/permissions") {
        sendJson(response, 200, { permissions: permissionQueue.list() });
        return;
      }

      if (request.method === "GET" && path === "/elicitations") {
        sendJson(response, 200, { elicitations: elicitationQueue.list() });
        return;
      }

      const elicitationMatch = path.match(/^\/elicitations\/([^/]+)\/respond$/);
      if (request.method === "POST" && elicitationMatch) {
        const body = await readJson(request);
        const elicitation = elicitationQueue.respond(
          decodeURIComponent(elicitationMatch[1]),
          parseElicitationResponse(body),
        );
        broadcastEvent(
          clients,
          "elicitation_resolved",
          elicitation,
          getElicitationSessionId(elicitation.request),
        );
        sendJson(response, 200, { ok: true });
        return;
      }

      const permissionMatch = path.match(/^\/permissions\/([^/]+)\/respond$/);
      if (request.method === "POST" && permissionMatch) {
        const body = await readJson(request);
        const permission = permissionQueue.respond(
          decodeURIComponent(permissionMatch[1]),
          optionalString(body.optionId),
        );
        broadcastEvent(clients, "permission_resolved", permission, permission.request.sessionId);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && path === "/projects") {
        sendJson(response, 200, await readProjects());
        return;
      }

      if (request.method === "PUT" && path === "/projects") {
        const body = await readJson(request);
        sendJson(response, 200, await writeProjects({
          projects: Array.isArray(body.projects) ? (body.projects as ConnectorProject[]) : [],
        }));
        return;
      }

      if (request.method === "POST" && path === "/projects") {
        const body = await readJson(request);
        sendJson(response, 200, await upsertProject(body as ConnectorProject));
        return;
      }

      const projectMatch = path.match(/^\/projects\/([^/]+)$/);
      if (request.method === "DELETE" && projectMatch) {
        sendJson(response, 200, await removeProject(decodeURIComponent(projectMatch[1])));
        return;
      }

      if (request.method === "GET" && path === "/sessions") {
        const cwd = url.searchParams.get("cwd");
        const cursor = url.searchParams.get("cursor");
        const sessions = await connector.listSessions({
          cwd,
          cursor,
        });
        sendJson(response, 200, sessions);
        return;
      }

      if (request.method === "GET" && path === "/events") {
        const sessionId = url.searchParams.get("sessionId") ?? undefined;
        openEventStream(request, response, clients, sessionId);
        return;
      }

      if (request.method === "POST" && path === "/sessions") {
        const body = await readJson(request);
        const session = await connector.createSession({
          cwd: requireString(body, "cwd"),
          additionalDirectories: optionalStringArray(body.additionalDirectories),
        });
        sendJson(response, 200, session);
        return;
      }

      if (request.method === "POST" && path === "/sessions/load") {
        const body = await readJson(request);
        const sessionId = requireString(body, "sessionId");
        const session = await connector.loadSession({
          sessionId,
          cwd: requireString(body, "cwd"),
          additionalDirectories: optionalStringArray(body.additionalDirectories),
          mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
        });
        sendJson(response, 200, session);
        return;
      }

      if (request.method === "POST" && path === "/sessions/history") {
        const body = await readJson(request);
        const sessionId = requireString(body, "sessionId");
        const capture: HistoryCapture = { sessionId, updates: [] };
        historyCaptures.add(capture);
        try {
          const session = await connector.loadSession({
            sessionId,
            cwd: requireString(body, "cwd"),
            additionalDirectories: optionalStringArray(body.additionalDirectories),
            mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
          });
          sendJson(response, 200, {
            session,
            updates: capture.updates,
          });
        } finally {
          historyCaptures.delete(capture);
        }
        return;
      }

      if (request.method === "POST" && path === "/sessions/resume") {
        const body = await readJson(request);
        const session = await connector.resumeSession({
          sessionId: requireString(body, "sessionId"),
          cwd: requireString(body, "cwd"),
          additionalDirectories: optionalStringArray(body.additionalDirectories),
          mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
        });
        sendJson(response, 200, session);
        return;
      }

      const messageMatch = path.match(/^\/sessions\/([^/]+)\/messages$/);
      if (request.method === "POST" && messageMatch) {
        const body = await readJson(request);
        const result = await connector.sendText({
          sessionId: decodeURIComponent(messageMatch[1]),
          text: requireString(body, "text"),
          messageId: typeof body.messageId === "string" ? body.messageId : undefined,
          attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
        });
        sendJson(response, 200, result);
        return;
      }

      const modeMatch = path.match(/^\/sessions\/([^/]+)\/mode$/);
      if (request.method === "POST" && modeMatch) {
        const body = await readJson(request);
        await connector.setMode(decodeURIComponent(modeMatch[1]), requireString(body, "modeId"));
        sendJson(response, 200, { ok: true });
        return;
      }

      const modelMatch = path.match(/^\/sessions\/([^/]+)\/model$/);
      if (request.method === "POST" && modelMatch) {
        const body = await readJson(request);
        await connector.setModel(decodeURIComponent(modelMatch[1]), requireString(body, "modelId"));
        sendJson(response, 200, { ok: true });
        return;
      }

      const closeMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (request.method === "DELETE" && closeMatch) {
        await connector.closeSession({ sessionId: decodeURIComponent(closeMatch[1]) });
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, {
        error: "request_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(options.port ?? 17890, options.host ?? "127.0.0.1");

  return {
    server,
    connector,
    async close() {
      for (const client of clients) {
        client.response.end();
      }
      clients.clear();
      permissionQueue.cancelAll();
      elicitationQueue.cancelAll();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await connector.close();
    },
  };
}

function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  clients: Set<EventClient>,
  sessionId?: string,
) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  });
  response.write(`event: ready\n`);
  response.write(`data: {"ok":true}\n\n`);

  const client = { response, sessionId };
  clients.add(client);
  request.on("close", () => {
    clients.delete(client);
  });
}

function broadcastEvent(
  clients: Set<EventClient>,
  eventName: string,
  payload: unknown,
  sessionId?: string,
) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.sessionId && sessionId && client.sessionId !== sessionId) {
      continue;
    }
    client.response.write(`event: ${eventName}\n`);
    client.response.write(`data: ${data}\n\n`);
  }
}

function setCorsHeaders(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function isAuthorized(request: IncomingMessage, token?: string, url?: URL) {
  if (!token) {
    return true;
  }
  return request.headers.authorization === `Bearer ${token}` || url?.searchParams.get("token") === token;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body) as JsonObject;
}

function requireString(body: JsonObject, key: string) {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string field: ${key}`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseElicitationResponse(body: JsonObject): CreateElicitationResponse {
  const action = optionalString(body.action) ?? "accept";
  if (action === "accept") {
    return {
      action: "accept",
      content: isJsonObject(body.content) ? filterElicitationContent(body.content) : {},
    };
  }
  if (action === "decline" || action === "cancel") {
    return { action };
  }
  throw new Error(`Unsupported elicitation action: ${action}`);
}

function getElicitationSessionId(request: CreateElicitationRequest) {
  return "sessionId" in request && typeof request.sessionId === "string"
    ? request.sessionId
    : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterElicitationContent(value: JsonObject): Record<string, ElicitationContentValue> {
  const content: Record<string, ElicitationContentValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isElicitationContentValue(item)) {
      content[key] = item;
    }
  }
  return content;
}

function isElicitationContentValue(value: unknown): value is ElicitationContentValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function optionalStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected string array");
  }
  return value;
}

function trimTrailingSlash(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isDirectRun() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isDirectRun()) {
  const { host, port, ...options } = await loadConnectorServerConfig("http");
  await startAcpHttpServer({ ...options, host, port });
  console.log(`ACP HTTP connector listening on http://${host}:${port}`);
}
