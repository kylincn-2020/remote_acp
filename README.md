# remote_acp

Prototype UI plus an ACP connector for controlling local or remote coding agents.

## Modules

- `connector/`: standalone TypeScript ACP connector module
- `miniapp_server/`: HTTP/SSE server that serves the miniapp and forwards requests to a connected connector
- `miniapp/`: standalone miniapp page module
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
npm run dev
```

Connector startup reads `config/config.json` from inside the `connector/` directory.

By default the connector opens an outbound WebSocket connection to
`http://127.0.0.1:17892`. Override it with `server.appServerUrl` or
`APP_SERVER_URL`. The miniapp server then forwards client HTTP/SSE requests
to this connected connector.

## Run Miniapp Server

```powershell
cd miniapp_server
npm run dev
```

Open `http://127.0.0.1:17892`. The connector reconnects automatically, so the
connector and `miniapp_server` can be started in either order.

For multi-user testing, give each connector a distinct user id and open the
miniapp with the same query parameter:

```powershell
cd connector
$env:APP_SERVER_USER_ID="alice"
npm run dev
```

Then open `http://127.0.0.1:17892/?userId=alice`.

## Run Miniapp

```powershell
cd miniapp
npm run dev
```

Open `http://127.0.0.1:17893`. This standalone static server still sends API
requests through `miniapp_server` at `http://127.0.0.1:17892`.

## Checks

```powershell
cd connector
npm run check
npm run build

cd ..\miniapp_server
npm run check

cd ..\miniapp
npm run check
```
