import type { KeyObject } from "node:crypto";
import { loadSigningKey, signJwt } from "./jwt.js";

export const DEFAULT_API_URL = "https://api.enablebanking.com";
const TIMEOUT_MS = 60_000;

export interface Aspsp {
  readonly name: string;
  readonly country: string;
  readonly psu_types?: readonly string[];
  readonly maximum_consent_validity?: number;
  readonly beta?: boolean;
}

export interface AccountIdentification {
  readonly iban?: string;
  readonly other?: { readonly identification?: string; readonly scheme_name?: string };
}

export interface SessionAccount {
  readonly uid: string;
  readonly identification_hash: string;
  readonly account_id?: AccountIdentification;
  readonly name?: string;
  readonly currency?: string;
}

export interface Session {
  readonly session_id: string;
  readonly accounts: readonly SessionAccount[];
  readonly aspsp: { readonly name: string; readonly country: string };
  readonly access: { readonly valid_until: string };
}

export interface AmountType {
  readonly currency: string;
  readonly amount: string;
}

export interface Balance {
  readonly name?: string;
  readonly balance_amount: AmountType;
  readonly balance_type: string;
  readonly reference_date?: string;
}

/** Shape as documented; fields are untrusted and parsed by the sync (slice 5). */
export interface Transaction {
  readonly entry_reference?: string | null;
  readonly transaction_amount: AmountType;
  readonly credit_debit_indicator: string;
  readonly status: string;
  readonly booking_date?: string | null;
  readonly value_date?: string | null;
  readonly transaction_date?: string | null;
  readonly creditor?: { readonly name?: string | null } | null;
  readonly debtor?: { readonly name?: string | null } | null;
  readonly remittance_information?: readonly string[] | null;
}

export interface TransactionsPage {
  readonly transactions: readonly Transaction[];
  readonly continuation_key: string | null;
}

export interface TransactionQuery {
  readonly date_from?: string;
  readonly date_to?: string;
  readonly strategy?: "default" | "longest";
  readonly transaction_status?: string;
}

