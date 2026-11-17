import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { formatMinor } from "../src/amount.js";
import { ExitCode } from "../src/errors.js";
import { addDays, isoDate } from "../src/sync.js";
import type { Transaction } from "../src/enable-banking.js";
import { BANK, install, session, tx } from "./support/fixtures.js";
import { callback, harness, type Harness } from "./support/harness.js";

const NOW = new Date("2026-11-15T09:00:00.000Z");
const TODAY = "2026-11-15";
const authArgs = ["auth", "--bank", BANK.name, "--country", "FR"] as const;

async function authed(pages: Transaction[][][], now = NOW): Promise<{ h: Harness; uid: string }> {
  const h = await harness();
  const s = session("sess-1", pages.length);
  install(h.api, s, pages);
  const run = await h.run(authArgs, { paste: (api) => callback(api), now });
  assert.equal(run.code, 0, run.stderr);
  return { h, uid: s.uids[0] ?? "" };
}

function all<T>(h: Harness, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(h.paths.dbFile, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function exec(h: Harness, sql: string, ...params: (string | number)[]): void {
  const db = new DatabaseSync(h.paths.dbFile);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

const n = (h: Harness, sql: string, ...params: (string | number)[]): number => Number(h.value(sql, ...params));
const bookedKeys = (h: Harness): string[] =>
  all<{ dedup_key: string }>(h, "SELECT dedup_key FROM transactions WHERE status = 'BOOK' ORDER BY dedup_key").map((r) => r.dedup_key);
/** Transactions request params, minus continuation_key (the fake already checks that pages repeat the params). */
const txQueries = (h: Harness, uid: string) =>
  h.api.requests
    .filter((r) => r.path === `/accounts/${uid}/transactions`)
    .map(({ query: { continuation_key: _key, ...rest } }) => rest);
const sync = (h: Harness, now = NOW, json = false) => h.run(json ? ["sync", "--json"] : ["sync"], { now });
const gaps = (h: Harness) => JSON.parse(String(h.value("SELECT history_gaps AS v FROM accounts"))) as { kind: string; from?: string; to?: string }[];

test("AC-4: sync is idempotent, keeps category and note, and keys do not depend on the window or page split", async () => {
  const same = { entry_reference: null, amount: "3.00", remittance_information: ["COFFEE"], creditor: { name: "Cafe" }, booking_date: "2026-11-12" };
  const a = tx({ booking_date: "2026-11-05" });
  const b = tx(same);
  const c = tx(same);
  const d = tx({ booking_date: "2026-11-14" });
  const { h, uid } = await authed([[[a, b], [c, d]]]);
  h.api.state.filterDates = true;
  exec(h, "UPDATE transactions SET category = 'food', note = 'synthetic note' WHERE entry_reference = ?", a.entry_reference ?? "");
  const before = bookedKeys(h);
  assert.equal(before.length, 4);
  h.api.state.pages.set(uid, [[a], [b], [c, d]]);
  assert.equal((await sync(h, new Date("2026-11-17T09:00:00.000Z"))).code, 0);
  assert.deepEqual(txQueries(h, uid).at(-1), { date_from: "2026-11-05", date_to: "2026-11-17" });
  h.api.state.pages.set(uid, [[d, c, b, a]]);
  const later = await sync(h, new Date("2026-11-20T09:00:00.000Z"), true);
  assert.equal(later.code, 0, later.stderr);
  assert.deepEqual(txQueries(h, uid).at(-1), { date_from: "2026-11-07", date_to: "2026-11-20" });
  assert.deepEqual(bookedKeys(h), before);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions"), 4);
  const out = JSON.parse(later.stdout) as { accounts: { received_book: number; inserted: number }[] };
  assert.deepEqual([out.accounts[0]?.received_book, out.accounts[0]?.inserted], [3, 0]);
  assert.deepEqual(all(h, "SELECT category, note FROM transactions WHERE entry_reference = ?", a.entry_reference ?? "").map((r) => ({ ...(r as object) })), [
    { category: "food", note: "synthetic note" },
  ]);
});

test("AC-4: identical rows split across pages, then refetched in one page, stay two rows", async () => {
  const same = tx({ entry_reference: null, amount: "3.00", remittance_information: ["COFFEE"], creditor: { name: "Cafe" } });
  const { h, uid } = await authed([[[same], [{ ...same }]]]);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions"), 2);
  h.api.state.pages.set(uid, [[{ ...same }, { ...same }, tx()]]);
  assert.equal((await sync(h)).code, 0);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions"), 3);
});

test("normal window starts 10 days before the cursor, without strategy", async () => {
  const { h, uid } = await authed([[[tx()]]], new Date("2026-11-01T09:00:00.000Z"));
  assert.equal((await sync(h)).code, 0);
  assert.deepEqual(txQueries(h, uid).at(-1), { date_from: "2026-10-22", date_to: TODAY });
  assert.equal(h.value("SELECT synced_through AS v FROM accounts"), TODAY);
});

test("AC-5: a pending row becomes booked without duplication; a vanished pending row goes away", async () => {
  const pending = tx({ status: "PDNG", entry_reference: null, booking_date: null, value_date: "2026-11-14" });
  const ghost = tx({ status: "PDNG", entry_reference: null, booking_date: null, value_date: "2026-11-13" });
  const { h, uid } = await authed([[[tx(), pending, ghost]]]);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 2);
  h.api.state.pages.set(uid, [[{ ...pending, status: "BOOK", booking_date: "2026-11-15", entry_reference: "NEW" }]]);
  assert.equal((await sync(h)).code, 0);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status != 'BOOK'"), 0);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE entry_reference = 'NEW' AND status = 'BOOK'"), 1);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions"), 2);
});

