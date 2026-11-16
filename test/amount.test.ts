import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toMinorUnits } from "../src/amount.js";

const cases: readonly [string, string, string, number][] = [
  ["0.29", "EUR", "CRDT", 29],
  ["1234567.89", "EUR", "CRDT", 123456789],
  ["12.30", "EUR", "DBIT", -1230],
  ["12.3", "EUR", "DBIT", -1230],
  ["-12.30", "EUR", "DBIT", -1230],
  ["-12.30", "EUR", "CRDT", 1230],
  ["5", "JPY", "CRDT", 5],
  ["5.0", "JPY", "CRDT", 5],
  ["1.234", "BHD", "DBIT", -1234],
  ["70368744177664.01", "EUR", "CRDT", 7036874417766401],
  ["90071992547409.91", "EUR", "CRDT", 9007199254740991],
  ["1.2300", "EUR", "CRDT", 123],
  ["0", "EUR", "CRDT", 0],
];

for (const [amount, currency, indicator, expected] of cases) {
  test(`${amount} ${currency} ${indicator} -> ${expected}`, () => {
    assert.equal(toMinorUnits(amount, currency, indicator), expected);
  });
}

for (const [amount, currency, indicator, message] of [
  ["90071992547409.92", "EUR", "CRDT", /too large/],
  ["1.2345", "EUR", "CRDT", /more decimals/],
  ["5.1", "JPY", "CRDT", /more decimals/],
  ["1,00", "EUR", "CRDT", /invalid amount/],
  ["1e3", "EUR", "CRDT", /invalid amount/],
  ["", "EUR", "CRDT", /invalid amount/],
  [" 1.00", "EUR", "CRDT", /invalid amount/],
  ["1.00", "eur", "CRDT", /invalid currency/],
  ["1.23", "QQQ", "CRDT", /invalid currency/],
  ["1.00", "EUR", "", /credit_debit_indicator/],
] as const) {
  test(`refuses ${JSON.stringify(amount)} ${currency} ${JSON.stringify(indicator)}`, () => {
    assert.throws(() => toMinorUnits(amount, currency, indicator), message);
  });
}
test("a zero debit is plain 0, never -0", () => {
  assert.ok(Object.is(toMinorUnits("0.00", "EUR", "DBIT"), 0));
});
