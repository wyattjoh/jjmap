---
paths:
  - "src/**/*.test.ts"
  - "src/**/*.test.tsx"
  - "src/test-support.ts"
  - "src/web/e2e/**"
  - "playwright.config.ts"
---

# Testing

## Stay synthetic

Tests and the demo must never load credentials, call JMAP or TypeSafe, or change real mail. A paid run needs the user's separate, explicit authorization, with a bound on its size.

## Unit tests

Unit tests use `bun:test` and run effects with `Effect.runPromise`. Provide synthetic services instead of mocking modules; the `anti-slop/no-module-mocking` lint rule forbids module mocks:

```ts
// src/triage.test.ts: override only the JmapClient members a test needs
withJmap(fakeJmap({ isReadOnly: true }))(prepareApplier(folders, "inbox", [receipts]));
```

Use `Jev.of(...)`, `Connector`/`Paths` layers, and `TestClock` for TTL caches.

## Browser tests

- Browser tests live in `src/web/e2e/*.pw.ts`. The `.pw.ts` suffix keeps `bun test` from picking them up.
- `bun run test:web` runs them in installed Chrome.
- Each test starts a fresh demo server so state can't leak between tests.
- Tag tests that start at category setup with `@unconfigured`.
- Browser artifacts go in the ignored `.scratch/` directory.