test("AC-5: an empty result removes the account's pending rows; cancelled rows are never stored", async () => {
  const { h, uid } = await authed([[[tx({ status: "PDNG" }), tx({ status: "HOLD", booking_date: null, value_date: null })]]]);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions"), 2);
  h.api.state.pages.set(uid, [[tx({ status: "CNCL" }), tx({ status: "RJCT" })]]);
  assert.equal((await sync(h)).code, 0);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions"), 0);
});

test("AC-5: the window reaches back to a pending row older than the overlap; kept while served, removed once gone", async () => {
  const old = tx({ status: "PDNG", entry_reference: null, booking_date: null, value_date: addDays(TODAY, -20) });
  const { h, uid } = await authed([[[old]]]);
  h.api.state.filterDates = true;
  assert.equal((await sync(h)).code, 0);
  assert.equal(txQueries(h, uid).at(-1)?.["date_from"], addDays(TODAY, -20));
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 1);
  h.api.state.pages.set(uid, [[]]);
  assert.equal((await sync(h)).code, 0);
  assert.equal(txQueries(h, uid).at(-1)?.["date_from"], addDays(TODAY, -20));
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 0);
});

test("AC-5: the pending reach is capped at 90 days, with a warning", async () => {
  const ancient = tx({ status: "PDNG", entry_reference: null, booking_date: null, value_date: addDays(TODAY, -120) });
  const { h, uid } = await authed([[[ancient]]]);
  h.api.state.filterDates = true;
  const run = await sync(h, NOW, true);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(txQueries(h, uid).at(-1)?.["date_from"], addDays(TODAY, -90));
  assert.match(run.stdout, /outside the sync window/);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 0);
});

test("AC-5/AC-6: a failure on page 2 keeps page 1 booked rows, the pending snapshot, balances and the cursor", async () => {
  const pending = tx({ status: "PDNG" });
  const h = await harness();
  const s = session("sess-1", 1);
  const uid = s.uids[0] ?? "";
  install(h.api, s, [[[pending]]]);
  h.api.state.balances.set(uid, [{ balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "10.00" } }]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api), now: new Date("2026-11-10T09:00:00.000Z") })).code, 0);
  h.api.state.pages.set(uid, [[tx()], [tx()]]);
  h.api.state.balances.set(uid, []);
  h.api.state.failTransactions.set(uid, { atRequest: 3, error: { status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" } });
  const run = await sync(h);
  assert.equal(run.code, ExitCode.rateLimit, run.stderr);
  assert.match(run.stderr, /6 hours/);
  assert.equal(txQueries(h, uid).length, 3);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 1);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'BOOK'"), 1);
  assert.equal(n(h, "SELECT count(*) AS v FROM balances"), 1);
  assert.equal(h.value("SELECT synced_through AS v FROM accounts"), "2026-11-10");
  assert.equal(n(h, "SELECT count(*) AS v FROM sync_lock"), 0);
});

