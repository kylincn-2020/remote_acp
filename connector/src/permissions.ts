import { randomUUID } from "node:crypto";
import type {
  PermissionOptionId,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export type PendingPermission = {
  id: string;
  request: RequestPermissionRequest;
  createdAt: string;
};

type PendingPermissionEntry = PendingPermission & {
  resolve: (response: RequestPermissionResponse) => void;
};

export class PermissionQueue {
  private readonly pending = new Map<string, PendingPermissionEntry>();

  constructor(private readonly onRequest?: (permission: PendingPermission) => void) {}

  request(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    return new Promise((resolve) => {
      const entry: PendingPermissionEntry = {
        id,
        request,
        createdAt,
        resolve,
      };
      this.pending.set(id, entry);
      this.onRequest?.(toPublicPermission(entry));
    });
  }

  list(): PendingPermission[] {
    return Array.from(this.pending.values()).map(toPublicPermission);
  }

  respond(id: string, optionId?: PermissionOptionId): PendingPermission {
    const entry = this.pending.get(id);
    if (!entry) {
      throw new Error(`Permission request not found: ${id}`);
    }

    this.pending.delete(id);
    entry.resolve({
      outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
    });
    return toPublicPermission(entry);
  }

  cancelAll(): void {
    for (const id of Array.from(this.pending.keys())) {
      this.respond(id);
    }
  }
}

function toPublicPermission(entry: PendingPermissionEntry): PendingPermission {
  return {
    id: entry.id,
    request: entry.request,
    createdAt: entry.createdAt,
  };
}
