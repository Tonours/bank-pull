import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { consentValidUntil, main, parseCallback } from "../src/cli.js";
import { openReadWrite } from "../src/db.js";
import { ExitCode } from "../src/errors.js";
import { BANK, install, session, syntheticIban, tx } from "./support/fixtures.js";
import { APP_ID, callback, harness, REDIRECT } from "./support/harness.js";
import { testKeyPair } from "./support/keys.js";

const keys = testKeyPair();

const authArgs = ["auth", "--bank", BANK.name, "--country", "FR"] as const;
const count = (h: { value: (sql: string) => unknown }, table: string): number => Number(h.value(`SELECT count(*) AS v FROM ${table}`));

test("AC-1/AC-3: auth stores the session and accounts, then backfills every page with strategy=longest", async () => {
  const h = await harness();
  const s = session("sess-1", 2);
  install(h.api, s, [[[tx(), tx()], [], [tx(), tx(), tx()]], [[tx()]]]);
  const run = await h.run([...authArgs, "--json"], { paste: (api) => callback(api) });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(count(h, "sessions"), 1);
  assert.equal(count(h, "accounts"), 2);
  assert.equal(count(h, "session_accounts"), 2);
  assert.equal(h.value("SELECT iban AS v FROM accounts WHERE identification_hash = 'hash-1'"), syntheticIban(1));
  const first = Number(h.value("SELECT id AS v FROM accounts WHERE identification_hash = 'hash-0'"));
  assert.equal(Number(h.value("SELECT count(*) AS v FROM transactions WHERE account_id = ?", first)), 5);
  assert.equal(count(h, "transactions"), 6);
  const txRequests = h.api.requests.filter((r) => r.path === `/accounts/${s.uids[0]}/transactions`);
  assert.equal(txRequests.length, 3);
  for (const r of txRequests) assert.equal(r.query["strategy"], "longest");
  const out = JSON.parse(run.stdout) as { session_id: string; accounts: { received_book: number; inserted: number }[] };
  assert.equal(out.session_id, "sess-1");
  assert.deepEqual(out.accounts.map((a) => [a.received_book, a.inserted]), [[5, 5], [1, 1]]);
  assert.equal(Number(h.value("SELECT backfill_done AS v FROM accounts WHERE id = ?", first)), 1);
  assert.equal(h.value("SELECT covered_from AS v FROM accounts WHERE id = ?", first), "2026-11-01");
  assert.equal(count(h, "sync_lock"), 0);
  const authBody = h.api.requests.find((r) => r.path === "/auth")?.body as { psu_type: string; redirect_url: string; state: string };
  assert.equal(authBody.psu_type, "personal");
  assert.equal(authBody.redirect_url, REDIRECT);
  assert.match(authBody.state, /^[0-9a-f-]{36}$/);
});

for (const [name, paste, message] of [
  ["wrong state", (url: string) => url.replace(/state=[^&]+/, "state=other"), /state mismatch/],
  ["no state", (url: string) => url.replace(/state=[^&]+&/, ""), /state mismatch/],
  ["error parameter", () => `${REDIRECT}?error=access_denied&error_description=User%20cancelled`, /access_denied \(User cancelled\)/],
  ["missing code", (url: string) => url.replace(/&code=[^&]+/, ""), /no authorization code/],
  ["empty code", (url: string) => url.replace(/code=[^&]+/, "code="), /no authorization code/],
  ["other origin", (url: string) => url.replace("https://localhost", "https://evil.example"), /configured redirect URL/],
  ["other scheme", (url: string) => url.replace("https://", "http://"), /configured redirect URL/],
  ["other path", (url: string) => url.replace("/bank-pull/callback", "/other"), /configured redirect URL/],
  ["not a URL", () => "hello", /not a URL/],
] as const) {
  test(`AC-2: a pasted URL with ${name} is refused; no POST /sessions, no row`, async () => {
    const h = await harness();
    install(h.api, session("sess-x", 1), [[[tx()]]]);
    const run = await h.run(authArgs, { paste: (api) => paste(callback(api)) });
    assert.equal(run.code, ExitCode.failure);
    assert.match(run.stderr, message);
    assert.equal(h.api.requests.filter((r) => r.path === "/sessions").length, 0);
    assert.equal(count(h, "sessions"), 0);
    assert.equal(count(h, "accounts"), 0);
  });
}

