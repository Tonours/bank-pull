/**
 * Offline read surfaces shared by the CLI and the MCP server. This module and its imports never reach
 * the network, the API client or the signing key, and every connection here is opened read-only.
 */
import { constants, type DatabaseSync, type SQLInputValue } from "node:sqlite";
import { currencyExponent, formatMinor } from "./amount.js";
import type { Paths } from "./config.js";
import { isCalendarDay } from "./day.js";
import { openReadOnly } from "./db.js";
import { CliError, ExitCode } from "./errors.js";

export const QUERY_DEFAULT_ROWS = 500;
export const QUERY_MAX_ROWS = 5000;
export const TRANSACTIONS_DEFAULT_LIMIT = 100;
export const TRANSACTIONS_MAX_LIMIT = 5000;

const usage = (message: string): CliError => new CliError(message, ExitCode.usage);

export interface BalanceView {
  readonly balance_type: string;
  readonly currency: string;
  readonly amount: string;
  readonly amount_minor: number;
  readonly reference_date: string | null;
  readonly fetched_at: string;
}

export interface AccountView {
  readonly account_id: number;
  readonly name: string | null;
  readonly iban: string | null;
  readonly currency: string | null;
  readonly bank: string;
  readonly synced_through: string | null;
  readonly balances: readonly BalanceView[];
}

/** Balances as last fetched (sync replaces them per account), optionally for one account. */
export function listBalances(db: DatabaseSync, accountId?: number): (BalanceView & { readonly account_id: number })[] {
  const rows = db
    .prepare(
      `SELECT account_id, balance_type, currency, amount_minor, reference_date, fetched_at FROM balances
        WHERE ?1 IS NULL OR account_id = ?1 ORDER BY account_id, balance_type, currency`,
    )
    .all(accountId ?? null) as { account_id: number; balance_type: string; currency: string; amount_minor: number; reference_date: string | null; fetched_at: string }[];
  return rows.map((r) => ({ ...r, amount: formatMinor(r.amount_minor, r.currency) }));
}

export function listAccounts(db: DatabaseSync): AccountView[] {
  const balances = listBalances(db);
  const rows = db
    .prepare("SELECT id, name, iban, currency, aspsp_name, aspsp_country, synced_through FROM accounts ORDER BY id")
    .all() as { id: number; name: string | null; iban: string | null; currency: string | null; aspsp_name: string; aspsp_country: string; synced_through: string | null }[];
  return rows.map((r) => ({
    account_id: r.id,
    name: r.name,
    iban: r.iban,
    currency: r.currency,
    bank: `${r.aspsp_name} (${r.aspsp_country})`,
    synced_through: r.synced_through,
    balances: balances.filter((b) => b.account_id === r.id).map(({ account_id: _id, ...b }) => b),
  }));
}

export interface TransactionFilter {
  readonly accountId?: number;
  /** Inclusive `YYYY-MM-DD` bounds on the transaction day (booking, else value, else transaction date). */
  readonly from?: string;
  readonly to?: string;
  /** Case-insensitive (ASCII) substring of the label, counterparty or note. */
  readonly text?: string;
  /** Exact category; the empty string selects uncategorized rows. */
  readonly category?: string;
  /** A stored status (`BOOK`, `PDNG`, ...) or `pending` for every non-booked row. */
  readonly status?: string;
  /** Inclusive bounds on the signed amount, as decimal strings in each row's currency (`-12.30`). */
  readonly minAmount?: string;
  readonly maxAmount?: string;
  readonly limit?: number;
}

export interface TransactionView {
  readonly id: number;
  readonly account_id: number;
  readonly status: string;
  readonly date: string | null;
  readonly booking_date: string | null;
  readonly value_date: string | null;
  readonly transaction_date: string | null;
  readonly amount: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly counterparty: string | null;
  readonly label: string | null;
  readonly entry_reference: string | null;
  readonly category: string | null;
  readonly note: string | null;
}

