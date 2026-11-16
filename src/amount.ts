const AMOUNT = /^-?(\d+)(?:\.(\d+))?$/;
const CURRENCY = /^[A-Z]{3}$/;

export function currencyExponent(currency: string): number {
  if (!CURRENCY.test(currency) || !Intl.supportedValuesOf("currency").includes(currency)) {
    throw new Error(`invalid currency code: ${JSON.stringify(currency)}`);
  }
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * Converts a decimal amount string to signed integer minor units by string arithmetic.
 * The sign comes from the credit/debit indicator, never from the string.
 */
export function toMinorUnits(amount: string, currency: string, indicator: string): number {
  const match = AMOUNT.exec(amount);
  if (match === null) throw new Error(`invalid amount: ${JSON.stringify(amount)}`);
  if (indicator !== "CRDT" && indicator !== "DBIT") throw new Error(`invalid credit_debit_indicator: ${JSON.stringify(indicator)}`);
  const exponent = currencyExponent(currency);
  const integer = match[1] ?? "0";
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > exponent) throw new Error(`amount ${amount} has more decimals than ${currency} allows (${exponent})`);
  const minor = BigInt(integer + fraction.padEnd(exponent, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`amount ${amount} ${currency} is too large`);
  const value = Number(minor);
  return indicator === "DBIT" && value !== 0 ? -value : value;
}


/** Signed integer minor units back to a decimal string (`-1230` EUR -> `"-12.30"`), for display and JSON. */
export function formatMinor(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const digits = Math.abs(minor).toString().padStart(exponent + 1, "0");
  const integer = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : "";
  return `${minor < 0 ? "-" : ""}${integer}${fraction}`;
}
