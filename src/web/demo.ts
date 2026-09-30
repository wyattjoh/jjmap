import { Effect, Layer, Ref } from "effect";
import {
  DEFAULT_CATEGORIES,
  OTHER,
  detectCategories,
  finalizeDrafts,
  foldersToCreate,
  toDraft,
  validateDrafts,
  type CategoryConfig,
} from "../categories.ts";
import { TRIAGED_KEYWORD } from "../config.ts";
import { DEFAULT_PRICING, EMPTY_USAGE_STATE } from "../domain.ts";
import { READ_CHUNK, type Message } from "../mailbox.ts";
import { decide, type Judgments } from "../plan.ts";
import type { Triaged } from "../triage.ts";
import { Backend, BackendError } from "./api.ts";
import type { Bootstrap, CategoriesState, FolderSummary } from "./model.ts";

const examples = [
  [
    "Maya Chen",
    "Dinner on Thursday?",
    "Found a little place on Valencia. Are you free around seven?",
    "personal",
  ],
  [
    "Health monitor",
    "All systems operational",
    "The nightly backup completed successfully. Everything is looking good.",
    "alerts",
  ],
  [
    "GitHub",
    "A new sign-in to your account",
    "A new session was started from your trusted device.",
    "notifications",
  ],
  [
    "Studio Supply",
    "Your order is on its way",
    "The paper, pencils, and other good things are heading your way.",
    "receipts",
  ],
  [
    "Offscreen",
    "A quieter kind of newsletter",
    "A few things worth slowing down for this week.",
    "promotions",
  ],
  [
    "Neighborhood group",
    "Notes from the community garden",
    "A few updates from this weekend and plans for the next gathering.",
    "other",
  ],
  [
    "Alex Rivera",
    "A few thoughts on the proposal",
    "I read through the draft. Can we talk through the next steps tomorrow?",
    "personal",
  ],
  [
    "Cloud status",
    "Deployment completed",
    "Your latest changes are live. No action is needed.",
    "alerts",
  ],
  [
    "Parcel",
    "Delivery scheduled for tomorrow",
    "Your package is on the final leg of its journey.",
    "receipts",
  ],
  [
    "Linear",
    "Your weekly workspace update",
    "Here is what happened across your projects this week.",
    "notifications",
  ],
  [
    "Field Notes",
    "Something new for your desk",
    "Our latest seasonal collection is here, in three new colors.",
    "promotions",
  ],
  [
    "Sam Wilson",
    "Photos from the weekend",
    "A handful of favorites from the coast. That light was incredible.",
    "personal",
  ],
] as const;

const builtIn = new Set<string>(DEFAULT_CATEGORIES.map(({ id }) => id));

const DAYS = { "24h": 1, "7d": 7, "30d": 30 } as const;

// Timings only from the authorized ten-email benchmark; no real email content.
const TIMINGS = [158, 113, 215, 153, 165, 118, 99, 95, 101, 164];

interface DemoFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

/**
 * Fully synthetic backend: never reads credentials, contacts providers, or writes usage.
 * Categories live in memory; `configured: false` starts at first-run setup.
 */
