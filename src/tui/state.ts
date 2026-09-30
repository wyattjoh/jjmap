import type { CategoryConfig } from "../categories.ts";
import { DEFAULT_LIMIT, type Flag } from "../config.ts";
import type { Scope, Usage, UsageState } from "../domain.ts";
import { scopeFilter, type Triaged } from "../triage.ts";
import type { BrowseFilter, Folder, MailboxPage, Message } from "../mailbox.ts";

/**
 * View and interaction state for the triage screen.
 */
export type State = {
  readonly mode: "browse" | "classifying" | "planned" | "applying" | "applied";
  readonly focus: "sidebar" | "list" | "form";
  readonly mailboxes: readonly Folder[];
  readonly categories: readonly CategoryConfig[];
  readonly scope: Scope;
  readonly browseFilter: BrowseFilter;
  readonly browseEmails: readonly Message[];
  readonly browseCursor: number;
  readonly browseHasMore: boolean;
  readonly browseLoading: boolean;
  readonly batch: readonly Message[];
  readonly batchFilter: Scope["filter"];
  readonly triaged: readonly Triaged[];
  readonly destination: string | null;
  readonly sidebarIndex: number;
  readonly listIndex: number;
  readonly formIndex: number;
  readonly confirmApply: boolean;
  readonly usage: Usage;
  readonly totals: UsageState;
  readonly error: string | null;
};

/**
 * A selectable mailbox or destination row in the sidebar.
 */
export type SidebarEntry = {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly section: "mailbox" | "destination";
};

const roleOrder = ["inbox", "archive", "sent", "drafts", "junk", "trash"];

/**
 * Creates a freshly connected browsing state.
 */
export function initialState(
  mailboxes: readonly Folder[],
  inboxId: string,
  totals: UsageState,
  categories: readonly CategoryConfig[],
): State {
  return {
    mode: "browse",
    focus: "sidebar",
    mailboxes,
    categories,
    scope: { mailboxId: inboxId, limit: DEFAULT_LIMIT, filter: "untriaged", since: "any" },
    browseFilter: "all",
    browseEmails: [],
    browseCursor: 0,
    browseHasMore: true,
    browseLoading: false,
    batch: [],
    batchFilter: "untriaged",
    triaged: [],
    destination: null,
    sidebarIndex: 0,
    listIndex: 0,
    formIndex: 0,
    confirmApply: false,
    usage: { input: 0, output: 0 },
    totals,
    error: null,
  };
}

/**
 * Display name for a destination mailbox id, or "stays" when mail is not moved.
 */
export function folderLabel(state: State, folderId: string | null): string {
  if (folderId === null) return "stays";

  return (
    state.mailboxes.find((mailbox) => mailbox.id === folderId)?.name ??
    state.categories.find((category) => category.folderId === folderId)?.name ??
    folderId
  );
}

/**
 * Derives mailbox and planned-destination entries with live counts.
 */
export function sidebarEntries(state: State): SidebarEntry[] {
  const mailboxes = [...state.mailboxes].sort((a, b) => {
    const rank = (role: string | null | undefined) => {
      const index = roleOrder.indexOf(role ?? "");

      return index < 0 ? roleOrder.length : index;
    };

    return rank(a.role) - rank(b.role) || a.name.localeCompare(b.name);
  });

  const entries: SidebarEntry[] = mailboxes.map((mailbox) => ({
    id: mailbox.id,
    label: mailbox.name,
    count: mailbox.totalEmails,
    section: "mailbox",
  }));

  if (state.mode !== "planned" && state.mode !== "applying") return entries;
  entries.push({
    id: "destination:inbox",
    label: "Inbox (stays)",
    count: state.triaged.filter((row) => !row.plan.folderId).length,
    section: "destination",
  });

  for (const folderId of new Set(state.categories.flatMap(({ folderId }) => folderId ?? []))) {
    entries.push({
      id: `destination:folder:${folderId}`,
      label: folderLabel(state, folderId),
      count: state.triaged.filter((row) => row.plan.folderId === folderId).length,
      section: "destination",
    });
  }

  for (const flag of ["urgent", "action", "review"] as const satisfies readonly Flag[]) {
    entries.push({
      id: `destination:flag:${flag}`,
      label: flag[0]!.toUpperCase() + flag.slice(1),
      count: state.triaged.filter((row) => row.plan.flag === flag).length,
      section: "destination",
    });
  }

  return entries;
}

/**
 * Filters planned rows by the selected destination or flag.
 */
export function visibleRows(state: State): readonly Triaged[] {
  if (!state.destination) return state.triaged;

  if (state.destination === "destination:inbox")
    return state.triaged.filter((row) => !row.plan.folderId);

  if (state.destination.startsWith("destination:folder:"))
    return state.triaged.filter(
      (row) => row.plan.folderId === state.destination!.slice("destination:folder:".length),
    );

  return state.triaged.filter(
    (row) => row.plan.flag === state.destination!.slice("destination:flag:".length),
  );
}

const mailboxIndex = (state: State, mailboxId: string) =>
  Math.max(
    0,
    sidebarEntries(state).findIndex((entry) => entry.id === mailboxId),
  );

