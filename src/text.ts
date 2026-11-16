const UNSAFE = /[\p{Cc}\p{Bidi_Control}]/gu;
const UNSAFE_ONE = /[\p{Cc}\p{Bidi_Control}]/u;
const UNSAFE_EXCEPT_LINES = /(?![\t\n])[\p{Cc}\p{Bidi_Control}]/u;

/** Bank-controlled text is printed without control or bidi characters (no terminal escapes, no visually reordered line). */
export const printable = (text: string): string => text.replace(UNSAFE, "?");

/** True when `text` holds a control or bidi character; `allowLines` lets newlines and tabs through. */
export function hasUnsafeChars(text: string, allowLines = false): boolean {
  return (allowLines ? UNSAFE_EXCEPT_LINES : UNSAFE_ONE).test(text);
}