for (const code of ["EXPIRED_SESSION", "CLOSED_SESSION"]) {
  test(`AC-6: ${code} exits 3 with a re-auth hint; cursor and pending snapshot unchanged`, async () => {
    const { h, uid } = await authed([[[tx(), tx({ status: "PDNG" })]]], new Date("2026-11-10T09:00:00.000Z"));
    h.api.state.failTransactions.set(uid, { atRequest: 2, error: { status: 401, error: code } });
    const run = await sync(h);
    assert.equal(run.code, ExitCode.consent);
    assert.match(run.stderr, /run "bank-pull auth" again/);
    assert.equal(h.value("SELECT synced_through AS v FROM accounts"), "2026-11-10");
    assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 1);
  });
}

test("AC-6: a bare 429 exits 4 with exactly one request, no retry", async () => {
  const { h, uid } = await authed([[[tx()]]]);
  h.api.state.failTransactions.set(uid, { atRequest: 2, error: { status: 429, error: "TOO_MANY" } });
  const before = h.api.requests.length;
  assert.equal((await sync(h)).code, ExitCode.rateLimit);
  assert.equal(h.api.requests.length - before, 1);
});

test("an expired stored consent exits 3 without calling the bank", async () => {
  const { h } = await authed([[[tx()]]]);
  exec(h, "UPDATE sessions SET valid_until = '2026-11-15T08:59:59.000Z'");
  const before = h.api.requests.length;
  const run = await sync(h);
  assert.equal(run.code, ExitCode.consent);
  assert.match(run.stderr, /bank-pull auth/);
  assert.equal(h.api.requests.length, before);
});

test("sync without any stored consent fails before any request", async () => {
  const { h } = await authed([[[tx()]]]);
  assert.equal((await h.run(["revoke"])).code, 0);
  const before = h.api.requests.length;
  const run = await sync(h);
  assert.equal(run.code, ExitCode.failure);
  assert.match(run.stderr, /no stored consent/);
  assert.equal(h.api.requests.length, before);
});

test("long downtime: strategy=longest from synced_through - 10, one retry without date_from on WRONG_TRANSACTIONS_PERIOD, gap recorded", async () => {
  const { h, uid } = await authed([[[tx({ booking_date: "2026-07-10" })]]], new Date("2026-07-18T09:00:00.000Z"));
  h.api.state.oldestServed = "2026-08-17";
  h.api.state.pages.set(uid, [[tx({ booking_date: "2026-07-01" }), tx({ booking_date: "2026-09-01" })], [tx({ booking_date: "2026-10-01" })]]);
  const run = await sync(h, NOW, true);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(txQueries(h, uid).slice(1), [
    { date_from: "2026-07-08", date_to: TODAY, strategy: "longest" },
    { strategy: "longest" },
    { strategy: "longest" },
  ]);
  assert.deepEqual(gaps(h).map((g) => [g.kind, g.from, g.to]), [["unserved-window", "2026-07-18", "2026-09-01"]]);
  assert.equal(h.value("SELECT synced_through AS v FROM accounts"), TODAY);
  assert.match(run.stdout, /WRONG_TRANSACTIONS_PERIOD/);
  const status = await h.run(["status"], { now: NOW });
  assert.match(status.stdout, /history gap: booked transactions between 2026-07-18 and 2026-09-01 may be missing/);
});

test("long downtime served in full still records a gap and uses strategy=longest", async () => {
  const { h, uid } = await authed([[[tx({ booking_date: "2026-07-10" })]]], new Date("2026-07-18T09:00:00.000Z"));
  h.api.state.pages.set(uid, [[tx({ booking_date: "2026-07-20" })]]);
  assert.equal((await sync(h)).code, 0);
  assert.deepEqual(txQueries(h, uid).at(-1), { date_from: "2026-07-08", date_to: TODAY, strategy: "longest" });
  assert.deepEqual(gaps(h).map((g) => [g.from, g.to]), [["2026-07-18", "2026-07-20"]]);
});

for (const [name, page] of [
  ["an empty", []],
  ["a pending-only", [tx({ status: "PDNG" })]],
] as const) {
  test(`long downtime with ${name} response records a gap up to today`, async () => {
    const { h, uid } = await authed([[[tx()]]], new Date("2026-07-18T09:00:00.000Z"));
    h.api.state.pages.set(uid, [[...page]]);
    assert.equal((await sync(h)).code, 0);
    assert.deepEqual(gaps(h).map((g) => [g.from, g.to]), [["2026-07-18", TODAY]]);
  });
}

