import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUR, WORKDAY, helperKey, sharedWorkdayEnd, forecastLabAssistant, savedLabTime, remainingLabTime, labAssistantAvailability } from "./lab-assistant.js";

test("the Apprentice supports levels 1-8 and applies its bonus gradually", () => {
  const forecast = forecastLabAssistant(0, 20 * HOUR, WORKDAY, 8, false, "Builder");
  const plan = { timerId: "builder-1", startedAt: 0, baseFinish: 20 * HOUR, level: 8, repeat: false, ...forecast };
  assert.equal(remainingLabTime(plan, 1000), 20 * HOUR - 9000);
  assert.equal(savedLabTime(plan, HOUR), 8 * HOUR);
  assert.equal(forecast.projectedFinish, 12 * HOUR);
  assert.throws(() => forecastLabAssistant(0, 20 * HOUR, WORKDAY, 9, false, "Builder"));
  assert.doesNotThrow(() => forecastLabAssistant(0, 20 * HOUR, WORKDAY, 12, false, "Lab"));
});

test("the two helpers use independent state keys even for accounts containing separators", () => {
  assert.notEqual(helperKey("account", "Lab"), helperKey("account", "Builder"));
  assert.equal(helperKey("account"), helperKey("account", "Lab"));
  assert.notEqual(helperKey("account|Builder", "Lab"), helperKey("account", "Builder"));
});

test("helpers reuse their account's shared workday including repeated sessions", () => {
  const plan = {
    accountKey: "account", timerId: "lab-1", startedAt: 0, workdayEnd: WORKDAY,
    workUntil: HOUR, nextSession: WORKDAY, projectedFinish: 60 * HOUR, repeat: true,
  };
  assert.equal(sharedWorkdayEnd([plan], "account", 3 * HOUR), WORKDAY);
  assert.equal(sharedWorkdayEnd([plan], "account", 24 * HOUR), 46 * HOUR);
  assert.equal(sharedWorkdayEnd([plan], "different", 3 * HOUR), null);
  assert.equal(sharedWorkdayEnd([{ ...plan, repeat: false }], "account", 24 * HOUR), null);
});

test("the countdown applies a level-one bonus gradually for one hour", () => {
  const forecast = forecastLabAssistant(0, 10 * HOUR, WORKDAY, 1, false);
  const plan = { timerId: "1", startedAt: 0, baseFinish: 10 * HOUR, level: 1, repeat: false, ...forecast };
  assert.equal(remainingLabTime(plan, 0), 10 * HOUR);
  assert.equal(remainingLabTime(plan, 1000), 10 * HOUR - 2000);
  assert.equal(remainingLabTime(plan, HOUR / 2), 9 * HOUR);
  assert.equal(remainingLabTime(plan, HOUR), 8 * HOUR);
  assert.equal(remainingLabTime(plan, 2 * HOUR), 7 * HOUR);
});

test("the countdown applies repeated and previously saved time only once", () => {
  const forecast = forecastLabAssistant(0, 50 * HOUR, 5 * HOUR, 2, true);
  const plan = { timerId: "1", startedAt: 0, baseFinish: 50 * HOUR, level: 2, repeat: true, savedMs: HOUR, ...forecast };
  assert.equal(remainingLabTime(plan, 0), 50 * HOUR);
  assert.equal(remainingLabTime(plan, 2 * HOUR), 46 * HOUR);
  assert.equal(remainingLabTime(plan, 5.5 * HOUR), 41.5 * HOUR);
  assert.equal(remainingLabTime(plan, forecast.projectedFinish), 0);
});

test("short upgrades finish when live progress reaches zero", () => {
  const forecast = forecastLabAssistant(0, HOUR, WORKDAY, 2, false);
  const plan = { timerId: "1", startedAt: 0, baseFinish: HOUR, level: 2, repeat: false, ...forecast };
  assert.equal(remainingLabTime(plan, 10 * 60 * 1000), HOUR / 2);
  assert.equal(remainingLabTime(plan, forecast.projectedFinish), 0);
  assert.equal(remainingLabTime(plan, HOUR), 0);
});

