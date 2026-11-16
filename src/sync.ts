import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { formatMinor, toMinorUnits } from "./amount.js";
import type { Gap } from "./db.js";
import { isCalendarDay } from "./day.js";
import { ApiError, type Balance, type EnableBankingClient, type Session, type Transaction, type TransactionQuery } from "./enable-banking.js";
import { CliError, ExitCode } from "./errors.js";
import { lockedWrite } from "./lock.js";

const MAX_PAGES = 10_000;
/** Cancelled and rejected rows are never stored; every other non-BOOK status is part of the pending snapshot. */
const DROPPED = new Set(["CNCL", "RJCT"]);
const DAY_MS = 86_400_000;
/** Incremental windows re-read this many days before the cursor. */
const OVERLAP_DAYS = 10;
/** A stored pending row pulls the window back at most this far. */
const PENDING_REACH_DAYS = 90;
/** Past this downtime the bank may no longer serve date_from: ask for strategy=longest and record a gap. */
const LONG_DOWNTIME_DAYS = 80;

export interface InsertedRow {
  readonly date: string | null;
  readonly amount: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly label: string;
  readonly counterparty: string;
}

export interface AccountResult {
  readonly account_id: number;
  readonly name: string;
  readonly mode: "backfill" | "incremental";
  readonly received_book: number;
  readonly inserted: number;
  readonly inserted_rows: readonly InsertedRow[];
  readonly pending: number;
  readonly skipped_undated: number;
  readonly gaps_added: readonly Gap[];
  readonly warnings: readonly string[];
}

export interface SyncContext {
  readonly db: DatabaseSync;
  readonly client: EnableBankingClient;
  readonly lockToken: string;
  readonly now: Date;
}

interface AccountState {
  readonly id: number;
  readonly name: string | null;
  readonly identification_hash: string;
  readonly synced_through: string | null;
  readonly backfill_started: number;
  readonly backfill_done: number;
  readonly covered_from: string | null;
  readonly history_gaps: string;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return isoDate(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const minDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);

/** Maps provider errors to the CLI's exit codes; never retries. */
export function mapApiError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code === "EXPIRED_SESSION" || error.code === "CLOSED_SESSION") {
    return new CliError(`bank consent is no longer valid (${error.code}); run "bank-pull auth" again`, ExitCode.consent);
  }
  if (error.status === 429 || error.code === "ASPSP_RATE_LIMIT_EXCEEDED") {
    return new CliError(
      `the bank's rate limit is reached (${error.code ?? error.status}); rows fetched so far are kept, try again in about 6 hours`,
      ExitCode.rateLimit,
    );
  }
  return new CliError(error.message);
}

/** API fields are untrusted: anything but a string (or absent/null) fails the run with the field named. */
function optionalString(value: unknown, field: string, what = "transaction"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CliError(`API returned a ${what} with a non-string ${field}`);
  return value;
}

function optionalDay(value: unknown, field: string, what = "transaction"): string | null {
  const day = optionalString(value, field, what);
  if (day !== null && !isCalendarDay(day)) {
    throw new CliError(`API returned a ${what} with an invalid ${field}: ${JSON.stringify(day)}`);
  }
  return day;
}

interface Row {
  readonly status: string;
  /** Dedup key material: never transaction_id (unstable) and nothing that depends on the rest of the fetch. */
  readonly material: string;
  readonly undated: boolean;
  readonly day: string | null;
  readonly booking_date: string | null;
  readonly value_date: string | null;
  readonly transaction_date: string | null;
  readonly amount_minor: number;
  readonly currency: string;
  readonly indicator: string;
  readonly counterparty: string;
  readonly remittance: string;
  readonly entry_reference: string | null;
  readonly raw: Transaction;
}

