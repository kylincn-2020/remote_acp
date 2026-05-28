import { loadConnectorAppConfig } from "./config.js";
import { connectToAppServer } from "./server-connection.js";
import { ConnectorService } from "./service.js";

const { appServerUrl, appServerToken, appServerUserId, ...options } =
  await loadConnectorAppConfig();

const service = await ConnectorService.create(options);

console.log(`ACP connector app server ${appServerUrl}`);
const serverConnection = connectToAppServer({
  serverUrl: appServerUrl,
  serverToken: appServerToken,
  userId: appServerUserId,
  agentInfo: service.connector.initializeResult.agentInfo,
  handleRequest: (request) => service.handleRequest(request),
  openStream: (request, sink) => service.openEventStream(request, sink),
  logger: console.log,
});

async function shutdown() {
  serverConnection.close();
  await service.close();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
