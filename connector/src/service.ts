import { randomUUID } from "node:crypto";
import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from "@agentclientprotocol/sdk";
import { ElicitationQueue } from "./elicitations.js";
import { createAcpConnector, type AcpConnector, type AcpConnectorOptions } from "./index.js";
import { PermissionQueue } from "./permissions.js";
import {
  readProjects,
  removeProject,
  upsertProject,
  writeProjects,
  type ConnectorProject,
} from "./projects.js";

export type ConnectorRequest = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
};

export type ConnectorResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

export type ConnectorStreamSink = {
  start(response: ConnectorResponse): void;
  chunk(text: string): void;
  end(): void;
  error(error: string): void;
};

type EventClient = {
  write: (text: string) => void;
  sessionId?: string;
};

type BufferedEvent = {
  id: number;
  eventName: string;
  payload: unknown;
  sessionId?: string;
  createdAt: number;
};

type JsonObject = Record<string, unknown>;
type HistoryCapture = {
  sessionId: string;
  updates: unknown[];
};

const maxBufferedEvents = 5000;
const maxBufferedEventAgeMs = 30 * 60 * 1000;

export class ConnectorService {
  readonly clients = new Set<EventClient>();
  readonly eventBuffer: BufferedEvent[] = [];
  readonly historyCaptures = new Set<HistoryCapture>();
  readonly permissionQueue: PermissionQueue;
  readonly elicitationQueue: ElicitationQueue;
  readonly activeTurns = new Map<string, string>();
  nextEventId = 1;

  private constructor(readonly connector: AcpConnector) {
    this.permissionQueue = new PermissionQueue((permission) => {
      this.broadcastEvent("permission_request", permission, permission.request.sessionId);
    });
    this.elicitationQueue = new ElicitationQueue((elicitation) => {
      this.broadcastEvent(
        "elicitation_request",
        elicitation,
        getElicitationSessionId(elicitation.request),
      );
    });
  }

