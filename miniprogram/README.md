# miniprogram

Standalone mini program page module for `remote_acp`.

## Run

1. Start the local connector:

```powershell
cd connector
npm run dev:http
```

Connector startup reads `config/config.json` in the connector module by default.

2. Start the page:

```powershell
cd miniprogram
npm run dev
```

3. Open `http://127.0.0.1:17892`.

The page talks directly to the connector HTTP API at `http://127.0.0.1:17890`.
Use the top-right settings button if the connector URL or token is different.

## Current scope

- Agent permission requests and elicitation forms render inline in the active chat.
- Agent home tab reading the connected agent from `/health`.
- Shared project list from `/projects`.
- Sessions grouped under each project via `/sessions?cwd=...`.
- Create/load Session and send messages through ACP connector endpoints.
- Live agent updates, inline permission approval events, and elicitation events through the connector SSE endpoint `/events`.