export interface TransactionPage {
  readonly transactions: TransactionView[];
  /** True when more rows matched than `limit`. */
  readonly truncated: boolean;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const STATUS = /^[A-Z]{4}$/;

function day(value: string, flag: string): string {
  if (!isCalendarDay(value)) throw usage(`${flag} must be a date YYYY-MM-DD (got "${value}")`);
  return value;
}

function boundedInt(value: number, flag: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw usage(`${flag} must be an integer between 1 and ${max}`);
  return value;
}

/**
 * A decimal bound to minor units of `currency`, rounded so the integer comparison is exact: up for a lower
 * bound, down for an upper one (`-12.30` is -13 JPY as an upper bound). Clamped to +-2^53, just outside every stored (safe-integer) amount, so the comparison stays exact.
 */
function boundMinor(amount: string, currency: string, round: "up" | "down"): number {
  const [, sign = "", integer = "0", fraction = ""] = DECIMAL.exec(amount) ?? [];
  const exponent = currencyExponent(currency);
  const digits = fraction.padEnd(exponent, "0");
  let minor = BigInt(integer + digits.slice(0, exponent));
  if (sign === "-") minor = -minor;
  if (/[1-9]/.test(digits.slice(exponent))) {
    if (round === "up" && sign === "") minor += 1n;
    if (round === "down" && sign === "-") minor -= 1n;
  }
  const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  return Number(minor > beyond ? beyond : minor < -beyond ? -beyond : minor);
}

/** Amount bounds are decimal, so they are converted once per stored currency (exponents differ: EUR 2, JPY 0). */
function amountClause(db: DatabaseSync, filter: TransactionFilter, params: SQLInputValue[]): string | undefined {
  const bounds = [
    ["--min-amount", filter.minAmount, ">=", "up"],
    ["--max-amount", filter.maxAmount, "<=", "down"],
  ] as const;
  const active = bounds.filter(([flag, value]) => {
    if (value === undefined) return false;
    if (!DECIMAL.test(value)) throw usage(`${flag} must be a decimal amount such as -12.30 (got "${value}")`);
    return true;
  });
  if (active.length === 0) return undefined;
  const currencies = (db.prepare("SELECT DISTINCT currency FROM transactions ORDER BY currency").all() as { currency: string }[]).map((r) => r.currency);
  if (currencies.length === 0) return "0";
  const perCurrency = currencies.map((currency) => {
    params.push(currency);
    const parts = ["t.currency = ?"];
    for (const [, value, op, round] of active) {
      params.push(boundMinor(value ?? "", currency, round));
      parts.push(`t.amount_minor ${op} ?`);
    }
    return `(${parts.join(" AND ")})`;
  });
  return `(${perCurrency.join(" OR ")})`;
}

const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Filtered transactions, newest first; every filter value is a bound parameter. */
export function searchTransactions(db: DatabaseSync, filter: TransactionFilter = {}): TransactionPage {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const dayExpr = "COALESCE(t.booking_date, t.value_date, t.transaction_date)";
  if (filter.accountId !== undefined) {
    if (!Number.isSafeInteger(filter.accountId) || filter.accountId < 1) throw usage("--account must be an account id (see bank-pull accounts)");
    where.push("t.account_id = ?");
    params.push(filter.accountId);
  }
  if (filter.from !== undefined) {
    where.push(`${dayExpr} >= ?`);
    params.push(day(filter.from, "--from"));
  }
  if (filter.to !== undefined) {
    where.push(`${dayExpr} <= ?`);
    params.push(day(filter.to, "--to"));
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) throw usage("--from must not be after --to");
  if (filter.text !== undefined) {
    if (filter.text === "") throw usage("--text must not be empty");
    where.push("(t.remittance LIKE ? ESCAPE '\\' OR t.counterparty LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\')");
    const pattern = likePattern(filter.text);
    params.push(pattern, pattern, pattern);
  }
  if (filter.category !== undefined) {
    if (filter.category === "") where.push("t.category IS NULL");
    else {
      where.push("t.category = ?");
      params.push(filter.category);
    }
  }
  if (filter.status !== undefined) {
    if (filter.status === "pending") where.push("t.status != 'BOOK'");
    else if (STATUS.test(filter.status)) {
      where.push("t.status = ?");
      params.push(filter.status);
    } else throw usage(`--status must be BOOK, PDNG, HOLD, SCHD, OTHR or pending (got "${filter.status}")`);
  }
  const amounts = amountClause(db, filter, params);
  if (amounts !== undefined) where.push(amounts);
  const limit = boundedInt(filter.limit ?? TRANSACTIONS_DEFAULT_LIMIT, "--limit", TRANSACTIONS_MAX_LIMIT);
  params.push(limit + 1);
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, t.status, ${dayExpr} AS date, t.booking_date, t.value_date, t.transaction_date,
              t.amount_minor, t.currency, t.counterparty, t.remittance AS label, t.entry_reference, t.category, t.note
         FROM transactions t ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY date DESC NULLS LAST, t.id DESC LIMIT ?`,
    )
    .all(...params) as Omit<TransactionView, "amount">[];
  return {
    transactions: rows.slice(0, limit).map((r) => ({ ...r, amount: formatMinor(r.amount_minor, r.currency) })),
    truncated: rows.length > limit,
  };
}

/** Index just past the quoted run opening at `start`. A doubled quote (`'it''s'`) needs no special case: it scans as two adjacent runs. */
function skipQuoted(sql: string, start: number): number {
  const close = sql[start] === "[" ? "]" : sql[start] ?? "";
  const end = sql.indexOf(close, start + 1);
  return end === -1 ? sql.length : end + 1;
}

const SQL_SPACE = new Set([" ", "\t", "\n", "\r", "\f"]);
const QUOTES = new Set(["'", '"', "`", "["]);

/**
 * Throws unless `sql` holds exactly one statement: after the first `;` outside literals and comments only
 * whitespace, comments and further `;` may follow. Needed because prepare() silently ignores trailing statements.
 */
export function assertSingleStatement(sql: string): void {
  let ended = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] ?? "";
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === ";") {
      ended = true;
      i++;
    } else if (SQL_SPACE.has(c)) {
      i++;
    } else if (ended) {
      throw usage("query must be a single statement; remove everything after the first ';'");
    } else {
      i = QUOTES.has(c) ? skipQuoted(sql, i) : i + 1;
    }
  }
}

