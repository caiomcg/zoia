# Contributing

Thanks for looking. This is a small project with a small surface, so the bar is less about
process and more about not breaking the two things it guarantees: that only one person can
broadcast at a time, and that sharing one application does not leak the rest of the machine.

## Getting set up

You need Node 20 or 22. The server runs anywhere; the desktop app only builds on Windows.

```bash
git clone https://github.com/caiomcg/zoia.git
cd zoia
npm install
cp .env.example .env     # the server will not start without it

npm run dev              # server, on :3000
```

For the desktop app:

```bash
cd desktop
npm install              # from Windows, not WSL — see below
npm run dev
```

> **Install the desktop dependencies from Windows.** The audio capture is a native addon
> with platform-specific binaries. Running `npm install` from WSL puts Linux binaries in a
> `node_modules` that Windows then loads, and the failure looks like "no audio" rather than
> anything about architecture. This has cost hours; it is not a style preference.

## What CI enforces

Every pull request runs lint, formatting, the test suite on Node 20 and 22, a coverage
floor, and commit message linting. You can run the same checks locally:

```bash
npm run lint
npm run format:check
npm test
npm run coverage:check
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). The allowed
scopes are in `commitlint.config.js` — `desktop`, `api`, `web`, `infra` and a few others.
`feat(desktop): …`, `fix(api): …`.

## Things worth knowing before you change them

**Permissions are the security boundary.** Everyone joins a room unable to publish;
`server/src/stage.js` grants that at runtime and LiveKit enforces it, so a client that skips
the request still cannot broadcast. If you touch how permissions are granted, add a test
showing the change cannot be used to gain rights nobody else has — the existing tests in
`server/test/stage.test.js` and `token.test.js` show the shape.

**Tests describe behaviour, not implementation.** `a second claimant is refused with 409 and
told who holds it` says what someone would notice. Names like `test claim() returns false`
do not.

**Comments explain why.** The code says what it does. A comment earns its place by
recording something that is not obvious from reading it — a measurement, a constraint, a
thing that was tried and failed. There are several of these in `desktop/src/main/nvenc.ts`
that would otherwise be re-discovered the hard way.

**Write down what you measured.** A surprising number of decisions in this repository came
from timing something rather than reasoning about it. If you find a number, put it in the
comment or the commit message; the next person should not have to measure it again.

## Reporting a problem

The desktop app reports its own crashes to the server, with a stack, so a bug report can be
as short as roughly when it happened and what you were sharing. Server-side, they are in
`docker compose logs app`.

Security issues: [SECURITY.md](SECURITY.md).
