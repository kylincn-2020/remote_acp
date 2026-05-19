import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createAcpConnector, type AcpTarget } from "../src/index.js";

function targetFromEnv(): AcpTarget {
  const wsUrl = process.env.ACP_WS_URL;
  if (wsUrl) {
    return {
      kind: "websocket",
      url: wsUrl,
      headers: process.env.ACP_AUTH_TOKEN
        ? {
            Authorization: `Bearer ${process.env.ACP_AUTH_TOKEN}`,
          }
        : undefined,
    };
  }

  const command = process.env.ACP_COMMAND;
  if (!command) {
    throw new Error("Set ACP_COMMAND for a local ACP process or ACP_WS_URL for a remote ACP endpoint.");
  }

  return {
    kind: "local",
    command,
    args: process.env.ACP_ARGS ? JSON.parse(process.env.ACP_ARGS) : [],
    cwd: process.env.ACP_CWD ?? process.cwd(),
  };
}

const connector = await createAcpConnector({
  target: targetFromEnv(),
  allowedRoots: [process.env.ACP_CWD ?? process.cwd()],
  exposeFileSystem: false,
  onSessionUpdate(notification) {
    const update = notification.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      output.write(update.content.text);
    } else if (update.sessionUpdate === "tool_call") {
      output.write(`\n[tool] ${update.title} (${update.status})\n`);
    } else if (update.sessionUpdate === "tool_call_update") {
      output.write(`\n[tool] ${update.toolCallId} -> ${update.status}\n`);
    }
  },
  onPermissionRequest(request) {
    const allow =
      request.options.find((option) => option.kind === "allow_once") ?? request.options[0];
    return {
      outcome: allow
        ? {
            outcome: "selected",
            optionId: allow.optionId,
          }
        : {
            outcome: "cancelled",
          },
    };
  },
});

console.log(
  `Connected to ${connector.initializeResult.agentInfo?.name ?? "ACP agent"} ` +
    `(protocol v${connector.initializeResult.protocolVersion})`,
);

const session = await connector.createSession({
  cwd: process.env.ACP_CWD ?? process.cwd(),
});
console.log(`Session: ${session.sessionId}`);

const rl = createInterface({ input, output });
try {
  while (true) {
    const text = await rl.question("\n> ");
    if (!text.trim() || text.trim() === "/exit") {
      break;
    }

    const result = await connector.sendText({
      sessionId: session.sessionId,
      text,
    });
    console.log(`\n[stop: ${result.stopReason}]`);
  }
} finally {
  rl.close();
  await connector.close();
}