test("WRONG_TRANSACTIONS_PERIOD after a short downtime: exactly one retry, then the error stands", async () => {
  const { h, uid } = await authed([[[tx()]]], new Date("2026-10-15T09:00:00.000Z"));
  h.api.state.failTransactions.set(uid, { atRequest: 2, error: { status: 422, error: "WRONG_TRANSACTIONS_PERIOD" } });
  assert.equal((await sync(h)).code, 0);
  assert.deepEqual(txQueries(h, uid).slice(1), [{ date_from: "2026-10-05", date_to: TODAY }, { strategy: "longest" }]);
  assert.deepEqual(gaps(h).map((g) => [g.from, g.to]), [["2026-10-15", "2026-11-01"]]);
  h.api.state.failPath.set(`/accounts/${uid}/transactions`, { status: 422, error: "WRONG_TRANSACTIONS_PERIOD" });
  const before = txQueries(h, uid).length;
  const run = await sync(h, new Date("2026-11-20T09:00:00.000Z"));
  assert.equal(run.code, ExitCode.failure);
  assert.match(run.stderr, /WRONG_TRANSACTIONS_PERIOD/);
  assert.equal(txQueries(h, uid).length - before, 2);
  assert.equal(h.value("SELECT synced_through AS v FROM accounts"), TODAY);
});

test("balances are replaced per account on each complete fetch, keyed by type and currency", async () => {
  const h = await harness();
  const s = session("sess-1", 1);
  install(h.api, s, [[[tx()]]]);
  const uid = s.uids[0] ?? "";
  h.api.state.balances.set(uid, [
    { balance_type: "ITAV", balance_amount: { currency: "EUR", amount: "100.00" } },
    { balance_type: "ITAV", balance_amount: { currency: "USD", amount: "200.00" } },
    { balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "-5.10" }, reference_date: "2026-11-14" },
  ]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api), now: NOW })).code, 0);
  assert.equal(n(h, "SELECT count(*) AS v FROM balances"), 3);
  assert.equal(n(h, "SELECT amount_minor AS v FROM balances WHERE balance_type = 'CLBD'"), -510);
  assert.equal(h.value("SELECT reference_date AS v FROM balances WHERE balance_type = 'CLBD'"), "2026-11-14");
  h.api.state.balances.set(uid, [{ balance_type: "ITAV", balance_amount: { currency: "EUR", amount: "90.00" } }]);
  assert.equal((await sync(h)).code, 0);
  assert.equal(n(h, "SELECT count(*) AS v FROM balances"), 1);
  assert.equal(n(h, "SELECT amount_minor AS v FROM balances"), 9000);
});

for (const [name, balance, message] of [
  ["a float amount", { balance_type: "ITAV", balance_amount: { currency: "EUR", amount: "1.234" } }, /balance_amount: .*more decimals/],
  ["an unknown currency", { balance_type: "ITAV", balance_amount: { currency: "QQQ", amount: "1.00" } }, /invalid currency code/],
  ["an empty type", { balance_type: "", balance_amount: { currency: "EUR", amount: "1.00" } }, /empty balance_type/],
  ["an impossible reference_date", { balance_type: "ITAV", balance_amount: { currency: "EUR", amount: "1.00" }, reference_date: "2026-02-30" }, /invalid reference_date/],
  ["a numeric balance_type", { balance_type: 42 as unknown as string, balance_amount: { currency: "EUR", amount: "1.00" } }, /balances \(balance_type\)/],
  ["a numeric amount", { balance_type: "ITAV", balance_amount: { currency: "EUR", amount: 1 as unknown as string } }, /balances \(balance_amount\)/],
] as const) {
  test(`untrusted balance with ${name} fails the sync naming the field; transactions commit, previous balances kept`, async () => {
    const { h, uid } = await authed([[[tx()]]], new Date("2026-11-10T09:00:00.000Z"));
    exec(h, "INSERT INTO balances (account_id, balance_type, currency, amount_minor, fetched_at) VALUES (1, 'OLD', 'EUR', 7, 'x')");
    h.api.state.pages.set(uid, [[tx({ status: "PDNG" })]]);
    h.api.state.balances.set(uid, [balance]);
    const run = await sync(h);
    assert.equal(run.code, ExitCode.failure);
    assert.match(run.stderr, message);
    assert.equal(h.value("SELECT synced_through AS v FROM accounts"), TODAY);
    assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 1);
    assert.equal(h.value("SELECT group_concat(balance_type) AS v FROM balances"), "OLD");
    assert.equal(n(h, "SELECT count(*) AS v FROM sync_lock"), 0);
  });
}

