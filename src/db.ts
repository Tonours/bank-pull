import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertPrivate, ensurePrivateDir, ensurePrivateFile, rethrowDenied, type Paths } from "./config.js";
import { CliError, ExitCode } from "./errors.js";
import { hasUnsafeChars } from "./text.js";

/** Exported for the migration test only. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    identification_hash TEXT NOT NULL UNIQUE,
    aspsp_name TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    name TEXT,
    iban TEXT,
    currency TEXT,
    raw_json TEXT NOT NULL,
    synced_through TEXT,
    backfill_started INTEGER NOT NULL DEFAULT 0,
    backfill_done INTEGER NOT NULL DEFAULT 0,
    covered_from TEXT,
    history_gaps TEXT NOT NULL DEFAULT '[]',
    skipped_undated INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    aspsp_name TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;

  CREATE TABLE session_accounts (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    uid TEXT NOT NULL,
    PRIMARY KEY (session_id, account_id)
  ) STRICT;

  CREATE TABLE balances (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    balance_type TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    reference_date TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (account_id, balance_type, currency)
  ) STRICT;

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    dedup_key TEXT NOT NULL,
    status TEXT NOT NULL,
    booking_date TEXT,
    value_date TEXT,
    transaction_date TEXT,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    credit_debit_indicator TEXT NOT NULL,
    counterparty TEXT,
    remittance TEXT,
    entry_reference TEXT,
    raw_json TEXT NOT NULL,
    category TEXT,
    note TEXT,
    first_seen_at TEXT NOT NULL,
    UNIQUE (account_id, dedup_key)
  ) STRICT;

  CREATE INDEX transactions_account_date ON transactions (account_id, booking_date);

  CREATE TABLE sync_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    token TEXT NOT NULL,
    started_at TEXT NOT NULL
  ) STRICT;
  `,
  /** 2: transaction ids are never reused (AUTOINCREMENT), so an id printed before a sync can never name another row. */
  `
  CREATE TABLE transactions_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    dedup_key TEXT NOT NULL,
    status TEXT NOT NULL,
    booking_date TEXT,
    value_date TEXT,
    transaction_date TEXT,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    credit_debit_indicator TEXT NOT NULL,
    counterparty TEXT,
    remittance TEXT,
    entry_reference TEXT,
    raw_json TEXT NOT NULL,
    category TEXT,
    note TEXT,
    first_seen_at TEXT NOT NULL,
    UNIQUE (account_id, dedup_key)
  ) STRICT;
  INSERT INTO transactions_v2 SELECT * FROM transactions;
  DROP TABLE transactions;
  ALTER TABLE transactions_v2 RENAME TO transactions;
  CREATE INDEX transactions_account_date ON transactions (account_id, booking_date);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function tooNew(version: number): CliError {
  return new CliError(`database schema version ${version} is newer than this bank-pull (${SCHEMA_VERSION}); upgrade bank-pull`);
}

function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = userVersion(db);
    if (current > SCHEMA_VERSION) throw tooNew(current);
    if (current < SCHEMA_VERSION) {
      for (let version = current; version < SCHEMA_VERSION; version++) db.exec(MIGRATIONS[version] ?? "");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Any journal left next to the DB (ours or another tool's) must pass the same gate. */
function assertSidecarsPrivate(dbFile: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (lstatSync(dbFile + suffix, { throwIfNoEntry: false }) !== undefined) assertPrivate(dbFile + suffix, "file");
  }
}

/**
 * Opens the database read-write, creating directory and file with private modes, and migrates it.
 * Uses the rollback journal, not WAL: a WAL read-only open creates -wal/-shm, and reads must create nothing.
 */
export function openReadWrite(paths: Paths): DatabaseSync {
  ensurePrivateDir(paths.dataDir);
  ensurePrivateFile(paths.dbFile);
  assertSidecarsPrivate(paths.dbFile);
  const db = new DatabaseSync(paths.dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;");
    migrate(db);
    assertSidecarsPrivate(paths.dbFile);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** True when the SQLite header says WAL (read/write versions 2), where a read-only open would create -wal/-shm. */
function isWalFormat(dbFile: string): boolean {
  const header = Buffer.alloc(20);
  let fd: number;
  try {
    fd = openSync(dbFile, "r");
  } catch (error) {
    rethrowDenied(error, dbFile);
  }
  try {
    return readSync(fd, header, 0, 20, 0) === 20 && (header[18] === 2 || header[19] === 2);
  } finally {
    closeSync(fd);
  }
}

/** Opens an existing database read-only; never creates or migrates anything. */
export function openReadOnly(paths: Paths): DatabaseSync {
  assertPrivate(paths.dataDir, "dir");
  assertPrivate(paths.dbFile, "file");
  assertSidecarsPrivate(paths.dbFile);
  if (isWalFormat(paths.dbFile)) {
    throw new CliError(`${paths.dbFile} is in WAL mode; run "bank-pull sync" once to convert it`);
  }
  const db = new DatabaseSync(paths.dbFile, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const version = userVersion(db);
    if (version > SCHEMA_VERSION) throw tooNew(version);
    if (version < SCHEMA_VERSION) {
      throw new CliError(`database schema version ${version}, expected ${SCHEMA_VERSION}; run "bank-pull sync" to migrate`);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** An append-only entry of `accounts.history_gaps`: history in or before this range may be incomplete. */
export type Gap =
  | { readonly kind: "interrupted-backfill"; readonly recorded_at: string }
  | { readonly kind: "unserved-window"; readonly from: string; readonly to: string; readonly recorded_at: string };

export const CONSENT_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

export interface AccountStatus {
  readonly account_id: number;
  readonly name: string | null;
  readonly bank: string;
  readonly synced_through: string | null;
  readonly backfill_done: boolean;
  readonly covered_from: string | null;
  readonly booked: number;
  readonly pending: number;
  readonly skipped_undated: number;
  readonly history_gaps: readonly Gap[];
  readonly consent_valid_until: string | null;
  readonly consent_days_left: number | null;
  readonly warnings: readonly string[];
}

/** Latest consent of an account (revoked sessions are deleted), or undefined. */
export function latestSession(db: DatabaseSync, accountId: number): { id: string; uid: string; valid_until: string } | undefined {
  return db
    .prepare(
      `SELECT s.id, sa.uid, s.valid_until FROM sessions s JOIN session_accounts sa ON sa.session_id = s.id
        WHERE sa.account_id = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
    )
    .get(accountId) as { id: string; uid: string; valid_until: string } | undefined;
}

