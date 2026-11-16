#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { assertPrivate, ensurePrivateDir, loadConfig, resolvePaths, type Config, type Env, type Paths } from "./config.js";
import { categorize, latestSession, openReadWrite, syncStatus, withReadOnly, type AccountStatus } from "./db.js";
import { ApiError, DEFAULT_API_URL, EnableBankingClient } from "./enable-banking.js";
import { CliError, ExitCode } from "./errors.js";
import { loadSigningKey, readPrivateKey } from "./jwt.js";
import { acquireLock, lockedWrite, releaseLock } from "./lock.js";
import { guardedQuery, listAccounts, QUERY_MAX_ROWS, searchTransactions, TRANSACTIONS_MAX_LIMIT, type QueryValue, type TransactionFilter } from "./read.js";
import { backfillAccount, mapApiError, persistSession, syncAccount, type AccountResult, type SyncContext } from "./sync.js";
import { printable } from "./text.js";

export interface Io {
  readonly env: Env;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Reads one line typed or pasted by the user. */
  readonly readLine: () => Promise<string>;
  readonly now?: () => Date;
}

const USAGE = `Usage: bank-pull <command> [options]

Commands:
  init --app-id <id> --key <path> --redirect-url <https-url> [--force]
                         write the config file (the key stays where it is)
  banks --country <CC> [--json]
                         list banks available through Enable Banking
  auth --bank <name> --country <CC> [--json]
                         open a bank consent, paste the redirect URL, then backfill
  revoke [--session <id>]
                         close the latest consent at the bank and forget it locally
  sync [--json]          fetch new transactions and balances for every consented account
  status [--json]        offline: cursor, consent expiry and history gaps per account
  accounts [--json]      offline: accounts with their latest balances
  transactions [--account <id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--text <s>]
               [--category <c>] [--status BOOK|PDNG|...|pending] [--min-amount <n>]
               [--max-amount <n>] [--limit <n>] [--json]
                         offline: transactions, newest first (--category "" = uncategorized;
                         negative amounts as --max-amount=-12.30)
  query "<SELECT ...>" [--max-rows <n>] [--json]
                         offline: one read-only SQL statement (default 500 rows, max 5000)
  categorize --id <n> [--category <c>] [--note <text>] [--json]
                         set the category and/or note of one booked transaction (empty value clears)
  mcp                    offline stdio MCP server over the local database (no network, no key)

Exit codes: 0 ok, 1 failure, 2 usage, 3 consent expired or closed,
4 bank rate limit, 5 another sync running, 6 unsafe file permissions.
`;

const DAY_SECONDS = 86_400;
const MAX_CONSENT_DAYS = 180;
const COUNTRY = /^[A-Z]{2}$/;

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new CliError((error as Error).message, ExitCode.usage);
  }
}

function required(value: string | boolean | undefined, flag: string): string {
  if (typeof value !== "string" || value.length === 0) throw new CliError(`missing --${flag}`, ExitCode.usage);
  return value;
}

function country(value: string | boolean | undefined): string {
  const code = required(value, "country").toUpperCase();
  if (!COUNTRY.test(code)) throw new CliError(`--country must be a two-letter country code (got "${code}")`, ExitCode.usage);
  return code;
}

