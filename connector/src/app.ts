import { loadConnectorAppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { connectToAppServer } from "./server-connection.js";
import { ConnectorService } from "./service.js";

const { appServerUrl, appServerToken, appServerUserId, logging, ...options } =
  await loadConnectorAppConfig();

const logger = createLogger(logging);
logger.info(`logging to ${logger.file} at ${logger.level} level`);

const service = await ConnectorService.create({
  ...options,
  logger: logger.child("acp"),
});

logger.info(`ACP connector app server ${appServerUrl}`);
const serverConnection = connectToAppServer({
  serverUrl: appServerUrl,
  serverToken: appServerToken,
  userId: appServerUserId,
  agentInfo: service.connector.initializeResult.agentInfo,
  handleRequest: (request) => service.handleRequest(request),
  openStream: (request, sink) => service.openEventStream(request, sink),
  logger: logger.child("server-connection"),
});

async function shutdown() {
  logger.info("shutting down connector");
  serverConnection.close();
  await service.close();
  await logger.close();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
