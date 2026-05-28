import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";

const DEFAULT_CONNECTOR_URL =
  window.location.port === "17893" ? "http://127.0.0.1:17892" : window.location.origin || "http://127.0.0.1:17892";

marked.setOptions({
  async: false,
  breaks: true,
  gfm: true,
  mangle: false,
  headerIds: false,
});

const fallbackAgent = {
  id: "connector-agent",
  name: "未连接 Agent",
  version: "",
  status: "离线",
};

const state = {
  connectorUrl: loadConnectorUrl(),
  userId: loadUserId(),
  token: localStorage.getItem("connectorToken") || "",
  activeHomeTab: "approval",
  activeApprovalTab: "todo",
  agent: null,
  projects: [],
  sessionsByProject: new Map(),
  loadingProjectIds: new Set(),
  openProjectIds: new Set(),
  currentProject: null,
  currentSession: null,
  currentSessionId: null,
  eventSource: null,
  eventReconnectTimer: null,
  eventSeqBySession: new Map(),
  sendingMessage: false,
  currentTurnMessageId: null,
  messages: [],
  toolMessageIndexes: new Map(),
  permissionMessageIndexes: new Map(),
  elicitationMessageIndexes: new Map(),
  pendingThought: null,
  permissions: [],
  elicitations: [],
  loadingPermissions: false,
};

const views = document.querySelectorAll(".view");
const approvalHome = document.querySelector("#approvalHome");
const agentHome = document.querySelector("#agentHome");
const approvalList = document.querySelector("#approvalList");
const agentList = document.querySelector("#agentList");
const connectorSummary = document.querySelector("#connectorSummary");
const projectList = document.querySelector("#projectList");
const agentTitle = document.querySelector("#agentTitle");
const agentNotice = document.querySelector("#agentNotice");
const chatTitle = document.querySelector("#chatTitle");
const messageList = document.querySelector("#messageList");
const messageInput = document.querySelector("#messageInput");
const sendButton = document.querySelector(".send-button");
const settingsDialog = document.querySelector("#settingsDialog");
const projectDialog = document.querySelector("#projectDialog");
const sessionDialog = document.querySelector("#sessionDialog");
const modeSelect = document.querySelector("#modeSelect");
const modelSelect = document.querySelector("#modelSelect");

document.querySelector("#connectorUrlInput").value = state.connectorUrl;
document.querySelector("#connectorTokenInput").value = state.token;

document.querySelectorAll("[data-home-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    switchHomeTab(button.dataset.homeTab);
    if (button.dataset.homeTab === "approval") {
      loadPermissions();
    }
  });
});

document.querySelectorAll("[data-approval-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeApprovalTab = button.dataset.approvalTab;
    if (state.activeApprovalTab === "todo") {
      loadPermissions();
    }
    renderApproval();
  });
});

document.querySelectorAll("[data-back]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.back));
});

document.querySelector("#settingsButton").addEventListener("click", () => settingsDialog.showModal());
document.querySelector("#refreshAgentsButton").addEventListener("click", loadHome);
document.querySelector("#refreshProjectsButton").addEventListener("click", refreshAgentView);
document.querySelector("#addProjectButton").addEventListener("click", () => projectDialog.showModal());
document.querySelector("#sessionSettingsButton").addEventListener("click", openSessionSettings);

document.querySelector("#saveSettingsButton").addEventListener("click", (event) => {
  event.preventDefault();
  state.connectorUrl = document.querySelector("#connectorUrlInput").value.trim() || DEFAULT_CONNECTOR_URL;
  state.token = document.querySelector("#connectorTokenInput").value.trim();
  localStorage.setItem("connectorUrl", state.connectorUrl);
  localStorage.setItem("connectorToken", state.token);
  settingsDialog.close();
  loadHome();
});

document.querySelector("#saveProjectButton").addEventListener("click", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#projectNameInput").value.trim();
  const cwd = document.querySelector("#projectCwdInput").value.trim();
  if (!name || !cwd) {
    alert("请填写项目名称和项目目录");
    return;
  }
  const store = await api("/projects", {
    method: "POST",
    body: {
      id: slugify(name),
      name,
      cwd,
    },
  });
  state.projects = Array.isArray(store.projects) ? store.projects : [];
  const project = state.projects.find((item) => item.id === slugify(name));
  if (project) {
    state.openProjectIds.add(project.id);
    state.sessionsByProject.delete(project.id);
  }
  document.querySelector("#projectNameInput").value = "";
  document.querySelector("#projectCwdInput").value = "";
  projectDialog.close();
  renderProjects();
  if (project) {
    loadProjectSessionsAndRender(project);
  }
});

document.querySelector("#saveSessionSettingsButton").addEventListener("click", async (event) => {
  event.preventDefault();
  if (!state.currentSession) return;
  const modeId = modeSelect.value;
  const modelId = modelSelect.value;
  if (modeId) {
    await api(`/sessions/${encodeURIComponent(state.currentSession.sessionId)}/mode`, {
      method: "POST",
      body: { modeId },
    });
  }
  if (modelId) {
    await api(`/sessions/${encodeURIComponent(state.currentSession.sessionId)}/model`, {
      method: "POST",
      body: { modelId },
    });
  }
  sessionDialog.close();
});

document.querySelector("#composerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !state.currentSession || state.sendingMessage) return;
  const messageId = createMessageId();
  appendMessage("user", text, { messageId });
  ensurePendingThought();
  messageInput.value = "";
  setComposerBusy(true, messageId);
  try {
    await api(`/sessions/${encodeURIComponent(state.currentSession.sessionId)}/messages`, {
      method: "POST",
      body: { text, messageId },
    });
  } catch (error) {
    alert(error.message);
    setComposerBusy(false);
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
});