test("parseCallback accepts the exact configured callback, trimmed", () => {
  assert.equal(parseCallback(`  ${REDIRECT}?state=s&code=c  `, REDIRECT, "s"), "c");
});

test("consent validity is the bank's maximum capped at 180 days", async () => {
  const h = await harness();
  install(h.api, session("s", 1), [[[]]]);
  const now = new Date("2026-11-15T10:00:00.000Z");
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api), now })).code, 0);
  const body = h.api.requests.find((r) => r.path === "/auth")?.body as { access: { valid_until: string } };
  assert.equal(body.access.valid_until, "2027-05-14T10:00:00.000Z");
  assert.equal(consentValidUntil(now, 10 * 86_400), "2026-11-25T10:00:00.000Z");
  assert.equal(consentValidUntil(now, 999 * 86_400), "2027-05-14T10:00:00.000Z");
  assert.equal(consentValidUntil(now, "junk"), "2027-05-14T10:00:00.000Z");
  assert.equal(consentValidUntil(now, 3600), "2026-11-15T11:00:00.000Z");
  assert.equal(consentValidUntil(now, 1.5 * 86_400), "2026-11-16T10:00:00.000Z");
});

test("backfill stores non-final rows, drops CNCL/RJCT, skips and counts undated booked rows", async () => {
  const h = await harness();
  const s = session("s", 1);
  const undated = tx({ entry_reference: null, booking_date: null, value_date: null });
  install(h.api, s, [[[tx({ status: "PDNG" }), tx({ status: "CNCL" }), tx({ status: "RJCT" }), undated, tx()]]]);
  const run = await h.run([...authArgs, "--json"], { paste: (api) => callback(api) });
  assert.equal(run.code, 0, run.stderr);
  const out = JSON.parse(run.stdout) as { accounts: { received_book: number; inserted: number; pending: number; skipped_undated: number }[] };
  assert.deepEqual(out.accounts[0], { ...out.accounts[0], received_book: 2, inserted: 1, pending: 1, skipped_undated: 1 });
  assert.deepEqual(
    (new DatabaseSync(h.paths.dbFile, { readOnly: true }).prepare("SELECT status FROM transactions ORDER BY status").all() as { status: string }[]).map(
      (r) => r.status,
    ),
    ["BOOK", "PDNG"],
  );
  assert.equal(Number(h.value("SELECT skipped_undated AS v FROM accounts")), 1);
});

test("dedup: identical rows split across pages stay two rows; same reference with another label is a third", async () => {
  const h = await harness();
  const s = session("s", 1);
  const same = tx({ entry_reference: null });
  install(h.api, s, [[[same], [{ ...same }, { ...same, remittance_information: ["OTHER LABEL"] }]]]);
  const run = await h.run(authArgs, { paste: (api) => callback(api) });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(count(h, "transactions"), 3);
  assert.equal(Number(h.value("SELECT count(DISTINCT dedup_key) AS v FROM transactions")), 3);
});

test("dedup across backfills: a re-fetched row is not doubled; same reference, date and amount with another label is kept", async () => {
  const h = await harness();
  const x = tx({ entry_reference: "SAME-REF", amount: "9.99" });
  const y = { ...x, remittance_information: ["ANOTHER LABEL"] };
  for (const [i, pages] of [[[x]], [[y]], [[x]]].entries()) {
    const s = session(`sess-${i}`, 1, `code-${i}`);
    install(h.api, s, [pages]);
    const run = await h.run(authArgs, { paste: (api) => callback(api, `code-${i}`) });
    assert.equal(run.code, 0, run.stderr);
  }
  assert.equal(count(h, "transactions"), 2);
});

