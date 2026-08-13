import { randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import { sha256 } from "../security/hash.js";
import type { QuickBooksControlRepository } from "./controlRepository.js";

type TicketRepository = Pick<QuickBooksControlRepository, "saveConnectTicket" | "consumeConnectTicket">;

export class QuickBooksConnectionTicketService {
  readonly #repository: TicketRepository;
  readonly #publicBaseUrl: string;

  constructor(repository: TicketRepository, publicBaseUrl: string) {
    this.#repository = repository;
    this.#publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
  }

  async issue(actorId: string): Promise<{ url: string; expiresAt: Date }> {
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await this.#repository.saveConnectTicket(sha256(`quickbooks:${ticket}`), actorId, expiresAt);
    return {
      url: `${this.#publicBaseUrl}/connect/quickbooks?ticket=${encodeURIComponent(ticket)}`,
      expiresAt,
    };
  }

  async consume(ticket: string): Promise<{ actorId: string }> {
    const consumed = await this.#repository.consumeConnectTicket(
      sha256(`quickbooks:${ticket}`),
      new Date(),
    );
    if (!consumed) {
      throw new AppError("FORBIDDEN", "QuickBooks connect ticket is invalid, expired, or already used.", {
        httpStatus: 403,
      });
    }
    return consumed;
  }
}
