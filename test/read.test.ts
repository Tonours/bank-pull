import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ExitCode } from "../src/errors.js";
import { MIGRATIONS, openReadWrite } from "../src/db.js";
import { assertSingleStatement, guardedQuery, searchTransactions, type TransactionView } from "../src/read.js";
import { BANK, install, session, tx } from "./support/fixtures.js";
import { callback, harness, type CliRun, type Harness } from "./support/harness.js";
import { refusedSql } from "./support/sql-escapes.js";
import { tempHome } from "./support/tmp.js";

const NOW = new Date("2026-11-15T09:00:00.000Z");

const grocery = tx({ booking_date: "2026-11-01", value_date: "2026-11-01", amount: "12.30", remittance_information: ["SYNTHETIC GROCERY 50%"], creditor: { name: "Grocer" } });
const salary = tx({ booking_date: "2026-11-05", value_date: "2026-11-05", amount: "1000.00", credit_debit_indicator: "CRDT", remittance_information: ["SYNTHETIC SALARY"], creditor: null, debtor: { name: "Employer" } });
const pending = tx({ status: "PDNG", booking_date: null, value_date: null, transaction_date: "2026-11-10", entry_reference: null, amount: "4.50", remittance_information: ["SYNTHETIC CAFE"], creditor: { name: "Cafe" } });
const yen = tx({ booking_date: "2026-11-03", value_date: "2026-11-03", transaction_amount: { currency: "JPY", amount: "500" }, remittance_information: ["SYNTHETIC TOKYO SHOP"] });
const other = tx({ booking_date: "2026-10-20", value_date: "2026-10-20", amount: "7.00", remittance_information: ["SYNTHETIC OTHER ACCOUNT"] });

/** A synced DB, then the key, the config and the API are taken away: every read below runs offline. */
const h: Harness = await harness();
{
  const s = session("sess-read", 2);
  install(h.api, s, [[[grocery, salary, pending, yen]], [[other]]]);
  h.api.state.balances.set(s.uids[0] ?? "", [
    { balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "1234.56" }, reference_date: "2026-11-14" },
    { balance_type: "ITAV", balance_amount: { currency: "EUR", amount: "-5.00" } },
    { balance_type: "ITAV", balance_amount: { currency: "USD", amount: "3.00" } },
  ]);
  const run = await h.run(["auth", "--bank", BANK.name, "--country", "FR"], { paste: (api) => callback(api), now: NOW });
  assert.equal(run.code, 0, run.stderr);
  rmSync(h.keyPath);
  rmSync(h.paths.configFile);
  await h.api.close();
}
const requestsAfterSetup = h.api.requests.length;

const ok = async (args: readonly string[]): Promise<CliRun> => {
  const run = await h.run(args);
  assert.equal(run.code, 0, run.stderr);
  return run;
};
const ids = async (...args: string[]): Promise<string[]> => {
  const out = JSON.parse((await ok(["transactions", "--json", ...args])).stdout) as { transactions: TransactionView[] };
  return out.transactions.map((t) => t.label ?? "");
};
const dbHash = (): string => createHash("sha256").update(readFileSync(h.paths.dbFile)).digest("hex");