renderApproval();
loadHome();

function switchHomeTab(tab) {
  state.activeHomeTab = tab;
  document.querySelectorAll("[data-home-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.homeTab === tab);
  });
  approvalHome.classList.toggle("hidden", tab !== "approval");
  agentHome.classList.toggle("hidden", tab !== "agent");
}

function loadConnectorUrl() {
  return localStorage.getItem("connectorUrl") || DEFAULT_CONNECTOR_URL;
}

function showView(name) {
  views.forEach((view) => view.classList.toggle("active", view.dataset.view === name));
}

async function loadHome() {
  await Promise.allSettled([loadAgent(), loadProjects(), loadPermissions()]);
  renderAgents();
}

async function loadAgent() {
  try {
    const health = await api("/health");
    const info = health.agentInfo || {};
    state.agent = {
      id: info.name || "agent",
      name: info.name || "Agent",
      version: info.version || "",
      status: "已连接",
      raw: info,
    };
    connectorSummary.textContent = `${state.connectorUrl} · 已连接`;
  } catch (error) {
    state.agent = fallbackAgent;
    connectorSummary.textContent = `${state.connectorUrl} · ${error.message}`;
  }
}

async function loadProjects() {
  try {
    const store = await api("/projects");
    state.projects = Array.isArray(store.projects) ? store.projects : [];
  } catch {
    state.projects = [];
  }
}

function renderApproval() {
  document.querySelectorAll("[data-approval-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.approvalTab === state.activeApprovalTab);
  });

  if (state.activeApprovalTab === "todo") {
    renderPermissionApprovals();
    return;
  }

  const empty = document.createElement("div");
  empty.className = "panel empty";
  empty.style.padding = "16px";
  empty.textContent = "暂无已处理的 Agent 审批";
  approvalList.replaceChildren(empty);
}

async function loadPermissions() {
  state.loadingPermissions = true;
  renderPermissionApprovals();
  try {
    const result = await api("/permissions");
    state.permissions = Array.isArray(result.permissions) ? result.permissions : [];
  } catch (error) {
    state.permissions = [{ error: error.message }];
  } finally {
    state.loadingPermissions = false;
    renderPermissionApprovals();
  }
}

async function mountCurrentSessionPermissions() {
  try {
    const result = await api("/permissions");
    const permissions = Array.isArray(result.permissions) ? result.permissions : [];
    state.permissions = permissions;
    for (const permission of permissions) {
      if (permission.request?.sessionId === state.currentSessionId) {
        upsertPermissionMessage(permission);
      }
    }
    renderPermissionApprovals();
  } catch {
    // Chat remains usable even if the connector has not enabled permission endpoints.
  }

  try {
    const result = await api("/elicitations");
    const elicitations = Array.isArray(result.elicitations) ? result.elicitations : [];
    state.elicitations = elicitations;
    for (const elicitation of elicitations) {
      if (elicitation.request?.sessionId === state.currentSessionId) {
        upsertElicitationMessage(elicitation);
      }
    }
  } catch {
    // Older connectors may not expose elicitation endpoints yet.
  }
}

function renderPermissionApprovals() {
  if (state.activeApprovalTab !== "todo") return;

  const empty = document.createElement("div");
  empty.className = "panel empty";
  empty.style.padding = "16px";
  empty.textContent = "Agent 审批会直接显示在对应聊天里";
  approvalList.replaceChildren(empty);
}

function renderPermissionCard(permission) {
  if (permission.error) {
    const error = document.createElement("div");
    error.className = "panel empty";
    error.style.padding = "16px";
    error.textContent = permission.error;
    return error;
  }

  const request = permission.request || {};
  const toolCall = request.toolCall || {};
  const card = document.createElement("div");
  card.className = "permission-card";

  const title = document.createElement("div");
  title.className = "permission-title";
  title.textContent = toolCall.title || toolTitle({ toolKind: toolCall.kind }) || "Agent 请求执行操作";

  const meta = document.createElement("div");
  meta.className = "permission-meta";
  meta.textContent = [toolCall.kind, request.sessionId].filter(Boolean).join(" · ");

  const detail = document.createElement("pre");
  detail.className = "permission-detail";
  detail.textContent = permissionDetailText(toolCall);

  const actions = document.createElement("div");
  actions.className = "permission-actions";
  for (const option of request.options || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = option.kind?.startsWith("allow") ? "primary-button small" : "text-button";
    button.textContent = option.name || permissionOptionLabel(option.kind);
    button.addEventListener("click", () => respondPermission(permission.id, option.optionId, button));
    actions.append(button);
  }

  if (!request.options?.length) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "text-button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => respondPermission(permission.id, undefined, cancel));
    actions.append(cancel);
  }

  card.append(title, meta, detail, actions);
  return card;
}

function renderAgents() {
  const agent = state.agent || fallbackAgent;
  agentList.replaceChildren(
    rowButton({
      title: agent.name,
      subtitle: [agent.version, agent.status].filter(Boolean).join(" · "),
      badge: agent.status,
      onClick: async () => {
        state.agent = agent;
        agentTitle.textContent = agent.name;
        showView("agent");
        await refreshAgentView();
      },
    }),
  );
}

