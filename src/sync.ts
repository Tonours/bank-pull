import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { toMinorUnits } from "./amount.js";
import { ApiError, type EnableBankingClient, type Session, type Transaction, type TransactionQuery } from "./enable-banking.js";
import { CliError, ExitCode } from "./errors.js";
import { lockedWrite } from "./lock.js";

const MAX_PAGES = 10_000;
/** Cancelled and rejected rows are never stored; every other non-BOOK status is part of the pending snapshot. */
const DROPPED = new Set(["CNCL", "RJCT"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface Gap {
  readonly kind: "interrupted-backfill";
  readonly recorded_at: string;
}

export interface AccountResult {
  readonly account_id: number;
  readonly name: string;
  readonly received_book: number;
  readonly inserted: number;
  readonly pending: number;
  readonly skipped_undated: number;
  readonly gaps_added: readonly Gap[];
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
  readonly backfill_started: number;
  readonly backfill_done: number;
  readonly covered_from: string | null;
  readonly history_gaps: string;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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
function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CliError(`API returned a transaction with a non-string ${field}`);
  return value;
}

/** A calendar day `YYYY-MM-DD` that exists (so string order is date order). */
function isCalendarDay(day: string): boolean {
  const time = Date.parse(`${day}T00:00:00Z`);
  return ISO_DAY.test(day) && Number.isFinite(time) && new Date(time).toISOString().startsWith(day);
}

function optionalDay(value: unknown, field: string): string | null {
  const day = optionalString(value, field);
  if (day !== null && !isCalendarDay(day)) {
    throw new CliError(`API returned a transaction with an invalid ${field}: ${JSON.stringify(day)}`);
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
  receivedBook = 0;
  inserted = 0;
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
async function fetchRun(ctx: SyncContext, accountId: number, uid: string, query: TransactionQuery): Promise<Run> {
  const run = new Run();
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
          if (insertRow(ctx.db, accountId, run.keyFor(row.material, ""), row, ctx.now)) run.inserted++;
        } else if (!DROPPED.has(row.status)) {
          run.pending.push(row);
        }
      }
    });
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

/** Full-history fetch with strategy=longest. The caller has already run openBackfill for this attempt. */
export async function backfillAccount(ctx: SyncContext, accountId: number, uid: string, openedGaps: readonly Gap[]): Promise<AccountResult> {
  const today = isoDate(ctx.now);
  let run: Run;
  try {
    run = await fetchRun(ctx, accountId, uid, { strategy: "longest", date_to: today });
  } catch (error) {
    throw mapApiError(error);
  }
  const state = lockedWrite(ctx.db, ctx.lockToken, () => {
    replacePending(ctx, accountId, run);
    const before = account(ctx.db, accountId);
    ctx.db
      .prepare("UPDATE accounts SET backfill_done = 1, synced_through = ?, covered_from = ?, skipped_undated = skipped_undated + ? WHERE id = ?")
      .run(today, minDate(before.covered_from, run.earliestBook), run.skippedUndated, accountId);
    return before;
  });
  return {
    account_id: state.id,
    name: state.name ?? state.identification_hash.slice(0, 12),
    received_book: run.receivedBook,
    inserted: run.inserted,
    pending: run.pending.length,
    skipped_undated: run.skippedUndated,
    gaps_added: openedGaps,
  };
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
