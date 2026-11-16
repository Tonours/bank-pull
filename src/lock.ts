import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CliError, ExitCode } from "./errors.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs fn inside BEGIN IMMEDIATE; rolls back on any error. */
export function writeTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Takes the single sync lock row, reclaiming it only from a dead holder. Returns the owner token. */
export function acquireLock(db: DatabaseSync, now: Date): string {
  return writeTransaction(db, () => {
    const row = db.prepare("SELECT pid, started_at FROM sync_lock WHERE id = 1").get() as
      | { pid: number; started_at: string }
      | undefined;
    if (row !== undefined && alive(row.pid)) {
      throw new CliError(`another bank-pull sync or auth is running (pid ${row.pid}, since ${row.started_at})`, ExitCode.locked);
    }
    const token = randomUUID();
    db.prepare("INSERT OR REPLACE INTO sync_lock (id, pid, token, started_at) VALUES (1, ?, ?, ?)").run(
      process.pid,
      token,
      now.toISOString(),
    );
    return token;
  });
}

/** A write transaction that aborts unless the caller still owns the lock. */
export function lockedWrite<T>(db: DatabaseSync, token: string, fn: () => T): T {
  return writeTransaction(db, () => {
    const row = db.prepare("SELECT token FROM sync_lock WHERE id = 1").get() as { token: string } | undefined;
    if (row?.token !== token) throw new CliError("sync lock lost to another process; aborting without writing", ExitCode.locked);
    return fn();
  });
}

export function releaseLock(db: DatabaseSync, token: string): void {
  db.prepare("DELETE FROM sync_lock WHERE token = ?").run(token);
}
