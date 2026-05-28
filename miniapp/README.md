# miniapp

Standalone miniapp page module for `remote_acp`.

## Run

1. Start the local connector:

```powershell
cd connector
npm run dev
```

Connector startup reads `config/config.json` in the connector module by default.

2. Start the standalone page:

```powershell
cd miniapp
npm run dev
```

3. Open `http://127.0.0.1:17893`.

The standalone miniapp defaults to `http://127.0.0.1:17893` to avoid conflicting
with `miniapp_server` on `17892`, but it still sends API requests through
`miniapp_server` at `http://127.0.0.1:17892`.

## Current scope

- Agent permission requests and elicitation forms render inline in the active chat.
- Agent home tab reading the connected agent from `/health`.
- Shared project list from `/projects`.
- Sessions grouped under each project via `/sessions?cwd=...`.
- Create/load Session and send messages through ACP connector endpoints.
- Live agent updates, inline permission approval events, and elicitation events through the connector SSE endpoint `/events`.
