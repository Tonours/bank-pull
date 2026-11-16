import { strict as assert } from "node:assert";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ApiError, DEFAULT_API_URL, EnableBankingClient } from "../src/enable-banking.js";
import { JWT_TTL_SECONDS, loadSigningKey, signJwt } from "../src/jwt.js";
import { startFakeApi, type FakeApi } from "./support/fake-api.js";
import { testKeyPair } from "./support/keys.js";

const keys = testKeyPair();
const APP_ID = "00000000-0000-4000-8000-000000000000";
let api: FakeApi;
let client: EnableBankingClient;

function apiError(status: number, code: string | undefined): (error: unknown) => boolean {
  return (error) => error instanceof ApiError && error.status === status && error.code === code;
}

before(async () => {
  api = await startFakeApi(APP_ID, keys.publicKeyPem);
  client = new EnableBankingClient({ appId: APP_ID, privateKeyPem: keys.privateKeyPem, baseUrl: api.url });
});
after(() => api.close());

test("signJwt produces a documented RS256 token with a TTL of at most 300 s", () => {
  const token = signJwt(APP_ID, loadSigningKey(keys.privateKeyPem), 1_000_000);
  const [h, p, s] = token.split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { typ: "JWT", alg: "RS256", kid: APP_ID });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), {
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: 1_000_000,
    exp: 1_000_000 + JWT_TTL_SECONDS,
  });
  assert.ok(JWT_TTL_SECONDS > 0 && JWT_TTL_SECONDS <= 300);
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(keys.publicKeyPem), Buffer.from(s, "base64url")));
});

test("a non-RSA or invalid private key is refused before any request", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => new EnableBankingClient({ appId: APP_ID, privateKeyPem: ec, baseUrl: api.url }), /must be RSA/);
  assert.throws(() => new EnableBankingClient({ appId: APP_ID, privateKeyPem: "nope", baseUrl: api.url }), /not a valid PEM/);
  assert.throws(() => new EnableBankingClient({ appId: "", privateKeyPem: keys.privateKeyPem, baseUrl: api.url }), /appId/);
});

test("the fake API rejects a token signed by another key or for another app", async () => {
  const stranger = new EnableBankingClient({ appId: APP_ID, privateKeyPem: testKeyPair().privateKeyPem, baseUrl: api.url });
  await assert.rejects(stranger.listAspsps("FR"), apiError(401, "UNAUTHORIZED"));
  const otherApp = new EnableBankingClient({ appId: "other-app", privateKeyPem: keys.privateKeyPem, baseUrl: api.url });
  await assert.rejects(otherApp.listAspsps("FR"), apiError(401, "UNAUTHORIZED"));
});

test("listAspsps sends country and psu_type", async () => {
  api.state.aspsps = [
    { name: "Test Bank", country: "FR", psu_types: ["personal"] },
    { name: "Biz Bank", country: "FR", psu_types: ["business"] },
  ];
  const banks = await client.listAspsps("FR", "personal");
  assert.deepEqual(banks.map((b) => b.name), ["Test Bank"]);
  assert.deepEqual(api.requests.at(-1)?.query, { country: "FR", psu_type: "personal" });
});

test("startAuth posts the documented body and returns the bank URL", async () => {
  const { url } = await client.startAuth({
    aspsp: { name: "Test Bank", country: "FR" },
    validUntil: "2027-05-01T00:00:00.000Z",
    state: "s-123",
    redirectUrl: "https://localhost/bank-pull/callback",
  });
  assert.match(url, /state=s-123/);
  assert.deepEqual(api.requests.at(-1)?.body, {
    access: { valid_until: "2027-05-01T00:00:00.000Z" },
    aspsp: { name: "Test Bank", country: "FR" },
    state: "s-123",
    redirect_url: "https://localhost/bank-pull/callback",
    psu_type: "personal",
  });
});

test("createSession returns the session and refuses an unknown code or a malformed body", async () => {
  const session = {
    session_id: "sess-1",
    accounts: [{ uid: "uid-1", identification_hash: "hash-1", currency: "EUR" }],
    aspsp: { name: "Test Bank", country: "FR" },
    access: { valid_until: "2027-05-01T00:00:00.000Z" },
  };
  api.state.sessionsByCode.set("code-1", session);
  assert.deepEqual(await client.createSession("code-1"), session);
  await assert.rejects(client.createSession("bad"), apiError(422, "WRONG_AUTHORIZATION_CODE"));
  for (const accounts of [[{ uid: "uid-1" }], undefined, null]) {
    api.state.sessionsByCode.set("code-2", { ...session, accounts } as never);
    await assert.rejects(client.createSession("code-2"), apiError(0, "MALFORMED_RESPONSE"), String(accounts));
  }
});

test("startAuth refuses a consent URL that is not https", async () => {
  const input = {
    aspsp: { name: "Test Bank", country: "FR" },
    validUntil: "2027-05-01T00:00:00.000Z",
    state: "s",
    redirectUrl: "https://localhost/bank-pull/callback",
  };
  for (const url of ["http://phish.example/c", "javascript:alert(1)", "not a url", 5]) {
    api.state.rawPath.set("/auth", { status: 200, body: JSON.stringify({ url }) });
    await assert.rejects(client.startAuth(input), apiError(0, "MALFORMED_RESPONSE"), String(url));
  }
  api.state.rawPath.delete("/auth");
});

