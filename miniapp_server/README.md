# miniapp_server

Serves the miniapp and forwards HTTP/SSE API calls to a connector that connects
outward over WebSocket.

## Run

```powershell
cd miniapp_server
npm install
npm run dev
```

Then start the connector with `server.appServerUrl` in
`connector/config/config.json`, or with:

```powershell
cd ..\connector
$env:APP_SERVER_URL="http://127.0.0.1:17892"
npm run dev
```

Open `http://127.0.0.1:17892`.

## Environment

- `MINIAPP_SERVER_HOST`: default `127.0.0.1`
- `MINIAPP_SERVER_PORT`: default `17892`
- `MINIAPP_SERVER_TOKEN`: optional token required from the connector
- `MINIAPP_SERVER_DEFAULT_USER_ID`: default `default`

For multi-user testing, start each connector with a distinct
`APP_SERVER_USER_ID`, then open the client with the same `userId` query
parameter, for example `http://127.0.0.1:17892/?userId=alice`.
