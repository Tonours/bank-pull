const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day `YYYY-MM-DD` that exists (so string order is date order). */
export function isCalendarDay(day: string): boolean {
  const time = Date.parse(`${day}T00:00:00Z`);
  return ISO_DAY.test(day) && Number.isFinite(time) && new Date(time).toISOString().startsWith(day);
}