test("getTransactions forwards the query and the continuation key unchanged", async () => {
  api.state.pages.set("uid-1", [[], []]);
  const query = { date_from: "2026-01-01", strategy: "longest" as const };
  const first = await client.getTransactions("uid-1", query);
  assert.deepEqual(api.requests.at(-1)?.query, { date_from: "2026-01-01", strategy: "longest" });
  assert.ok(first.continuation_key);
  const second = await client.getTransactions("uid-1", query, first.continuation_key ?? undefined);
  assert.equal(second.continuation_key, null);
  await assert.rejects(
    client.getTransactions("uid-1", { date_from: "2026-02-01" }, first.continuation_key ?? undefined),
    apiError(400, "WRONG_REQUEST_PARAMETERS"),
  );
});

for (const [status, code] of [
  [401, "EXPIRED_SESSION"],
  [401, "CLOSED_SESSION"],
  [429, "ASPSP_RATE_LIMIT_EXCEEDED"],
  [400, "WRONG_TRANSACTIONS_PERIOD"],
] as const) {
  test(`API error ${code} surfaces as ApiError with status and code`, async () => {
    api.state.failPath.set("/accounts/uid-err", { status, error: code });
    await assert.rejects(client.getTransactions("uid-err", {}), apiError(status, code));
    api.state.failPath.delete("/accounts/uid-err");
  });
}

test("a failure on a given transactions request leaves earlier pages served", async () => {
  api.state.pages.set("uid-fail", [[], [], []]);
  api.state.failTransactions.set("uid-fail", { atRequest: 2, error: { status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" } });
  const first = await client.getTransactions("uid-fail", {});
  assert.ok(first.continuation_key);
  await assert.rejects(client.getTransactions("uid-fail", {}, first.continuation_key ?? undefined), apiError(429, "ASPSP_RATE_LIMIT_EXCEEDED"));
});

test("a non-JSON or wrongly shaped success body is a MALFORMED_RESPONSE", async () => {
  for (const body of ["", "<html>", "[]", "{}", '{"transactions": null}', '{"transactions": "x"}', '{"transactions": [], "continuation_key": 5}']) {
    api.state.rawPath.set("/accounts/uid-raw", { status: 200, body });
    await assert.rejects(client.getTransactions("uid-raw", {}), apiError(0, "MALFORMED_RESPONSE"), body);
  }
  api.state.rawPath.set("/accounts/uid-raw", { status: 200, body: '{"transactions": []}' });
  assert.deepEqual(await client.getTransactions("uid-raw", {}), { transactions: [], continuation_key: null });
  for (const body of [
    "{}",
    '{"balances": null}',
    '{"balances": [{"balance_type": "ITAV", "balance_amount": {}}]}',
    '{"balances": [{"balance_type": "ITAV", "balance_amount": {"currency": "EUR", "amount": 1}}]}',
  ]) {
    api.state.rawPath.set("/accounts/uid-raw", { status: 200, body });
    await assert.rejects(client.getBalances("uid-raw"), apiError(0, "MALFORMED_RESPONSE"), body);
  }
  api.state.rawPath.set("/aspsps", { status: 200, body: "{}" });
  await assert.rejects(client.listAspsps(), apiError(0, "MALFORMED_RESPONSE"));
  api.state.rawPath.delete("/aspsps");
  api.state.rawPath.set("/sessions/s-raw", { status: 200, body: "<html>upstream unavailable</html>" });
  await assert.rejects(client.deleteSession("s-raw"), apiError(0, "MALFORMED_RESPONSE"));
  api.state.rawPath.delete("/sessions/s-raw");
  api.state.rawPath.set("/accounts/uid-raw", { status: 502, body: "<html>" });
  await assert.rejects(client.getTransactions("uid-raw", {}), apiError(502, undefined));
  api.state.rawPath.delete("/accounts/uid-raw");
});

test("a redirect is never followed, so the token never reaches another host", async () => {
  api.state.rawPath.set("/aspsps", { status: 302, body: "", headers: { location: `${api.url}/elsewhere` } });
  const count = api.requests.length;
  await assert.rejects(client.listAspsps(), apiError(0, "NETWORK_ERROR"));
  api.state.rawPath.delete("/aspsps");
  assert.equal(api.requests.length, count + 1);
});

test("a connection failure is an ApiError with status 0", async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
  const down = new EnableBankingClient({ appId: APP_ID, privateKeyPem: keys.privateKeyPem, baseUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(down.listAspsps(), apiError(0, "NETWORK_ERROR"));
});

test("deleteSession and getBalances hit the AIS endpoints", async () => {
  await client.deleteSession("sess/1");
  assert.equal(api.state.deletedSessions.at(-1), "sess/1");
  assert.equal(api.requests.at(-1)?.path, "/sessions/sess%2F1");
  api.state.balances.set("uid-1", [{ balance_type: "ITAV", balance_amount: { currency: "EUR", amount: "1.00" } }]);
  assert.equal((await client.getBalances("uid-1")).length, 1);
});

test("the API URL is production or a loopback test server, nothing else", () => {
  const make = (baseUrl: string) => () => new EnableBankingClient({ appId: APP_ID, privateKeyPem: keys.privateKeyPem, baseUrl });
  assert.equal(DEFAULT_API_URL, "https://api.enablebanking.com");
  for (const bad of [
    "http://api.enablebanking.com",
    "https://api.enablebanking.com.evil.example",
    "https://api.example.com",
    "http://localhost.example.com",
    "ftp://localhost",
    "not a url",
    "https://u:p@api.enablebanking.com",
  ]) {
    assert.throws(make(bad), /API URL/, bad);
  }
  for (const good of ["https://api.enablebanking.com", "http://localhost:1", "http://127.0.0.1:1", "http://[::1]:1"]) {
    assert.doesNotThrow(make(good), good);
  }
});

test("src/ never references a payment endpoint", () => {
  const src = fileURLToPath(new URL("../../src", import.meta.url));
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes("enable-banking.ts"));
  for (const file of files) assert.doesNotMatch(readFileSync(join(src, file), "utf8"), /payment/i, file);
});