for (const [name, patch, message] of [
  ["an empty identification_hash", { identification_hash: "" }, /empty uid or identification_hash/],
  ["an empty uid", { uid: "" }, /empty uid or identification_hash/],
  ["an impossible valid_until", { valid_until: "2026-02-30T12:00:00Z" }, /invalid access\.valid_until/],
  ["a non-date valid_until", { valid_until: "not-a-date" }, /invalid access\.valid_until/],
] as const) {
  test(`a session with ${name} is refused before anything is stored or fetched`, async () => {
    const h = await harness();
    const s = session("s", 1);
    const { valid_until, ...accountPatch } = { valid_until: undefined as string | undefined, ...patch };
    const accounts = s.session.accounts.map((a) => ({ ...a, ...accountPatch }));
    const access = { valid_until: valid_until ?? s.session.access.valid_until };
    install(h.api, { ...s, session: { ...s.session, accounts, access } }, [[[tx()]]]);
    const run = await h.run(authArgs, { paste: (api) => callback(api) });
    assert.equal(run.code, ExitCode.failure);
    assert.match(run.stderr, message);
    assert.equal(count(h, "sessions"), 0);
    assert.equal(count(h, "accounts"), 0);
    assert.equal(h.api.requests.filter((r) => r.path.endsWith("/transactions")).length, 0);
  });
}

test("a repeated continuation_key aborts before the replayed page is stored", async () => {
  const h = await harness();
  const s = session("s", 1);
  install(h.api, s, [[[]]]);
  const body = JSON.stringify({ transactions: [tx({ amount: "100.00" })], continuation_key: "same-key" });
  h.api.state.rawPath.set(`/accounts/${s.uids[0] ?? ""}/transactions`, { status: 200, body });
  const run = await h.run(authArgs, { paste: (api) => callback(api) });
  assert.equal(run.code, ExitCode.failure);
  assert.match(run.stderr, /repeated a continuation_key/);
  assert.equal(count(h, "transactions"), 1);
});

test("an unknown currency code fails the backfill", async () => {
  const h = await harness();
  install(h.api, session("s", 1), [[[tx({ transaction_amount: { currency: "QQQ", amount: "1.23" } })]]]);
  const run = await h.run(authArgs, { paste: (api) => callback(api) });
  assert.equal(run.code, ExitCode.failure);
  assert.match(run.stderr, /invalid currency code/);
  assert.equal(count(h, "transactions"), 0);
});

test("a valid epoch date is accepted", async () => {
  const h = await harness();
  install(h.api, session("s", 1), [[[tx({ booking_date: "1970-01-01", value_date: null })]]]);
  const run = await h.run(authArgs, { paste: (api) => callback(api) });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(h.value("SELECT covered_from AS v FROM accounts"), "1970-01-01");
});

test("an account with a non-string field is refused, not stored as NULL", async () => {
  const h = await harness();
  const s = session("s", 1);
  const bad = { ...s, session: { ...s.session, accounts: [{ ...s.session.accounts[0], name: 42 as unknown as string, uid: s.uids[0] ?? "", identification_hash: "hash-0" }] } };
  install(h.api, bad, [[[tx()]]]);
  const run = await h.run(authArgs, { paste: (api) => callback(api) });
  assert.equal(run.code, ExitCode.failure);
  assert.match(run.stderr, /non-string name/);
  assert.equal(h.api.requests.filter((r) => r.path.endsWith("/transactions")).length, 0);
});

test("amounts are stored as signed minor units from the indicator", async () => {
  const h = await harness();
  install(h.api, session("s", 1), [[[tx({ amount: "12.30" }), tx({ amount: "0.29", credit_debit_indicator: "CRDT", debtor: { name: "Payer" } })]]]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api) })).code, 0);
  assert.equal(h.value("SELECT group_concat(amount_minor, ',') AS v FROM (SELECT amount_minor FROM transactions ORDER BY id)"), "-1230,29");
  assert.equal(h.value("SELECT counterparty AS v FROM transactions WHERE amount_minor = 29"), "Payer");
});

for (const [name, bad, message] of [
  ["a float amount", { amount: "1.2345" }, /more decimals/],
  ["an unknown indicator", { credit_debit_indicator: "XXXX" }, /credit_debit_indicator/],
  ["an impossible date", { booking_date: "2026-02-30" }, /invalid booking_date/],
  ["a non-ISO date", { booking_date: "01/11/2026" }, /invalid booking_date/],
  ["non-string remittance", { remittance_information: [42] as unknown as string[] }, /remittance_information/],
  ["a scalar creditor", { creditor: "Shop A" as unknown as { name: string } }, /creditor is not an object/],
  ["a numeric creditor name", { creditor: { name: 7 as unknown as string } }, /creditor\.name/],
] as const) {
  test(`untrusted API data: ${name} fails the backfill, keeps the session and earlier pages`, async () => {
    const h = await harness();
    install(h.api, session("s", 1), [[[tx()], [tx(bad)]]]);
    const run = await h.run(authArgs, { paste: (api) => callback(api) });
    assert.equal(run.code, ExitCode.failure);
    assert.match(run.stderr, message);
    assert.equal(count(h, "sessions"), 1);
    assert.equal(count(h, "transactions"), 1);
    assert.equal(Number(h.value("SELECT backfill_done AS v FROM accounts")), 0);
    assert.equal(count(h, "sync_lock"), 0);
  });
}

