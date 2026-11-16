import { createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Aspsp, Balance, Session, Transaction } from "../../src/enable-banking.js";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface FakeError {
  readonly status: number;
  readonly error: string;
}

/** Per account uid: the pages served in order for every transactions request without continuation key. */
export interface FakeState {
  aspsps: Aspsp[];
  sessionsByCode: Map<string, Session>;
  pages: Map<string, Transaction[][]>;
  balances: Map<string, Balance[]>;
  /** Fails the n-th (1-based) transactions request of an account with this error. */
  failTransactions: Map<string, { readonly atRequest: number; readonly error: FakeError }>;
  /** Fails every request whose path starts with the key. */
  failPath: Map<string, FakeError>;
  /** Answers every request whose path starts with the key with this raw body (malformed-response tests). */
  rawPath: Map<string, { readonly status: number; readonly body: string; readonly headers?: Readonly<Record<string, string>> }>;
  /** Never answers the n-th (1-based) transactions request of an account (SIGKILL tests). */
  hangTransactions: Map<string, number>;
  /** When true, served rows are filtered by date_from/date_to on their first date (undated rows always pass). */
  filterDates: boolean;
  /** Oldest day the bank still serves: an earlier date_from gets 422 WRONG_TRANSACTIONS_PERIOD, older rows are not served. */
  oldestServed: string | undefined;
  authStates: string[];
  deletedSessions: string[];
}

export interface FakeApi {
  readonly url: string;
  readonly state: FakeState;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, error: FakeError): void {
  json(res, error.status, { code: error.status, message: error.error, error: error.error });
}

/**
 * Verifies an Enable Banking JWT as documented (RS256, kid = app id, iss/aud, not expired), with a TTL cap of
 * 300 s instead of the documented 86400 s so a longer-lived token fails every test that goes through the fake.
 */
function checkJwt(header: string | undefined, appId: string, publicKeyPem: string): string | undefined {
  if (header === undefined || !header.startsWith("Bearer ")) return "missing bearer token";
  const parts = header.slice(7).split(".");
  if (parts.length !== 3) return "malformed token";
  const [h, p, s] = parts as [string, string, string];
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(publicKeyPem), Buffer.from(s, "base64url"));
  if (!ok) return "bad signature";
  const head = JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>;
  const body = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  if (head["alg"] !== "RS256" || head["typ"] !== "JWT" || head["kid"] !== appId) return "bad header";
  if (body["iss"] !== "enablebanking.com" || body["aud"] !== "api.enablebanking.com") return "bad claims";
  const iat = body["iat"];
  const exp = body["exp"];
  const now = Date.now() / 1000;
  if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > 300 || exp <= iat || exp < now || iat > now + 60) return "bad times";
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text.length === 0 ? undefined : JSON.parse(text);
}

