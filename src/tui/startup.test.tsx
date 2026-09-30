import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Folder } from "../mailbox.ts";
import { Startup } from "./startup.tsx";
import type { Deps } from "./app.tsx";

const inbox = { id: "inbox", name: "Inbox", role: "inbox", totalEmails: 0 } satisfies Folder;

const deps: Deps = {
  mailboxes: [inbox],
  categories: [],
  inboxId: inbox.id,
  readOnly: false,
  totals: { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastRunAt: null },
  pricing: { inputPerMTok: 0.042, outputPerMTok: 0 },
  fetch: async () => [],
  browse: async () => ({ emails: [], nextPosition: 0, hasMore: false }),
  classify: async () => [],
  apply: async () => ({ updated: [], failed: {} }),
  refreshMailboxes: async () => [inbox],
  record: async () => deps.totals,
};

test("renders immediately while JMAP connects, updates stage, then opens the app", async () => {
  let finish: ((value: Deps) => void) | undefined;
  let progress: ((stage: string) => void) | undefined;

  const view = await testRender(
    <Startup
      load={(report) => {
        progress = report;

        return new Promise((resolve) => {
          finish = resolve;
        });
      }}
    />,
    { width: 80, height: 24 },
  );

  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Connecting to JMAP"));
    expect(view.captureCharFrame()).toContain("jjmap");
    act(() => progress?.("Loading JMAP mailboxes…"));
    await view.waitForFrame((frame) => frame.includes("Loading JMAP mailboxes"));
    await act(async () => finish?.(deps));
    await view.waitForFrame((frame) => frame.includes("Next batch") && frame.includes("Spend"));
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("shows startup errors without leaving a blank terminal", async () => {
  const view = await testRender(
    <Startup
      load={async () => {
        throw new Error("Offline");
      }}
    />,
    { width: 80, height: 24 },
  );

  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("JMAP load failed: Offline"));
    expect(view.captureCharFrame()).toContain("q quit");
  } finally {
    act(() => view.renderer.destroy());
  }
});