test("the session and accounts are committed before the first transaction request", async () => {
  const h = await harness();
  const s = session("s", 1);
  install(h.api, s, [[[tx()]]]);
  h.api.state.failTransactions.set(s.uids[0] ?? "", { atRequest: 1, error: { status: 500, error: "ASPSP_ERROR" } });
  const run = await h.run(authArgs, { paste: (api) => callback(api) });
  assert.equal(run.code, ExitCode.failure);
  assert.equal(count(h, "sessions"), 1);
  assert.equal(count(h, "accounts"), 1);
  assert.equal(Number(h.value("SELECT backfill_started AS v FROM accounts")), 1);
  assert.equal(Number(h.value("SELECT backfill_done AS v FROM accounts")), 0);
});

test("an interrupted backfill keeps its rows, then re-auth records the interruption (append-only)", async () => {
  const h = await harness();
  const first = session("sess-a", 1, "code-a");
  install(h.api, first, [[[tx(), tx()], [tx()]]]);
  h.api.state.failTransactions.set(first.uids[0] ?? "", { atRequest: 2, error: { status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" } });
  const run = await h.run(authArgs, { paste: (api) => callback(api, "code-a") });
  assert.equal(run.code, ExitCode.rateLimit, run.stderr);
  assert.equal(count(h, "transactions"), 2);
  assert.equal(count(h, "sync_lock"), 0);
  const second = session("sess-b", 1, "code-b");
  install(h.api, second, [[[tx()]]]);
  const again = await h.run(authArgs, { paste: (api) => callback(api, "code-b") });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /history gap recorded \(interrupted-backfill\)/);
  const third = session("sess-c", 1, "code-c");
  install(h.api, third, [[[]]]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api, "code-c") })).code, 0);
  const gaps = JSON.parse(String(h.value("SELECT history_gaps AS v FROM accounts"))) as { kind: string }[];
  assert.deepEqual(gaps.map((g) => g.kind), ["interrupted-backfill"]);
  assert.equal(count(h, "accounts"), 1);
  assert.equal(count(h, "sessions"), 3);
});

test("expired consent during backfill exits 3 with a re-auth hint", async () => {
  const h = await harness();
  const s = session("s", 1);
  install(h.api, s, [[[tx()]]]);
  h.api.state.failTransactions.set(s.uids[0] ?? "", { atRequest: 1, error: { status: 401, error: "EXPIRED_SESSION" } });
  const run = await h.run(authArgs, { paste: (api) => callback(api) });
  assert.equal(run.code, ExitCode.consent);
  assert.match(run.stderr, /run "bank-pull auth" again/);
});

test("SIGKILL right after the session commit: the next auth records the interrupted backfill and reclaims the lock", async () => {
  const h = await harness();
  const s = session("sess-k", 1, "code-k");
  install(h.api, s, [[[tx()]]]);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, ...authArgs], { env: { PATH: process.env["PATH"], ...h.env }, stdio: ["pipe", "ignore", "pipe"] });
  let childErr = "";
  child.stderr.on("data", (d: Buffer) => (childErr += d.toString()));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const wait = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 1000 && !done(); i++) await sleep(10);
    assert.ok(done(), `child did not reach the expected step: ${childErr} ${JSON.stringify(h.api.requests.map((r) => r.path))} exit=${String(child.exitCode)}`);
  };
  await wait(() => childErr.includes("paste it here"));
  child.stdin.end(`${callback(h.api, "code-k")}\n`);
  await wait(() => h.api.requests.some((r) => r.path.endsWith("/transactions")));
  child.kill("SIGKILL");
  await exited;
  assert.equal(count(h, "sessions"), 1);
  assert.equal(count(h, "sync_lock"), 1);
  assert.equal(Number(h.value("SELECT backfill_done AS v FROM accounts")), 0);
  const next = session("sess-l", 1, "code-l");
  install(h.api, next, [[[tx()]]]);
  const run = await h.run(authArgs, { paste: (api) => callback(api, "code-l") });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /interrupted-backfill/);
  assert.equal(count(h, "sync_lock"), 0);
});

