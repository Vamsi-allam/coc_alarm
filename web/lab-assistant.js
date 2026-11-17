export const HOUR = 60 * 60 * 1000;
export const WORKDAY = 23 * HOUR;
export const HELPER_TYPES = {
  Lab: { name: "Lab Assistant", maxLevel: 12, action: "Assign assistant" },
  Builder: { name: "Builder's Apprentice", maxLevel: 8, action: "Assign apprentice" },
};

export function helperKey(accountKey, helperType = "Lab") {
  return JSON.stringify([accountKey, helperType]);
}

export function sharedWorkdayEnd(plans, accountKey, now) {
  const ends = [...plans].filter((plan) => plan.accountKey === accountKey)
    .map((plan) => labAssistantAvailability(plan, now).workdayEnd)
    .filter((end) => end > now);
  return ends.length ? Math.max(...ends) : null;
}

export function forecastLabAssistant(start, baseFinish, workdayEnd, level, repeat, helperType = "Lab") {
  let remaining = baseFinish - start;
  const helper = HELPER_TYPES[helperType];
  if (!helper || !Number.isFinite(remaining) || remaining <= 0 || !Number.isInteger(level) || level < 1 || level > helper.maxLevel
      || workdayEnd <= start || workdayEnd > start + WORKDAY) {
    throw new Error("Invalid helper assignment.");
  }
  const nextSession = Math.max(workdayEnd, start + HOUR);
  const rate = level + 1;
  const firstWork = Math.min(HOUR, remaining / rate);
  remaining -= firstWork * rate;
  let cursor = start + firstWork;
  if (remaining > 0 && repeat) {
    const gap = nextSession - cursor;
    if (remaining > gap) {
      remaining -= gap;
      const cycles = Math.max(0, Math.ceil(remaining / (WORKDAY + level * HOUR)) - 1);
      remaining -= cycles * (WORKDAY + level * HOUR);
      cursor = nextSession + cycles * WORKDAY;
      const work = Math.min(HOUR, remaining / rate);
      remaining -= work * rate;
      cursor += work;
    }
  }
  return { projectedFinish: cursor + remaining, nextSession };
}

export function savedLabTime(plan, now) {
  if (!plan.timerId || !plan.projectedFinish) return plan.savedMs || 0;
  const end = Math.min(now, plan.projectedFinish);
  const firstWork = Math.max(0, Math.min(HOUR, end - plan.startedAt));
  let work = firstWork;
  if (plan.repeat && end > plan.nextSession) {
    const elapsed = end - plan.nextSession;
    work += Math.floor(elapsed / WORKDAY) * HOUR + Math.min(HOUR, elapsed % WORKDAY);
  }
  return (plan.savedMs || 0) + work * plan.level;
}

export function remainingLabTime(plan, now) {
  const savedThisAssignment = savedLabTime(plan, now) - (plan.savedMs || 0);
  return Math.max(0, plan.baseFinish - now - savedThisAssignment);
}

export function labAssistantAvailability(plan, now) {
  if (!plan) return { available: true, availableAt: now };
  let startedAt = plan.startedAt;
  let workdayEnd = plan.workdayEnd;
  let workUntil = plan.workUntil;
  if (plan.repeat && plan.timerId && plan.projectedFinish > plan.nextSession && now >= plan.nextSession) {
    const lastPossible = Math.min(now, plan.projectedFinish - 1);
    const cycles = Math.floor((lastPossible - plan.nextSession) / WORKDAY);
    startedAt = plan.nextSession + cycles * WORKDAY;
    workdayEnd = startedAt + WORKDAY;
    workUntil = Math.min(startedAt + HOUR, plan.projectedFinish);
  }
  const availableAt = Math.max(workdayEnd, workUntil);
  return { available: now >= availableAt && !(plan.repeat && plan.timerId && now < plan.projectedFinish), availableAt, startedAt, workdayEnd };
}