function normalize(tx: Transaction): Row {
  const amountField: unknown = typeof tx === "object" && tx !== null ? tx.transaction_amount : undefined;
  if (typeof amountField !== "object" || amountField === null) throw new CliError("API returned a transaction without transaction_amount");
  const { amount, currency } = amountField as Record<string, unknown>;
  if (typeof amount !== "string" || typeof currency !== "string") {
    throw new CliError("API returned a transaction amount that is not a string pair");
  }
  const indicator = optionalString(tx.credit_debit_indicator, "credit_debit_indicator") ?? "";
  let amountMinor: number;
  try {
    amountMinor = toMinorUnits(amount, currency, indicator);
  } catch (error) {
    throw new CliError(`transaction_amount: ${(error as Error).message}`);
  }
  const lines: unknown = tx.remittance_information ?? [];
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
    throw new CliError("API returned a transaction whose remittance_information is not a list of strings");
  }
  const partyField = indicator === "DBIT" ? "creditor" : "debtor";
  const party: unknown = tx[partyField];
  if (party !== undefined && party !== null && (typeof party !== "object" || Array.isArray(party))) {
    throw new CliError(`API returned a transaction whose ${partyField} is not an object`);
  }
  const counterparty = party ? (optionalString((party as Record<string, unknown>)["name"], `${partyField}.name`) ?? "") : "";
  const booking = optionalDay(tx.booking_date, "booking_date");
  const value = optionalDay(tx.value_date, "value_date");
  const transaction = optionalDay(tx.transaction_date, "transaction_date");
  const reference = optionalString(tx.entry_reference, "entry_reference");
  const day = booking ?? value ?? transaction;
  const remittance = lines.join("\n");
  return {
    status: requiredStatus(tx.status),
    material: JSON.stringify([reference ?? "", day ?? "", amountMinor, currency, indicator, remittance, counterparty]),
    undated: day === null && (reference ?? "") === "",
    day,
    booking_date: booking,
    value_date: value,
    transaction_date: transaction,
    amount_minor: amountMinor,
    currency,
    indicator,
    counterparty,
    remittance,
    entry_reference: reference,
    raw: tx,
  };
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

/** State of one fetch run: occurrence counters span every page of the run, so identical rows stay distinct. */
class Run {
  readonly #occurrences = new Map<string, number>();
  readonly pending: Row[] = [];
  /** Pages stored so far; a retry is only safe while this is 0. */
  pages = 0;
  receivedBook = 0;
  skippedUndated = 0;
  earliestBook: string | null = null;

  keyFor(material: string, prefix: string): string {
    const n = this.#occurrences.get(prefix + material) ?? 0;
    this.#occurrences.set(prefix + material, n + 1);
    return `${prefix}${sha(material)}:${n}`;
  }
}

function insertRow(db: DatabaseSync, accountId: number, key: string, row: Row, now: Date): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO transactions (account_id, dedup_key, status, booking_date, value_date, transaction_date,
        amount_minor, currency, credit_debit_indicator, counterparty, remittance, entry_reference, raw_json, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      accountId,
      key,
      row.status,
      row.booking_date,
      row.value_date,
      row.transaction_date,
      row.amount_minor,
      row.currency,
      row.indicator,
      row.counterparty || null,
      row.remittance || null,
      row.entry_reference,
      JSON.stringify(row.raw),
      now.toISOString(),
    );
  return Number(result.changes) > 0;
}

/**
 * Follows continuation_key to the end with the same query. BOOK rows of each page are committed as the page
 * arrives (kept on a later failure); non-final rows are only collected, for the caller to commit as a snapshot.
 */
async function fetchRun(
  ctx: SyncContext,
  accountId: number,
  uid: string,
  query: TransactionQuery,
  inserted: InsertedRow[],
  run = new Run(),
): Promise<Run> {
  const seenKeys = new Set<string>();
  let continuation: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new CliError(`more than ${MAX_PAGES} pages for one account; aborting`);
    const result = await ctx.client.getTransactions(uid, query, continuation);
    const next = result.continuation_key;
    if (next !== null && seenKeys.has(next)) throw new CliError("API repeated a continuation_key; aborting before storing the page");
    const rows = result.transactions.map(normalize);
    lockedWrite(ctx.db, ctx.lockToken, () => {
      for (const row of rows) {
        if (row.status === "BOOK") {
          run.receivedBook++;
          if (row.undated) {
            run.skippedUndated++;
            continue;
          }
          run.earliestBook = minDate(run.earliestBook, row.day);
          if (insertRow(ctx.db, accountId, run.keyFor(row.material, ""), row, ctx.now)) inserted.push(describe(row));
        } else if (!DROPPED.has(row.status)) {
          run.pending.push(row);
        }
      }
    });
    run.pages++;
    if (next === null) return run;
    seenKeys.add(next);
    continuation = next;
  }
}

