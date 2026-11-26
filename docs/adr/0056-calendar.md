# 56. A calendar of the month, with every birthday on it

- **Status:** proposed
- **Date:** 2026-11-26
- **Extends** [ADR 0050](0050-scheduled-events.md) and [ADR 0055](0055-birthdays.md)

## Context

Events and birthdays are on the server, but the app shows them only as a list (the Events
panel) and a carousel of what is about to start. Nobody can look at a month and see when
things are, and a birthday appears only on the day itself, so nobody can see one coming.

## Decision

**A calendar of one month**, opened from a button in the Events panel's heading. It is a grid
of six weeks starting on the first weekday of the app's language, with the picked day listed
beside it. Each day shows its birthdays, then its events by start, up to three, then "+N
more". The arrows and Page Up/Down move the day and the month; "Today" comes back.

- **Clicking an event opens it**, in the same dialog as the Events panel's: answer, join,
  change or cancel there. A day from today on has "Schedule on this day", which opens a new
  event on that day, at the hour a new one would start today.
- **Repeating events are forecast.** The server keeps one occurrence (ADR 0050); the
  calendar steps it forward as the server's `nextStart` will, and shows the later
  occurrences lighter, dashed, saying the answers are for the next one only. The step is
  copied in `desktop/src/renderer/schedule/calendar.ts`, and both must change together.
- **An event over midnight is on each day it touches**, in the machine's own time zone.

**Every birthday is visible to everyone signed in, all year.**
`GET /api/schedule/birthdays` answers, to any session, the day and month (`MM-DD`), the
account id and the name of each active account that is not a bot and has given one: no year,
no email. A birthday falls on its day and month in the viewer's own calendar; February 29
falls on the 28th in other years, as on the server. The server's all-day birthday event
(ADR 0055) is not drawn twice; it stays what the party and the bell go by.
`PUT /api/birthday` now sends `schedule` on the stream, so open calendars read the list again.

An app on a server before this gets `404` and shows the birthday events the server already
has, today's alone.

## Consequences

- **This changes what ADR 0055 promised.** A birthday was visible to everyone only on the
  day; now it is visible every day of the year to everyone let in. The sign-up and Settings
  hint says so. For one group of friends that is the point; a server where people do not
  know each other would want a setting to keep one's own off the calendar, which there is not.
- **The forecast can be wrong.** A repeating event that is changed or cancelled changes all
  of its forecast at once, and an occurrence cannot be skipped (ADR 0050). Daily and weekly
  steps are UTC: across a change of clocks a forecast moves by an hour, as the event will.
- **Past events are mostly gone.** The server deletes an event a week after it starts, so
  earlier months show birthdays and little else. Keeping a history would be a decision about
  storage, not about the calendar.
- **The birthdays list is the whole server.** Fine at a few dozen accounts; a list of
  thousands would want to be asked for by month.
- The Android viewer has no calendar.