async function respondPermission(permissionId, optionId, button) {
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "处理中...";
  }

  try {
    await api(`/permissions/${encodeURIComponent(permissionId)}/respond`, {
      method: "POST",
      body: optionId ? { optionId } : {},
    });
    state.permissions = state.permissions.filter((item) => item.id !== permissionId);
    resolvePermissionMessage(permissionId);
    renderPermissionApprovals();
  } catch (error) {
    alert(error.message);
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function permissionDetailText(toolCall) {
  const text = toolText(toolCall);
  if (text) return text;
  if (toolCall.rawInput) {
    return typeof toolCall.rawInput === "string"
      ? toolCall.rawInput
      : JSON.stringify(toolCall.rawInput, null, 2);
  }
  return "Agent 正在等待你确认这个操作。";
}

function permissionOptionLabel(kind) {
  return {
    allow_always: "始终允许",
    allow_once: "允许一次",
    reject_always: "始终拒绝",
    reject_once: "拒绝",
  }[kind] || "选择";
}

function renderElicitationField(name, schema, required = []) {
  const label = document.createElement("label");
  label.className = "elicitation-field";
  const title = document.createElement("span");
  title.textContent = `${schema.title || name}${required.includes(name) ? " *" : ""}`;
  label.append(title);

  const description = schema.description;
  if (description) {
    const hint = document.createElement("span");
    hint.className = "elicitation-hint";
    hint.textContent = description;
    label.append(hint);
  }

  const enumValues = schema.enum || schema.items?.enum;
  const oneOf = schema.oneOf || schema.items?.oneOf;
  if (schema.type === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    label.append(input);
    return label;
  }

  if (Array.isArray(enumValues) || Array.isArray(oneOf)) {
    const select = document.createElement("select");
    select.name = name;
    select.multiple = schema.type === "array";
    for (const option of normalizeEnumOptions(enumValues, oneOf)) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }
    label.append(select);
    return label;
  }

  const input = document.createElement(schema.type === "string" ? "textarea" : "input");
  input.name = name;
  if (input.tagName === "INPUT") {
    input.type = schema.type === "integer" || schema.type === "number" ? "number" : "text";
  } else {
    input.rows = 2;
  }
  label.append(input);
  return label;
}

function normalizeEnumOptions(enumValues, oneOf) {
  if (Array.isArray(oneOf)) {
    return oneOf.map((option) => ({
      value: String(option.const),
      label: option.title || String(option.const),
    }));
  }
  return (enumValues || []).map((value) => ({
    value: String(value),
    label: String(value),
  }));
}

function collectElicitationContent(form, properties) {
  const content = {};
  for (const [name, schema] of Object.entries(properties)) {
    const field = form.elements[name];
    if (!field) continue;
    if (schema.type === "boolean") {
      content[name] = Boolean(field.checked);
    } else if (schema.type === "array") {
      content[name] = Array.from(field.selectedOptions || []).map((option) => option.value);
    } else if (schema.type === "integer") {
      content[name] = Number.parseInt(field.value || "0", 10);
    } else if (schema.type === "number") {
      content[name] = Number.parseFloat(field.value || "0");
    } else {
      content[name] = field.value || "";
    }
  }
  return content;
}

async function respondElicitation(elicitationId, response, button) {
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "处理中...";
  }

  try {
    await api(`/elicitations/${encodeURIComponent(elicitationId)}/respond`, {
      method: "POST",
      body: response,
    });
    state.elicitations = state.elicitations.filter((item) => item.id !== elicitationId);
    resolveElicitationMessage(elicitationId);
  } catch (error) {
    alert(error.message);
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function refreshAgentView() {
  await loadProjects();
  state.openProjectIds = new Set(state.projects[0] ? [state.projects[0].id] : []);
  agentNotice.textContent = `${state.agent?.name || "Agent"} 使用 connector 中配置的共享项目。展开项目可查看该项目下的 Session。`;
  renderProjects();
  await loadAllProjectSessionsAndRender();
}

async function loadProjectSessions(project) {
  try {
    const params = new URLSearchParams({ cwd: project.cwd });
    const result = await api(`/sessions?${params.toString()}`);
    state.sessionsByProject.set(project.id, Array.isArray(result.sessions) ? result.sessions : []);
  } catch (error) {
    state.sessionsByProject.set(project.id, [{ error: error.message }]);
  }
}

async function loadProjectSessionsAndRender(project) {
  if (state.sessionsByProject.has(project.id) || state.loadingProjectIds.has(project.id)) {
    return;
  }

  state.loadingProjectIds.add(project.id);
  renderProjects();
  await loadProjectSessions(project);
  state.loadingProjectIds.delete(project.id);
  renderProjects();
}

async function loadAllProjectSessionsAndRender() {
  const pendingProjects = state.projects.filter(
    (project) => !state.sessionsByProject.has(project.id) && !state.loadingProjectIds.has(project.id),
  );
  if (pendingProjects.length === 0) {
    return;
  }

  for (const project of pendingProjects) {
    state.loadingProjectIds.add(project.id);
  }
  renderProjects();
  await Promise.allSettled(pendingProjects.map((project) => loadProjectSessions(project)));
  for (const project of pendingProjects) {
    state.loadingProjectIds.delete(project.id);
  }
  renderProjects();
}

function renderProjects() {
  if (state.projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel empty";
    empty.style.padding = "16px";
    empty.textContent = "还没有项目。先新增一个本地项目目录，再创建 Session。";
    projectList.replaceChildren(empty);
    return;
  }

  projectList.replaceChildren(
    ...state.projects.map((project, index) => {
      const sessions = state.sessionsByProject.get(project.id) || [];
      const details = document.createElement("details");
      details.className = "project-panel";
      details.open = state.openProjectIds.has(project.id);
      details.addEventListener("toggle", () => {
        if (details.open) {
          state.openProjectIds.add(project.id);
          loadProjectSessionsAndRender(project);
        } else {
          state.openProjectIds.delete(project.id);
        }
      });

      const summary = document.createElement("summary");
      summary.innerHTML = `
        <span>${escapeHtml(project.name)}</span>
        <span class="meta">${sessions.filter((session) => !session.error).length} 个 Session</span>
      `;

      const body = document.createElement("div");
      body.className = "project-body";
      const createButton = document.createElement("button");
      createButton.className = "session-row new-session-row";
      createButton.type = "button";
      createButton.textContent = "＋ 新建 Session";
      createButton.addEventListener("click", () => createSession(project, createButton));

      body.append(createButton);
      if (state.loadingProjectIds.has(project.id)) {
        const loading = document.createElement("div");
        loading.className = "empty";
        loading.textContent = "正在加载 Session...";
        body.append(loading);
      } else if (!state.sessionsByProject.has(project.id)) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "展开后加载 Session";
        body.append(empty);
      } else if (sessions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "暂无历史 Session";
        body.append(empty);
      } else {
        for (const session of sessions) {
          body.append(renderSessionRow(project, session));
        }
      }
      details.append(summary, body);
      return details;
    }),
  );
}