const ALLOWED_ACTIONS = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);
const DENIED_FUNCTIONS = new Set(["load_extension"]);

/** SQLite authorizer: reads only. Denies ATTACH, PRAGMA (also table-valued pragma_*), temp DDL, writes, VACUUM. */
function readOnlyAuthorizer(action: number, _arg1: string | null, arg2: string | null): number {
  if (!ALLOWED_ACTIONS.has(action)) return constants.SQLITE_DENY;
  if (action === constants.SQLITE_FUNCTION && DENIED_FUNCTIONS.has((arg2 ?? "").toLowerCase())) return constants.SQLITE_DENY;
  return constants.SQLITE_OK;
}

/** Integers beyond Number.MAX_SAFE_INTEGER come back as decimal strings, never rounded; infinities as "Infinity"/"-Infinity". */
export type QueryValue = string | number | null;

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, QueryValue>[];
  /** True when the statement returned more than `maxRows` rows. */
  readonly truncated: boolean;
}

/** Blobs come back as `x'..'` hex text so JSON output stays readable. */
function plain(value: unknown): QueryValue {
  if (value instanceof Uint8Array) return `x'${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "number" && !Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  return value as QueryValue;
}

/**
 * Runs one user- or agent-supplied SELECT on its own read-only connection with the authorizer allow-list,
 * returning at most `maxRows` rows. The connection never migrates and creates no file.
 */
export function guardedQuery(paths: Paths, sql: string, maxRows: number = QUERY_DEFAULT_ROWS): QueryResult {
  const cap = boundedInt(maxRows, "--max-rows", QUERY_MAX_ROWS);
  if (sql.trim() === "") throw usage("query is empty");
  assertSingleStatement(sql);
  const db = openReadOnly(paths);
  try {
    if (typeof db.setAuthorizer !== "function") {
      throw new CliError("this Node.js has no DatabaseSync#setAuthorizer; bank-pull needs Node.js 24.10 or newer for query");
    }
    db.setAuthorizer(readOnlyAuthorizer);
    let statement;
    try {
      statement = db.prepare(sql);
    } catch (error) {
      throw usage(`query refused (read-only SELECT only): ${(error as Error).message}`);
    }
    const columns = statement.columns().map((column) => column.name);
    const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
    if (duplicate !== undefined) throw usage(`query returns two columns named "${duplicate}"; give each one a distinct alias (AS ...)`);
    statement.setReadBigInts(true);
    const rows: Record<string, QueryValue>[] = [];
    let truncated = false;
    try {
      for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
        if (rows.length === cap) {
          truncated = true;
          break;
        }
        rows.push(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plain(value)])));
      }
    } catch (error) {
      throw new CliError(`query failed: ${(error as Error).message}`);
    }
    return { columns, rows, truncated };
  } finally {
    db.close();
  }
}
