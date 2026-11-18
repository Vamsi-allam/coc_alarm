import test from "node:test";
import assert from "node:assert/strict";
import { applyClock, clockReadyAt, clockRemaining, clockSaved } from "./clock-tower.js";

const start = Date.UTC(2026, 0, 1);
const minute = 60000;
const boost = { startedAt: start, endsAt: start + 30 * minute };
const timer = (village = "Night Village", builderType = "Builder", duration = 600 * minute) => ({
  village, builderType, finishAt: new Date(start + duration).toISOString(),
});

test("20-, 30-, and 32-minute boosts each leave a full 22-hour cooldown at boost end", () => {
  for (const [duration, expectedReady] of [[20, "22:20"], [30, "22:30"], [32, "22:32"]]) {
    const endsAt = start + duration * minute;
    const readyAt = clockReadyAt(endsAt);
    assert.equal(new Date(readyAt).toISOString(), `2026-01-01T${expectedReady}:00.000Z`);
    assert.equal(readyAt - endsAt, 22 * 60 * minute);
  }
});

test("Clock Tower progresses at 10x without deducting future savings immediately", () => {
  const row = applyClock(timer(), boost, start);
  assert.equal(clockRemaining(row, start), 600 * minute);
  assert.equal(clockRemaining(row, start + 1000), 600 * minute - 10000);
  assert.equal(clockSaved(row, start + 1000), 9000);
  assert.equal(Date.parse(row.finishAt), start + 330 * minute);
  assert.equal(clockRemaining(row, boost.endsAt), 300 * minute);
  assert.equal(clockRemaining(row, boost.endsAt + 1000), 300 * minute - 1000);
  assert.equal(clockSaved(row, boost.endsAt + minute), 270 * minute);
});

test("short upgrades stop accruing savings when complete", () => {
  const row = applyClock(timer("Night Village", "Lab", 10 * minute), boost, start);
  assert.equal(Date.parse(row.finishAt), start + minute);
  assert.equal(clockRemaining(row, start + minute), 0);
  assert.equal(clockSaved(row, start + minute - 1000), 9 * (minute - 1000));
  assert.equal(clockRemaining(row, start + minute), 0);
  assert.equal(clockSaved(row, start + minute), null);
  assert.equal(clockSaved(row, start + 30 * minute), null);
});

test("only Night Builders and Labs receive the boost", () => {
  for (const [village, type, eligible] of [
    ["Night Village", "Builder", true], ["Night Village", "Lab", true],
    ["Home Village", "Builder", false], ["Home Village", "Lab", false],
    ["Home Village", "Pet House", false], ["Night Village", "Pet House", false],
  ]) {
    const row = applyClock(timer(village, type), boost, start);
    assert.equal(row.clockStartedAt !== null, eligible);
  }
});

test("timers set during a boost use only its remaining duration and reset prior savings", () => {
  const now = start + 20 * minute;
  const row = applyClock({ ...timer(), clockStartedAt: start, clockEndsAt: boost.endsAt, clockSavedMs: 100 }, boost, now, true);
  assert.equal(row.clockSavedMs, 0);
  assert.equal(clockSaved(row, now), 0);
  assert.equal(clockRemaining(row, now), 580 * minute);
  assert.equal(Date.parse(row.finishAt), start + 510 * minute);
  assert.equal(applyClock(timer(), boost, boost.endsAt).clockStartedAt, null);
});

test("another boost keeps savings from the previous boost on the same upgrade", () => {
  const long = timer("Night Village", "Builder", 6000 * minute);
  const first = applyClock(long, boost, start);
  const next = clockReadyAt(boost.endsAt);
  const second = applyClock(first, { startedAt: next, endsAt: next + 30 * minute }, next);
  assert.equal(clockSaved(second, next), 270 * minute);
  assert.equal(clockSaved(second, next + minute), 279 * minute);
});