test("AC-8: accounts lists every account with its latest balances per type and currency, offline", async () => {
  const run = await ok(["accounts", "--json"]);
  const out = JSON.parse(run.stdout) as { accounts: { name: string; balances: { balance_type: string; currency: string; amount: string; amount_minor: number }[] }[] };
  assert.deepEqual(out.accounts.map((a) => a.name), ["Synthetic account 0", "Synthetic account 1"]);
  assert.deepEqual(
    out.accounts[0]?.balances.map((b) => [b.balance_type, b.currency, b.amount, b.amount_minor]),
    [
      ["CLBD", "EUR", "1234.56", 123456],
      ["ITAV", "EUR", "-5.00", -500],
      ["ITAV", "USD", "3.00", 300],
    ],
  );
  assert.deepEqual(out.accounts[1]?.balances, []);
  const text = await ok(["accounts"]);
  assert.match(text.stdout, /#1 Synthetic account 0 \(Synthetic Bank \(FR\)\) FR00 TEST 0000 0000 0000 EUR\n  CLBD 1234\.56 EUR on 2026-11-14/);
  assert.match(text.stdout, /no balance fetched yet/);
  assert.equal(h.api.requests.length, requestsAfterSetup, "no request after setup");
});

test("AC-8: transactions filters by account, date range, text, category, status, amount and limit", async () => {
  assert.deepEqual(await ids(), ["SYNTHETIC CAFE", "SYNTHETIC SALARY", "SYNTHETIC TOKYO SHOP", "SYNTHETIC GROCERY 50%", "SYNTHETIC OTHER ACCOUNT"]);
  assert.deepEqual(await ids("--account", "2"), ["SYNTHETIC OTHER ACCOUNT"]);
  assert.deepEqual(await ids("--from", "2026-11-03", "--to", "2026-11-05"), ["SYNTHETIC SALARY", "SYNTHETIC TOKYO SHOP"]);
  assert.deepEqual(await ids("--from", "2026-11-10"), ["SYNTHETIC CAFE"], "an undated booking falls back to transaction_date");
  assert.deepEqual(await ids("--text", "salary"), ["SYNTHETIC SALARY"], "label, case-insensitive");
  assert.deepEqual(await ids("--text", "employer"), ["SYNTHETIC SALARY"], "counterparty");
  assert.deepEqual(await ids("--text", "50%"), ["SYNTHETIC GROCERY 50%"], "% is literal");
  assert.deepEqual(await ids("--text", "_"), [], "_ is literal");
  assert.deepEqual(await ids("--status", "PDNG"), ["SYNTHETIC CAFE"]);
  assert.deepEqual(await ids("--status", "pending"), ["SYNTHETIC CAFE"]);
  assert.equal((await ids("--status", "BOOK")).length, 4);
  assert.deepEqual(await ids("--min-amount", "0"), ["SYNTHETIC SALARY"]);
  assert.deepEqual(await ids("--max-amount=-12.30"), ["SYNTHETIC TOKYO SHOP", "SYNTHETIC GROCERY 50%"], "JPY -500 and EUR -12.30, each in its own exponent");
  assert.deepEqual(await ids("--min-amount=-12.30", "--max-amount=-5"), ["SYNTHETIC GROCERY 50%", "SYNTHETIC OTHER ACCOUNT"]);
  assert.deepEqual(await ids("--max-amount=-500.5"), [], "an upper bound rounds down in JPY (-501)");
  const limited = JSON.parse((await ok(["transactions", "--json", "--limit", "2"])).stdout) as { transactions: TransactionView[]; truncated: boolean };
  assert.deepEqual([limited.transactions.length, limited.truncated], [2, true]);
  const all = JSON.parse((await ok(["transactions", "--json", "--limit", "5"])).stdout) as { transactions: TransactionView[]; truncated: boolean };
  assert.equal(all.truncated, false);
  const salaryRow = all.transactions.find((t) => t.label === "SYNTHETIC SALARY");
  assert.deepEqual([salaryRow?.amount, salaryRow?.amount_minor, salaryRow?.date], ["1000.00", 100000, "2026-11-05"]);
  const text = await ok(["transactions", "--status", "pending"]);
  assert.match(text.stdout, /^#\d+ 2026-11-10 -4\.50 EUR \(PDNG\) SYNTHETIC CAFE \| Cafe\n$/);
  assert.equal(h.api.requests.length, requestsAfterSetup);
});

test("AC-8: transactions refuses invalid filters with exit 2", async () => {
  for (const args of [
    ["--from", "2026-02-30"],
    ["--to", "yesterday"],
    ["--from", "2026-11-05", "--to", "2026-11-01"],
    ["--account", "x"],
    ["--account", "0"],
    ["--limit", "0"],
    ["--limit", "5001"],
    ["--status", "booked"],
    ["--min-amount", "1e3"],
    ["--max-amount", "12,30"],
    ["--text", ""],
    ["--bogus"],
  ]) {
    const run = await h.run(["transactions", ...args]);
    assert.equal(run.code, ExitCode.usage, `${args.join(" ")}: ${run.stderr}`);
  }
});

test("AC-8: categorize changes only category and note of one row; empty clears; --category '' filters uncategorized", async () => {
  const snapshot = (): unknown[] => {
    const db = new DatabaseSync(h.paths.dbFile, { readOnly: true });
    try {
      return db.prepare("SELECT * FROM transactions ORDER BY id").all().map((r) => ({ ...(r as object) }));
    } finally {
      db.close();
    }
  };
  const id = String(h.value("SELECT id AS v FROM transactions WHERE remittance = 'SYNTHETIC GROCERY 50%'"));
  const beforeRows = snapshot() as Record<string, unknown>[];
  const set = JSON.parse((await ok(["categorize", "--id", id, "--category", "food", "--note", "weekly\nshop", "--json"])).stdout) as unknown;
  assert.deepEqual(set, { id: Number(id), category: "food", note: "weekly\nshop" });
  const afterRows = snapshot() as Record<string, unknown>[];
  assert.deepEqual(
    afterRows,
    beforeRows.map((r) => (String(r["id"]) === id ? { ...r, category: "food", note: "weekly\nshop" } : r)),
  );
  assert.deepEqual(await ids("--category", "food"), ["SYNTHETIC GROCERY 50%"]);
  assert.equal((await ids("--category", "")).length, 4);
  assert.deepEqual(await ids("--text", "weekly"), ["SYNTHETIC GROCERY 50%"], "the note is searched");
  await ok(["categorize", "--id", id, "--note", "kept category"]);
  assert.deepEqual([h.value("SELECT category AS v FROM transactions WHERE id = ?", Number(id)), h.value("SELECT note AS v FROM transactions WHERE id = ?", Number(id))], ["food", "kept category"]);
  await ok(["categorize", "--id", id, "--category", "groceries"]);
  assert.equal(h.value("SELECT note AS v FROM transactions WHERE id = ?", Number(id)), "kept category", "an omitted note is kept");
  await ok(["categorize", "--id", id, "--category", "", "--note", ""]);
  assert.deepEqual(snapshot(), beforeRows);
  assert.equal(h.api.requests.length, requestsAfterSetup);
});

test("categorize refuses bad input without writing", async () => {
  const before = dbHash();
  for (const [args, code, pattern] of [
    [["--category", "x"], ExitCode.usage, /missing --id/],
    [["--id", "1"], ExitCode.usage, /--category and\/or --note/],
    [["--id", "99999", "--category", "x"], ExitCode.failure, /no transaction with id 99999/],
    [["--id", String(h.value("SELECT id AS v FROM transactions WHERE status = 'PDNG'")), "--category", "x"], ExitCode.failure, /not booked \(PDNG\); pending rows are replaced/],
    [["--id", "1", "--category", "a\u001b[31m"], ExitCode.usage, /control characters/],
    [["--id", "1", "--category", "a\nb"], ExitCode.usage, /control characters/],
    [["--id", "1", "--note", "x\u202e"], ExitCode.usage, /control characters/],
    [["--id", "1", "--category", "a\u061cb"], ExitCode.usage, /control characters/],
    [["--id", "1", "--note", "a\u0085b"], ExitCode.usage, /control characters/],
    [["--id", "1", "--category", "x".repeat(101)], ExitCode.usage, /longer than 100/],
  ] as const) {
    const run = await h.run(["categorize", ...args]);
    assert.equal(run.code, code, run.stderr);
    assert.match(run.stderr, pattern);
  }
  assert.equal(dbHash(), before);
});

test("AC-8: query runs one read-only SELECT or WITH, capped by --max-rows", async () => {
  const out = JSON.parse((await ok(["query", "--json", "SELECT count(*) AS n, sum(amount_minor) AS s FROM transactions WHERE currency = 'EUR'"])).stdout) as unknown;
  assert.deepEqual(out, { columns: ["n", "s"], rows: [{ n: 4, s: 100000 - 1230 - 450 - 700 }], truncated: false });
  const cte = JSON.parse((await ok(["query", "--json", "--max-rows", "3", "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r"])).stdout) as { rows: unknown[]; truncated: boolean };
  assert.deepEqual([cte.rows, cte.truncated], [[{ n: 1 }, { n: 2 }, { n: 3 }], true]);
  const blob = JSON.parse((await ok(["query", "--json", "SELECT x'00ff' AS b, NULL AS z"])).stdout) as { rows: unknown[] };
  assert.deepEqual(blob.rows, [{ b: "x'00ff'", z: null }]);
  assert.equal((await ok(["query", "SELECT 'a;b' AS v; -- trailing comment ; ok\n/* and ; this */ ;"])).stdout, "v\na;b\n");
  const text = await ok(["query", "SELECT remittance FROM transactions WHERE status = 'PDNG'"]);
  assert.equal(text.stdout, "remittance\nSYNTHETIC CAFE\n");
  const big = JSON.parse((await ok(["query", "--json", "SELECT 9007199254740993 AS big, 9007199254740991 AS safe, -9007199254740993 AS neg"])).stdout) as { rows: unknown[] };
  assert.deepEqual(big.rows, [{ big: "9007199254740993", safe: 9007199254740991, neg: "-9007199254740993" }]);
  const infinite = JSON.parse((await ok(["query", "--json", "SELECT 1e999 AS pos, -1e999 AS neg, NULL AS empty"])).stdout) as { rows: unknown[] };
  assert.deepEqual(infinite.rows, [{ pos: "Infinity", neg: "-Infinity", empty: null }]);
  const duplicate = await h.run(["query", "SELECT 1 AS x, 2 AS x"]);
  assert.equal(duplicate.code, ExitCode.usage);
  assert.match(duplicate.stderr, /two columns named "x"/);
  assert.equal((await h.run(["query", "--max-rows", "5001", "SELECT 1"])).code, ExitCode.usage);
  assert.equal((await h.run(["query"])).code, ExitCode.usage);
  assert.equal((await h.run(["query", "SELECT 1", "SELECT 2"])).code, ExitCode.usage);
});

test("AC-8: query refuses writes, ATTACH, VACUUM INTO, temp tables, PRAGMA and a second statement; DB bytes and data dir unchanged", async () => {
  const hash = dbHash();
  const files = readdirSync(h.paths.dataDir).sort();
  for (const sql of refusedSql(h.paths.dataDir)) {
    const run = await h.run(["query", "--", sql]);
    assert.notEqual(run.code, 0, `${sql} was accepted: ${run.stdout}`);
    assert.match(run.stderr, /query|statement/, sql);
  }
  assert.equal(dbHash(), hash);
  assert.deepEqual(readdirSync(h.paths.dataDir).sort(), files);
  assert.equal(h.api.requests.length, requestsAfterSetup);
});

test("query: the read-only connection still refuses a write when the authorizer is not installed", () => {
  const proto = DatabaseSync.prototype as unknown as { setAuthorizer: unknown };
  const original = proto.setAuthorizer;
  try {
    proto.setAuthorizer = () => undefined;
    assert.throws(() => guardedQuery(h.paths, "DELETE FROM transactions"), /readonly|read-only/i);
    proto.setAuthorizer = undefined;
    assert.throws(() => guardedQuery(h.paths, "SELECT 1"), /setAuthorizer/);
  } finally {
    proto.setAuthorizer = original;
  }
});

test("assertSingleStatement tracks literals, quoted identifiers and comments", () => {
  for (const sql of ["SELECT 1", "SELECT 1;", "SELECT 1 ;\n -- x\n ;;", "SELECT 'it''s;'", "SELECT \"a\"\"\";", "SELECT `a;b`", "SELECT [a;b] FROM (SELECT 1 AS [a;b])", "SELECT 1 /* ; */", "SELECT '--;' -- ;", "SELECT 1; /* open"]) {
    assert.doesNotThrow(() => assertSingleStatement(sql), sql);
  }
  for (const sql of ["SELECT 1; SELECT 2", "SELECT 'it''s'; x", "SELECT 1 -- c\n; x", "SELECT 1; /* c */ x", "SELECT 1;\u000bx"]) {
    assert.throws(() => assertSingleStatement(sql), /single statement/, sql);
  }
});

test("AC-8: read commands never create or migrate a database", async () => {
  const { env, paths } = tempHome();
  const { main } = await import("../src/cli.js");
  const io = { env, stdout: () => undefined, stderr: () => undefined, readLine: () => Promise.reject(new Error("no prompt")) };
  for (const args of [["accounts"], ["transactions"], ["query", "SELECT 1"], ["categorize", "--id", "1", "--category", "x"], ["status"]]) {
    assert.notEqual(await main(args, io), 0, args.join(" "));
  }
  assert.throws(() => readdirSync(paths.dataDir), /ENOENT/);
});

test("transaction ids are never reused, migration 2 keeps every row, and amount bounds past 2^53 stay exact", () => {
  const { paths } = tempHome();
  mkdirSync(paths.dataDir, { mode: 0o700 });
  const v1 = new DatabaseSync(paths.dbFile);
  v1.exec(`${MIGRATIONS[0] ?? ""}; PRAGMA user_version = 1;`);
  v1.exec("INSERT INTO accounts (id, identification_hash, aspsp_name, aspsp_country, raw_json) VALUES (1, 'h', 'B', 'FR', '{}')");
  const insert = (key: string, minor: number): void => {
    v1.prepare(
      `INSERT INTO transactions (account_id, dedup_key, status, booking_date, amount_minor, currency, credit_debit_indicator, raw_json, category, first_seen_at)
       VALUES (1, ?, 'BOOK', '2026-11-01', ?, 'EUR', 'CRDT', '{}', 'kept', 'now')`,
    ).run(key, minor);
  };
  insert("a", Number.MAX_SAFE_INTEGER);
  insert("b", -Number.MAX_SAFE_INTEGER);
  v1.close();
  chmodSync(paths.dbFile, 0o600);
  const db = openReadWrite(paths);
  try {
    assert.deepEqual(db.prepare("SELECT id, dedup_key, category FROM transactions ORDER BY id").all().map((r) => ({ ...(r as object) })), [
      { id: 1, dedup_key: "a", category: "kept" },
      { id: 2, dedup_key: "b", category: "kept" },
    ]);
    db.exec("DELETE FROM transactions WHERE id = 2");
    db.prepare(
      "INSERT INTO transactions (account_id, dedup_key, status, amount_minor, currency, credit_debit_indicator, raw_json, first_seen_at) VALUES (1, 'c', 'PDNG', 1, 'EUR', 'CRDT', '{}', 'now')",
    ).run();
    assert.equal((db.prepare("SELECT max(id) AS v FROM transactions").get() as { v: number }).v, 3, "id 2 is not reused");
    const keys = (filter: Parameters<typeof searchTransactions>[1]): string[] =>
      searchTransactions(db, filter).transactions.map((t) => t.label ?? String(t.amount_minor));
    assert.deepEqual(keys({ minAmount: "90071992547409.92" }), []);
    assert.deepEqual(keys({ maxAmount: "-90071992547409.92" }), []);
    assert.equal(keys({ minAmount: "-90071992547409.92" }).length, 2);
    assert.equal(keys({ maxAmount: "90071992547409.92" }).length, 2);
    assert.deepEqual(keys({ minAmount: "90071992547409.91" }), [String(Number.MAX_SAFE_INTEGER)]);
  } finally {
    db.close();
  }
});

test("categorize validates its arguments first and never migrates an older database", async () => {
  const { env, paths } = tempHome();
  mkdirSync(paths.dataDir, { mode: 0o700 });
  const v1 = new DatabaseSync(paths.dbFile);
  v1.exec(`${MIGRATIONS[0] ?? ""}; PRAGMA user_version = 1;`);
  v1.close();
  chmodSync(paths.dbFile, 0o600);
  const { main } = await import("../src/cli.js");
  let stderr = "";
  const io = { env, stdout: () => undefined, stderr: (t: string) => void (stderr += t), readLine: () => Promise.reject(new Error("no prompt")) };
  assert.equal(await main(["categorize", "--id", "1", "--category", "x".repeat(101)], io), ExitCode.usage);
  assert.match(stderr, /longer than 100/);
  assert.equal(await main(["categorize", "--id", "1", "--category", "x"], io), ExitCode.failure);
  assert.match(stderr, /schema version 1, expected 2; run "bank-pull sync" to migrate/);
  const db = new DatabaseSync(paths.dbFile, { readOnly: true });
  try {
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  } finally {
    db.close();
  }
});
