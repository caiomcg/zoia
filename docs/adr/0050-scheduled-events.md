# 50. Scheduled events, with answers and a call when they start

- **Status:** proposed
- **Date:** 2026-11-05

## Context

People arrange to play together ("ranked night, Friday at nine") in the chat, where the plan
scrolls away, nobody knows who said yes, and nothing reminds anyone when the time comes.

## Decision

**An event is a title, a start, a length, a channel, an optional description and how it
repeats**, with everyone's answer: going, maybe, or not.

- **Its length** is from five minutes to fourteen days (`duration_minutes`, schema version 6);
  an event from before lengths lasts two hours. The app asks for an end date and time, as it
  asks for the start, and sends the minutes between them. A new event ends fifteen minutes
  after it starts until the end is moved, and moving the start moves the end with it. An
  event is on from its start to its end, and leaves the list when it ends.
- **It may repeat** daily, weekly or monthly (`recurrence`, schema version 7). It is still one
  row: when an occurrence ends, the sweep moves it on to the next (a day or a week of UTC
  time later, or the same day next month, the month's last day when it has fewer), and its
  answers start over with its creator going. A repeating event is never deleted by age.
- **An event under way can still be changed.** A start already in the past is refused, so a
  start sent unchanged is kept as it was rather than checked again. It is a row in a new SQLite table, `events` (schema
version 5), with the answers as JSON on the row: a few dozen people, always read with the
event.

**Anyone let in may schedule one,** and is going to it unless they say otherwise. **Only its
creator and admins** may change or cancel it, checked on the server on every request.
**Anyone may answer**, and take the answer back.

- A title of up to 100 characters on one line; a description of up to 1000. A start from five
  minutes ago (the form took a minute) to a year ahead. A channel that exists now, or none.
- At most 50 upcoming events, so nobody can fill the list.
- The list (`GET /api/schedule`) is the events not yet started and those that started less
  than six hours ago, which the app shows as happening now, soonest first.

**When an event starts**, a sweep in the server (every twenty seconds) marks it announced
and sends `event_starting` on the chat's stream to whoever answered going or maybe. The app
plays the mention sound, shows a banner with a button to join the event's channel, and, if
the window is not in front, a notification from the system. An event changed to a new time
is announced again when that comes. One that started more than fifteen minutes before the
sweep saw it (the server was down) is marked but not announced: late is worse than never.
**Every change** goes out as `schedule`, and apps read the list again.

**A week after it started** an event is deleted, by the same sweep.

In the app, events are kept out of the sidebar's lists, where a long voice channel pushed
them out of sight, and shown where they matter:

- **A carousel above every tab's list** holds the events from an hour before each starts until
  two hours after, when it counts as ended (events have no end time), up to five. It moves on
  every five seconds, and by arrows or a drag; pointing at it holds it and opens a popup
  beside the sidebar to answer, join the channel or open the event. Clicking the card joins
  the channel. With nothing that close, nothing shows.
- **A calendar button beside the tabs**, with how many events there are, opens the Events
  panel: a button to schedule one, then this week's events and later ones.
- **Right-clicking a channel** offers "Schedule event here", with the channel filled in.

Clicking an event opens it to answer, join its channel, or, for its creator and admins,
change or cancel it.

## Consequences

- **One announcement, at the start.** No reminder fifteen minutes before, no reminder by
  email, and nothing for someone whose app is closed at the time. The banner is the reminder.
- **One occurrence at a time.** A repeating event shows only its next occurrence; skipping one
  week, or changing a single occurrence, is not possible. Answers are per occurrence, so
  people answer again each time. Daily and weekly steps are UTC time: across a daylight-saving
  change the local time moves by an hour.
- **Times are absolute.** The app enters and shows them in the machine's own time zone; the
  server keeps UTC. Two people in different zones see the same moment, each in their own time.
- **The sweep runs in the app server's process**, and the "announced" mark is written before
  the event goes out: a crash between the two loses that announcement rather than repeating it.
- The answers live on the event row. Answering rewrites the row; at this size that is fine,
  and an event with hundreds of answers would want a table of its own.
- The Android viewer does not show events.
