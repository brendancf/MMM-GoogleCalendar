/**
 * Tests for the calendar refresh loop's resilience.
 *
 * See DESIGN-fetch-resilience.md. The loop must always arm the next fetch, even when
 * the Google API call errors, throws, or never calls back at all.
 *
 * Run with: npm test
 */
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

// --- stub out MagicMirror core + googleapis before loading the helper ---------

const noop = () => {};
const LogStub = { log: noop, info: noop, warn: noop, error: noop, debug: noop };

const NodeHelperStub = {
  create: (definition) => definition,
  checkFetchError: () => "MODULE_ERROR_UNSPECIFIED"
};

// Each test installs its own events.list implementation here.
let eventsList = () => Promise.resolve({ data: { items: [] } });
const googleStub = {
  google: {
    calendar: () => ({ events: { list: (...args) => eventsList(...args) } }),
    auth: { OAuth2: function () {} }
  }
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node_helper") return NodeHelperStub;
  if (request === "logger") return LogStub;
  if (request === "googleapis") return googleStub;
  return originalLoad.call(this, request, ...rest);
};

const helperDefinition = require(path.join(__dirname, "..", "node_helper.js"));

Module._load = originalLoad;

// --- test harness ------------------------------------------------------------

const FETCH_INTERVAL = 1000;

/**
 * Build a helper instance with timers and notifications captured rather than real.
 * @returns {object} the helper, plus `timers` and `sent` recording arrays.
 */
function makeHelper() {
  const helper = Object.create(helperDefinition);
  const timers = [];
  const sent = [];

  helper.name = "MMM-GoogleCalendar";
  helper.path = __dirname;
  helper.sendSocketNotification = (notification, payload) =>
    sent.push({ notification, payload });
  helper.start();
  helper.config = {};
  helper.calendarService = googleStub.google.calendar();

  // Capture scheduling instead of waiting on real time.
  helper.setTimeout = (fn, delay) => {
    const timer = { fn, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  helper.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  helper.timers = timers;
  helper.sent = sent;
  return helper;
}

/**
 * @param {object} helper harness helper
 * @returns {Array} timers that are still armed
 */
const pending = (helper) => helper.timers.filter((t) => !t.cleared);

const fetchOnce = (helper) =>
  helper.fetchCalendar("cal@example.com", FETCH_INTERVAL, 15, "module_1");

// --- tests -------------------------------------------------------------------

test("arms the next fetch after a successful load", async () => {
  const helper = makeHelper();
  eventsList = () =>
    Promise.resolve({ data: { items: [{ summary: "Standup" }] } });

  await fetchOnce(helper);

  assert.strictEqual(pending(helper).length, 1, "next fetch should be armed");
  assert.ok(
    helper.sent.some((s) => s.notification === "CALENDAR_EVENTS"),
    "events should still reach the frontend"
  );
});

test("arms the next fetch after the API returns an error", async () => {
  const helper = makeHelper();
  eventsList = () =>
    Promise.reject(Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
      code: "EAI_AGAIN"
    }));

  await fetchOnce(helper);

  assert.strictEqual(pending(helper).length, 1, "next fetch should be armed");
  assert.ok(
    helper.sent.some((s) => s.notification === "CALENDAR_ERROR"),
    "the frontend should be told about the failure"
  );
});

test("arms the next fetch when the API call throws synchronously", async () => {
  const helper = makeHelper();
  eventsList = () => {
    throw new Error("client not initialised");
  };

  await fetchOnce(helper);

  assert.strictEqual(pending(helper).length, 1, "next fetch should be armed");
});

test("arms the next fetch when the request never settles", async () => {
  // The production failure: googleapis' token refresh rejected out of band and the
  // callback was never invoked, so the chain ended silently.
  const helper = makeHelper();
  eventsList = () => new Promise(() => {});

  const inFlight = fetchOnce(helper);

  const armed = pending(helper);
  assert.strictEqual(armed.length, 1, "a request timeout should be armed");
  armed[0].cleared = true; // the timer has fired
  armed[0].fn(); // expire the request
  await inFlight;

  assert.strictEqual(
    pending(helper).length,
    1,
    "a hung request must not end the refresh loop"
  );
});

test("keeps at most one pending fetch per calendar", async () => {
  const helper = makeHelper();
  eventsList = () => Promise.resolve({ data: { items: [] } });

  await fetchOnce(helper);
  await fetchOnce(helper);
  await fetchOnce(helper);

  assert.strictEqual(pending(helper).length, 1, "timers should not accumulate");
});

test("stops scheduling once the helper is stopped", async () => {
  const helper = makeHelper();
  eventsList = () => Promise.resolve({ data: { items: [] } });

  helper.stop();
  await fetchOnce(helper);

  assert.strictEqual(pending(helper).length, 0, "a stopped helper arms nothing");
});

test("filters events that have no title without killing the loop", async () => {
  const helper = makeHelper();
  helper.config = { excludedEvents: ["cancelled"] };
  eventsList = () =>
    Promise.resolve({ data: { items: [{ summary: "Standup" }, {}] } });

  await fetchOnce(helper);

  assert.strictEqual(pending(helper).length, 1, "next fetch should be armed");
  const broadcast = helper.sent.find((s) => s.notification === "CALENDAR_EVENTS");
  assert.ok(broadcast, "untitled events must not break the broadcast");
});