function renderSessionRow(project, session) {
  if (session.error) {
    const row = document.createElement("div");
    row.className = "session-row empty";
    row.textContent = session.error;
    return row;
  }
  const button = document.createElement("button");
  button.className = "session-row";
  button.type = "button";
  button.innerHTML = `
    <span>
      <span class="row-title">${escapeHtml(session.title || session.name || "未命名 Session")}</span>
      <span class="row-subtitle">${escapeHtml(session.sessionId || session.id || "")}</span>
    </span>
    <span class="meta">进入</span>
  `;
  button.addEventListener("click", () => openSession(project, session.sessionId || session.id, button));
  return button;
}

async function createSession(project, button) {
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "正在创建...";
  }
  try {
    const session = await api("/sessions", {
      method: "POST",
      body: { cwd: project.cwd },
    });
    await enterChat(project, session);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function openSession(project, sessionId, button) {
  const originalHtml = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span><span class="row-title">正在进入...</span><span class="row-subtitle">${escapeHtml(sessionId)}</span></span>`;
  }
  try {
    const session = await api("/sessions/resume", {
      method: "POST",
      body: { sessionId, cwd: project.cwd },
    });
    await enterChat(project, session, { loadHistory: true });
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = originalHtml;
    }
  }
}

async function enterChat(project, session, options = {}) {
  state.currentProject = project;
  state.currentSession = session;
  state.currentSessionId = session.sessionId;
  state.messages = [];
  state.toolMessageIndexes = new Map();
  state.permissionMessageIndexes = new Map();
  state.elicitationMessageIndexes = new Map();
  state.pendingThought = null;
  setComposerBusy(false);
  chatTitle.textContent = project.name;
  clearMessages();
  showView("chat");
  connectEvents(session.sessionId);
  mountCurrentSessionPermissions();
  replaySession(session);
  if (options.loadHistory) {
    loadSessionHistory(project, session.sessionId);
  }
}

function replaySession(session) {
  const history = collectSessionHistory(session);
  const seen = new Set();
  for (const event of history) {
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    applySessionEvent(event, { replay: true });
  }
  if (state.messages.length === 0) {
    appendMessage("agent", "Session 已打开，可以直接发送消息。");
  }
}

function collectSessionHistory(session) {
  const historyFields = [session.updates, session.messages, session.transcript].filter(Boolean);
  const messages = [];
  for (const field of historyFields) {
    collectHistoryMessages(field, messages);
  }
  return messages;
}

async function loadSessionHistory(project, sessionId) {
  try {
    const result = await api("/sessions/history", {
      method: "POST",
      body: { sessionId, cwd: project.cwd },
    });
    if (state.currentSessionId !== sessionId || !Array.isArray(result.updates)) {
      return;
    }
    prependHistory(result.updates);
  } catch (error) {
    console.warn("Failed to load session history", error);
  }
}

function prependHistory(updates) {
  const events = [];
  for (const update of updates) {
    collectHistoryMessages(update, events);
  }

  const existingKeys = new Set(state.messages.map(messageKey));
  const historyMessages = [];
  for (const event of events) {
    const message = eventToStateMessage(event);
    if (!message) continue;
    const key = messageKey(message);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    historyMessages.push(message);
  }

  if (historyMessages.length === 0) {
    return;
  }

  state.messages.unshift(...historyMessages);
  rebuildToolIndexes();
  clearMessages();
  for (const message of state.messages) {
    mountMessage(message);
  }
}

function eventToStateMessage(event) {
  if (event.kind === "message") {
    const text = event.text.trim();
    if (!text) return null;
    return {
      role: event.role,
      text: event.role === "agent" ? normalizeAnswerText(text) : text,
      messageId: event.messageId,
    };
  }

  if (event.kind === "thought") {
    const text = event.text.trim();
    if (!text) return null;
    return {
      role: "process",
      processType: "thought",
      title: "思考过程",
      text,
      messageId: event.messageId,
      open: true,
    };
  }

  if (event.kind === "tool") {
    return {
      role: "process",
      processType: "tool",
      toolCallId: event.toolCallId,
      toolKind: event.toolKind,
      title: toolTitle(event),
      status: event.status,
      statusText: toolStatusText(event.status),
      text: event.text,
      items: event.items,
      open: event.status !== "completed",
    };
  }

  return null;
}

function messageKey(message) {
  return [
    message.role,
    message.processType || "",
    message.messageId || "",
    message.toolCallId || "",
    message.text || "",
    message.title || "",
  ].join("|");
}

function rebuildToolIndexes() {
  state.toolMessageIndexes = new Map();
  state.permissionMessageIndexes = new Map();
  state.messages.forEach((message, index) => {
    if (message.toolCallId) {
      state.toolMessageIndexes.set(message.toolCallId, index);
    }
    if (message.permissionId) {
      state.permissionMessageIndexes.set(message.permissionId, index);
    }
    if (message.elicitationId) {
      state.elicitationMessageIndexes.set(message.elicitationId, index);
    }
  });
}

function connectEvents(sessionId) {
  if (state.eventSource) {
    state.eventSource.close();
  }
  if (state.eventReconnectTimer) {
    clearTimeout(state.eventReconnectTimer);
    state.eventReconnectTimer = null;
  }
  const url = new URL(`${state.connectorUrl.replace(/\/$/, "")}/events`);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("userId", state.userId);
  const afterSeq = state.eventSeqBySession.get(sessionId);
  if (afterSeq !== undefined) {
    url.searchParams.set("afterSeq", String(afterSeq));
  }
  if (state.token) {
    url.searchParams.set("token", state.token);
  }
  const source = new EventSource(url);
  source.addEventListener("session_update", (event) => {
    rememberEventSeq(sessionId, event);
    const payload = JSON.parse(event.data);
    const parsed = updateToChatEvent(payload.update || payload, { includeUser: false });
    if (parsed) applySessionEvent(parsed);
  });
  source.addEventListener("turn_start", (event) => {
    rememberEventSeq(sessionId, event);
  });
  source.addEventListener("permission_request", (event) => {
    rememberEventSeq(sessionId, event);
    const permission = JSON.parse(event.data);
    state.permissions = [
      permission,
      ...state.permissions.filter((item) => item.id && item.id !== permission.id),
    ];
    upsertPermissionMessage(permission);
    renderPermissionApprovals();
  });
  source.addEventListener("permission_resolved", (event) => {
    rememberEventSeq(sessionId, event);
    const permission = JSON.parse(event.data);
    state.permissions = state.permissions.filter((item) => item.id !== permission.id);
    resolvePermissionMessage(permission.id);
    renderPermissionApprovals();
  });
  source.addEventListener("elicitation_request", (event) => {
    rememberEventSeq(sessionId, event);
    const elicitation = JSON.parse(event.data);
    state.elicitations = [
      elicitation,
      ...state.elicitations.filter((item) => item.id && item.id !== elicitation.id),
    ];
    upsertElicitationMessage(elicitation);
  });
  source.addEventListener("elicitation_resolved", (event) => {
    rememberEventSeq(sessionId, event);
    const elicitation = JSON.parse(event.data);
    state.elicitations = state.elicitations.filter((item) => item.id !== elicitation.id);
    resolveElicitationMessage(elicitation.id);
  });
  source.addEventListener("turn_complete", (event) => {
    rememberEventSeq(sessionId, event);
    const turn = JSON.parse(event.data);
    finishTurn(turn);
  });
  source.addEventListener("turn_error", (event) => {
    rememberEventSeq(sessionId, event);
    const turn = JSON.parse(event.data);
    finishTurn(turn);
    alert(turn.message || "Agent 处理失败");
  });
  source.onerror = () => {
    if (state.currentSessionId !== sessionId || state.eventSource !== source) {
      return;
    }
    source.close();
    state.eventReconnectTimer = setTimeout(() => {
      state.eventReconnectTimer = null;
      if (state.currentSessionId === sessionId) {
        connectEvents(sessionId);
      }
    }, 1000);
  };
  state.eventSource = source;
}

function rememberEventSeq(sessionId, event) {
  const id = Number(event.lastEventId);
  if (Number.isFinite(id)) {
    state.eventSeqBySession.set(sessionId, id);
  }
}

function setComposerBusy(busy, messageId = null) {
  state.sendingMessage = busy;
  state.currentTurnMessageId = busy ? messageId : null;
  messageInput.disabled = busy;
  sendButton.disabled = busy;
}

function finishTurn(turn) {
  if (turn.sessionId !== state.currentSessionId) {
    return;
  }
  if (state.currentTurnMessageId && turn.messageId !== state.currentTurnMessageId) {
    return;
  }
  setComposerBusy(false);
}

function openSessionSettings() {
  if (!state.currentSession) return;
  fillSelect(modeSelect, state.currentSession.modes || [], "modeId", "name");
  fillSelect(modelSelect, state.currentSession.models || [], "modelId", "name");
  sessionDialog.showModal();
}

function fillSelect(select, items, idKey, labelKey) {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = items.length ? "不修改" : "当前 Session 未返回可选项";
  select.append(empty);
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item[idKey] || item.id || item.name;
    option.textContent = item[labelKey] || item.id || item.name;
    select.append(option);
  }
}

function clearMessages() {
  messageList.replaceChildren();
}

function mountMessage(message) {
  messageList.append(renderMessageElement(message));
  messageList.scrollTop = messageList.scrollHeight;
}

function updateMountedMessage(message) {
  if (!message.element) {
    mountMessage(message);
    return;
  }

  if (message.role === "process") {
    updateProcessMessageElement(message);
  } else if (message.contentElement) {
    setMessageContent(message);
  }
  messageList.scrollTop = messageList.scrollHeight;
}

function renderMessageElement(message) {
  if (message.role === "process") {
    return renderProcessMessage(message);
  }

  const item = document.createElement("div");
  item.className = `message ${message.role}`;
  const card = document.createElement("div");
  card.className = message.role === "agent" ? "message-card markdown-body" : "message-card plain-text";
  item.append(card);
  message.element = item;
  message.contentElement = card;
  setMessageContent(message);
  return item;
}

function setMessageContent(message) {
  const element = message.contentElement;
  if (!element) return;

  if (message.role !== "agent") {
    element.textContent = message.text;
    return;
  }

  const html = marked.parse(markdownRenderSource(message.text || ""));
  element.innerHTML = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
  });
  element.querySelectorAll("a[href]").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
}

function markdownRenderSource(text) {
  let source = String(text).trim();
  const fenced = source.match(/^```(?:\s*(?:markdown|md|gfm))?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) {
    source = fenced[1].trim();
  }
  return source.replace(/^\s*(?:mark\s*down|markdown|md)\s*(?=#|\n)/i, "").trimStart();
}

function renderProcessMessage(message) {
  const wrapper = document.createElement("div");
  wrapper.className = `process-block ${message.processType}`;

  const details = document.createElement("details");
  details.open = message.open !== false;

  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.textContent = message.title;
  const status = document.createElement("span");
  status.className = "process-status";
  status.textContent = message.statusText || "";
  summary.append(title, status);

  const body = document.createElement("div");
  body.className = "process-body";

  if (message.processType === "elicitation") {
    body.append(renderElicitationInline(message));
  } else if (message.processType === "tool" && message.items?.length) {
    const list = document.createElement("div");
    list.className = "source-list";
    list.replaceChildren(
      ...message.items.map((item) => {
        const row = document.createElement("div");
        row.className = "source-item";
        const icon = document.createElement("span");
        icon.className = "source-icon";
        icon.textContent = item.icon || toolIcon(message.toolKind);
        const text = document.createElement("span");
        text.textContent = item.title;
        row.append(icon, text);
        return row;
      }),
    );
    body.append(list);
  } else if (message.processType === "permission") {
    body.append(renderPermissionInline(message));
  } else if (message.text) {
    const text = document.createElement("div");
    text.className = "process-text";
    text.textContent = message.text;
    body.append(text);
  }

  details.append(summary, body);
  wrapper.append(details);
  message.element = wrapper;
  message.detailsElement = details;
  message.titleElement = title;
  message.statusElement = status;
  message.bodyElement = body;
  return wrapper;
}

function updateProcessMessageElement(message) {
  if (message.detailsElement) {
    message.detailsElement.open = message.open !== false;
  }
  if (message.titleElement) {
    message.titleElement.textContent = message.title;
  }
  if (message.statusElement) {
    message.statusElement.textContent = message.statusText || "";
  }
  if (!message.bodyElement) {
    return;
  }

  message.bodyElement.replaceChildren();
  if (message.processType === "elicitation") {
    message.bodyElement.append(renderElicitationInline(message));
  } else if (message.processType === "permission") {
    message.bodyElement.append(renderPermissionInline(message));
  } else if (message.processType === "tool" && message.items?.length) {
    const list = document.createElement("div");
    list.className = "source-list";
    list.replaceChildren(...message.items.map(renderSourceItem));
    message.bodyElement.append(list);
  } else if (message.text) {
    const text = document.createElement("div");
    text.className = "process-text";
    text.textContent = message.text;
    message.bodyElement.append(text);
  }
}

function renderPermissionInline(message) {
  const card = renderPermissionCard(message.permission);
  card.classList.add("inline-permission-card");
  if (message.resolved) {
    card.classList.add("resolved");
    card.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    const status = document.createElement("div");
    status.className = "permission-resolved";
    status.textContent = "已处理";
    card.append(status);
  }
  return card;
}

function renderElicitationInline(message) {
  const elicitation = message.elicitation || {};
  const request = elicitation.request || {};
  const card = document.createElement("form");
  card.className = "elicitation-card";

  const title = document.createElement("div");
  title.className = "permission-title";
  title.textContent = request.requestedSchema?.title || "Agent 需要你选择";

  const text = document.createElement("div");
  text.className = "permission-meta";
  text.textContent = request.message || "请完成下面的输入";

  card.append(title, text);

  if (request.mode === "url") {
    const link = document.createElement("a");
    link.className = "primary-button small elicitation-link";
    link.href = request.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "打开链接";
    card.append(link);
  } else {
    const fields = document.createElement("div");
    fields.className = "elicitation-fields";
    const properties = request.requestedSchema?.properties || {};
    for (const [name, schema] of Object.entries(properties)) {
      fields.append(renderElicitationField(name, schema, request.requestedSchema?.required || []));
    }
    card.append(fields);
  }

  const actions = document.createElement("div");
  actions.className = "permission-actions";
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "text-button";
  decline.textContent = "拒绝";
  decline.addEventListener("click", () => respondElicitation(elicitation.id, { action: "decline" }, decline));
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary-button small";
  submit.textContent = "提交";
  actions.append(decline, submit);
  card.append(actions);

  card.addEventListener("submit", (event) => {
    event.preventDefault();
    respondElicitation(elicitation.id, {
      action: "accept",
      content: collectElicitationContent(card, request.requestedSchema?.properties || {}),
    }, submit);
  });

  if (message.resolved) {
    card.classList.add("resolved");
    card.querySelectorAll("button, input, select, textarea, a").forEach((element) => {
      if ("disabled" in element) {
        element.disabled = true;
      }
    });
    const status = document.createElement("div");
    status.className = "permission-resolved";
    status.textContent = "已处理";
    card.append(status);
  }

  return card;
}

function renderSourceItem(item) {
  const row = document.createElement("div");
  row.className = "source-item";
  const icon = document.createElement("span");
  icon.className = "source-icon";
  icon.textContent = item.icon || "·";
  const text = document.createElement("span");
  text.textContent = item.title;
  row.append(icon, text);
  return row;
}

function applySessionEvent(event, options = {}) {
  if (event.kind === "message") {
    const text = String(event.text || "");
    if (!text.trim()) return;
    appendMessage(event.role, text, {
      merge: !options.replay,
      messageId: event.messageId,
    });
    return;
  }

  if (event.kind === "thought") {
    appendThought(event.text, {
      merge: !options.replay,
      messageId: event.messageId,
    });
    return;
  }

  if (event.kind === "tool") {
    upsertToolMessage(event);
  }
}

function appendMessage(role, text, options = {}) {
  const last = state.messages[state.messages.length - 1];
  const sameMessage =
    !options.messageId || !last?.messageId || last.messageId === options.messageId;
  if (options.merge && last?.role === role && sameMessage) {
    last.text = normalizeAnswerText(mergeText(last.text, text));
    last.messageId = options.messageId || last.messageId;
    updateMountedMessage(last);
    return;
  }
  if (role === "agent" && state.pendingThought?.text === "") {
    state.pendingThought.text = "本轮暂未收到思考过程输出。";
    state.pendingThought.statusText = "";
    updateMountedMessage(state.pendingThought);
  }
  const message = {
    role,
    text: role === "agent" ? normalizeAnswerText(text) : text,
    messageId: options.messageId,
  };
  state.messages.push(message);
  mountMessage(message);
}

function appendThought(text, options = {}) {
  const trimmed = text.trim();

  const last =
    state.pendingThought && state.messages.includes(state.pendingThought)
      ? state.pendingThought
      : state.messages[state.messages.length - 1];
  const sameMessage =
    !options.messageId || !last?.messageId || last.messageId === options.messageId;
  if (
    (options.merge || last === state.pendingThought) &&
    last?.role === "process" &&
    last.processType === "thought" &&
    sameMessage
  ) {
    last.text = last.text ? mergeText(last.text, text) : trimmed;
    last.statusText = last.text ? "" : "等待中";
    last.messageId = options.messageId || last.messageId;
    updateMountedMessage(last);
    return;
  }

  const message = {
    role: "process",
    processType: "thought",
    title: "思考过程",
    text: trimmed,
    messageId: options.messageId,
    open: true,
  };
  state.pendingThought = message;
  state.messages.push(message);
  mountMessage(message);
}

function ensurePendingThought() {
  if (state.pendingThought && state.messages.includes(state.pendingThought)) {
    return;
  }
  const message = {
    role: "process",
    processType: "thought",
    title: "思考过程",
    statusText: "等待中",
    text: "",
    open: true,
  };
  state.pendingThought = message;
  state.messages.push(message);
  mountMessage(message);
}

function upsertToolMessage(event) {
  if (!event.toolCallId) return;

  const existingIndex = state.toolMessageIndexes.get(event.toolCallId);
  const statusText = toolStatusText(event.status);
  const next = {
    role: "process",
    processType: "tool",
    toolCallId: event.toolCallId,
    toolKind: event.toolKind,
    title: toolTitle(event),
    status: event.status,
    statusText,
    text: event.text,
    items: event.items,
    open: event.status !== "completed",
  };

  if (existingIndex !== undefined && state.messages[existingIndex]) {
    const existing = state.messages[existingIndex];
    Object.assign(existing, {
      ...next,
      items: event.items?.length ? event.items : existing.items,
      text: event.text || existing.text,
    });
    updateMountedMessage(existing);
  } else {
    state.toolMessageIndexes.set(event.toolCallId, state.messages.length);
    state.messages.push(next);
    mountMessage(next);
  }
}

function upsertPermissionMessage(permission) {
  if (!permission?.id) return;
  const existingIndex = state.permissionMessageIndexes.get(permission.id);
  const toolCall = permission.request?.toolCall || {};
  const next = {
    role: "process",
    processType: "permission",
    permissionId: permission.id,
    permission,
    title: `等待审批 · ${toolCall.title || toolTitle({ toolKind: toolCall.kind }) || "Agent 操作"}`,
    statusText: "",
    open: true,
  };

  if (existingIndex !== undefined && state.messages[existingIndex]) {
    Object.assign(state.messages[existingIndex], next);
    updateMountedMessage(state.messages[existingIndex]);
    return;
  }

  state.permissionMessageIndexes.set(permission.id, state.messages.length);
  state.messages.push(next);
  mountMessage(next);
}

function resolvePermissionMessage(permissionId) {
  const existingIndex = state.permissionMessageIndexes.get(permissionId);
  if (existingIndex === undefined || !state.messages[existingIndex]) {
    return;
  }

  const message = state.messages[existingIndex];
  message.resolved = true;
  message.statusText = "已处理";
  message.open = false;
  updateMountedMessage(message);
}

function upsertElicitationMessage(elicitation) {
  if (!elicitation?.id) return;
  const existingIndex = state.elicitationMessageIndexes.get(elicitation.id);
  const next = {
    role: "process",
    processType: "elicitation",
    elicitationId: elicitation.id,
    elicitation,
    title: "等待选择",
    statusText: "",
    open: true,
  };

  if (existingIndex !== undefined && state.messages[existingIndex]) {
    Object.assign(state.messages[existingIndex], next);
    updateMountedMessage(state.messages[existingIndex]);
    return;
  }

  state.elicitationMessageIndexes.set(elicitation.id, state.messages.length);
  state.messages.push(next);
  mountMessage(next);
}

function resolveElicitationMessage(elicitationId) {
  const existingIndex = state.elicitationMessageIndexes.get(elicitationId);
  if (existingIndex === undefined || !state.messages[existingIndex]) {
    return;
  }

  const message = state.messages[existingIndex];
  message.resolved = true;
  message.statusText = "已处理";
  message.open = false;
  updateMountedMessage(message);
}

function updateToChatEvent(update, options = {}) {
  if (!update || typeof update !== "object") {
    return null;
  }

  if (update.sessionUpdate === "agent_message_chunk") {
    return {
      kind: "message",
      role: "agent",
      text: contentToText(update.content),
      messageId: update.messageId,
    };
  }

  if (options.includeUser !== false && update.sessionUpdate === "user_message_chunk") {
    return {
      kind: "message",
      role: "user",
      text: contentToText(update.content),
      messageId: update.messageId,
    };
  }

  if (update.sessionUpdate === "agent_thought_chunk") {
    return {
      kind: "thought",
      text: contentToText(update.content),
      messageId: update.messageId,
    };
  }

  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return {
      kind: "tool",
      toolCallId: update.toolCallId,
      toolKind: update.kind,
      title: update.title,
      status: update.status,
      text: toolText(update),
      items: toolItems(update),
    };
  }

  return null;
}

function collectHistoryMessages(value, output, depth = 0) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectHistoryMessages(item, output, depth + 1));
    return;
  }
  if (typeof value !== "object") {
    return;
  }

  const event = updateToChatEvent(value);
  if (event) {
    output.push(event);
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (["updates", "messages", "transcript", "content"].includes(key)) {
      collectHistoryMessages(item, output, depth + 1);
    }
  }
}