test("one hour of work saves the assistant's level in hours", () => {
  const forecast = forecastLabAssistant(0, 10 * HOUR, WORKDAY, 2, false);
  assert.equal(forecast.projectedFinish, 8 * HOUR);
  const plan = { timerId: "1", startedAt: 0, workdayEnd: WORKDAY, workUntil: HOUR, level: 2, repeat: false, ...forecast };
  assert.equal(savedLabTime(plan, HOUR / 2), HOUR);
  assert.equal(savedLabTime(plan, 3 * HOUR), 2 * HOUR);
  assert.equal(labAssistantAvailability(plan, WORKDAY - 1).available, false);
  assert.equal(labAssistantAvailability(plan, WORKDAY).available, true);
});

test("reassigning the same upgrade retains time saved by earlier assignments", () => {
  const forecast = forecastLabAssistant(0, 10 * HOUR, WORKDAY, 3, false);
  const plan = { timerId: "1", startedAt: 0, level: 3, repeat: false, savedMs: 2 * HOUR, ...forecast };
  assert.equal(savedLabTime(plan, HOUR / 2), 3.5 * HOUR);
  assert.equal(savedLabTime({ ...plan, projectedFinish: null, savedMs: 3.5 * HOUR }, HOUR), 3.5 * HOUR);
});

test("short research stops assistant work when the upgrade finishes", () => {
  const forecast = forecastLabAssistant(0, HOUR, WORKDAY, 2, true);
  assert.equal(forecast.projectedFinish, HOUR / 3);
  const plan = { timerId: "1", startedAt: 0, workdayEnd: WORKDAY, workUntil: HOUR / 3, level: 2, repeat: true, ...forecast };
  assert.equal(savedLabTime(plan, HOUR), 2 * HOUR / 3);
  assert.equal(labAssistantAvailability(plan, WORKDAY).available, true);
});

test("repeat uses an already-started shared workday and then 23-hour workdays", () => {
  const forecast = forecastLabAssistant(0, 50 * HOUR, 5 * HOUR, 2, true);
  assert.equal(forecast.nextSession, 5 * HOUR);
  assert.equal(forecast.projectedFinish, 44 * HOUR);
  const plan = { timerId: "1", startedAt: 0, workdayEnd: 5 * HOUR, workUntil: HOUR, level: 2, repeat: true, ...forecast };
  assert.equal(savedLabTime(plan, 29 * HOUR), 6 * HOUR);
  assert.equal(labAssistantAvailability(plan, 6 * HOUR).available, false);
  assert.equal(labAssistantAvailability(plan, 51 * HOUR).availableAt, 51 * HOUR);
});

test("a shared workday ending during work waits until the current hour ends", () => {
  const forecast = forecastLabAssistant(0, 10 * HOUR, HOUR / 2, 1, true);
  assert.equal(forecast.nextSession, HOUR);
  assert.equal(forecast.projectedFinish, 8 * HOUR);
});

test("completion at a workday boundary does not start another session", () => {
  const forecast = forecastLabAssistant(0, 50 * HOUR, WORKDAY, 2, true);
  assert.equal(forecast.projectedFinish, 46 * HOUR);
  const plan = { timerId: "1", startedAt: 0, workdayEnd: WORKDAY, workUntil: HOUR, level: 2, repeat: true, ...forecast };
  assert.equal(savedLabTime(plan, 50 * HOUR), 4 * HOUR);
  assert.equal(labAssistantAvailability(plan, 50 * HOUR).available, true);
});

test("rejects invalid levels, workdays, and completed upgrades", () => {
  assert.throws(() => forecastLabAssistant(0, 4 * HOUR, WORKDAY, 13, false));
  assert.throws(() => forecastLabAssistant(0, 4 * HOUR, 24 * HOUR, 2, true));
  assert.throws(() => forecastLabAssistant(0, 0, WORKDAY, 1, false));
});
