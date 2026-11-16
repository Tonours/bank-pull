import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertPrivate, ensurePrivateDir, ensurePrivateFile, rethrowDenied, type Paths } from "./config.js";
import { CliError } from "./errors.js";

const MIGRATIONS: readonly string[] = [
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
    for (let version = current; version < SCHEMA_VERSION; version++) db.exec(MIGRATIONS[version] ?? "");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
