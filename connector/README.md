# connector

Standalone ACP connector module.

- Source: `src/index.ts`
- Example CLI: `examples/connect.ts`
- Build output: `../dist/connector/`

This module wraps `@agentclientprotocol/sdk` and exposes both raw ACP methods and app-friendly helpers.

## HTTP connector

Run a local HTTP wrapper around the ACP connector:

```bash
ACP_COMMAND="opencode"
ACP_ARGS='["acp"]'
ACP_CWD="/path/to/project"
npm run dev:connector:http
```

On Windows, prefer the real executable path when a PowerShell shim cannot be spawned:

```powershell
$env:ACP_COMMAND="E:\data\nodejs\node_global\node_modules\opencode-ai\bin\opencode.exe"
$env:ACP_ARGS='["acp"]'
$env:ACP_CWD="E:\develop\AI\remote_acp"
$env:CONNECTOR_TOKEN="dev-token"
npm run dev:connector:http
```

Default URL: `http://127.0.0.1:17890`.

Endpoints:

- `GET /health`
- `GET /capabilities`
- `GET /projects`
- `PUT /projects`
- `POST /projects`
- `DELETE /projects/:projectId`
- `GET /sessions?cwd=<absolute-path>&cursor=<cursor>`
- `POST /sessions`
- `POST /sessions/load`
- `POST /sessions/resume`
- `POST /sessions/:sessionId/messages`
- `POST /sessions/:sessionId/mode`
- `POST /sessions/:sessionId/model`
- `DELETE /sessions/:sessionId`
- `GET /events?sessionId=<sessionId>` for SSE `session_update` events

If `CONNECTOR_TOKEN` is set, pass `Authorization: Bearer <token>`.

## WebSocket connector

Run a local WebSocket wrapper around the ACP connector:

```powershell
$env:ACP_COMMAND="E:\data\nodejs\node_global\node_modules\opencode-ai\bin\opencode.exe"
$env:ACP_ARGS='["acp"]'
$env:ACP_CWD="E:\develop\AI\remote_acp"
$env:CONNECTOR_TOKEN="dev-token"
npm run dev:connector:ws
```

Default URL: `ws://127.0.0.1:17891?token=dev-token`.

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

## Project configuration

ACP does not provide a standard project list API. The local connector stores the
user-configured project list in `connector.projects.json` by default. Override
the path with `CONNECTOR_PROJECTS_PATH`.

Project shape:

```json
{
  "id": "remote_acp",
  "name": "remote_acp",
  "cwd": "E:\\develop\\AI\\remote_acp",
  "agentIds": ["opencode"]
}
```

The miniprogram flow should read `projects.list`, then call `sessions.list` with
each project's `cwd`.