test("a balances failure after a complete backfill warns, auth exits 0, and the next sync has no interrupted gap", async () => {
  const h = await harness();
  const s = session("sess-1", 1);
  const uid = s.uids[0] ?? "";
  install(h.api, s, [[[tx()]]]);
  h.api.state.failPath.set(`/accounts/${uid}/balances`, { status: 500, error: "ASPSP_ERROR" });
  const auth = await h.run(authArgs, { paste: (api) => callback(api), now: NOW });
  assert.equal(auth.code, 0, auth.stderr);
  assert.match(auth.stdout, /warning: balances not stored/);
  assert.equal(n(h, "SELECT backfill_done AS v FROM accounts"), 1);
  assert.equal(h.value("SELECT synced_through AS v FROM accounts"), TODAY);
  h.api.state.failPath.clear();
  h.api.state.balances.set(uid, [{ balance_type: "ITAV", balance_amount: { currency: "EUR", amount: "1.00" } }]);
  const run = await sync(h, NOW, true);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(gaps(h), []);
  assert.equal(n(h, "SELECT count(*) AS v FROM balances"), 1);
});

test("WRONG_TRANSACTIONS_PERIOD on a later page is not a refused window: no retry, cursor unchanged", async () => {
  const { h, uid } = await authed([[[tx()]]], new Date("2026-11-10T09:00:00.000Z"));
  h.api.state.pages.set(uid, [[tx()], [tx()]]);
  h.api.state.failTransactions.set(uid, { atRequest: 3, error: { status: 422, error: "WRONG_TRANSACTIONS_PERIOD" } });
  const run = await sync(h);
  assert.equal(run.code, ExitCode.failure);
  assert.equal(txQueries(h, uid).length, 3);
  assert.equal(h.value("SELECT synced_through AS v FROM accounts"), "2026-11-10");
  assert.deepEqual(gaps(h), []);
});

test("a recovery fetch that reaches back to the cursor records no gap", async () => {
  const { h, uid } = await authed([[[tx()]]], new Date("2026-10-15T09:00:00.000Z"));
  h.api.state.pages.set(uid, [[tx({ booking_date: "2026-10-01" }), tx({ booking_date: "2026-11-10" })]]);
  h.api.state.failTransactions.set(uid, { atRequest: 2, error: { status: 422, error: "WRONG_TRANSACTIONS_PERIOD" } });
  assert.equal((await sync(h)).code, 0);
  assert.equal(txQueries(h, uid).length, 3);
  assert.deepEqual(gaps(h), []);
});

test("sync takes the lock before reading consents: a live holder wins over an expired consent", async () => {
  const { h } = await authed([[[tx()]]]);
  exec(h, "UPDATE sessions SET valid_until = '2026-01-01T00:00:00.000Z'");
  exec(h, "INSERT INTO sync_lock (id, pid, token, started_at) VALUES (1, ?, 't', '2020-01-01T00:00:00Z')", process.pid);
  assert.equal((await sync(h)).code, ExitCode.locked);
  exec(h, "DELETE FROM sync_lock");
  assert.equal((await sync(h)).code, ExitCode.consent);
  assert.equal(n(h, "SELECT count(*) AS v FROM sync_lock"), 0);
});