export const DemoBackend = (configured: boolean) =>
  Layer.effect(
    Backend,
    Effect.gen(function* () {
      const seeds = [
        { id: "demo-inbox", name: "Inbox", total: 270, unclassified: 207 },
        { id: "demo-archive", name: "Archive", total: 96, unclassified: 36 },
        { id: "demo-alerts", name: "Alerts", total: 48, unclassified: 12 },
        { id: "demo-notifications", name: "Notifications", total: 72, unclassified: 24 },
        { id: "demo-receipts", name: "Receipts", total: 120, unclassified: 0 },
        { id: "demo-promotions", name: "Promotions", total: 84, unclassified: 48 },
      ];

      const mailboxes = yield* Ref.make<readonly DemoFolder[]>(
        seeds.map(({ id, name }) => ({ id, name, parentId: null })),
      );

      const categories = yield* Ref.make<readonly CategoryConfig[] | undefined>(
        configured ? finalizeDrafts(detectCategories(seeds).drafts, new Map()) : undefined,
      );

      const emails = yield* Ref.make<ReadonlyMap<string, Message>>(
        new Map(
          seeds.flatMap((folder, folderIndex) =>
            Array.from({ length: folder.total }, (_, index): [string, Message] => {
              const [name, subject, preview] = examples[index % examples.length]!;
              const id = `demo-${index}-${folderIndex}`;

              return [
                id,
                {
                  id,
                  from: [{ name, email: "hello@example.test" }],
                  subject,
                  preview,
                  receivedAt: new Date(Date.now() - index * 3600000).toISOString(),
                  keywords: index >= folder.unclassified ? { [TRIAGED_KEYWORD]: true } : {},
                  mailboxIds: { [folder.id]: true },
                },
              ];
            }),
          ),
        ),
      );

      // Synthetic latency so streamed load stages are visible; the first bootstrap "connects".
      const connected = yield* Ref.make(false);

      const targets = Effect.map(Ref.get(categories), (current) => current ?? []);

      return Backend.of({
        bootstrap: (report) =>
          Effect.gen(function* () {
            if (!(yield* Ref.get(connected))) {
              yield* report.stage("connect", null, null);
              yield* Effect.sleep(250);
              yield* report.stage("mailboxes", null, null);
              yield* Effect.sleep(120);
              yield* Ref.set(connected, true);
            }

            yield* report.stage("settings", null, null);
            const saved = yield* Ref.get(categories);

            const bootstrap: Bootstrap = {
              demo: true,
              readOnly: false,
              inboxId: "demo-inbox",
              mailboxes: yield* Ref.get(mailboxes),
              categories: (saved ?? []).map(({ id, name, color, folderId }) => ({
                id,
                name,
                color,
                folderId,
              })),
              categoriesSaved: saved !== undefined,
              pricing: DEFAULT_PRICING,
              totals: EMPTY_USAGE_STATE,
            };

            return bootstrap;
          }),
        folders: (report) =>
          Effect.gen(function* () {
            yield* report.stage("list", null, null);
            yield* Effect.sleep(120);
            const folders = yield* Ref.get(mailboxes);
            const summaries: FolderSummary[] = [];
            yield* report.stage("count", 0, folders.length);

            for (const folder of folders) {
              yield* Effect.sleep(90);

              const contents = [...(yield* Ref.get(emails)).values()].filter(
                (email) => email.mailboxIds?.[folder.id] && !email.keywords?.["$draft"],
              );

              const summary: FolderSummary = {
                ...folder,
                total: contents.length,
                unclassified: contents.filter((email) => !email.keywords?.[TRIAGED_KEYWORD]).length,
              };

              summaries.push(summary);
              yield* report.folder(summary);
              yield* report.stage("count", summaries.length, folders.length);
            }

            return summaries;
          }),
        categories: () =>
          Effect.gen(function* () {
            const saved = yield* Ref.get(categories);

            const state: CategoriesState = saved
              ? { saved: true, drafts: saved.map(toDraft), detected: 0, expected: 0 }
              : { saved: false, ...detectCategories(yield* Ref.get(mailboxes)) };

            return state;
          }),
        saveCategories: (drafts) =>
          Effect.gen(function* () {
            const folders = [...(yield* Ref.get(mailboxes))];

            if (!validateDrafts(drafts, new Set(folders.map(({ id }) => id))).valid)
              return yield* new BackendError({ message: "Invalid categories", cause: undefined });
            const created = new Map<string, string>();

            for (const name of foldersToCreate(drafts)) {
              const existing = folders.find((mailbox) => mailbox.name === name);
              const id = existing?.id ?? `demo-folder-${folders.length}`;

              if (!existing) folders.push({ id, name, parentId: null });
              created.set(name, id);
            }

            yield* Ref.set(mailboxes, folders);
            yield* Ref.set(categories, finalizeDrafts(drafts, created));
          }),
        fetch: (scope, report) =>
          Effect.gen(function* () {
            yield* report.stage("search", null, null);
            yield* Effect.sleep(150);
            const after = scope.since === "any" ? 0 : Date.now() - DAYS[scope.since] * 86_400_000;
            const hidden = scope.filter === "unread" ? "$seen" : TRIAGED_KEYWORD;

            const matches = [...(yield* Ref.get(emails)).values()]
              .filter(
                (email) =>
                  email.mailboxIds?.[scope.mailboxId] &&
                  !email.keywords?.["$draft"] &&
                  (scope.filter === "all" || !email.keywords?.[hidden]) &&
                  Date.parse(email.receivedAt ?? "") >= after,
              )
              .slice(0, scope.limit);

            yield* report.stage("read", 0, matches.length);

            for (let done = 0; done < matches.length;) {
              yield* Effect.sleep(60);
              done = Math.min(matches.length, done + READ_CHUNK);
              yield* report.stage("read", done, matches.length);
            }

            return matches;
          }),
        // No mailbox setup in demo mode.
        begin: () => Effect.void,
        classify: (email) =>
          Effect.gen(function* () {
            const index = Number(email.id.split("-")[1]);
            yield* Effect.sleep(TIMINGS[index % TIMINGS.length]!);
            const configured = yield* targets;
            const custom = configured.filter(({ id }) => !builtIn.has(id));
            const example = examples[index % examples.length]![3];

            // Every fourth email lands in a user-added category so custom targets animate too.
            const category =
              custom.length > 0 && index % 4 === 3
                ? custom[Math.floor(index / 4) % custom.length]!.id
                : configured.some(({ id }) => id === example)
                  ? example
                  : OTHER;

            const probabilities = Object.fromEntries(
              [...configured.map(({ id }) => id), OTHER].map((value) => [
                value,
                value === category ? 0.95 : 0.01,
              ]),
            );

            const judgments: Judgments = {
              category: { choice: category, probabilities },
              needsAction: category === "personal" ? 0.8 : 0.1,
              urgent: 0.1,
            };

            const triaged: Triaged = {
              email,
              from: "hello@example.test",
              subject: email.subject ?? "",
              judgments,
              plan: decide(judgments, undefined, configured),
              usage: { input: 0, output: 0 },
            };

            return triaged;
          }),
        // Update only the in-memory fixtures so overview percentages follow confirmed moves.
        apply: (results) =>
          Effect.gen(function* () {
            yield* Ref.update(emails, (current) => {
              const next = new Map(current);

              for (const { email, plan } of results) {
                const keywords = new Map(Object.entries(email.keywords ?? {}));
                keywords.set(TRIAGED_KEYWORD, true);

                if (plan.markSeen) keywords.set("$seen", true);

                next.set(email.id, {
                  ...email,
                  mailboxIds: plan.folderId ? { [plan.folderId]: true } : email.mailboxIds,
                  keywords: Object.fromEntries(keywords),
                });
              }

              return next;
            });

            return { updated: results.map((result) => result.email.id), failed: {} };
          }),
        record: () => Effect.succeed(EMPTY_USAGE_STATE),
      });
    }),
  );
