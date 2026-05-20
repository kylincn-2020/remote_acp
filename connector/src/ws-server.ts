import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import type { CreateElicitationRequest, ElicitationContentValue } from "@agentclientprotocol/sdk";
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

export type AcpWebSocketServerOptions = AcpConnectorOptions & {
  host?: string;
  port?: number;
  token?: string;
};

type JsonObject = Record<string, unknown>;

type WsRequest = {
  requestId?: string;
  type: string;
  payload?: JsonObject;
};

type WsClientState = {
  socket: WebSocket;
  sessionIds: Set<string>;
};

export async function startAcpWebSocketServer(options: AcpWebSocketServerOptions) {
  const clients = new Set<WsClientState>();
  const permissionQueue = new PermissionQueue((permission) => {
    broadcast(clients, {
      type: "permission.request",
      sessionId: permission.request.sessionId,
      permission,
    });
  });
  const elicitationQueue = new ElicitationQueue((elicitation) => {
    broadcast(clients, {
      type: "elicitation.request",
      sessionId: getElicitationSessionId(elicitation.request),
      elicitation,
    });
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
      broadcast(clients, {
        type: "session.update",
        sessionId: notification.sessionId,
        update: notification.update,
      });
    },
  });

  const wss = new WebSocketServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 17891,
  });

  wss.on("connection", (socket, request) => {
    if (!isAuthorized(request.url ?? "/", request.headers.authorization, options.token)) {
      socket.close(1008, "unauthorized");
      return;
    }

    const state: WsClientState = {
      socket,
      sessionIds: new Set(),
    };
    clients.add(state);

    send(socket, {
      type: "ready",
      agentInfo: connector.initializeResult.agentInfo,
    });

    socket.on("message", async (data) => {
      let message: WsRequest | undefined;
      try {
        message = parseRequest(data.toString());
        const result = await handleRequest(
          connector,
          permissionQueue,
          elicitationQueue,
          clients,
          state,
          message,
        );
        if (message.requestId) {
          send(socket, {
            type: "response",
            requestId: message.requestId,
            ok: true,
            result,
          });
        }
      } catch (error) {
        send(socket, {
          type: "response",
          requestId: typeof message?.requestId === "string" ? message.requestId : undefined,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("close", () => {
      clients.delete(state);
    });
  });

  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });

  return {
    wss,
    connector,
    async close() {
      for (const client of clients) {
        client.socket.close();
      }
      clients.clear();
      permissionQueue.cancelAll();
      elicitationQueue.cancelAll();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
      await connector.close();
    },
  };
}

async function handleRequest(
  connector: Awaited<ReturnType<typeof createAcpConnector>>,
  permissionQueue: PermissionQueue,
  elicitationQueue: ElicitationQueue,
  clients: Set<WsClientState>,
  state: WsClientState,
  request: WsRequest,
) {
  const payload = request.payload ?? {};

  switch (request.type) {
    case "capabilities.get":
      return connector.initializeResult;

    case "projects.list":
      return readProjects();

    case "projects.set":
      return writeProjects({
        projects: Array.isArray(payload.projects) ? (payload.projects as ConnectorProject[]) : [],
      });

    case "projects.add":
    case "projects.update":
      return upsertProject(payload as ConnectorProject);

    case "projects.remove":
      return removeProject(requireString(payload, "projectId"));

    case "permissions.list":
      return { permissions: permissionQueue.list() };

    case "permission.respond": {
      const permission = permissionQueue.respond(
        requireString(payload, "permissionId"),
        optionalString(payload.optionId),
      );
      broadcast(clients, {
        type: "permission.resolved",
        sessionId: permission.request.sessionId,
        permission,
      });
      return { ok: true };
    }

    case "elicitations.list":
      return { elicitations: elicitationQueue.list() };

    case "elicitation.respond": {
      const elicitation = elicitationQueue.respond(
        requireString(payload, "elicitationId"),
        parseElicitationResponse(payload),
      );
      broadcast(clients, {
        type: "elicitation.resolved",
        sessionId: getElicitationSessionId(elicitation.request),
        elicitation,
      });
      return { ok: true };
    }

    case "sessions.list":
      return connector.listSessions({
        cwd: optionalString(payload.cwd),
        cursor: optionalString(payload.cursor),
      });

    case "sessions.create":
      return connector.createSession({
        cwd: requireString(payload, "cwd"),
        additionalDirectories: optionalStringArray(payload.additionalDirectories),
      });

    case "sessions.load":
      return connector.loadSession({
        sessionId: requireString(payload, "sessionId"),
        cwd: requireString(payload, "cwd"),
        additionalDirectories: optionalStringArray(payload.additionalDirectories),
        mcpServers: optionalArray(payload.mcpServers) as acp.McpServer[],
      });

    case "sessions.resume":
      return connector.resumeSession({
        sessionId: requireString(payload, "sessionId"),
        cwd: requireString(payload, "cwd"),
        additionalDirectories: optionalStringArray(payload.additionalDirectories),
        mcpServers: optionalArray(payload.mcpServers) as acp.McpServer[],
      });

    case "session.prompt":
      return connector.sendText({
        sessionId: requireString(payload, "sessionId"),
        text: requireString(payload, "text"),
        messageId: optionalString(payload.messageId),
        attachments: optionalArray(payload.attachments) as acp.ContentBlock[] | undefined,
      });

    case "session.setMode":
      await connector.setMode(requireString(payload, "sessionId"), requireString(payload, "modeId"));
      return { ok: true };

    case "session.setModel":
      await connector.setModel(requireString(payload, "sessionId"), requireString(payload, "modelId"));
      return { ok: true };

    case "session.close":
      await connector.closeSession({ sessionId: requireString(payload, "sessionId") });
      return { ok: true };

    case "events.subscribe":
      state.sessionIds.add(requireString(payload, "sessionId"));
      return { ok: true };

    case "events.unsubscribe":
      state.sessionIds.delete(requireString(payload, "sessionId"));
      return { ok: true };

    default:
      throw new Error(`Unsupported request type: ${request.type}`);
  }
}

function broadcast(clients: Set<WsClientState>, message: JsonObject & { sessionId?: string }) {
  for (const client of clients) {
    if (
      message.sessionId &&
      client.sessionIds.size > 0 &&
      !client.sessionIds.has(message.sessionId)
    ) {
      continue;
    }
    send(client.socket, message);
  }
}

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parseRequest(raw: string): WsRequest {
  const value = JSON.parse(raw) as Partial<WsRequest>;
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new Error("Missing request type");
  }
  return {
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    type: value.type,
    payload: isJsonObject(value.payload) ? value.payload : {},
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function optionalStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected string array");
  }
  return value;
}

function optionalArray(value: unknown) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Expected array");
  }
  return value;
}

function parseElicitationResponse(body: JsonObject): acp.CreateElicitationResponse {
  const action = optionalString(body.action) ?? "accept";
  if (action === "accept") {
    return {
      action,
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

function isAuthorized(url: string, authorization: string | undefined, token?: string) {
  if (!token) {
    return true;
  }
  const queryToken = new URL(url, "ws://localhost").searchParams.get("token");
  return authorization === `Bearer ${token}` || queryToken === token;
}

function isDirectRun() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isDirectRun()) {
  const { host, port, ...options } = await loadConnectorServerConfig("ws");
  await startAcpWebSocketServer({ ...options, host, port });
  console.log(`ACP WebSocket connector listening on ws://${host}:${port}`);
}
