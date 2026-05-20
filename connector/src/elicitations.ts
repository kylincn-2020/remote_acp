import { randomUUID } from "node:crypto";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";

export type PendingElicitation = {
  id: string;
  request: CreateElicitationRequest;
  createdAt: string;
};

type PendingElicitationEntry = PendingElicitation & {
  resolve: (response: CreateElicitationResponse) => void;
};

export class ElicitationQueue {
  private readonly pending = new Map<string, PendingElicitationEntry>();

  constructor(private readonly onRequest?: (elicitation: PendingElicitation) => void) {}

  request(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const id = request.mode === "url" ? request.elicitationId : randomUUID();
    const createdAt = new Date().toISOString();

    return new Promise((resolve) => {
      const entry: PendingElicitationEntry = {
        id,
        request,
        createdAt,
        resolve,
      };
      this.pending.set(id, entry);
      this.onRequest?.(toPublicElicitation(entry));
    });
  }

  list(): PendingElicitation[] {
    return Array.from(this.pending.values()).map(toPublicElicitation);
  }

  respond(id: string, response: CreateElicitationResponse): PendingElicitation {
    const entry = this.pending.get(id);
    if (!entry) {
      throw new Error(`Elicitation request not found: ${id}`);
    }

    this.pending.delete(id);
    entry.resolve(response);
    return toPublicElicitation(entry);
  }

  cancelAll(): void {
    for (const id of Array.from(this.pending.keys())) {
      this.respond(id, { action: "cancel" });
    }
  }
}

function toPublicElicitation(entry: PendingElicitationEntry): PendingElicitation {
  return {
    id: entry.id,
    request: entry.request,
    createdAt: entry.createdAt,
  };
}
