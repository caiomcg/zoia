# 52. Admins rename people

- **Status:** proposed
- **Date:** 2026-11-06
- **Amends** [ADR 0031](0031-accounts-with-admin-approval.md)

## Context

A display name is the person's own, set in Settings › Profile with `POST /api/name`. Admins
could disable someone or reset their password, but not change what they are called, so a
name that is offensive, impersonates someone, or is simply unreadable stayed until its owner
changed it, or the account was disabled over it.

## Decision

**An admin renames someone with `POST /api/admin/accounts/:id/name`**, offered as Rename in
Settings › Accounts and when an admin right-clicks someone in People.

**By the same rules as the other account actions** (`canManage` in `accounts.js`): an admin
renames users, only the super admin renames admins, and nobody renames the super admin from
the app. Your own name is still `/api/name`; the admin route refuses yourself. A user gets
`403`. A bot is refused as an unknown account: its name is its addon's (ADR 0041).

**Checked and told exactly as your own rename is.** Both routes go through one function in
`app.js`: trimmed, 1 to 32 characters, unique on the server as `names.js` judges it (`409
name_taken`); then a `renamed` event on the chat stream, and the new name on every machine of
the account in every LiveKit room. The renamed person's own app takes its new name from that
event, at once.

## Consequences

- **An admin can change what someone is called without asking them.** That is the point, and
  the cost: nothing tells the person who did it, beyond the server log (`[admin] <id> renamed
  <id>`, ids only).
- **Nothing stops them changing it back.** Renaming is not a lock; an admin who disagrees can
  rename again, or disable the account.
- The admin's role table in ADR 0031 grows by one action; the super admin still cannot be
  touched from the app.