  static async create(options: AcpConnectorOptions) {
    const service = new ConnectorService(undefined as unknown as AcpConnector);
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
        options.onCreateElicitation ?? ((request) => service.elicitationQueue.request(request)),
      onPermissionRequest:
        options.onPermissionRequest ?? ((request) => service.permissionQueue.request(request)),
      onSessionUpdate: async (notification) => {
        await options.onSessionUpdate?.(notification);
        for (const capture of service.historyCaptures) {
          if (capture.sessionId === notification.sessionId) {
            capture.updates.push(notification.update);
          }
        }
        service.broadcastEvent("session_update", notification, notification.sessionId);
      },
    });
    Object.defineProperty(service, "connector", { value: connector });
    return service;
  }

  async handleRequest(request: ConnectorRequest): Promise<ConnectorResponse> {
    try {
      const url = new URL(request.path, "http://localhost");
      const path = trimTrailingSlash(url.pathname);
      const method = request.method.toUpperCase();

      if (method === "GET" && path === "/health") {
        return json(200, {
          ok: true,
          agentInfo: this.connector.initializeResult.agentInfo,
        });
      }

      if (method === "GET" && path === "/capabilities") {
        return json(200, this.connector.initializeResult);
      }

      if (method === "GET" && path === "/permissions") {
        return json(200, { permissions: this.permissionQueue.list() });
      }

      if (method === "GET" && path === "/elicitations") {
        return json(200, { elicitations: this.elicitationQueue.list() });
      }

      const elicitationMatch = path.match(/^\/elicitations\/([^/]+)\/respond$/);
      if (method === "POST" && elicitationMatch) {
        const body = parseJsonBody(request.body);
        const elicitation = this.elicitationQueue.respond(
          decodeURIComponent(elicitationMatch[1]),
          parseElicitationResponse(body),
        );
        this.broadcastEvent(
          "elicitation_resolved",
          elicitation,
          getElicitationSessionId(elicitation.request),
        );
        return json(200, { ok: true });
      }

      const permissionMatch = path.match(/^\/permissions\/([^/]+)\/respond$/);
      if (method === "POST" && permissionMatch) {
        const body = parseJsonBody(request.body);
        const permission = this.permissionQueue.respond(
          decodeURIComponent(permissionMatch[1]),
          optionalString(body.optionId),
        );
        this.broadcastEvent("permission_resolved", permission, permission.request.sessionId);
        return json(200, { ok: true });
      }

      if (method === "GET" && path === "/projects") {
        return json(200, await readProjects());
      }

      if (method === "PUT" && path === "/projects") {
        const body = parseJsonBody(request.body);
        return json(200, await writeProjects({
          projects: Array.isArray(body.projects) ? (body.projects as ConnectorProject[]) : [],
        }));
      }

      if (method === "POST" && path === "/projects") {
        return json(200, await upsertProject(parseJsonBody(request.body) as ConnectorProject));
      }

      const projectMatch = path.match(/^\/projects\/([^/]+)$/);
      if (method === "DELETE" && projectMatch) {
        return json(200, await removeProject(decodeURIComponent(projectMatch[1])));
      }

      if (method === "GET" && path === "/sessions") {
        return json(200, await this.connector.listSessions({
          cwd: url.searchParams.get("cwd"),
          cursor: url.searchParams.get("cursor"),
        }));
      }

      if (method === "POST" && path === "/sessions") {
        const body = parseJsonBody(request.body);
        return json(200, await this.connector.createSession({
          cwd: requireString(body, "cwd"),
          additionalDirectories: optionalStringArray(body.additionalDirectories),
        }));
      }

      if (method === "POST" && path === "/sessions/load") {
        const body = parseJsonBody(request.body);
        return json(200, await this.connector.loadSession({
          sessionId: requireString(body, "sessionId"),
          cwd: requireString(body, "cwd"),
          additionalDirectories: optionalStringArray(body.additionalDirectories),
          mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
        }));
      }

      if (method === "POST" && path === "/sessions/history") {
        const body = parseJsonBody(request.body);
        const sessionId = requireString(body, "sessionId");
        const capture: HistoryCapture = { sessionId, updates: [] };
        this.historyCaptures.add(capture);
        try {
          const session = await this.connector.loadSession({
            sessionId,
            cwd: requireString(body, "cwd"),
            additionalDirectories: optionalStringArray(body.additionalDirectories),
            mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
          });
          return json(200, { session, updates: capture.updates });
        } finally {
          this.historyCaptures.delete(capture);
        }
      }

      if (method === "POST" && path === "/sessions/resume") {
        const body = parseJsonBody(request.body);
        return json(200, await this.connector.resumeSession({
          sessionId: requireString(body, "sessionId"),
          cwd: requireString(body, "cwd"),
          additionalDirectories: optionalStringArray(body.additionalDirectories),
          mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
        }));
      }

      const messageMatch = path.match(/^\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        const body = parseJsonBody(request.body);
        const sessionId = decodeURIComponent(messageMatch[1]);
        const messageId = optionalString(body.messageId) ?? randomUUID();
        if (this.activeTurns.has(sessionId)) {
          return json(409, {
            error: "session_busy",
            message: "A message is already being processed for this session.",
            messageId: this.activeTurns.get(sessionId),
          });
        }
        this.activeTurns.set(sessionId, messageId);
        this.broadcastEvent("turn_start", { sessionId, messageId }, sessionId);
        void this.runPrompt({
          sessionId,
          messageId,
          text: requireString(body, "text"),
          attachments: Array.isArray(body.attachments) ? (body.attachments as ContentBlock[]) : undefined,
        });
        return json(202, {
          ok: true,
          status: "accepted",
          sessionId,
          messageId,
        });
      }

      const modeMatch = path.match(/^\/sessions\/([^/]+)\/mode$/);
      if (method === "POST" && modeMatch) {
        const body = parseJsonBody(request.body);
        await this.connector.setMode(decodeURIComponent(modeMatch[1]), requireString(body, "modeId"));
        return json(200, { ok: true });
      }

      const modelMatch = path.match(/^\/sessions\/([^/]+)\/model$/);
      if (method === "POST" && modelMatch) {
        const body = parseJsonBody(request.body);
        await this.connector.setModel(decodeURIComponent(modelMatch[1]), requireString(body, "modelId"));
        return json(200, { ok: true });
      }

      const closeMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (method === "DELETE" && closeMatch) {
        await this.connector.closeSession({ sessionId: decodeURIComponent(closeMatch[1]) });
        return json(200, { ok: true });
      }

      return json(404, { error: "not_found" });
    } catch (error) {
      return json(500, {
        error: "request_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  openEventStream(request: ConnectorRequest, sink: ConnectorStreamSink) {
    const url = new URL(request.path, "http://localhost");
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    sink.start({
      status: 200,
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
    });
    sink.chunk(`event: ready\ndata: {"ok":true}\n\n`);
    this.replayBufferedEvents(sink, parseLastEventId(request), sessionId);
    const client = { write: (text: string) => sink.chunk(text), sessionId };
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  async close() {
    this.permissionQueue.cancelAll();
    this.elicitationQueue.cancelAll();
    await this.connector.close();
  }

  private broadcastEvent(eventName: string, payload: unknown, sessionId?: string) {
    const event: BufferedEvent = {
      id: this.nextEventId++,
      eventName,
      payload,
      sessionId,
      createdAt: Date.now(),
    };
    this.eventBuffer.push(event);
    pruneEventBuffer(this.eventBuffer);
    for (const client of this.clients) {
      if (client.sessionId && sessionId && client.sessionId !== sessionId) {
        continue;
      }
      client.write(formatSseEvent(event));
    }
  }

  private replayBufferedEvents(
    sink: ConnectorStreamSink,
    lastEventId: number | undefined,
    sessionId?: string,
  ) {
    if (lastEventId === undefined) return;
    for (const event of this.eventBuffer) {
      if (event.id <= lastEventId) continue;
      if (sessionId && event.sessionId && event.sessionId !== sessionId) continue;
      sink.chunk(formatSseEvent(event));
    }
  }

  private async runPrompt(input: {
    sessionId: string;
    messageId: string;
    text: string;
    attachments?: ContentBlock[];
  }) {
    try {
      const response = await this.connector.sendText({
        sessionId: input.sessionId,
        messageId: input.messageId,
        text: input.text,
        attachments: input.attachments,
      });
      this.broadcastEvent(
        "turn_complete",
        {
          sessionId: input.sessionId,
          messageId: input.messageId,
          response,
        },
        input.sessionId,
      );
    } catch (error) {
      this.broadcastEvent(
        "turn_error",
        {
          sessionId: input.sessionId,
          messageId: input.messageId,
          message: error instanceof Error ? error.message : String(error),
        },
        input.sessionId,
      );
    } finally {
      if (this.activeTurns.get(input.sessionId) === input.messageId) {
        this.activeTurns.delete(input.sessionId);
      }
    }
  }
}

function json(status: number, body: unknown): ConnectorResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function parseJsonBody(body: string | undefined): JsonObject {
  return body ? (JSON.parse(body) as JsonObject) : {};
}

function formatSseEvent(event: BufferedEvent) {
  return `id: ${event.id}\nevent: ${event.eventName}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

function parseLastEventId(request: ConnectorRequest) {
  const raw = request.headers?.["last-event-id"];
  if (!raw) return undefined;
  const id = Number(raw);
  return Number.isFinite(id) ? id : undefined;
}

function pruneEventBuffer(eventBuffer: BufferedEvent[]) {
  const oldestAllowed = Date.now() - maxBufferedEventAgeMs;
  while (
    eventBuffer.length > maxBufferedEvents ||
    (eventBuffer.length > 0 && eventBuffer[0].createdAt < oldestAllowed)
  ) {
    eventBuffer.shift();
  }
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