test("a live lock holder makes auth exit 5 before the code is exchanged", async () => {
  const h = await harness();
  install(h.api, session("s", 1), [[[tx()]]]);
  const db = openReadWrite(h.paths);
  db.prepare("INSERT INTO sync_lock (id, pid, token, started_at) VALUES (1, ?, 'other', '2000-01-01T00:00:00Z')").run(process.pid);
  db.close();
  const run = await h.run(authArgs, { paste: (api) => callback(api) });
  assert.equal(run.code, ExitCode.locked);
  assert.equal(h.api.requests.filter((r) => r.path === "/sessions").length, 0);
  assert.equal(h.value("SELECT token AS v FROM sync_lock"), "other");
});

test("AC-7: a 0644 key stops auth before any request, naming the fix", async () => {
  const h = await harness();
  chmodSync(h.keyPath, 0o644);
  const run = await h.run(authArgs, { paste: () => "unused" });
  assert.equal(run.code, ExitCode.permissions);
  assert.ok(run.stderr.includes(`chmod 600 ${h.keyPath}`), run.stderr);
  assert.equal(h.api.requests.length, 0);
  assert.equal(existsSync(h.paths.dbFile), false);
});

test("AC-7: a loose DB stops revoke before any request", async () => {
  const h = await harness();
  install(h.api, session("s", 1), [[[tx()]]]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api) })).code, 0);
  const before = h.api.requests.length;
  chmodSync(h.paths.dbFile, 0o644);
  const run = await h.run(["revoke"]);
  assert.equal(run.code, ExitCode.permissions);
  assert.ok(run.stderr.includes(`chmod 600 ${h.paths.dbFile}`), run.stderr);
  assert.equal(h.api.requests.length, before);
});

test("a non-loopback API URL override is refused before any request", async () => {
  const h = await harness();
  let stderr = "";
  const code = await main(["banks", "--country", "FR"], {
    env: { ...h.env, BANK_PULL_API_URL: "https://example.com" },
    stdout: () => undefined,
    stderr: (t) => (stderr += t),
    readLine: async () => "",
  });
  assert.equal(code, ExitCode.failure);
  assert.match(stderr, /must be https:\/\/api\.enablebanking\.com or a localhost/);
  assert.equal(h.api.requests.length, 0);
});

test("auth accepts the bank name exactly as `banks` prints it, beta marker included", async () => {
  const h = await harness();
  install(h.api, session("s", 1), [[[tx()]]]);
  const run = await h.run(["auth", "--bank", `${BANK.name} (beta)`, "--country", "FR"], { paste: (api) => callback(api) });
  assert.equal(run.code, 0, run.stderr);
});

test("an unknown bank name is refused with suggestions, before POST /auth", async () => {
  const h = await harness();
  const run = await h.run(["auth", "--bank", "synthetic", "--country", "FR"], { paste: () => "unused" });
  assert.equal(run.code, ExitCode.failure);
  assert.match(run.stderr, /did you mean: Synthetic Bank/);
  assert.equal(h.api.requests.filter((r) => r.path === "/auth").length, 0);
});

test("revoke closes the consent at the bank and forgets it, keeping transactions", async () => {
  const h = await harness();
  install(h.api, session("sess-r", 1), [[[tx(), tx()]]]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api) })).code, 0);
  const run = await h.run(["revoke"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(h.api.state.deletedSessions, ["sess-r"]);
  assert.equal(count(h, "sessions"), 0);
  assert.equal(count(h, "session_accounts"), 0);
  assert.equal(count(h, "transactions"), 2);
  assert.equal((await h.run(["revoke"])).code, ExitCode.failure);
});

test("revoke waits for the sync lock: a live holder makes it exit 5 without DELETE", async () => {
  const h = await harness();
  install(h.api, session("sess-l", 1), [[[tx()]]]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api) })).code, 0);
  const db = openReadWrite(h.paths);
  db.prepare("INSERT INTO sync_lock (id, pid, token, started_at) VALUES (1, ?, 'other', '2000-01-01T00:00:00Z')").run(process.pid);
  db.close();
  const run = await h.run(["revoke"]);
  assert.equal(run.code, ExitCode.locked);
  assert.deepEqual(h.api.state.deletedSessions, []);
  assert.equal(count(h, "sessions"), 1);
  assert.equal(h.value("SELECT token AS v FROM sync_lock"), "other");
});