function account(db: DatabaseSync, id: number): AccountState {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountState | undefined;
  if (row === undefined) throw new CliError(`unknown account id ${id}`);
  return row;
}

/**
 * Opening step of every backfill attempt, run inside a locked write transaction: an unfinished previous attempt
 * is recorded (append-only) before the new one marks itself started.
 */
export function openBackfill(db: DatabaseSync, id: number, now: Date): Gap[] {
  const state = account(db, id);
  const gaps: Gap[] = [];
  if (state.backfill_started === 1 && state.backfill_done === 0) {
    gaps.push({ kind: "interrupted-backfill", recorded_at: now.toISOString() });
    const current = JSON.parse(state.history_gaps) as unknown[];
    db.prepare("UPDATE accounts SET history_gaps = ? WHERE id = ?").run(JSON.stringify([...current, ...gaps]), id);
  }
  db.prepare("UPDATE accounts SET backfill_started = 1, backfill_done = 0 WHERE id = ?").run(id);
  return gaps;
}

/** The pending snapshot is the whole account's non-final rows of the last complete fetch. */
function replacePending(ctx: SyncContext, accountId: number, run: Run): void {
  ctx.db.prepare("DELETE FROM transactions WHERE account_id = ? AND status != 'BOOK'").run(accountId);
  const local = new Run();
  for (const row of run.pending) insertRow(ctx.db, accountId, local.keyFor(row.material, "p:"), row, ctx.now);
}

interface StoredBalance {
  readonly balance_type: string;
  readonly currency: string;
  readonly amount_minor: number;
  readonly reference_date: string | null;
}

/** Balance fields are untrusted too; the sign of a balance is carried by its amount string. */
function normalizeBalance(balance: Balance): StoredBalance {
  if (balance.balance_type === "") throw new CliError("API returned a balance with an empty balance_type");
  const { amount, currency } = balance.balance_amount;
  let amountMinor: number;
  try {
    amountMinor = toMinorUnits(amount, currency, amount.startsWith("-") ? "DBIT" : "CRDT");
  } catch (error) {
    throw new CliError(`balance_amount: ${(error as Error).message}`);
  }
  return {
    balance_type: balance.balance_type,
    currency,
    amount_minor: amountMinor,
    reference_date: optionalDay(balance.reference_date, "reference_date", "balance"),
  };
}

function describe(row: Row): InsertedRow {
  return {
    date: row.day,
    amount: formatMinor(row.amount_minor, row.currency),
    amount_minor: row.amount_minor,
    currency: row.currency,
    label: row.remittance,
    counterparty: row.counterparty,
  };
}

interface Completion {
  readonly mode: AccountResult["mode"];
  /** Gaps to report; in backfill mode openBackfill has already stored them, incremental gaps are stored here. */
  readonly gaps: readonly Gap[];
  readonly warnings: readonly string[];
}

/**
 * After the last page: fetch balances, then in one locked transaction replace the pending snapshot and the
 * balances, advance the cursor and append gaps. A failed or malformed balances answer does not undo the complete
 * transaction fetch: the snapshot and cursor are committed with the previous balances kept, then the error is raised
 * (incremental sync) or reported as a warning (backfill, so `auth` completes).
 */
