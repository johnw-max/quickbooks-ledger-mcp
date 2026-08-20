import { randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import {
  buildQuickBooksAuthorizationUrl,
  exchangeQuickBooksAuthorizationCode,
} from "../providers/quickbooksOAuth.js";
import { QUICKBOOKS_ACCOUNTING_SCOPE } from "../providers/quickbooksTypes.js";
import { sha256 } from "../security/hash.js";
import type { QuickBooksClientManager, QuickBooksClientManagerConfig } from "./clientManager.js";
import type { QuickBooksControlRepository } from "./controlRepository.js";

type OAuthStateRepository = Pick<QuickBooksControlRepository, "saveOAuthState" | "consumeOAuthState">;

export class QuickBooksOAuthService {
  readonly #states: OAuthStateRepository;
  readonly #manager: QuickBooksClientManager;
  readonly #config: QuickBooksClientManagerConfig;

  constructor(options: {
    states: OAuthStateRepository;
    manager: QuickBooksClientManager;
    config: QuickBooksClientManagerConfig;
  }) {
    this.#states = options.states;
    this.#manager = options.manager;
    this.#config = options.config;
  }

  async start(actorId: string, browserSession: string): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    await this.#states.saveOAuthState(
      sha256(`quickbooks:${state}`),
      sha256(browserSession),
      actorId,
      new Date(Date.now() + 10 * 60_000),
    );
    return await buildQuickBooksAuthorizationUrl(this.#config, state);
  }

  async callback(options: {
    state: string;
    browserSession: string;
    code?: string;
    realmId?: string;
    error?: string;
  }): Promise<{ actorId: string; realmId: string; companyName: string; scopes: string[] }> {
    const consumed = await this.#states.consumeOAuthState(
      sha256(`quickbooks:${options.state}`),
      sha256(options.browserSession),
      new Date(),
    );
    if (!consumed) {
      throw new AppError("FORBIDDEN", "QuickBooks OAuth state is invalid, expired, already used, or from another browser.", {
        httpStatus: 403,
      });
    }
    if (options.error) {
      throw new AppError("AUTH_REQUIRED", "QuickBooks authorization was not granted.", { httpStatus: 401 });
    }
    if (!options.code || !options.realmId || !/^\d{3,32}$/.test(options.realmId)) {
      throw new AppError("AUTH_REQUIRED", "QuickBooks OAuth callback is incomplete.", { httpStatus: 401 });
    }
    const token = await exchangeQuickBooksAuthorizationCode({
      config: this.#config,
      code: options.code,
      ...(this.#config.request ? { request: this.#config.request } : {}),
    });
    const connection = await this.#manager.connect({
      actorId: consumed.actorId,
      realmId: options.realmId,
      token,
      grantedScopes: [QUICKBOOKS_ACCOUNTING_SCOPE],
    });
    return {
      actorId: connection.actorId,
      realmId: connection.realmId,
      companyName: connection.companyName,
      scopes: connection.grantedScopes,
    };
  }
}
