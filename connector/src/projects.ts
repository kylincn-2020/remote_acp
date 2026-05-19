import {
  defaultConnectorConfigPath,
  normalizeProject,
  readConnectorConfig,
  writeConnectorConfig,
  type ConnectorProject,
} from "./config.js";

export type { ConnectorProject } from "./config.js";

export type ProjectStore = {
  projects: ConnectorProject[];
};

export function defaultProjectsPath() {
  return defaultConnectorConfigPath();
}

export async function readProjects(path = defaultProjectsPath()): Promise<ProjectStore> {
  const config = await readConnectorConfig(path);
  return { projects: config.projects ?? [] };
}

export async function writeProjects(store: ProjectStore, path = defaultProjectsPath()) {
  const normalized = normalizeStore(store);
  const config = await readConnectorConfig(path);
  await writeConnectorConfig({ ...config, projects: normalized.projects }, path);
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

function normalizeStore(value: unknown): ProjectStore {
  if (!isObject(value)) {
    throw new Error("Project store must be an object");
  }
  const projects = Array.isArray(value.projects) ? value.projects.map(normalizeProject) : [];
  return { projects };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