async function complete(ctx: SyncContext, accountId: number, uid: string, run: Run, inserted: readonly InsertedRow[], done: Completion): Promise<AccountResult> {
  let balances: StoredBalance[] | undefined;
  let balanceError: unknown;
  try {
    balances = (await ctx.client.getBalances(uid)).map(normalizeBalance);
  } catch (error) {
    balanceError = mapApiError(error);
  }
  const today = isoDate(ctx.now);
  const state = lockedWrite(ctx.db, ctx.lockToken, () => {
    replacePending(ctx, accountId, run);
    if (balances !== undefined) {
      ctx.db.prepare("DELETE FROM balances WHERE account_id = ?").run(accountId);
      const insertBalance = ctx.db.prepare(
        "INSERT OR REPLACE INTO balances (account_id, balance_type, currency, amount_minor, reference_date, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const b of balances) insertBalance.run(accountId, b.balance_type, b.currency, b.amount_minor, b.reference_date, ctx.now.toISOString());
    }
    const before = account(ctx.db, accountId);
    const gaps = [...(JSON.parse(before.history_gaps) as Gap[]), ...(done.mode === "incremental" ? done.gaps : [])];
    const coveredFrom = done.mode === "backfill" ? minDate(before.covered_from, run.earliestBook) : before.covered_from;
    ctx.db
      .prepare(
        `UPDATE accounts SET backfill_done = CASE WHEN ? THEN 1 ELSE backfill_done END, synced_through = ?, covered_from = ?,
           skipped_undated = skipped_undated + ?, history_gaps = ? WHERE id = ?`,
      )
      .run(done.mode === "backfill" ? 1 : 0, today, coveredFrom, run.skippedUndated, JSON.stringify(gaps), accountId);
    return before;
  });
  // During auth the consent and every booked row are already stored: a bank without a usable balances endpoint must
  // not fail the consent flow, so the backfill reports it as a warning. Incremental sync still fails the run.
  const warnings = [...done.warnings];
  if (balanceError !== undefined) {
    if (done.mode !== "backfill") throw balanceError;
    warnings.push(`balances not stored: ${balanceError instanceof Error ? balanceError.message : String(balanceError)}`);
  }
  return {
    account_id: state.id,
    name: state.name ?? state.identification_hash.slice(0, 12),
    mode: done.mode,
    received_book: run.receivedBook,
    inserted: inserted.length,
    inserted_rows: inserted,
    pending: run.pending.length,
    skipped_undated: run.skippedUndated,
    gaps_added: done.gaps,
    warnings,
  };
}

/** Full-history fetch with strategy=longest. The caller has already run openBackfill for this attempt. */
export async function backfillAccount(ctx: SyncContext, accountId: number, uid: string, openedGaps: readonly Gap[]): Promise<AccountResult> {
  const inserted: InsertedRow[] = [];
  let run: Run;
  try {
    run = await fetchRun(ctx, accountId, uid, { strategy: "longest", date_to: isoDate(ctx.now) }, inserted);
  } catch (error) {
    throw mapApiError(error);
  }
  return complete(ctx, accountId, uid, run, inserted, { mode: "backfill", gaps: openedGaps, warnings: [] });
}

/**
 * One account of `sync`: reruns the backfill while it is unfinished; otherwise fetches from
 * min(synced_through - 10 days, oldest stored dated pending row capped at 90 days) to today.
 * Past 80 days of downtime it asks for strategy=longest; a WRONG_TRANSACTIONS_PERIOD answer gets exactly one retry
 * without date_from. Both cases append an unserved-window gap from synced_through to the earliest booked row received.
 */
export async function syncAccount(ctx: SyncContext, accountId: number, uid: string): Promise<AccountResult> {
  const state = account(ctx.db, accountId);
  const through = state.synced_through;
  if (state.backfill_done !== 1 || through === null) {
    const gaps = lockedWrite(ctx.db, ctx.lockToken, () => openBackfill(ctx.db, accountId, ctx.now));
    return backfillAccount(ctx, accountId, uid, gaps);
  }
  const today = isoDate(ctx.now);
  const warnings: string[] = [];
  const oldest = ctx.db
    .prepare("SELECT min(coalesce(booking_date, value_date, transaction_date)) AS day FROM transactions WHERE account_id = ? AND status != 'BOOK'")
    .get(accountId) as { day: string | null };
  const cap = addDays(today, -PENDING_REACH_DAYS);
  if (oldest.day !== null && oldest.day < cap) {
    warnings.push(`pending rows dated before ${cap} are outside the sync window and are dropped unless the bank still returns them`);
  }
  const pendingFrom = oldest.day === null ? null : oldest.day < cap ? cap : oldest.day;
  const dateFrom = minDate(minDate(addDays(through, -OVERLAP_DAYS), pendingFrom), today) ?? today;
  const longDowntime = daysBetween(through, today) > LONG_DOWNTIME_DAYS;
  const query: TransactionQuery = longDowntime ? { date_from: dateFrom, date_to: today, strategy: "longest" } : { date_from: dateFrom, date_to: today };
  if (longDowntime) warnings.push(`last complete sync was ${through}; the bank may no longer serve all of that period`);
  const inserted: InsertedRow[] = [];
  let recovered = longDowntime;
  const first = new Run();
  let run: Run;
  try {
    try {
      run = await fetchRun(ctx, accountId, uid, query, inserted, first);
    } catch (error) {
      // Only a refusal of the first request is a refused window; later pages already stored rows of this run.
      if (first.pages > 0 || !(error instanceof ApiError && error.code === "WRONG_TRANSACTIONS_PERIOD")) throw error;
      recovered = true;
      warnings.push(`the bank refused date_from ${dateFrom} (WRONG_TRANSACTIONS_PERIOD); retried once without it`);
      run = await fetchRun(ctx, accountId, uid, { date_to: today, strategy: "longest" }, inserted);
    }
  } catch (error) {
    throw mapApiError(error);
  }
  // An empty interval (the recovery reached back to the cursor) is no gap.
  const reached = run.earliestBook ?? today;
  const gaps: Gap[] = recovered && reached > through ? [{ kind: "unserved-window", from: through, to: reached, recorded_at: ctx.now.toISOString() }] : [];
  return complete(ctx, accountId, uid, run, inserted, { mode: "incremental", gaps, warnings });
}

/** Account fields are untrusted: absent/null is stored as NULL, any other non-string refuses the session. */
function accountText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new CliError(`API returned an account with a non-string ${field}`);
  return value;
}