/** Offline sync health per account: cursor, consent expiry, gaps. Read-only; shared by CLI `status`, `sync` and MCP `sync_status`. */
export function syncStatus(db: DatabaseSync, now: Date): AccountStatus[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.aspsp_name, a.aspsp_country, a.synced_through, a.backfill_done, a.covered_from,
              a.skipped_undated, a.history_gaps,
              (SELECT count(*) FROM transactions t WHERE t.account_id = a.id AND t.status = 'BOOK') AS booked,
              (SELECT count(*) FROM transactions t WHERE t.account_id = a.id AND t.status != 'BOOK') AS pending
         FROM accounts a ORDER BY a.id`,
    )
    .all() as {
    id: number;
    name: string | null;
    aspsp_name: string;
    aspsp_country: string;
    synced_through: string | null;
    backfill_done: number;
    covered_from: string | null;
    skipped_undated: number;
    history_gaps: string;
    booked: number;
    pending: number;
  }[];
  return rows.map((row) => {
    const gaps = JSON.parse(row.history_gaps) as Gap[];
    const validUntil = latestSession(db, row.id)?.valid_until ?? null;
    const warnings: string[] = [];
    const daysLeft = validUntil === null ? null : Math.floor((Date.parse(validUntil) - now.getTime()) / DAY_MS);
    if (validUntil === null) warnings.push('no active consent; run "bank-pull auth"');
    else if (Date.parse(validUntil) <= now.getTime()) warnings.push('consent expired; run "bank-pull auth"');
    else if (daysLeft !== null && daysLeft < CONSENT_WARNING_DAYS) warnings.push(`consent expires in ${daysLeft} day(s); run "bank-pull auth" soon`);
    if (row.backfill_done !== 1) warnings.push('initial backfill not complete; run "bank-pull sync"');
    for (const gap of gaps) {
      warnings.push(
        gap.kind === "interrupted-backfill"
          ? `an initial backfill was interrupted; history before ${row.covered_from ?? "the first booked row"} may be shorter than the bank's initial window`
          : `history gap: booked transactions between ${gap.from} and ${gap.to} may be missing`,
      );
    }
    if (row.skipped_undated > 0) warnings.push(`${row.skipped_undated} booked row(s) without any date or reference were skipped`);
    return {
      account_id: row.id,
      name: row.name,
      bank: `${row.aspsp_name} (${row.aspsp_country})`,
      synced_through: row.synced_through,
      backfill_done: row.backfill_done === 1,
      covered_from: row.covered_from,
      booked: Number(row.booked),
      pending: Number(row.pending),
      skipped_undated: row.skipped_undated,
      history_gaps: gaps,
      consent_valid_until: validUntil,
      consent_days_left: daysLeft,
      warnings,
    };
  });
}