test("bank-controlled text is printed without control characters", async () => {
  const { h, uid } = await authed([[[tx()]]]);
  h.api.state.pages.set(uid, [[tx({ remittance_information: ["\u001b[2K\rFAKE\u001b]52;c;aGk=\u0007\u202eDERC"], booking_date: "2026-11-14" })]]);
  const run = await sync(h);
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
  assert.match(run.stdout, /\?\[2K\?FAKE.*\?DERC/);
  h.api.state.aspsps = [{ name: "Evil\u001b]0;x\u0007Bank", country: "FR", psu_types: ["personal"] }];
  const banks = await h.run(["banks", "--country", "FR"]);
  assert.equal(banks.stdout, "Evil?]0;x?Bank\n");
});

test("a live lock holder makes sync exit 5 before any request; a dead one is reclaimed", async () => {
  const { h } = await authed([[[tx()]]]);
  exec(h, "INSERT INTO sync_lock (id, pid, token, started_at) VALUES (1, ?, 't', '2020-01-01T00:00:00Z')", process.pid);
  const before = h.api.requests.length;
  assert.equal((await sync(h)).code, ExitCode.locked);
  assert.equal(h.api.requests.length, before);
  exec(h, "UPDATE sync_lock SET pid = 2147483646");
  assert.equal((await sync(h)).code, 0);
  assert.equal(n(h, "SELECT count(*) AS v FROM sync_lock"), 0);
});

test("sync --json reports received_book, inserted rows and skipped_undated; text lists inserted rows", async () => {
  const { h, uid } = await authed([[[tx()]]]);
  const undated = tx({ entry_reference: null, booking_date: null, value_date: null, transaction_date: null });
  h.api.state.pages.set(uid, [[tx({ amount: "4.20", remittance_information: ["NEW SHOP"], booking_date: "2026-11-14" }), undated]]);
  const run = await sync(h, NOW, true);
  assert.equal(run.code, 0, run.stderr);
  const out = JSON.parse(run.stdout) as {
    accounts: { mode: string; received_book: number; inserted: number; skipped_undated: number; inserted_rows: { date: string; amount: string; amount_minor: number; label: string }[] }[];
  };
  const acc = out.accounts[0];
  assert.deepEqual([acc?.mode, acc?.received_book, acc?.inserted, acc?.skipped_undated], ["incremental", 2, 1, 1]);
  assert.deepEqual(acc?.inserted_rows.map((r) => [r.date, r.amount, r.amount_minor, r.label]), [["2026-11-14", "-4.20", -420, "NEW SHOP"]]);
  assert.equal(n(h, "SELECT skipped_undated AS v FROM accounts"), 1);
  h.api.state.pages.set(uid, [[tx({ amount: "1.05", remittance_information: ["TEXT SHOP"], booking_date: "2026-11-15" })]]);
  const text = await sync(h);
  assert.match(text.stdout, /\+ 2026-11-15 -1\.05 EUR TEXT SHOP/);
});

test("formatMinor round-trips minor units with the currency exponent", () => {
  assert.equal(formatMinor(-1230, "EUR"), "-12.30");
  assert.equal(formatMinor(5, "EUR"), "0.05");
  assert.equal(formatMinor(0, "EUR"), "0.00");
  assert.equal(formatMinor(5, "JPY"), "5");
  assert.equal(formatMinor(1234, "BHD"), "1.234");
});

test("sync resumes an unfinished backfill with strategy=longest and records the interruption", async () => {
  const h = await harness();
  const s = session("sess-1", 1);
  const uid = s.uids[0] ?? "";
  install(h.api, s, [[[tx()], [tx()]]]);
  h.api.state.failTransactions.set(uid, { atRequest: 2, error: { status: 500, error: "ASPSP_ERROR" } });
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api), now: NOW })).code, ExitCode.failure);
  assert.equal(n(h, "SELECT backfill_done AS v FROM accounts"), 0);
  const run = await sync(h, NOW, true);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(txQueries(h, uid).slice(2), [{ strategy: "longest" }, { strategy: "longest" }]);
  const out = JSON.parse(run.stdout) as { accounts: { mode: string; gaps_added: { kind: string }[] }[] };
  assert.equal(out.accounts[0]?.mode, "backfill");
  assert.deepEqual(out.accounts[0]?.gaps_added.map((g) => g.kind), ["interrupted-backfill"]);
  assert.equal(n(h, "SELECT backfill_done AS v FROM accounts"), 1);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions"), 2);
  assert.deepEqual(gaps(h).map((g) => g.kind), ["interrupted-backfill"]);
  assert.match((await h.run(["status"], { now: NOW })).stdout, /initial backfill was interrupted/);
});

