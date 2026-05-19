# remote_acp

Prototype UI plus an ACP connector for controlling local or remote coding agents.

## Modules

- `connector/`: standalone TypeScript ACP connector module
- `miniprogram/`: standalone mini program page module
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

## Run Connector

```powershell
cd connector
npm run dev:http
```

Connector startup reads `config/config.json` from inside the `connector/` directory.

## Run Miniprogram

```powershell
cd miniprogram
npm run dev
```

Open `http://127.0.0.1:17892`.

## Checks

```powershell
cd connector
npm run check
npm run build

cd ..\miniprogram
npm run check
```
