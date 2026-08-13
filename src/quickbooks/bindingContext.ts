import { hashObject } from "../security/hash.js";
import type { QuickBooksConnection } from "./connections.js";

export interface QuickBooksBindingContext {
  readonly connectionRefSafe: string;
  readonly boundTargetRefSafe: string;
  readonly bindingRevision: string;
  readonly companyName: string;
}

function opaqueRef(prefix: string, value: unknown): string {
  return `${prefix}:${hashObject(value).slice(0, 32)}`;
}

/**
 * Builds Agent-safe binding evidence without exposing the Intuit Realm ID or
 * the internal connection primary key. Token rotation deliberately does not
 * change the revision; replacing the connected company does.
 */
export function quickBooksBindingContext(
  connection: Pick<QuickBooksConnection, "connectionId" | "realmId" | "companyName">,
): QuickBooksBindingContext {
  return {
    connectionRefSafe: opaqueRef("quickbooks-connection", {
      provider: "quickbooks-online",
      connectionId: connection.connectionId,
    }),
    boundTargetRefSafe: opaqueRef("quickbooks-target", {
      provider: "quickbooks-online",
      realmId: connection.realmId,
    }),
    bindingRevision: opaqueRef("quickbooks-binding-revision", {
      provider: "quickbooks-online",
      connectionId: connection.connectionId,
      realmId: connection.realmId,
    }),
    companyName: connection.companyName,
  };
}