/** status 0 = no HTTP response (network failure, timeout, refused redirect, unparsable body on success). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ClientOptions {
  readonly appId: string;
  readonly privateKeyPem: string;
  /** Production by default; any other value must be a loopback host (the test fake), so a token never goes elsewhere. */
  readonly baseUrl?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkBaseUrl(raw: string): URL {
  if (!URL.canParse(raw)) throw new Error(`API URL is not a valid URL: ${raw}`);
  const url = new URL(raw);
  if (url.username !== "" || url.password !== "") throw new Error("API URL must not carry credentials");
  const production = url.origin === new URL(DEFAULT_API_URL).origin;
  const loopback = (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname);
  if (!production && !loopback) throw new Error(`API URL must be ${DEFAULT_API_URL} or a localhost test server: ${raw}`);
  return url;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(what: string): ApiError {
  return new ApiError(0, "MALFORMED_RESPONSE", `${what}: unexpected response shape`);
}

/** The field must be present and an array of objects: an absent list is malformed, never an empty result. */
function arrayField(body: Json, key: string, what: string): Json[] {
  const value = body[key];
  if (!Array.isArray(value) || !value.every(isObject)) throw malformed(what);
  return value;
}

/** Read-only AIS client: only the account-information endpoints the CLI needs. */
export class EnableBankingClient {
  readonly #appId: string;
  readonly #key: KeyObject;
  readonly #baseUrl: URL;

  constructor(options: ClientOptions) {
    if (options.appId.length === 0) throw new Error("appId must be a non-empty string");
    this.#baseUrl = checkBaseUrl(options.baseUrl ?? DEFAULT_API_URL);
    this.#appId = options.appId;
    this.#key = loadSigningKey(options.privateKeyPem);
  }

  async #request(method: "GET" | "POST" | "DELETE", path: string, body?: Json): Promise<Json> {
    const url = new URL(path, this.#baseUrl);
    const what = `${method} ${url.pathname}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${signJwt(this.#appId, this.#key)}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, init);
      text = await response.text();
    } catch (error) {
      throw new ApiError(0, "NETWORK_ERROR", `${what} failed: ${(error as Error).message}`);
    }
    if (response.ok && method === "DELETE" && text.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const code = isObject(parsed) && typeof parsed["error"] === "string" ? parsed["error"] : undefined;
      const detail = isObject(parsed) && typeof parsed["message"] === "string" ? parsed["message"] : response.statusText;
      throw new ApiError(response.status, code, `${what} failed: ${response.status}${code === undefined ? "" : ` ${code}`} ${detail}`.trim());
    }
    if (!isObject(parsed)) throw malformed(what);
    return parsed;
  }

  async listAspsps(country?: string, psuType?: string): Promise<readonly Aspsp[]> {
    const query = new URLSearchParams();
    if (country !== undefined) query.set("country", country);
    if (psuType !== undefined) query.set("psu_type", psuType);
    const body = await this.#request("GET", `/aspsps?${query}`);
    const aspsps = arrayField(body, "aspsps", "GET /aspsps");
    if (!aspsps.every((a) => typeof a["name"] === "string" && typeof a["country"] === "string")) {
      throw malformed("GET /aspsps");
    }
    return aspsps as unknown as readonly Aspsp[];
  }

  /** Starts a consent; returns the bank URL the user opens. Never called by tests against production. */
  async startAuth(input: {
    readonly aspsp: { readonly name: string; readonly country: string };
    readonly validUntil: string;
    readonly state: string;
    readonly redirectUrl: string;
  }): Promise<{ readonly url: string }> {
    const body = await this.#request("POST", "/auth", {
      access: { valid_until: input.validUntil },
      aspsp: { name: input.aspsp.name, country: input.aspsp.country },
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: "personal",
    });
    const url = body["url"];
    if (typeof url !== "string" || !URL.canParse(url) || new URL(url).protocol !== "https:") throw malformed("POST /auth");
    return { url };
  }

  /** Exchanges the callback code; the response is shown once, so the caller persists it before anything else. */
  async createSession(code: string): Promise<Session> {
    const body = await this.#request("POST", "/sessions", { code });
    const accounts = arrayField(body, "accounts", "POST /sessions");
    const access = body["access"];
    const aspsp = body["aspsp"];
    if (
      typeof body["session_id"] !== "string" ||
      body["session_id"].length === 0 ||
      !isObject(access) ||
      typeof access["valid_until"] !== "string" ||
      !isObject(aspsp) ||
      typeof aspsp["name"] !== "string" ||
      typeof aspsp["country"] !== "string" ||
      !accounts.every((a) => typeof a["uid"] === "string" && typeof a["identification_hash"] === "string")
    ) {
      throw malformed("POST /sessions");
    }
    return body as unknown as Session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async getBalances(accountUid: string): Promise<readonly Balance[]> {
    const what = "GET balances";
    const body = await this.#request("GET", `/accounts/${encodeURIComponent(accountUid)}/balances`);
    const balances = arrayField(body, "balances", what);
    const amountOk = (amount: unknown): boolean =>
      isObject(amount) && typeof amount["currency"] === "string" && typeof amount["amount"] === "string";
    if (!balances.every((b) => typeof b["balance_type"] === "string" && amountOk(b["balance_amount"]))) {
      throw malformed(what);
    }
    return balances as unknown as readonly Balance[];
  }

  /** One page; the caller loops on continuation_key with the same query. */
  async getTransactions(accountUid: string, query: TransactionQuery, continuationKey?: string): Promise<TransactionsPage> {
    const what = "GET transactions";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
    if (continuationKey !== undefined) params.set("continuation_key", continuationKey);
    const body = await this.#request("GET", `/accounts/${encodeURIComponent(accountUid)}/transactions?${params}`);
    const transactions = arrayField(body, "transactions", what);
    const key = body["continuation_key"] ?? null;
    if (key !== null && (typeof key !== "string" || key.length === 0)) throw malformed(what);
    return { transactions: transactions as unknown as readonly Transaction[], continuation_key: key };
  }
}
