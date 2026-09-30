import { Effect } from "effect";
import { JmapClient, type Message } from "./mailbox.ts";
import type { Triaged } from "./triage.ts";

/**
 * A synthetic JMAP client for tests: every operation dies unless overridden,
 * so a test fails loudly on any call it did not expect.
 */
export function fakeJmap(overrides: Partial<JmapClient["Service"]> = {}): JmapClient["Service"] {
  return JmapClient.of({
    isReadOnly: false,
    getMailboxes: () => Effect.die("unexpected getMailboxes"),
    searchEmails: () => Effect.die("unexpected searchEmails"),
    countEmails: () => Effect.die("unexpected countEmails"),
    getEmails: () => Effect.die("unexpected getEmails"),
    createMailboxes: () => Effect.die("unexpected createMailboxes"),
    updateEmails: () => Effect.die("unexpected updateEmails"),
    ...overrides,
  });
}

/**
 * A synthetic email that Jev placed confidently in `receipts`.
 */
export function receiptTriaged(email: Message): Triaged {
  return {
    email,
    from: "fixture@example.test",
    subject: email.subject ?? "",
    judgments: {
      category: {
        choice: "receipts",
        probabilities: {
          personal: 0.01,
          alerts: 0.01,
          notifications: 0.01,
          receipts: 0.95,
          promotions: 0.01,
          other: 0.01,
        },
      },
      needsAction: 0,
      urgent: 0,
    },
    plan: {
      category: "receipts",
      folderId: "folder-receipts",
      flag: null,
      markSeen: true,
      reason: "fixture",
    },
    usage: { input: 12, output: 4 },
  };
}
