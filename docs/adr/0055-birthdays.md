# 55. Birthdays on the calendar, with a party

- **Status:** proposed
- **Date:** 2026-11-14
- **Extends** [ADR 0050](0050-scheduled-events.md)

## Context

The group keeps forgetting each other's birthdays, or learns of one from a message late in the
day. Zoia already has a calendar (ADR 0050) that everyone looks at; it only lacks the dates.

## Decision

**A birthday is a day and a month, never a year.** It is `accounts.birthday`, stored as `MM-DD`
(schema version 8). Nothing needs the age, and a year is more than anyone should have to give.
February 29 is a birthday; in other years it falls on the 28th.

**It is asked for at sign-up.** The app requires it there, and `POST /api/signup` refuses one
that does not exist (`invalid_birthday`). The route accepts a sign-up without one, so an app
from before birthdays can still sign up; that account is then asked after signing in, like any
other without one.

**Someone without one is asked at every sign-in.** The session (`/api/session`, a login, a
device session) carries `birthday`, null until given. While it is null the app opens a prompt
once per sign-in: a launch, or signing in again. The prompt can be closed ("Later"), and comes
back next time, until a date is saved. `PUT /api/birthday` sets it, for the person alone. They
can change it later under Settings › Profile. Admins cannot set someone else's.

**On the day, the server puts it on the calendar.** The schedule's sweep (every twenty seconds)
adds an event for each active, non-bot account whose birthday is today: `kind = 'birthday'`,
`subject_id` the account, from midnight to midnight. A unique index on
`(subject_id, starts_at)` makes it once a day. It has no channel, no creator and no answers.
**Nobody may change, cancel or answer it, admins included** (`403`). It goes off the calendar
if the person changes their birthday away from today or is disabled, it goes with their account,
and it is deleted a week later like any event. It does not count against the 50 upcoming events.
The app titles it "{name}'s birthday" in its own language, under the name the person has now.

**"The day" is one time zone for the whole server**, `BIRTHDAY_TZ` (default
`America/Sao_Paulo`), checked at startup. Everyone sees the same birthday start at the same
moment, and a day with a change of clocks lasts 23 or 25 hours.

**The party is the app's, not the stream's.** A birthday is never sent as `event_starting`.
The app celebrates any birthday on the calendar now that this machine has not celebrated yet,
so someone online at midnight gets it then (the sweep's `schedule` change makes the app read
the list again), and someone who opens the app at nine gets it then. Each birthday is
remembered per machine (local storage) so the party comes once. The party is:

- confetti over the whole window and a card naming whose birthday it is. The person whose
  birthday it is gets "Happy birthday" instead;
- a sound of its own (`birthday`), a fixed cue that no style or pitch changes, so it is never
  mistaken for an event starting;
- a notification of its own kind, `birthday`, under the bell and from Windows. It is on by
  default and can be turned off like the others; turning off "in Zoia" also turns off the
  confetti.

## Consequences

- **One zone for everyone.** Someone abroad sees a friend's birthday start at Brazil's midnight,
  not their own. For one group in one country that is right; a spread-out group would want
  the person's own zone, which the server does not know.
- **The party is per machine.** Someone with two computers gets it on each. Clearing the app's
  storage brings it back that day.
- **Nothing is announced to an app that is closed all day.** The birthday is still on the
  calendar for a week, but there is no party late.
- **Everyone's birthday is visible to everyone, on the day.** Nobody can keep theirs off the
  calendar except by giving a wrong date. If that turns out to matter, it needs a setting.
- **The prompt is a nag.** Someone who never wants to say sees it at every launch. That is the
  ask: the date is wanted from everyone.
- The Android viewer does not ask for the date and shows no party.
