# connector

Standalone ACP connector module.

- Source: `src/index.ts`
- Example CLI: `examples/connect.ts`
- Build output: `../dist/connector/`

This module wraps `@agentclientprotocol/sdk` and exposes both raw ACP methods and app-friendly helpers.

## App entry

Run the connector app:

```powershell
cd connector
npm run dev
```

By default the connector reads `config/config.json`. Copy
`config/config.example.json` to `config/config.json` and adjust the local
agent command, ports, token, and permission switches.

`npm run dev` connects outward to the app server at `/connector`. The default
app server URL is `http://127.0.0.1:17892`; override it with `APP_SERVER_URL`
or `server.appServerUrl`. The connector no longer opens a local HTTP API port.

## Connector configuration

Startup config is stored in `config/config.json` by default. Override the
path with `CONNECTOR_CONFIG_PATH`.

```json
{
  "target": {
    "kind": "local",
    "command": "E:\\data\\nodejs\\node_global\\node_modules\\opencode-ai\\bin\\opencode.exe",
    "args": ["acp"]
  },
  "server": {
    "appServerUrl": "http://127.0.0.1:17892",
    "appServerToken": "",
    "appServerUserId": "default"
  },
  "permissions": {
    "exposeFileSystem": false,
    "exposeTerminal": false,
    "autoApprovePermission": false
  },
  "allowedRoots": [],
  "logging": {
    "level": "info",
    "file": "logs/connector.log",
    "console": true
  },
  "projects": [
    {
      "id": "remote_acp",
      "name": "remote_acp",
      "cwd": "E:\\develop\\AI\\remote_acp"
    }
  ]
}
```

For a local target, `target.cwd` is optional. When omitted, the connector uses
the directory where `npm run dev` was started.

Environment variables still work and override the config file:

- `ACP_COMMAND`, `ACP_ARGS`, `ACP_CWD`
- `ACP_WS_URL`, `ACP_AUTH_TOKEN`
- `APP_SERVER_URL`, `APP_SERVER_TOKEN`, `APP_SERVER_USER_ID`
- `CONNECTOR_LOG_LEVEL`, `CONNECTOR_LOG_FILE`, `CONNECTOR_LOG_CONSOLE`
- `ACP_EXPOSE_FS`, `ACP_EXPOSE_TERMINAL`, `ACP_AUTO_APPROVE`
- `ACP_ALLOWED_ROOTS`

## Logging

Connector logs are written to `logs/connector.log` by default. Configure the
log level and path in `config/config.json`:

```json
{
  "logging": {
    "level": "debug",
    "file": "logs/connector.log",
    "console": true
  }
}
```

Supported levels are `error`, `warn`, `info`, and `debug`. Environment
variables override the config file:

```powershell
$env:CONNECTOR_LOG_LEVEL="debug"
$env:CONNECTOR_LOG_FILE="logs/connector-debug.log"
$env:CONNECTOR_LOG_CONSOLE="false"
npm run dev
```

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

The miniapp flow reads `GET /projects`, then calls `GET /sessions?cwd=...`
with each project's `cwd`.
