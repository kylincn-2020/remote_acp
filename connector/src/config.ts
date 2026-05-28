import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AcpConnectorOptions, AcpTarget } from "./index.js";

export type ConnectorConfig = {
  target?: AcpTargetConfig;
  server?: {
    appServerUrl?: string;
    appServerToken?: string;
    appServerUserId?: string;
  };
  permissions?: {
    exposeFileSystem?: boolean;
    exposeTerminal?: boolean;
    autoApprovePermission?: boolean;
  };
  allowedRoots?: string[];
  client?: {
    name?: string;
    version?: string;
  };
  projects?: ConnectorProject[];
};

export type ConnectorProject = {
  id: string;
  name: string;
  cwd: string;
  agentIds?: string[];
};

export type AcpTargetConfig =
  | {
      kind: "local";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | {
      kind: "websocket";
      url: string;
      authToken?: string;
      headers?: Record<string, string>;
      protocols?: string | string[];
    };

export type ConnectorAppConfig = AcpConnectorOptions & {
  appServerUrl: string;
  appServerToken?: string;
  appServerUserId?: string;
};

export function defaultConnectorConfigPath() {
  return process.env.CONNECTOR_CONFIG_PATH ?? "config/config.json";
}

export async function readConnectorConfig(path = defaultConnectorConfigPath()) {
  try {
    const raw = await readFile(path, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) {
      return {};
    }
    throw error;
  }
}

export async function writeConnectorConfig(config: ConnectorConfig, path = defaultConnectorConfigPath()) {
  const normalized = normalizeConfig(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function loadConnectorAppConfig() {
  return resolveConnectorAppConfig(await readConnectorConfig());
}

export function resolveConnectorAppConfig(
  config: ConnectorConfig,
): ConnectorAppConfig {
  const target = targetFromEnv() ?? targetFromConfig(config.target);
  if (!target) {
    throw new Error(
      "Set ACP_COMMAND, ACP_WS_URL, or config/config.json target before starting the connector.",
    );
  }

  const cwd = target.kind === "local" ? target.cwd : undefined;
  const allowedRoots = envStringArray("ACP_ALLOWED_ROOTS") ?? config.allowedRoots ?? (cwd ? [cwd] : []);

  return {
    target,
    allowedRoots,
    exposeFileSystem: envBoolean("ACP_EXPOSE_FS", config.permissions?.exposeFileSystem ?? false),
    exposeTerminal: envBoolean("ACP_EXPOSE_TERMINAL", config.permissions?.exposeTerminal ?? false),
    autoApprovePermission: envBoolean(
      "ACP_AUTO_APPROVE",
      config.permissions?.autoApprovePermission ?? false,
    ),
    clientName: process.env.ACP_CLIENT_NAME ?? config.client?.name,
    clientVersion: process.env.ACP_CLIENT_VERSION ?? config.client?.version,
    appServerUrl:
      process.env.APP_SERVER_URL ?? config.server?.appServerUrl ?? "http://127.0.0.1:17892",
    appServerToken: process.env.APP_SERVER_TOKEN ?? config.server?.appServerToken,
    appServerUserId:
      process.env.APP_SERVER_USER_ID ?? config.server?.appServerUserId ?? "default",
  };
}

function targetFromEnv(): AcpTarget | undefined {
  if (process.env.ACP_WS_URL) {
    return {
      kind: "websocket",
      url: process.env.ACP_WS_URL,
      headers: process.env.ACP_AUTH_TOKEN
        ? {
            Authorization: `Bearer ${process.env.ACP_AUTH_TOKEN}`,
          }
        : undefined,
    };
  }

  if (process.env.ACP_COMMAND) {
    return {
      kind: "local",
      command: process.env.ACP_COMMAND,
      args: process.env.ACP_ARGS ? (JSON.parse(process.env.ACP_ARGS) as string[]) : [],
      cwd: process.env.ACP_CWD ?? process.cwd(),
    };
  }

  return undefined;
}

function targetFromConfig(target?: AcpTargetConfig): AcpTarget | undefined {
  if (!target) {
    return undefined;
  }

  if (target.kind === "websocket") {
    return {
      kind: "websocket",
      url: target.url,
      headers: target.authToken
        ? {
            ...target.headers,
            Authorization: `Bearer ${target.authToken}`,
          }
        : target.headers,
      protocols: target.protocols,
    };
  }

  return {
    kind: "local",
    command: target.command,
    args: target.args ?? [],
    cwd: target.cwd ?? process.cwd(),
    env: target.env,
  };
}

function normalizeConfig(value: unknown): ConnectorConfig {
  if (!isObject(value)) {
    throw new Error("Connector config must be an object");
  }

  return {
    target: normalizeTarget(value.target),
    server: normalizeServer(value.server),
    permissions: normalizePermissions(value.permissions),
    allowedRoots: optionalStringArray(value.allowedRoots),
    client: normalizeClient(value.client),
    projects: normalizeProjects(value.projects),
  };
}

export function normalizeProject(value: unknown): ConnectorProject {
  if (!isObject(value)) {
    throw new Error("Project must be an object");
  }

  return {
    id: requireString(value, "id"),
    name: requireString(value, "name"),
    cwd: resolve(requireString(value, "cwd")),
    agentIds: optionalStringArray(value.agentIds),
  };
}

function normalizeProjects(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Connector projects must be an array");
  }
  return value.map(normalizeProject);
}

function normalizeTarget(value: unknown): AcpTargetConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error("Connector target must be an object");
  }
  if (value.kind === "websocket") {
    return {
      kind: "websocket",
      url: requireString(value, "url"),
      authToken: optionalString(value.authToken),
      headers: optionalStringRecord(value.headers),
      protocols: optionalProtocols(value.protocols),
    };
  }
  if (value.kind === "local") {
    return {
      kind: "local",
      command: requireString(value, "command"),
      args: optionalStringArray(value.args),
      cwd: optionalString(value.cwd),
      env: optionalStringRecord(value.env),
    };
  }
  throw new Error("Connector target.kind must be local or websocket");
}

function normalizeServer(value: unknown): ConnectorConfig["server"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error("Connector server config must be an object");
  }
  return {
    appServerUrl: optionalString(value.appServerUrl),
    appServerToken: optionalString(value.appServerToken),
    appServerUserId: optionalString(value.appServerUserId),
  };
}

function normalizePermissions(value: unknown): ConnectorConfig["permissions"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error("Connector permissions config must be an object");
  }
  return {
    exposeFileSystem: optionalBoolean(value.exposeFileSystem),
    exposeTerminal: optionalBoolean(value.exposeTerminal),
    autoApprovePermission: optionalBoolean(value.autoApprovePermission),
  };
}

function normalizeClient(value: unknown): ConnectorConfig["client"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error("Connector client config must be an object");
  }
  return {
    name: optionalString(value.name),
    version: optionalString(value.version),
  };
}

function envBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function envStringArray(name: string) {
  const value = process.env[name];
  return value ? (JSON.parse(value) as string[]) : undefined;
}

function requireString(value: Record<string, unknown>, key: string) {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0) {
    throw new Error(`Missing required connector config field: ${key}`);
  }
  return item;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected string array in connector config");
  }
  return value;
}

function optionalStringRecord(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error("Expected string record in connector config");
  }
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) {
    throw new Error("Expected string record in connector config");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalProtocols(value: unknown) {
  if (value === undefined || typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected websocket protocols to be a string or string array");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown) {
  return isObject(error) && error.code === "ENOENT";
}