/**
 * Stores a new session and its accounts and opens a backfill attempt for each, in one locked transaction,
 * before any transaction is fetched: the POST /sessions response is shown only once.
 */
export function persistSession(ctx: SyncContext, session: Session): { id: number; uid: string; gaps: Gap[] }[] {
  const validUntil = session.access.valid_until;
  if (!isCalendarDay(validUntil.slice(0, 10)) || validUntil[10] !== "T" || !Number.isFinite(Date.parse(validUntil))) {
    throw new CliError(`API returned a session with an invalid access.valid_until: ${JSON.stringify(validUntil)}`);
  }
  for (const acc of session.accounts) {
    if (acc.uid === "" || acc.identification_hash === "") throw new CliError("API returned an account with an empty uid or identification_hash");
  }
  return lockedWrite(ctx.db, ctx.lockToken, () => {
    ctx.db
      .prepare("INSERT INTO sessions (id, aspsp_name, aspsp_country, valid_until, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(session.session_id, session.aspsp.name, session.aspsp.country, session.access.valid_until, ctx.now.toISOString());
    const upsert = ctx.db.prepare(
      `INSERT INTO accounts (identification_hash, aspsp_name, aspsp_country, name, iban, currency, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (identification_hash) DO UPDATE SET
         aspsp_name = excluded.aspsp_name, aspsp_country = excluded.aspsp_country, name = excluded.name,
         iban = excluded.iban, currency = excluded.currency, raw_json = excluded.raw_json
       RETURNING id`,
    );
    const link = ctx.db.prepare("INSERT INTO session_accounts (session_id, account_id, uid) VALUES (?, ?, ?)");
    return session.accounts.map((acc) => {
      const identification: unknown = acc.account_id;
      if (identification !== undefined && identification !== null && (typeof identification !== "object" || Array.isArray(identification))) {
        throw new CliError("API returned an account whose account_id is not an object");
      }
      const iban: unknown = identification ? (identification as Record<string, unknown>)["iban"] : undefined;
      const row = upsert.get(
        acc.identification_hash,
        session.aspsp.name,
        session.aspsp.country,
        accountText(acc.name, "name"),
        accountText(iban, "account_id.iban"),
        accountText(acc.currency, "currency"),
        JSON.stringify(acc),
      ) as { id: number };
      link.run(session.session_id, row.id, acc.uid);
      return { id: row.id, uid: acc.uid, gaps: openBackfill(ctx.db, row.id, ctx.now) };
    });
  });
}

function requiredStatus(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new CliError("API returned a transaction whose status is not a non-empty string");
  return value;
}
