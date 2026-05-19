# remote_acp

Prototype UI plus an ACP connector for controlling local or remote coding agents.

## Modules

- `connector/`: standalone TypeScript ACP connector module
- `miniprogram/`: standalone mini program module, reserved for the app implementation
- `prototype/`: static HTML prototype screens

## ACP connector

The connector lives in `connector/` and wraps `@agentclientprotocol/sdk`:

- local ACP agent: starts a subprocess and speaks ACP over stdio NDJSON
- remote ACP agent: connects to a WebSocket endpoint and speaks the same NDJSON protocol
- full ACP client methods are exposed directly on the connector and under `connector.api`
- convenience helpers: `createSession`, `sendText`, `setMode`, `setModel`, `close`
- callbacks: session updates, permission requests, file system, terminal, elicitation, extension methods

Examples:

```ts
const connector = await createAcpConnector({ target });

// Raw ACP method.
const sessions = await connector.listSessions({ cwd: process.cwd() });

// Convenience helper for the app chat box.
const session = await connector.createSession({ cwd: process.cwd() });
await connector.sendText({
  sessionId: session.sessionId,
  text: "hello",
});
```

## Local agent

```powershell
$env:ACP_COMMAND = "opencode"
$env:ACP_ARGS = '["acp"]'
$env:ACP_CWD = "E:\develop\AI\remote_acp"
npm run dev:acp
```

Adjust `ACP_COMMAND` and `ACP_ARGS` to match the agent command that exposes ACP on stdio.

## Remote agent

```powershell
$env:ACP_WS_URL = "wss://example.com/acp"
$env:ACP_AUTH_TOKEN = "token-if-needed"
$env:ACP_CWD = "E:\develop\AI\remote_acp"
npm run dev:acp
```

The remote endpoint should accept WebSocket messages containing newline-delimited JSON ACP frames.

## Build

```powershell
npm run check
npm run build
```