test("two interrupted backfills (auth, then a failed sync) record two gaps but warn once", async () => {
  const h = await harness();
  const s = session("sess-1", 1);
  const uid = s.uids[0] ?? "";
  install(h.api, s, [[[tx()]]]);
  h.api.state.failTransactions.set(uid, { atRequest: 1, error: { status: 500, error: "ASPSP_ERROR" } });
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api), now: NOW })).code, ExitCode.failure);
  h.api.state.failTransactions.set(uid, { atRequest: 2, error: { status: 500, error: "ASPSP_ERROR" } });
  assert.equal((await sync(h)).code, ExitCode.failure);
  h.api.state.failTransactions.clear();
  const run = await sync(h);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(gaps(h).length, 2);
  assert.equal(run.stdout.match(/an initial backfill was interrupted/g)?.length, 1, run.stdout);
  const status = await h.run(["status", "--json"], { now: NOW });
  const parsed = JSON.parse(status.stdout) as { accounts: { warnings: string[] }[] };
  assert.equal(parsed.accounts[0]?.warnings.filter((w) => w.includes("was interrupted")).length, 1);
});

test("status is offline and read-only: no key, no config, no request, DB bytes and data dir unchanged; warns under 14 days", async () => {
  const { h } = await authed([[[tx(), tx({ status: "PDNG" })]]]);
  exec(h, "UPDATE sessions SET valid_until = '2026-11-25T00:00:00.000Z'");
  unlinkSync(h.keyPath);
  unlinkSync(h.paths.configFile);
  const bytes = readFileSync(h.paths.dbFile);
  const files = readdirSync(h.paths.dataDir);
  const before = h.api.requests.length;
  const run = await h.run(["status", "--json"], { now: NOW });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(h.api.requests.length, before);
  assert.deepEqual(readFileSync(h.paths.dbFile), bytes);
  assert.deepEqual(readdirSync(h.paths.dataDir), files);
  const out = JSON.parse(run.stdout) as { accounts: { booked: number; pending: number; consent_days_left: number; warnings: string[] }[] };
  assert.equal(out.accounts[0]?.booked, 1);
  assert.equal(out.accounts[0]?.pending, 1);
  assert.equal(out.accounts[0]?.consent_days_left, 9);
  assert.match(out.accounts[0]?.warnings.join("\n") ?? "", /consent expires in 9 day\(s\)/);
  exec(h, "UPDATE sessions SET valid_until = '2026-11-30T00:00:00.000Z'");
  const later = JSON.parse((await h.run(["status", "--json"], { now: NOW })).stdout) as { accounts: { warnings: string[] }[] };
  assert.deepEqual(later.accounts[0]?.warnings, []);
  exec(h, "UPDATE sessions SET valid_until = '2026-11-15T08:00:00.000Z'");
  chmodSync(h.paths.dbFile, 0o400);
  const expired = await h.run(["status"], { now: NOW });
  assert.equal(expired.code, 0, expired.stderr);
  assert.match(expired.stdout, /consent expired/);
});

test("sync warns before consent expiry", async () => {
  const { h } = await authed([[[tx()]]]);
  exec(h, "UPDATE sessions SET valid_until = '2026-11-20T00:00:00.000Z'");
  assert.match((await sync(h)).stdout, /consent expires in 4 day\(s\)/);
});

test("SIGKILL between two pages of a sync: page 1 kept, cursor and pending unchanged; the next sync reclaims the lock and resumes", async () => {
  const today = isoDate(new Date());
  const day = addDays(today, -2);
  const h = await harness();
  const s = session("sess-k", 1);
  const uid = s.uids[0] ?? "";
  const p1 = tx({ booking_date: day });
  const p2 = tx({ booking_date: day });
  const pending = tx({ status: "PDNG", booking_date: null, value_date: day });
  install(h.api, s, [[[tx({ booking_date: day }), pending]]]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api), now: new Date(Date.now() - 86_400_000) })).code, 0);
  const cursor = h.value("SELECT synced_through AS v FROM accounts");
  h.api.state.pages.set(uid, [[p1], [p2]]);
  h.api.state.hangTransactions.set(uid, 3);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "sync"], { env: { PATH: process.env["PATH"], ...h.env }, stdio: ["ignore", "ignore", "pipe"] });
  let childErr = "";
  child.stderr.on("data", (d: Buffer) => (childErr += d.toString()));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  for (let i = 0; i < 1000 && txQueries(h, uid).length < 3; i++) await sleep(10);
  assert.equal(txQueries(h, uid).length, 3, childErr);
  child.kill("SIGKILL");
  await exited;
  assert.equal(n(h, "SELECT count(*) AS v FROM sync_lock"), 1);
  assert.equal(h.value("SELECT synced_through AS v FROM accounts"), cursor);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE entry_reference = ?", p1.entry_reference ?? ""), 1);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE entry_reference = ?", p2.entry_reference ?? ""), 0);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 1);
  const run = await h.run(["sync", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(n(h, "SELECT count(*) AS v FROM sync_lock"), 0);
  assert.equal(h.value("SELECT synced_through AS v FROM accounts"), today);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'BOOK'"), 3);
  assert.equal(n(h, "SELECT count(*) AS v FROM transactions WHERE status = 'PDNG'"), 0);
  const out = JSON.parse(run.stdout) as { accounts: { inserted: number }[] };
  assert.equal(out.accounts[0]?.inserted, 1);
});

