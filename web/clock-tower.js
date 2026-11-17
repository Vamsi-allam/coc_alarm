export const CLOCK_RATE = 10;
export const CLOCK_COOLDOWN = 22 * 60 * 60 * 1000;

export function clockEligible(row) {
  return row.village === "Night Village" && ["Builder", "Lab"].includes(row.builderType || "Builder");
}

export function clockSaved(row, now) {
  if (row.clockStartedAt == null) return null;
  const end = Math.min(now, row.clockEndsAt, Date.parse(row.finishAt));
  return (row.clockSavedMs || 0) + Math.max(0, end - row.clockStartedAt) * (CLOCK_RATE - 1);
}

export function clockRemaining(row, now) {
  return Math.max(0, row.clockBaseFinish - now - (clockSaved(row, now) - (row.clockSavedMs || 0)));
}

export function applyClock(row, boost, now, reset = false) {
  const result = {
    ...row, clockStartedAt: null, clockEndsAt: null, clockBaseFinish: null, clockSavedMs: 0,
  };
  if (!clockEligible(row) || !boost || boost.endsAt <= now || Date.parse(row.finishAt) <= now) return result;
  const baseFinish = Date.parse(row.finishAt);
  const remaining = baseFinish - now;
  const work = Math.min(boost.endsAt - now, remaining / CLOCK_RATE);
  return {
    ...result,
    clockStartedAt: now,
    clockEndsAt: boost.endsAt,
    clockBaseFinish: baseFinish,
    clockSavedMs: reset ? 0 : (clockSaved(row, now) ?? 0),
    finishAt: new Date(Math.floor(baseFinish - work * (CLOCK_RATE - 1))).toISOString(),
  };
}
