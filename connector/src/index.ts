import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import WebSocket from "ws";
import * as acp from "@agentclientprotocol/sdk";
import type { Logger } from "./logger.js";
import type {
  Client,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  InitializeResponse,
  NewSessionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

export type AcpTarget =
  | {
      kind: "local";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string | undefined>;
    }
  | {
      kind: "websocket";
      url: string;
      headers?: Record<string, string>;
      protocols?: string | string[];
    };

export type AcpConnectorOptions = {
  target: AcpTarget;
  clientName?: string;
  clientVersion?: string;
  allowedRoots?: string[];
  exposeFileSystem?: boolean;
  exposeTerminal?: boolean;
  autoApprovePermission?: boolean;
  clientCapabilities?: acp.ClientCapabilities;
  onSessionUpdate?: (notification: SessionNotification) => void | Promise<void>;
  onPermissionRequest?: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
  onCreateTerminal?: (request: CreateTerminalRequest) => Promise<CreateTerminalResponse>;
  onTerminalOutput?: (request: TerminalOutputRequest) => Promise<TerminalOutputResponse>;
  onReleaseTerminal?: (
    request: ReleaseTerminalRequest,
  ) => Promise<ReleaseTerminalResponse | void>;
  onWaitForTerminalExit?: (
    request: WaitForTerminalExitRequest,
  ) => Promise<WaitForTerminalExitResponse>;
  onKillTerminal?: (request: KillTerminalRequest) => Promise<KillTerminalResponse | void>;
  onCreateElicitation?: (
    request: CreateElicitationRequest,
  ) => Promise<CreateElicitationResponse>;
  onCompleteElicitation?: (notification: acp.CompleteElicitationNotification) => Promise<void> | void;
  onExtMethod?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  onExtNotification?: (method: string, params: Record<string, unknown>) => Promise<void> | void;
  onError?: (error: unknown) => void;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error" | "child">;
};

export type AcpPromptInput = {
  sessionId: string;
  text: string;
  messageId?: string;
  attachments?: ContentBlock[];
};

export type AcpProtocolApi = Pick<
  acp.ClientSideConnection,
  | "initialize"
  | "newSession"
  | "loadSession"
  | "unstable_forkSession"
  | "listSessions"
  | "resumeSession"
  | "closeSession"
  | "setSessionMode"
  | "unstable_setSessionModel"
  | "setSessionConfigOption"
  | "authenticate"
  | "unstable_listProviders"
  | "unstable_setProvider"
  | "unstable_disableProvider"
  | "unstable_logout"
  | "prompt"
  | "cancel"
  | "unstable_startNes"
  | "unstable_suggestNes"
  | "unstable_closeNes"
  | "unstable_didOpenDocument"
  | "unstable_didChangeDocument"
  | "unstable_didCloseDocument"
  | "unstable_didSaveDocument"
  | "unstable_didFocusDocument"
  | "unstable_acceptNes"
  | "unstable_rejectNes"
  | "extMethod"
  | "extNotification"
>;

export type AcpConnector = AcpProtocolApi & {
  readonly connection: acp.ClientSideConnection;
  readonly api: AcpProtocolApi;
  readonly initializeResult: InitializeResponse;
  readonly target: AcpTarget;
  createSession(input: { cwd: string; additionalDirectories?: string[] }): Promise<NewSessionResponse>;
  sendText(input: AcpPromptInput): Promise<PromptResponse>;
  setMode(sessionId: string, modeId: string): Promise<void>;
  setModel(sessionId: string, modelId: string): Promise<void>;
  close(): Promise<void>;
};

type TransportCleanup = () => Promise<void> | void;

export async function createAcpConnector(options: AcpConnectorOptions): Promise<AcpConnector> {
  const { stream, cleanup } = await openTransport(options.target, options.logger);
  const client = new ConnectorClient(options);
  const connection = new acp.ClientSideConnection(() => client, stream);
  const api = bindAcpApi(connection);

  const initializeResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: {
      name: options.clientName ?? "remote-acp",
      version: options.clientVersion ?? "0.1.0",
    },
    clientCapabilities: {
      ...options.clientCapabilities,
      fs:
        options.clientCapabilities?.fs ??
        (options.exposeFileSystem
          ? {
              readTextFile: true,
              writeTextFile: true,
            }
          : undefined),
      terminal: options.clientCapabilities?.terminal ?? options.exposeTerminal ?? false,
    },
  });

  return {
    ...api,
    connection,
    api,
    initializeResult,
    target: options.target,
    async createSession(input) {
      return connection.newSession({
        cwd: resolve(input.cwd),
        additionalDirectories: input.additionalDirectories?.map((dir) => resolve(dir)),
        mcpServers: [],
      });
    },
    async sendText(input) {
      return connection.prompt({
        sessionId: input.sessionId,
        messageId: input.messageId ?? randomUUID(),
        prompt: [
          {
            type: "text",
            text: input.text,
          },
          ...(input.attachments ?? []),
        ],
      });
    },
    async setMode(sessionId, modeId) {
      await connection.setSessionMode({ sessionId, modeId });
    },
    async setModel(sessionId, modelId) {
      await connection.unstable_setSessionModel({ sessionId, modelId });
    },
    async close() {
      await cleanup();
    },
  };
}