export async function startFakeApi(appId: string, publicKeyPem: string): Promise<FakeApi> {
  const state: FakeState = {
    aspsps: [],
    sessionsByCode: new Map(),
    pages: new Map(),
    balances: new Map(),
    failTransactions: new Map(),
    failPath: new Map(),
    rawPath: new Map(),
    hangTransactions: new Map(),
    filterDates: false,
    oldestServed: undefined,
    authStates: [],
    deletedSessions: [],
  };
  const requests: RecordedRequest[] = [];
  const transactionRequests = new Map<string, number>();
  /** Continuation key -> params of the request that issued it, minus the key. */
  const continuations = new Map<string, { account: string; params: string; page: number }>();
  let nextKey = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const query = Object.fromEntries(url.searchParams);
      const body = await readBody(req);
      requests.push({ method: req.method ?? "", path: url.pathname, query, body });
      const jwtError = checkJwt(req.headers.authorization, appId, publicKeyPem);
      if (jwtError !== undefined) return json(res, 401, { error: "UNAUTHORIZED", message: jwtError });
      for (const [prefix, error] of state.failPath) if (url.pathname.startsWith(prefix)) return fail(res, error);
      for (const [prefix, raw] of state.rawPath) {
        if (url.pathname.startsWith(prefix)) {
          res.writeHead(raw.status, { "content-type": "application/json", ...raw.headers });
          return res.end(raw.body);
        }
      }

      if (req.method === "GET" && url.pathname === "/aspsps") {
        return json(res, 200, {
          aspsps: state.aspsps.filter(
            (a) =>
              (query["country"] === undefined || a.country === query["country"]) &&
              (query["psu_type"] === undefined || (a.psu_types ?? []).includes(query["psu_type"])),
          ),
        });
      }
      if (req.method === "POST" && url.pathname === "/auth") {
        const input = body as { state?: string };
        state.authStates.push(input.state ?? "");
        return json(res, 200, { url: `https://bank.example/consent?state=${encodeURIComponent(input.state ?? "")}`, authorization_id: "auth-1" });
      }
      if (req.method === "POST" && url.pathname === "/sessions") {
        const session = state.sessionsByCode.get((body as { code?: string }).code ?? "");
        if (session === undefined) return json(res, 422, { error: "WRONG_AUTHORIZATION_CODE", message: "unknown code" });
        return json(res, 200, session);
      }
      const sessionMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && sessionMatch !== null) {
        state.deletedSessions.push(decodeURIComponent(sessionMatch[1] ?? ""));
        res.writeHead(200);
        return res.end();
      }
      const balanceMatch = /^\/accounts\/([^/]+)\/balances$/.exec(url.pathname);
      if (req.method === "GET" && balanceMatch !== null) {
        return json(res, 200, { balances: state.balances.get(decodeURIComponent(balanceMatch[1] ?? "")) ?? [] });
      }
      const txMatch = /^\/accounts\/([^/]+)\/transactions$/.exec(url.pathname);
      if (req.method === "GET" && txMatch !== null) {
        const account = decodeURIComponent(txMatch[1] ?? "");
        const count = (transactionRequests.get(account) ?? 0) + 1;
        transactionRequests.set(account, count);
        const failure = state.failTransactions.get(account);
        if (failure !== undefined && failure.atRequest === count) return fail(res, failure.error);
        if (state.hangTransactions.get(account) === count) return;
        const from = query["date_from"];
        // Real API rule (seen live): date_to without date_from is refused.
        if (query["date_to"] !== undefined && from === undefined) {
          return json(res, 422, { error: "DATE_TO_WITHOUT_DATE_FROM", message: "date_from must be provided if date_to provided" });
        }
        if (from !== undefined && state.oldestServed !== undefined && from < state.oldestServed) {
          return json(res, 422, { error: "WRONG_TRANSACTIONS_PERIOD", message: "date_from too old" });
        }
        const { continuation_key: key, ...rest } = query;
        const params = JSON.stringify(Object.entries(rest).sort());
        let page = 0;
        if (key !== undefined) {
          const previous = continuations.get(key);
          if (previous === undefined || previous.account !== account) return json(res, 400, { error: "WRONG_CONTINUATION_KEY" });
          if (previous.params !== params) return json(res, 400, { error: "WRONG_REQUEST_PARAMETERS", message: "params changed" });
          page = previous.page + 1;
        }
        const pages = state.pages.get(account) ?? [[]];
        const day = (t: Transaction): string | null | undefined => t.booking_date ?? t.value_date ?? t.transaction_date;
        const inWindow = (t: Transaction): boolean => {
          const d = day(t);
          if (d === null || d === undefined) return true;
          if (state.oldestServed !== undefined && d < state.oldestServed) return false;
          return !state.filterDates || ((from === undefined || d >= from) && (query["date_to"] === undefined || d <= query["date_to"]));
        };
        const transactions = (pages[page] ?? []).filter(inWindow);
        let continuation: string | null = null;
        if (page + 1 < pages.length) {
          continuation = `ck-${nextKey++}`;
          continuations.set(continuation, { account, params, page });
        }
        return json(res, 200, { transactions, continuation_key: continuation });
      }
      return json(res, 404, { error: "NOT_FOUND" });
    })().catch((error: unknown) => json(res, 500, { error: "FAKE_FAILURE", message: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