function contentToText(content) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(contentToText).join("");
  }
  if (typeof content !== "object") {
    return "";
  }
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  if (typeof content.text === "string") {
    return content.text;
  }
  if (content.content) {
    return contentToText(content.content);
  }
  return "";
}

function mergeText(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  return previous + next;
}

function normalizeAnswerText(text) {
  return text
    .replace(/\bop\s+encode\b/gi, "opencode")
    .replace(/\bopen\s+code\b/g, "OpenCode")
    .replace(/\bcli\s+工具\b/gi, "CLI工具");
}

function toolTitle(event) {
  if (event.items?.length) {
    return `检索到${event.items.length}个资料`;
  }
  if (event.title) {
    return event.title;
  }
  const labels = {
    delete: "删除文件",
    edit: "修改文件",
    execute: "执行命令",
    fetch: "获取资料",
    move: "移动文件",
    other: "执行工具",
    read: "读取资料",
    search: "检索资料",
    switch_mode: "切换模式",
    think: "思考过程",
  };
  return labels[event.toolKind] || "执行工具";
}

function toolStatusText(status) {
  return {
    completed: "完成",
    failed: "失败",
    in_progress: "进行中",
    pending: "等待中",
  }[status] || "";
}

function toolIcon(kind) {
  return {
    edit: "✎",
    execute: ">",
    fetch: "↧",
    read: "□",
    search: "⌕",
    think: "·",
  }[kind] || "·";
}

