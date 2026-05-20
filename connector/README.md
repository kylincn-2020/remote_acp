# connector

Standalone ACP connector module.

- Source: `src/index.ts`
- Example CLI: `examples/connect.ts`
- Build output: `../dist/connector/`

This module wraps `@agentclientprotocol/sdk` and exposes both raw ACP methods and app-friendly helpers.

## HTTP connector

Run a local HTTP wrapper around the ACP connector:

```powershell
cd connector
npm run dev:http
```

By default the connector reads `config/config.json`. Copy
`config/config.example.json` to `config/config.json` and adjust the local
agent command, ports, token, and permission switches.

Default URL: `http://127.0.0.1:17890`.

Endpoints:

- `GET /health`
- `GET /capabilities`
- `GET /permissions`
- `POST /permissions/:permissionId/respond`
- `GET /elicitations`
- `POST /elicitations/:elicitationId/respond`
- `GET /projects`
- `PUT /projects`
- `POST /projects`
- `DELETE /projects/:projectId`
- `GET /sessions?cwd=<absolute-path>&cursor=<cursor>`
- `POST /sessions`
- `POST /sessions/load`
- `POST /sessions/history`
- `POST /sessions/resume`
- `POST /sessions/:sessionId/messages`
- `POST /sessions/:sessionId/mode`
- `POST /sessions/:sessionId/model`
- `DELETE /sessions/:sessionId`
- `GET /events?sessionId=<sessionId>` for SSE `session_update`, `permission_request`, `permission_resolved`, `elicitation_request`, and `elicitation_resolved` events

If `CONNECTOR_TOKEN` is set, pass `Authorization: Bearer <token>`.

## WebSocket connector

Run a local WebSocket wrapper around the ACP connector:

```powershell
cd connector
npm run dev:ws
```

Default URL: `ws://127.0.0.1:17891`.

Request format:

```json
{
  "requestId": "req-1",
  "type": "sessions.list",
  "payload": {
    "cwd": "E:\\develop\\AI\\remote_acp"
  }
}
```

Response format:

```json
{
  "type": "response",
  "requestId": "req-1",
  "ok": true,
  "result": {}
}
```

Supported request types:

- `capabilities.get`
- `projects.list`
- `projects.set`
- `projects.add`
- `projects.update`
- `projects.remove`
- `permissions.list`
- `permission.respond`
- `elicitations.list`
- `elicitation.respond`
- `sessions.list`
- `sessions.create`
- `sessions.load`
- `sessions.resume`
- `session.prompt`
- `session.setMode`
- `session.setModel`
- `session.close`
- `events.subscribe`
- `events.unsubscribe`

ACP streaming updates are pushed as:

```json
{
  "type": "session.update",
  "sessionId": "ses_xxx",
  "update": {}
}
```

Agent permission requests are pushed as:

```json
{
  "type": "permission.request",
  "sessionId": "ses_xxx",
  "permission": {}
}
```

Agent elicitations are pushed as:

```json
{
  "type": "elicitation.request",
  "sessionId": "ses_xxx",
  "elicitation": {}
}
```

## Connector configuration

Startup config is stored in `config/config.json` by default. Override the
path with `CONNECTOR_CONFIG_PATH`.

```json
{
  "target": {
    "kind": "local",
    "command": "E:\\data\\nodejs\\node_global\\node_modules\\opencode-ai\\bin\\opencode.exe",
    "args": ["acp"],
    "cwd": "E:\\develop\\AI\\remote_acp"
  },
  "server": {
    "host": "127.0.0.1",
    "port": 17890,
    "wsPort": 17891,
    "token": ""
  },
  "permissions": {
    "exposeFileSystem": false,
    "exposeTerminal": false,
    "autoApprovePermission": false
  },
  "allowedRoots": ["E:\\develop\\AI\\remote_acp"],
  "projects": [
    {
      "id": "remote_acp",
      "name": "remote_acp",
      "cwd": "E:\\develop\\AI\\remote_acp"
    }
  ]
}
```

Environment variables still work and override the config file:

- `ACP_COMMAND`, `ACP_ARGS`, `ACP_CWD`
- `ACP_WS_URL`, `ACP_AUTH_TOKEN`
- `HOST`, `PORT`, `CONNECTOR_TOKEN`
- `ACP_EXPOSE_FS`, `ACP_EXPOSE_TERMINAL`, `ACP_AUTO_APPROVE`
- `ACP_ALLOWED_ROOTS`

## Projects

ACP does not provide a standard project list API. The local connector stores the
user-configured project list in the `projects` field of `config/config.json`.

Project shape:

```json
{
  "id": "remote_acp",
  "name": "remote_acp",
  "cwd": "E:\\develop\\AI\\remote_acp",
  "agentIds": ["opencode"]
}
```

The miniprogram flow reads `GET /projects`, then calls `GET /sessions?cwd=...`
with each project's `cwd`.
