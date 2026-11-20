const test = require("node:test");
const assert = require("node:assert");
const moment = require("moment");

// Mock global Module and moment for MMM-GoogleCalendar
global.moment = moment;
let registeredModule = null;
global.Module = {
  register: (name, definition) => {
    registeredModule = definition;
  }
};

require("../MMM-GoogleCalendar.js");

function createInstance(configOverrides = {}) {
  const instance = Object.create(registeredModule);
  instance.config = Object.assign(
    {
      wrapEvents: false,
      maxTitleLength: 30,
      maxTitleLines: 1,
      showLocation: true,
      calendars: [
        {
          name: "Ellie work",
          calendarID: "ellie@ridgedata.ai",
          showLocation: "physical",
          mergeAdjacentBusy: true,
          mergeBusyGapMs: 900000, // 15 min
          titleReplace: {
            "/^[\\s\\S]*$/": "Work — Busy"
          }
        },
        {
          name: "Brendan",
          calendarID: "brendancf@gmail.com"
        }
      ]
    },
    configOverrides
  );
  return instance;
}

const baseDay = "2026-11-20";

function makeEvent(calId, summary, startHour, startMin, endHour, endMin, location = null, isAllDay = false) {
  const startMoment = moment(`${baseDay}T${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}:00`);
  const endMoment = moment(`${baseDay}T${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}:00`);

  const ev = {
    calendarID: calId,
    summary: summary,
    title: summary,
    startDate: startMoment.valueOf(),
    endDate: endMoment.valueOf(),
    start: isAllDay ? { date: baseDay } : { dateTime: startMoment.toISOString() },
    end: isAllDay ? { date: baseDay } : { dateTime: endMoment.toISOString() }
  };
  if (location) {
    ev.location = location;
  }
  return ev;
}

test("consolidates two back-to-back busy meetings into one line item", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "1:1 with Alice", 9, 0, 9, 30);
  const e2 = makeEvent("ellie@ridgedata.ai", "Daily Standup", 9, 30, 10, 0);

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, e2]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].startDate, e1.startDate);
  assert.strictEqual(merged[0].endDate, e2.endDate);
  assert.strictEqual(inst.getPlaceholderBusyLabel(merged[0]), "Work — Busy");
});

test("consolidates back-to-back meetings even when location (e.g. Zoom, conference room) is set", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "1:1 with Bob", 9, 0, 9, 30, "Zoom");
  const e2 = makeEvent("ellie@ridgedata.ai", "Team Sync", 9, 30, 10, 0, "Conference Room B");

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, e2]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].startDate, e1.startDate);
  assert.strictEqual(merged[0].endDate, e2.endDate);
  assert.strictEqual(merged[0].location, undefined);
  assert.strictEqual(inst.getPlaceholderBusyLabel(merged[0]), "Work — Busy");
});

test("consolidates three consecutive meetings into one block", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "Meeting 1", 9, 0, 9, 30);
  const e2 = makeEvent("ellie@ridgedata.ai", "Meeting 2", 9, 30, 10, 0);
  const e3 = makeEvent("ellie@ridgedata.ai", "Meeting 3", 10, 0, 10, 30);

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, e2, e3]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].startDate, e1.startDate);
  assert.strictEqual(merged[0].endDate, e3.endDate);
});

test("consolidates overlapping meetings into one span", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "Meeting 1", 9, 0, 10, 0);
  const e2 = makeEvent("ellie@ridgedata.ai", "Meeting 2", 9, 30, 10, 30);

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, e2]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].startDate, e1.startDate);
  assert.strictEqual(merged[0].endDate, e2.endDate);
});

test("consolidates meetings with gap within mergeBusyGapMs (10 min gap <= 15 min)", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "Meeting 1", 9, 0, 9, 30);
  const e2 = makeEvent("ellie@ridgedata.ai", "Meeting 2", 9, 40, 10, 15); // 10 min gap

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, e2]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].startDate, e1.startDate);
  assert.strictEqual(merged[0].endDate, e2.endDate);
});

test("does NOT consolidate meetings with gap exceeding mergeBusyGapMs (30 min gap > 15 min)", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "Meeting 1", 9, 0, 9, 30);
  const e2 = makeEvent("ellie@ridgedata.ai", "Meeting 2", 10, 0, 10, 30); // 30 min gap

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, e2]);
  assert.strictEqual(merged.length, 2);
});

test("consolidates back-to-back meetings into a single Work — Busy line item", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "Prep sync", 9, 0, 9, 30);
  const e2 = makeEvent("ellie@ridgedata.ai", "Customer Demo with Acme", 9, 30, 10, 30);

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, e2]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].startDate, e1.startDate);
  assert.strictEqual(merged[0].endDate, e2.endDate);
  assert.strictEqual(inst.getPlaceholderBusyLabel(merged[0]), "Work — Busy");
});

test("does not merge across midnight / days", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "Late call", 23, 30, 23, 55);
  const nextDay = moment(e1.startDate).add(1, "day").format("YYYY-MM-DD");
  const e2 = {
    calendarID: "ellie@ridgedata.ai",
    summary: "Early call",
    title: "Early call",
    startDate: moment(`${nextDay}T00:05:00`).valueOf(),
    endDate: moment(`${nextDay}T00:30:00`).valueOf(),
    start: { dateTime: `${nextDay}T00:05:00` },
    end: { dateTime: `${nextDay}T00:30:00` }
  };

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, e2]);
  assert.strictEqual(merged.length, 2);
});

test("preserves non-merge calendars and interleaves them correctly", () => {
  const inst = createInstance();
  const e1 = makeEvent("ellie@ridgedata.ai", "Ellie Sync 1", 9, 0, 9, 30);
  const b1 = makeEvent("brendancf@gmail.com", "Brendan Coffee", 9, 15, 9, 45);
  const e2 = makeEvent("ellie@ridgedata.ai", "Ellie Sync 2", 9, 30, 10, 0);

  const merged = inst.mergeAdjacentBusyPlaceholders([e1, b1, e2]);
  assert.strictEqual(merged.length, 2);
  // Merged Ellie event starts at 9:00, Brendan starts at 9:15
  assert.strictEqual(merged[0].calendarID, "ellie@ridgedata.ai");
  assert.strictEqual(merged[0].startDate, e1.startDate);
  assert.strictEqual(merged[0].endDate, e2.endDate);
  assert.strictEqual(merged[1].calendarID, "brendancf@gmail.com");
  assert.strictEqual(merged[1].title, "Brendan Coffee");
});

test("titleTransform handles null/undefined title safely", () => {
  const inst = createInstance();
  const titleReplace = { "/foo/": "bar" };
  assert.doesNotThrow(() => {
    inst.titleTransform(undefined, titleReplace, false, 30, 1);
    inst.titleTransform(null, titleReplace, false, 30, 1);
  });
});