/**
 * IDs of loaded emails eligible for the next scoped batch, in newest-first order.
 */
export function nextBatchIds(state: State, now: Date = new Date()): ReadonlySet<string> {
  if (state.mode !== "browse") return new Set();
  const filter = scopeFilter(state.scope, now);

  return new Set(
    state.browseEmails
      .filter(
        (email) =>
          !email.keywords?.["$draft"] &&
          (!filter.notKeyword || !email.keywords?.[filter.notKeyword]) &&
          (!filter.after ||
            (email.receivedAt &&
              new Date(email.receivedAt).getTime() >= new Date(filter.after).getTime())),
      )
      .slice(0, state.scope.limit)
      .map((email) => email.id),
  );
}

/**
 * Events accepted by the pure state reducer.
 */
export type Action =
  | { type: "focus" }
  | { type: "focusTarget"; target: State["focus"] }
  | { type: "sidebar"; index: number }
  | { type: "list"; index: number }
  | { type: "form"; index: number }
  | { type: "scope"; scope: Scope }
  | { type: "browseFilter"; filter: BrowseFilter }
  | { type: "browseStart"; mailboxId: string }
  | { type: "browseLoading" }
  | { type: "browsePage"; page: MailboxPage; append: boolean }
  | { type: "browseError"; message: string }
  | { type: "start"; batch: readonly Message[] }
  | { type: "result"; result: Triaged }
  | { type: "planned"; totals: UsageState }
  | { type: "mailboxes"; mailboxes: readonly Folder[] }
  | { type: "confirm" }
  | { type: "applyStart" }
  | { type: "applied" }
  | { type: "back" }
  | { type: "error"; message: string }
  | { type: "clearError" };

/**
 * Handles TUI transitions without network or filesystem effects.
 */
export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "focus": {
      const focus = ["sidebar", "list", "form"] as const;

      return { ...state, focus: focus[(focus.indexOf(state.focus) + 1) % focus.length]! };
    }

    case "focusTarget":
      return { ...state, focus: action.target };
    case "sidebar": {
      const index = Math.max(0, Math.min(action.index, sidebarEntries(state).length - 1));
      const entry = sidebarEntries(state)[index];

      return {
        ...state,
        sidebarIndex: index,
        listIndex: 0,
        destination: entry?.section === "destination" ? entry.id : null,
      };
    }

    case "list":
      return { ...state, listIndex: Math.max(0, action.index) };
    case "form":
      return { ...state, formIndex: Math.max(0, Math.min(3, action.index)) };
    case "scope":
      return { ...state, scope: action.scope };
    case "browseFilter":
      return { ...state, browseFilter: action.filter };
    case "browseStart":
      return {
        ...state,
        mode: "browse",
        scope: { ...state.scope, mailboxId: action.mailboxId },
        sidebarIndex: mailboxIndex(state, action.mailboxId),
        browseEmails: [],
        browseCursor: 0,
        browseHasMore: true,
        browseLoading: true,
        listIndex: 0,
        error: null,
      };
    case "browseLoading":
      return { ...state, browseLoading: true };
    case "browsePage": {
      const seen = new Set(state.browseEmails.map((email) => email.id));

      const emails = action.append
        ? [...state.browseEmails, ...action.page.emails.filter((email) => !seen.has(email.id))]
        : [...action.page.emails];

      return {
        ...state,
        browseEmails: emails,
        browseCursor: action.page.nextPosition,
        browseHasMore: action.page.hasMore && action.page.nextPosition > state.browseCursor,
        browseLoading: false,
        error: null,
      };
    }

    case "browseError":
      return { ...state, browseLoading: false, browseHasMore: false, error: action.message };
    case "start":
      return {
        ...state,
        mode: "classifying",
        sidebarIndex: mailboxIndex(state, state.scope.mailboxId),
        batch: action.batch,
        batchFilter: state.scope.filter,
        triaged: [],
        destination: null,
        listIndex: 0,
        confirmApply: false,
        usage: { input: 0, output: 0 },
        error: null,
      };
    case "result":
      return {
        ...state,
        triaged: [...state.triaged, action.result],
        usage: {
          input: state.usage.input + action.result.usage.input,
          output: state.usage.output + action.result.usage.output,
        },
      };
    case "planned":
      return { ...state, mode: "planned", totals: action.totals };
    case "mailboxes":
      return { ...state, mailboxes: action.mailboxes };
    case "confirm":
      return { ...state, confirmApply: !state.confirmApply };
    case "applyStart":
      return { ...state, mode: "applying", confirmApply: false };
    case "applied":
      return { ...state, mode: "applied", destination: null };
    case "back":
      return {
        ...state,
        mode: "browse",
        destination: null,
        confirmApply: false,
        sidebarIndex: mailboxIndex(state, state.scope.mailboxId),
        listIndex: 0,
        error: null,
      };
    case "clearError":
      return { ...state, error: null };
    case "error":
      return {
        ...state,
        error: action.message,
        mode: state.mode === "applying" || state.mode === "classifying" ? "planned" : state.mode,
        confirmApply: false,
      };
  }
}
