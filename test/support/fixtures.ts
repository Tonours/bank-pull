import type { Session, Transaction } from "../../src/enable-banking.js";
import type { FakeApi } from "./fake-api.js";

/**
 * Synthetic fixtures only: every name, reference and amount is made up. Account numbers use the
 * `FR00 TEST ...` pattern, whose check digits 00 are never valid, so no real IBAN can ever match.
 */
export const BANK = { name: "Synthetic Bank", country: "FR" } as const;

export function syntheticIban(n: number): string {
  return `FR00 TEST 0000 0000 ${String(n).padStart(4, "0")}`;
}

export interface FakeSession {
  readonly code: string;
  readonly session: Session;
  readonly uids: string[];
}

export function session(id: string, accounts: number, code = "code-1"): FakeSession {
  const uids = Array.from({ length: accounts }, (_, i) => `${id}-uid-${i}`);
  const list = uids.map((uid, i) => ({
    uid,
    identification_hash: `hash-${i}`,
    name: `Synthetic account ${i}`,
    currency: "EUR",
    account_id: { iban: syntheticIban(i) },
  }));
  return { code, uids, session: { session_id: id, accounts: list, aspsp: BANK, access: { valid_until: "2099-01-01T00:00:00.000Z" } } };
}

let txSeq = 0;
/** A synthetic booked transaction with a unique reference and label. */
export function tx(overrides: Partial<Transaction> & { amount?: string } = {}): Transaction {
  txSeq++;
  const { amount, ...rest } = overrides;
  return {
    entry_reference: `REF-${txSeq}`,
    transaction_amount: { currency: "EUR", amount: amount ?? `${txSeq}.00` },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: "2026-11-01",
    value_date: "2026-11-01",
    remittance_information: [`SYNTHETIC SHOP ${txSeq}`],
    creditor: { name: `Shop ${txSeq}` },
    ...rest,
  };
}

/** Serves the session for its code, and per account uid the given transaction pages. */
export function install(api: FakeApi, s: FakeSession, pages: Transaction[][][]): void {
  api.state.sessionsByCode.set(s.code, s.session);
  s.uids.forEach((uid, i) => api.state.pages.set(uid, pages[i] ?? [[]]));
}