/** Loads the key through the permission gate; nothing is sent before this succeeds. The API URL override exists for the test fake. */
function client(config: Config, env: Env): EnableBankingClient {
  const privateKeyPem = readPrivateKey(config.keyPath);
  const override = env["BANK_PULL_API_URL"];
  try {
    return new EnableBankingClient({ appId: config.appId, privateKeyPem, baseUrl: override === undefined || override === "" ? DEFAULT_API_URL : override });
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

/** True when both paths name one existing inode (catches symlinked or hard-linked aliases). */
function sameFile(a: string, b: string): boolean {
  const left = statSync(a, { throwIfNoEntry: false });
  const right = statSync(b, { throwIfNoEntry: false });
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function init(args: readonly string[], paths: Paths, io: Io): number {
  const values = parse(args, {
    "app-id": { type: "string" },
    key: { type: "string" },
    "redirect-url": { type: "string" },
    force: { type: "boolean" },
  });
  const appId = required(values["app-id"], "app-id");
  const keyPath = resolve(required(values.key, "key"));
  const redirectUrl = required(values["redirect-url"], "redirect-url");
  if (!URL.canParse(redirectUrl) || new URL(redirectUrl).protocol !== "https:") {
    throw new CliError("--redirect-url must be an https URL (Enable Banking only redirects to https)", ExitCode.usage);
  }
  if (keyPath === paths.configFile || sameFile(keyPath, paths.configFile)) {
    throw new CliError("--key must not be the config file itself", ExitCode.usage);
  }
  try {
    loadSigningKey(readPrivateKey(keyPath));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${keyPath}: ${(error as Error).message}`);
  }
  ensurePrivateDir(paths.configDir);
  if (values.force === true) rmSync(paths.configFile, { force: true });
  try {
    writeFileSync(paths.configFile, `${JSON.stringify({ appId, keyPath, redirectUrl }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError(`${paths.configFile} exists; pass --force to overwrite`);
    throw error;
  }
  assertPrivate(paths.configFile, "file");
  openReadWrite(paths).close();
  io.stdout(`wrote ${paths.configFile}\ndatabase ready at ${paths.dbFile}\n`);
  return 0;
}

async function banks(args: readonly string[], paths: Paths, io: Io): Promise<number> {
  const values = parse(args, { country: { type: "string" }, json: { type: "boolean" } });
  const list = await client(loadConfig(paths), io.env).listAspsps(country(values.country), "personal");
  if (values.json === true) {
    io.stdout(`${JSON.stringify(list, null, 2)}\n`);
  } else {
    for (const bank of list) io.stdout(`${printable(bank.name)}${bank.beta === true ? " (beta)" : ""}\n`);
  }
  return 0;
}

/** Validates the pasted redirect URL against the configured callback and the expected state; returns the code. */
export function parseCallback(pasted: string, redirectUrl: string, state: string): string {
  const text = pasted.trim();
  if (!URL.canParse(text)) throw new CliError("the pasted text is not a URL; paste the full address of the redirect page");
  const url = new URL(text);
  const expected = new URL(redirectUrl);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new CliError(`the pasted URL does not start with the configured redirect URL ${expected.origin}${expected.pathname}`);
  }
  const error = url.searchParams.get("error");
  if (error !== null) {
    const description = url.searchParams.get("error_description");
    throw new CliError(`the bank returned an error: ${error}${description === null ? "" : ` (${description})`}`);
  }
  if (url.searchParams.get("state") !== state) {
    throw new CliError("the pasted URL belongs to another consent attempt (state mismatch); run auth again");
  }
  const code = url.searchParams.get("code");
  if (code === null || code === "") throw new CliError("the pasted URL carries no authorization code");
  return code;
}

/** Consent length: the bank's maximum, capped at 180 days, rounded down to whole days (to whole seconds under one day). */
export function consentValidUntil(now: Date, maximumSeconds: unknown): string {
  const cap = MAX_CONSENT_DAYS * DAY_SECONDS;
  const seconds = typeof maximumSeconds === "number" && Number.isFinite(maximumSeconds) && maximumSeconds > 0 ? Math.min(maximumSeconds, cap) : cap;
  const whole = seconds >= DAY_SECONDS ? Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS : Math.floor(seconds);
  return new Date(now.getTime() + whole * 1000).toISOString();
}

function summarize(results: readonly AccountResult[], statuses: readonly AccountStatus[], io: Io): void {
  for (const r of results) {
    const undated = r.skipped_undated > 0 ? `, ${r.skipped_undated} undated skipped` : "";
    io.stdout(`${printable(r.name)}: ${r.mode}, ${r.received_book} booked received, ${r.inserted} new, ${r.pending} pending${undated}\n`);
    if (r.mode === "incremental") {
      for (const row of r.inserted_rows) io.stdout(`  + ${row.date ?? "????-??-??"} ${row.amount} ${row.currency} ${printable(row.label || row.counterparty)}\n`);
    }
    for (const gap of r.gaps_added) io.stdout(`  warning: history gap recorded (${gap.kind}); older history may be shorter than the bank's window\n`);
    const permanent = statuses.find((s) => s.account_id === r.account_id)?.warnings ?? [];
    for (const warning of [...r.warnings, ...permanent]) io.stdout(`  warning: ${warning}\n`);
  }
}

async function auth(args: readonly string[], paths: Paths, io: Io): Promise<number> {
  const values = parse(args, { bank: { type: "string" }, country: { type: "string" }, json: { type: "boolean" } });
  const bankName = required(values.bank, "bank");
  const countryCode = country(values.country);
  const config = loadConfig(paths);
  const api = client(config, io.env);
  const db = openReadWrite(paths);
  try {
    const now = io.now?.() ?? new Date();
    const aspsps = await api.listAspsps(countryCode, "personal");
    const aspsp = aspsps.find((a) => a.name === bankName);
    if (aspsp === undefined) {
      const names = aspsps.map((a) => a.name).filter((n) => n.toLowerCase().includes(bankName.toLowerCase()));
      throw new CliError(`no bank named "${bankName}" in ${countryCode}${names.length > 0 ? `; did you mean: ${names.join(", ")}` : ""}`);
    }
    const state = randomUUID();
    const { url } = await api.startAuth({
      aspsp: { name: aspsp.name, country: countryCode },
      validUntil: consentValidUntil(now, aspsp.maximum_consent_validity),
      state,
      redirectUrl: config.redirectUrl,
    });
    io.stderr(
      `Open this URL in a browser and approve the consent:\n\n  ${url}\n\n` +
        `The browser then lands on ${config.redirectUrl} (the page does not load, that is expected).\n` +
        "Copy the full address from the address bar and paste it here:\n",
    );
    const code = parseCallback(await io.readLine(), config.redirectUrl, state);
    const token = acquireLock(db, now);
    try {
      const session = await api.createSession(code);
      const ctx: SyncContext = { db, client: api, lockToken: token, now };
      const accounts = persistSession(ctx, session);
      io.stderr(printable(`consent stored (session ${session.session_id}, ${accounts.length} account(s), valid until ${session.access.valid_until})`) + "\n");
      const results: AccountResult[] = [];
      for (const acc of accounts) results.push(await backfillAccount(ctx, acc.id, acc.uid, acc.gaps));
      if (values.json === true) io.stdout(`${JSON.stringify({ session_id: session.session_id, accounts: results }, null, 2)}\n`);
      else summarize(results, syncStatus(db, now), io);
      return 0;
    } finally {
      releaseLock(db, token);
    }
  } finally {
    db.close();
  }
}

async function revoke(args: readonly string[], paths: Paths, io: Io): Promise<number> {
  const values = parse(args, { session: { type: "string" } });
  const api = client(loadConfig(paths), io.env);
  const db = openReadWrite(paths);
  let token: string | undefined;
  try {
    token = acquireLock(db, io.now?.() ?? new Date());
    const row = (
      typeof values.session === "string"
        ? db.prepare("SELECT id FROM sessions WHERE id = ?").get(values.session)
        : db.prepare("SELECT id FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1").get()
    ) as { id: string } | undefined;
    if (row === undefined) throw new CliError("no stored consent to revoke");
    let note = "closed at the bank";
    try {
      await api.deleteSession(row.id);
    } catch (error) {
      if (!(error instanceof ApiError && (error.code === "EXPIRED_SESSION" || error.code === "CLOSED_SESSION"))) throw error;
      note = `already ${error.code === "EXPIRED_SESSION" ? "expired" : "closed"} at the bank`;
    }
    lockedWrite(db, token, () => db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id));
    io.stdout(`${printable(`revoked session ${row.id} (${note}); synced transactions stay in the database`)}\n`);
    return 0;
  } finally {
    if (token !== undefined) releaseLock(db, token);
    db.close();
  }
}

const expiredError = (accounts: number): CliError =>
  new CliError(`bank consent expired for ${accounts} account(s); run "bank-pull auth" again`, ExitCode.consent);

/**
 * Syncs every account whose latest consent is still valid. Expired consents are reported (exit 3) without a request;
 * any API error stops the run with its own exit code and no retry.
 */
async function sync(args: readonly string[], paths: Paths, io: Io): Promise<number> {
  const values = parse(args, { json: { type: "boolean" } });
  const api = client(loadConfig(paths), io.env);
  const db = openReadWrite(paths);
  try {
    const now = io.now?.() ?? new Date();
    // Consents are read under the lock, so a concurrent auth or revoke cannot hand this run a stale uid.
    const token = acquireLock(db, now);
    const results: AccountResult[] = [];
    let expired = 0;
    try {
      const usable: { id: number; uid: string }[] = [];
      for (const { id } of db.prepare("SELECT id FROM accounts ORDER BY id").all() as { id: number }[]) {
        const consent = latestSession(db, id);
        if (consent === undefined) continue;
        if (Date.parse(consent.valid_until) > now.getTime()) usable.push({ id, uid: consent.uid });
        else expired++;
      }
      if (usable.length === 0) throw expired > 0 ? expiredError(expired) : new CliError('no stored consent; run "bank-pull auth" first');
      const ctx: SyncContext = { db, client: api, lockToken: token, now };
      for (const acc of usable) results.push(await syncAccount(ctx, acc.id, acc.uid));
    } finally {
      releaseLock(db, token);
    }
    const statuses = syncStatus(db, now);
    if (values.json === true) {
      const accounts = results.map((r) => ({ ...r, warnings: [...r.warnings, ...(statuses.find((s) => s.account_id === r.account_id)?.warnings ?? [])] }));
      io.stdout(`${JSON.stringify({ accounts }, null, 2)}\n`);
    } else {
      summarize(results, statuses, io);
    }
    if (expired === 0) return 0;
    io.stderr(`bank-pull: ${expiredError(expired).message}\n`);
    return ExitCode.consent;
  } finally {
    db.close();
  }
}

/** Offline and read-only: needs neither the config nor the key, and never writes. */
function status(args: readonly string[], paths: Paths, io: Io): number {
  const values = parse(args, { json: { type: "boolean" } });
  const accounts = withReadOnly(paths, (db) => syncStatus(db, io.now?.() ?? new Date()));
  if (values.json === true) return json(io, { accounts });
  if (accounts.length === 0) io.stdout('no account yet; run "bank-pull auth"\n');
  for (const a of accounts) {
    const consent = a.consent_valid_until === null ? "no consent" : `consent until ${a.consent_valid_until.slice(0, 10)}`;
    io.stdout(`${printable(a.name ?? `account ${a.account_id}`)} (${printable(a.bank)}): synced through ${a.synced_through ?? "never"}, ${a.booked} booked, ${a.pending} pending, ${consent}\n`);
    for (const warning of a.warnings) io.stdout(`  warning: ${warning}\n`);
  }
  return 0;
}

function json(io: Io, value: unknown): number {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

const text = (value: string | boolean | undefined): string | undefined => (typeof value === "string" ? value : undefined);

function integer(value: string | boolean | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) throw new CliError(`--${flag} must be a positive integer`, ExitCode.usage);
  return Number(value);
}

/** Offline: accounts with their latest balances per type and currency. */
function accounts(args: readonly string[], paths: Paths, io: Io): number {
  const values = parse(args, { json: { type: "boolean" } });
  const list = withReadOnly(paths, listAccounts);
  if (values.json === true) return json(io, { accounts: list });
  if (list.length === 0) io.stdout('no account yet; run "bank-pull auth"\n');
  for (const a of list) {
    const iban = a.iban === null ? "" : ` ${a.iban}`;
    io.stdout(`${printable(`#${a.account_id} ${a.name ?? "(unnamed)"} (${a.bank})${iban}${a.currency === null ? "" : ` ${a.currency}`}`)}\n`);
    if (a.balances.length === 0) io.stdout("  no balance fetched yet\n");
    for (const b of a.balances) {
      const date = b.reference_date === null ? "" : ` on ${b.reference_date}`;
      io.stdout(`${printable(`  ${b.balance_type} ${b.amount} ${b.currency}${date} (fetched ${b.fetched_at})`)}\n`);
    }
  }
  return 0;
}

/** Offline: filtered transactions, newest first. */
function transactions(args: readonly string[], paths: Paths, io: Io): number {
  const values = parse(args, {
    account: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    text: { type: "string" },
    category: { type: "string" },
    status: { type: "string" },
    "min-amount": { type: "string" },
    "max-amount": { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  const filter: TransactionFilter = {
    accountId: integer(values.account, "account"),
    from: text(values.from),
    to: text(values.to),
    text: text(values.text),
    category: text(values.category),
    status: text(values.status),
    minAmount: text(values["min-amount"]),
    maxAmount: text(values["max-amount"]),
    limit: integer(values.limit, "limit"),
  };
  const page = withReadOnly(paths, (db) => searchTransactions(db, filter));
  if (values.json === true) return json(io, page);
  for (const t of page.transactions) {
    const label = [t.label, t.counterparty].filter((s) => s !== null && s !== "").join(" | ");
    const category = t.category === null ? "" : ` [${t.category}]`;
    const status = t.status === "BOOK" ? "" : ` (${t.status})`;
    io.stdout(`${printable(`#${t.id} ${t.date ?? "????-??-??"} ${t.amount} ${t.currency}${status}${category} ${label}`)}\n`);
  }
  if (page.transactions.length === 0) io.stdout("no matching transaction\n");
  if (page.truncated) io.stdout(`(more rows match; raise --limit, max ${TRANSACTIONS_MAX_LIMIT})\n`);
  return 0;
}

/** Offline: one read-only SELECT through the guarded read path. */
function query(args: readonly string[], paths: Paths, io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options: { json: { type: "boolean" }, "max-rows": { type: "string" } }, strict: true, allowPositionals: true });
  } catch (error) {
    throw new CliError((error as Error).message, ExitCode.usage);
  }
  const [sql, ...extra] = parsed.positionals;
  if (sql === undefined || extra.length > 0) throw new CliError('query takes exactly one SQL argument (quote it: bank-pull query "SELECT ...")', ExitCode.usage);
  const result = guardedQuery(paths, sql, integer(parsed.values["max-rows"], "max-rows"));
  if (parsed.values.json === true) return json(io, result);
  const cell = (value: QueryValue | undefined): string => (value === null || value === undefined ? "NULL" : printable(String(value)));
  io.stdout(`${result.columns.map(printable).join("\t")}\n`);
  for (const row of result.rows) io.stdout(`${result.columns.map((c) => cell(row[c])).join("\t")}\n`);
  if (result.truncated) io.stdout(`(truncated at ${result.rows.length} rows; raise --max-rows, max ${QUERY_MAX_ROWS})\n`);
  return 0;
}

/** The only write besides sync: sets or clears the category and note of one existing transaction; never creates the DB. */
function categorizeCommand(args: readonly string[], paths: Paths, io: Io): number {
  const values = parse(args, { id: { type: "string" }, category: { type: "string" }, note: { type: "string" }, json: { type: "boolean" } });
  const id = integer(values.id, "id");
  if (id === undefined) throw new CliError("missing --id (see bank-pull transactions)", ExitCode.usage);
  const row = categorize(paths, id, { category: text(values.category), note: text(values.note) });
  if (values.json === true) return json(io, row);
  io.stdout(`${printable(`#${row.id} category ${row.category ?? "(none)"}, note ${row.note ?? "(none)"}`)}\n`);
  return 0;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.stdout(USAGE);
    return 0;
  }
  try {
    const paths = resolvePaths(io.env);
    switch (command) {
      case "init":
        return init(rest, paths, io);
      case "banks":
        return await banks(rest, paths, io);
      case "auth":
        return await auth(rest, paths, io);
      case "revoke":
        return await revoke(rest, paths, io);
      case "sync":
        return await sync(rest, paths, io);
      case "status":
        return status(rest, paths, io);
      case "accounts":
        return accounts(rest, paths, io);
      case "transactions":
        return transactions(rest, paths, io);
      case "query":
        return query(rest, paths, io);
      case "categorize":
        return categorizeCommand(rest, paths, io);
      case "mcp": {
        parse(rest, {});
        const { serveStdio } = await import("./mcp.js");
        await serveStdio(paths);
        return 0;
      }
      default:
        io.stderr(`bank-pull: unknown command "${command}"\n${USAGE}`);
        return ExitCode.usage;
    }
  } catch (error) {
    const mapped = mapApiError(error);
    if (mapped instanceof CliError) {
      io.stderr(`bank-pull: ${printable(mapped.message)}\n`);
      return mapped.exitCode;
    }
    io.stderr(`bank-pull: ${(mapped as Error).stack ?? String(mapped)}\n`);
    return ExitCode.failure;
  }
}

function readStdinLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  return new Promise((resolveLine, reject) => {
    rl.once("line", (line) => {
      resolveLine(line);
      rl.close();
    });
    rl.once("close", () => reject(new CliError("no input received on stdin")));
  });
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readLine: readStdinLine,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`bank-pull: ${String(error)}\n`);
      process.exitCode = ExitCode.failure;
    },
  );
}