/** A second, independent bank with its own account (distinct identification_hash and uid). */
async function twoBanks(): Promise<{ h: Harness; first: string; second: string }> {
  const h = await harness();
  const other = { name: "Other Bank", country: "FR" } as const;
  h.api.state.aspsps.push({ ...other, psu_types: ["personal"], maximum_consent_validity: 15_552_000 });
  const a = session("sess-a", 1, "code-a");
  const base = session("sess-b", 1, "code-b");
  const b = {
    ...base,
    uids: ["sess-b-uid-0"],
    session: { ...base.session, aspsp: other, accounts: [{ ...base.session.accounts[0], uid: "sess-b-uid-0", identification_hash: "hash-other", name: "Other account" }] },
  } as typeof base;
  install(h.api, a, [[[tx()]]]);
  install(h.api, b, [[[tx()]]]);
  assert.equal((await h.run(authArgs, { paste: (api) => callback(api, "code-a"), now: NOW })).code, 0);
  const auth = await h.run(["auth", "--bank", other.name, "--country", "FR"], { paste: (api) => callback(api, "code-b"), now: NOW });
  assert.equal(auth.code, 0, auth.stderr);
  return { h, first: a.uids[0] ?? "", second: b.uids[0] ?? "" };
}

test("several banks: one bank rate-limited does not stop the others; exit 4 and the failure is reported", async () => {
  const { h, first, second } = await twoBanks();
  assert.equal(n(h, "SELECT count(DISTINCT aspsp_name) AS v FROM sessions"), 2);
  h.api.state.pages.set(second, [[tx()]]);
  h.api.state.failTransactions.set(first, { atRequest: 2, error: { status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" } });
  const run = await sync(h, NOW, true);
  assert.equal(run.code, ExitCode.rateLimit, run.stderr);
  const out = JSON.parse(run.stdout) as { accounts: { name: string; inserted: number }[]; failures: { name: string; exit_code: number }[] };
  assert.deepEqual(out.accounts.map((a) => [a.name, a.inserted]), [["Other account", 1]]);
  assert.deepEqual(out.failures.map((f) => [f.name, f.exit_code]), [["Synthetic account 0", ExitCode.rateLimit]]);
  assert.match(run.stderr, /Synthetic account 0: .*rate limit/i);
  h.api.state.failTransactions.clear();
  const ok = await sync(h, NOW, true);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual((JSON.parse(ok.stdout) as { failures: unknown[] }).failures, []);
});

test("several banks: different failures give exit 1", async () => {
  const { h, first, second } = await twoBanks();
  h.api.state.failTransactions.set(first, { atRequest: 2, error: { status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" } });
  h.api.state.failTransactions.set(second, { atRequest: 2, error: { status: 401, error: "EXPIRED_SESSION" } });
  const run = await sync(h);
  assert.equal(run.code, ExitCode.failure, run.stderr);
});

test("revoke --bank closes that bank's latest consent only", async () => {
  const { h } = await twoBanks();
  const run = await h.run(["revoke", "--bank", "Other Bank (beta)"], { now: NOW });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(h.api.state.deletedSessions, ["sess-b"]);
  assert.equal(h.value("SELECT group_concat(aspsp_name) AS v FROM sessions"), BANK.name);
  const again = await h.run(["revoke", "--bank", "Other Bank"], { now: NOW });
  assert.equal(again.code, ExitCode.failure);
  assert.match(again.stderr, /no stored consent for Other Bank/);
  assert.equal((await h.run(["revoke", "--bank", "Other Bank", "--session", "x"], { now: NOW })).code, ExitCode.usage);
});