function toolText(update) {
  const fromContent = contentToText(update.content);
  if (fromContent) return fromContent;
  if (typeof update.rawOutput === "string") return update.rawOutput;
  if (update.rawOutput) return JSON.stringify(update.rawOutput, null, 2);
  if (typeof update.rawInput === "string") return update.rawInput;
  if (update.rawInput) return JSON.stringify(update.rawInput, null, 2);
  return "";
}

function toolItems(update) {
  if (!["fetch", "read", "search"].includes(update.kind)) {
    return [];
  }

  const values = [];
  collectToolItems(update.content, values);
  collectToolItems(update.rawOutput, values);
  collectToolItems(update.rawInput, values);

  const unique = [];
  const seen = new Set();
  for (const item of values) {
    const title = item.title?.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    unique.push({ ...item, title });
  }
  return unique.slice(0, 8);
}

function collectToolItems(value, output, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) {
      const title = line.replace(/^[-*•\d.\s]+/, "").trim();
      if (title.length >= 6 && title.length <= 120) {
        output.push({ title });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectToolItems(item, output, depth + 1));
    return;
  }
  if (typeof value !== "object") return;

  const title =
    value.title ||
    value.name ||
    value.label ||
    value.url ||
    value.path ||
    (value.type === "text" ? value.text : undefined);
  if (typeof title === "string") {
    output.push({ title, icon: value.icon });
  }

  for (const key of ["items", "results", "sources", "content", "data"]) {
    collectToolItems(value[key], output, depth + 1);
  }
}

function rowButton({ title, subtitle, badge, onClick }) {
  const button = document.createElement("button");
  button.className = "row";
  button.type = "button";
  button.innerHTML = `
    <span>
      <span class="row-title">${escapeHtml(title)}</span>
      <span class="row-subtitle">${escapeHtml(subtitle || "")}</span>
    </span>
    <span class="badge">${escapeHtml(badge || "")}</span>
  `;
  button.addEventListener("click", onClick);
  return button;
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Remote-Acp-User-Id": state.userId,
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

function apiUrl(path) {
  const url = new URL(`${state.connectorUrl.replace(/\/$/, "")}${path}`);
  url.searchParams.set("userId", state.userId);
  return url.toString();
}

function loadUserId() {
  const fromUrl = new URLSearchParams(window.location.search).get("userId")?.trim();
  if (fromUrl) {
    localStorage.setItem("miniappUserId", fromUrl);
    return fromUrl;
  }
  return localStorage.getItem("miniappUserId") || "default";
}

function createMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