export const CATEGORY_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 1000;

export interface CategoryUpdate {
  /** New category; the empty string clears it. Omitted keeps the current value. */
  readonly category?: string;
  /** New note; the empty string clears it. Omitted keeps the current value. */
  readonly note?: string;
}

/** Category and note are shown in terminals and to agents: no control or bidi characters (the note may hold newlines and tabs). */
function checkText(value: string | undefined, field: string, max: number, allowLines: boolean): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.length > max) throw new CliError(`--${field} is longer than ${max} characters`, ExitCode.usage);
  if (hasUnsafeChars(value, allowLines)) throw new CliError(`--${field} must not contain control characters`, ExitCode.usage);
  return value === "" ? null : value;
}

/** Validates a categorize request before any database is opened; empty values become NULL. */
export function checkCategoryUpdate(transactionId: number, update: CategoryUpdate): { category: string | null | undefined; note: string | null | undefined } {
  if (!Number.isSafeInteger(transactionId) || transactionId < 1) throw new CliError("transaction id must be a positive integer", ExitCode.usage);
  const category = checkText(update.category, "category", CATEGORY_MAX_LENGTH, false);
  const note = checkText(update.note, "note", NOTE_MAX_LENGTH, true);
  if (category === undefined && note === undefined) throw new CliError("give --category and/or --note (an empty value clears it)", ExitCode.usage);
  return { category, note };
}

/**
 * The one write outside sync, shared by CLI `categorize` and MCP `set_category`: a single fixed UPDATE that can
 * only touch `category` and `note` of one transaction. Sync never writes these columns, so no sync lock is needed.
 */
export function setCategory(db: DatabaseSync, transactionId: number, update: CategoryUpdate): { id: number; category: string | null; note: string | null } {
  const { category, note } = checkCategoryUpdate(transactionId, update);
  const row = db
    .prepare(
      `UPDATE transactions SET category = iif(?1, ?2, category), note = iif(?3, ?4, note) WHERE id = ?5 AND status = 'BOOK'
        RETURNING id, category, note`,
    )
    .get(category === undefined ? 0 : 1, category ?? null, note === undefined ? 0 : 1, note ?? null, transactionId) as
    | { id: number; category: string | null; note: string | null }
    | undefined;
  if (row === undefined) {
    const found = db.prepare("SELECT status FROM transactions WHERE id = ?").get(transactionId) as { status: string } | undefined;
    if (found === undefined) throw new CliError(`no transaction with id ${transactionId} (see bank-pull transactions)`);
    throw new CliError(`transaction ${transactionId} is not booked (${found.status}); pending rows are replaced on every sync, categorize it once booked`);
  }
  return row;
}