test("revoke of a consent the bank already expired still forgets it; other errors keep it", async () => {
  const h = await harness();
  install(h.api, session("sess-e", 1), [[[tx()]]]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api) })).code, 0);
  h.api.state.failPath.set("/sessions/", { status: 500, error: "INTERNAL" });
  assert.equal((await h.run(["revoke", "--session", "sess-e"])).code, ExitCode.failure);
  assert.equal(count(h, "sessions"), 1);
  h.api.state.failPath.set("/sessions/", { status: 401, error: "EXPIRED_SESSION" });
  const run = await h.run(["revoke", "--session", "sess-e"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /already expired/);
  assert.equal(count(h, "sessions"), 0);
});

test("init writes a 0600 config, validates the key, and refuses to overwrite without --force", async () => {
  const h = await harness();
  const config = h.paths.configFile;
  const args = ["init", "--app-id", APP_ID, "--key", h.keyPath, "--redirect-url", REDIRECT];
  assert.equal((await h.run(args)).code, ExitCode.failure);
  chmodSync(config, 0o644);
  const forced = await h.run([...args, "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(statSync(h.paths.dbFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { appId: APP_ID, keyPath: h.keyPath, redirectUrl: REDIRECT });
  assert.equal((await h.run(["init", "--app-id", APP_ID, "--key", h.keyPath, "--redirect-url", "http://x"])).code, ExitCode.usage);
  chmodSync(h.keyPath, 0o640);
  assert.equal((await h.run([...args, "--force"])).code, ExitCode.permissions);
  chmodSync(h.keyPath, 0o600);
  writeFileSync(config, keys.privateKeyPem, { mode: 0o600 });
  const same = await h.run(["init", "--app-id", APP_ID, "--key", config, "--redirect-url", REDIRECT, "--force"]);
  assert.equal(same.code, ExitCode.usage);
  assert.equal(readFileSync(config, "utf8"), keys.privateKeyPem);
  rmSync(config);
  assert.equal((await h.run(args)).code, 0);
  const notKey = await h.run(["init", "--app-id", APP_ID, "--key", h.paths.dbFile, "--redirect-url", REDIRECT, "--force"]);
  assert.equal(notKey.code, ExitCode.failure);
  assert.match(notKey.stderr, /not a valid PEM private key/);
});

test("init refuses a --key that is the config file reached through a symlinked config dir", async () => {
  const h = await harness();
  const real = h.paths.configDir;
  const alias = `${real}-alias`;
  symlinkSync(real, alias);
  writeFileSync(h.paths.configFile, keys.privateKeyPem, { mode: 0o600 });
  const run = await h.run(["init", "--app-id", APP_ID, "--key", `${alias}/config.json`, "--redirect-url", REDIRECT, "--force"]);
  assert.equal(run.code, ExitCode.usage, run.stderr);
  assert.equal(readFileSync(h.paths.configFile, "utf8"), keys.privateKeyPem);
});

test("a transaction with a null or missing status fails the backfill", async () => {
  for (const status of [null, undefined]) {
    const h = await harness();
    install(h.api, session("s", 1), [[[tx({ status: status as unknown as string })]]]);
    const run = await h.run(authArgs, { paste: (api) => callback(api) });
    assert.equal(run.code, ExitCode.failure);
    assert.match(run.stderr, /status is not a non-empty string/);
    assert.equal(count(h, "transactions"), 0);
  }
});

test("banks lists the country's banks", async () => {
  const h = await harness();
  const run = await h.run(["banks", "--country", "fr"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "Synthetic Bank (beta)\n");
  assert.equal(h.api.requests[0]?.query["country"], "FR");
});

test("usage errors exit 2", async () => {
  const h = await harness();
  assert.equal((await h.run(["auth", "--country", "FR"])).code, ExitCode.usage);
  assert.equal((await h.run(["banks", "--country", "France"])).code, ExitCode.usage);
  assert.equal((await h.run(["banks", "--nope"])).code, ExitCode.usage);
  assert.equal((await h.run(["nope"])).code, ExitCode.usage);
});