class ConnectorClient implements Client {
  constructor(private readonly options: AcpConnectorOptions) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    await this.options.onSessionUpdate?.(params);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.options.onPermissionRequest) {
      return this.options.onPermissionRequest(params);
    }

    if (this.options.autoApprovePermission && params.options.length > 0) {
      const allowOption =
        params.options.find((option) => option.kind === "allow_once") ?? params.options[0];
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOption.optionId,
        },
      };
    }

    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.assertPathAllowed(params.path);
    const content = await readFile(params.path, "utf8");
    const lines = content.split(/\r?\n/);
    const start = Math.max((params.line ?? 1) - 1, 0);
    const end = params.limit == null ? undefined : start + params.limit;

    return {
      content: lines.slice(start, end).join("\n"),
    };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    this.assertPathAllowed(params.path);
    await writeFile(params.path, params.content, "utf8");
    return {};
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    if (!this.options.onCreateTerminal) {
      throw new Error("ACP terminal/create requested but no onCreateTerminal handler is configured.");
    }

    return this.options.onCreateTerminal(params);
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    if (!this.options.onTerminalOutput) {
      throw new Error("ACP terminal/output requested but no onTerminalOutput handler is configured.");
    }

    return this.options.onTerminalOutput(params);
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse | void> {
    if (!this.options.onReleaseTerminal) {
      throw new Error("ACP terminal/release requested but no onReleaseTerminal handler is configured.");
    }

    return this.options.onReleaseTerminal(params);
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    if (!this.options.onWaitForTerminalExit) {
      throw new Error(
        "ACP terminal/wait_for_exit requested but no onWaitForTerminalExit handler is configured.",
      );
    }

    return this.options.onWaitForTerminalExit(params);
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse | void> {
    if (!this.options.onKillTerminal) {
      throw new Error("ACP terminal/kill requested but no onKillTerminal handler is configured.");
    }

    return this.options.onKillTerminal(params);
  }

  async unstable_createElicitation(
    params: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    if (!this.options.onCreateElicitation) {
      throw new Error(
        "ACP elicitation/create requested but no onCreateElicitation handler is configured.",
      );
    }

    return this.options.onCreateElicitation(params);
  }

  async unstable_completeElicitation(
    params: acp.CompleteElicitationNotification,
  ): Promise<void> {
    await this.options.onCompleteElicitation?.(params);
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.options.onExtMethod) {
      throw new Error(`ACP extension method requested but no onExtMethod handler is configured: ${method}`);
    }

    return this.options.onExtMethod(method, params);
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.options.onExtNotification?.(method, params);
  }

  private assertPathAllowed(path: string): void {
    const roots = this.options.allowedRoots?.map((root) => resolve(root));
    if (!roots?.length) {
      return;
    }

    const filePath = resolve(path);
    const allowed = roots.some((root) => filePath === root || filePath.startsWith(root + sep));
    if (!allowed) {
      throw new Error(`ACP file access denied outside allowed roots: ${filePath}`);
    }
  }
}

