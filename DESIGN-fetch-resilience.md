# Design: calendar refresh must survive a fetch that never comes back

## Problem

Each calendar refreshes itself as a chain: fetch -> Google API callback -> schedule the
next fetch. The "schedule the next fetch" step lives *inside* the API callback.

If that callback never fires, the chain ends. Nothing logs, nothing errors, the module
just stops refreshing that calendar until MagicMirror is restarted. Observed in
production Aug 2026: a multi-day DNS outage on the mirror made googleapis' internal
OAuth token refresh reject out-of-band, so `events.list` never invoked its callback.
All eight calendars died one at a time between Aug 8 and Aug 22 and the display sat
frozen on late-August events for eleven days.

## Requirements

1. Every fetch attempt schedules the next one, whatever the outcome: success, API
   error, thrown exception, or no response at all.
2. A request that never settles must not stall the loop. Cap it with a timeout and
   treat expiry as a failed attempt.
3. At most one pending timer per (calendar, module instance). No runaway doubling.
4. `stop()` still ends the loop and leaves no timers behind.
5. Notifications to the frontend (`CALENDAR_EVENTS`, `CALENDAR_ERROR`) are unchanged.

## Design

- `fetchCalendar` becomes async and uses the promise form of `events.list`.
- The request races a timeout of half the fetch interval (floor 30s), so a hung
  request costs at most half a cycle before the loop recovers.
- Rescheduling moves to a `finally` block: it runs on every path out of the function.
- Error handling is wrapped so a bug in error classification cannot escape and skip
  the reschedule.
- `scheduleNextCalendarFetch` keys timers by `identifier|calendarID`, clearing any
  existing timer before arming a new one.
