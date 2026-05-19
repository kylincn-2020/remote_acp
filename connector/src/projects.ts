import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ConnectorProject = {
  id: string;
  name: string;
  cwd: string;
  agentIds?: string[];
};

export type ProjectStore = {
  projects: ConnectorProject[];
};

export function defaultProjectsPath() {
  return resolve(process.env.CONNECTOR_PROJECTS_PATH ?? "connector.projects.json");
}

export async function readProjects(path = defaultProjectsPath()): Promise<ProjectStore> {
  try {
    const raw = await readFile(path, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) {
      return { projects: [] };
    }
    throw error;
  }
}

export async function writeProjects(store: ProjectStore, path = defaultProjectsPath()) {
  const normalized = normalizeStore(store);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function upsertProject(project: ConnectorProject, path = defaultProjectsPath()) {
  const store = await readProjects(path);
  const normalized = normalizeProject(project);
  const index = store.projects.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    store.projects[index] = normalized;
  } else {
    store.projects.push(normalized);
  }
  return writeProjects(store, path);
}

export async function removeProject(projectId: string, path = defaultProjectsPath()) {
  const store = await readProjects(path);
  return writeProjects(
    {
      projects: store.projects.filter((project) => project.id !== projectId),
    },
    path,
  );
}

export function normalizeProject(value: unknown): ConnectorProject {
  if (!isObject(value)) {
    throw new Error("Project must be an object");
  }

  const id = requireString(value, "id");
  const name = requireString(value, "name");
  const cwd = resolve(requireString(value, "cwd"));
  const agentIds = optionalStringArray(value.agentIds);

  return {
    id,
    name,
    cwd,
    agentIds,
  };
}

function normalizeStore(value: unknown): ProjectStore {
  if (!isObject(value)) {
    throw new Error("Project store must be an object");
  }
  const projects = Array.isArray(value.projects) ? value.projects.map(normalizeProject) : [];
  return { projects };
}

function requireString(value: Record<string, unknown>, key: string) {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0) {
    throw new Error(`Missing required project field: ${key}`);
  }
  return item;
}

function optionalStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected project agentIds to be a string array");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown) {
  return isObject(error) && error.code === "ENOENT";
}