function bindAcpApi(connection: acp.ClientSideConnection): AcpProtocolApi {
  return {
    initialize: connection.initialize.bind(connection),
    newSession: connection.newSession.bind(connection),
    loadSession: connection.loadSession.bind(connection),
    unstable_forkSession: connection.unstable_forkSession.bind(connection),
    listSessions: connection.listSessions.bind(connection),
    resumeSession: connection.resumeSession.bind(connection),
    closeSession: connection.closeSession.bind(connection),
    setSessionMode: connection.setSessionMode.bind(connection),
    unstable_setSessionModel: connection.unstable_setSessionModel.bind(connection),
    setSessionConfigOption: connection.setSessionConfigOption.bind(connection),
    authenticate: connection.authenticate.bind(connection),
    unstable_listProviders: connection.unstable_listProviders.bind(connection),
    unstable_setProvider: connection.unstable_setProvider.bind(connection),
    unstable_disableProvider: connection.unstable_disableProvider.bind(connection),
    unstable_logout: connection.unstable_logout.bind(connection),
    prompt: connection.prompt.bind(connection),
    cancel: connection.cancel.bind(connection),
    unstable_startNes: connection.unstable_startNes.bind(connection),
    unstable_suggestNes: connection.unstable_suggestNes.bind(connection),
    unstable_closeNes: connection.unstable_closeNes.bind(connection),
    unstable_didOpenDocument: connection.unstable_didOpenDocument.bind(connection),
    unstable_didChangeDocument: connection.unstable_didChangeDocument.bind(connection),
    unstable_didCloseDocument: connection.unstable_didCloseDocument.bind(connection),
    unstable_didSaveDocument: connection.unstable_didSaveDocument.bind(connection),
    unstable_didFocusDocument: connection.unstable_didFocusDocument.bind(connection),
    unstable_acceptNes: connection.unstable_acceptNes.bind(connection),
    unstable_rejectNes: connection.unstable_rejectNes.bind(connection),
    extMethod: connection.extMethod.bind(connection),
    extNotification: connection.extNotification.bind(connection),
  };
}

async function openTransport(
  target: AcpTarget,
  logger?: AcpConnectorOptions["logger"],
): Promise<{ stream: acp.Stream; cleanup: TransportCleanup }> {
  if (target.kind === "local") {
    return openLocalTransport(target, logger);
  }

  return openWebSocketTransport(target, logger);
}

function openLocalTransport(
  target: Extract<AcpTarget, { kind: "local" }>,
  logger?: AcpConnectorOptions["logger"],
): { stream: acp.Stream; cleanup: TransportCleanup } {
  const transportLogger = logger?.child("local-transport");
  transportLogger?.info(`starting local ACP process ${target.command}`);
  const child = spawn(target.command, target.args ?? [], {
    cwd: target.cwd,
    env: {
      ...process.env,
      ...target.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stderr.on("data", (data) => {
    const text = data.toString().trimEnd();
    if (text) {
      transportLogger?.warn(text);
    }
  });

  child.on("exit", (code, signal) => {
    transportLogger?.warn(`local ACP process exited code=${code ?? ""} signal=${signal ?? ""}`);
  });

  child.on("error", (error) => {
    transportLogger?.error(`local ACP process error: ${error.message}`);
  });

  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  return {
    stream,
    cleanup: () => stopChild(child),
  };
}

async function openWebSocketTransport(
  target: Extract<AcpTarget, { kind: "websocket" }>,
  logger?: AcpConnectorOptions["logger"],
): Promise<{ stream: acp.Stream; cleanup: TransportCleanup }> {
  const transportLogger = logger?.child("websocket-transport");
  transportLogger?.info(`connecting ACP websocket ${target.url}`);
  const socket = new WebSocket(target.url, target.protocols, {
    headers: target.headers,
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.on("message", (data) => {
        if (typeof data === "string") {
          controller.enqueue(new TextEncoder().encode(data));
          return;
        }

        if (Buffer.isBuffer(data)) {
          controller.enqueue(new Uint8Array(data));
          return;
        }

        if (data instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(data));
        }
      });

      socket.on("close", () => controller.close());
      socket.on("error", (error) => {
        transportLogger?.error(`ACP websocket error: ${error.message}`);
        controller.error(error);
      });
    },
  });

  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolveWrite, rejectWrite) => {
        socket.send(Buffer.from(chunk), (error) => {
          if (error) rejectWrite(error);
          else resolveWrite();
        });
      });
    },
    close() {
      socket.close();
    },
    abort() {
      socket.terminate();
    },
  });

  return {
    stream: acp.ndJsonStream(output, input),
    cleanup: () => {
      transportLogger?.info("closing ACP websocket");
      socket.close();
    },
  };
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null || child.killed) {
    return Promise.resolve();
  }

  return new Promise((resolveStop) => {
    child.once("exit", () => resolveStop());
    child.kill();
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      resolveStop();
    }, 1500).unref();
  });
}
