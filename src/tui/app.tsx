import type {
  InputRenderable,
  MouseEvent as TuiMouseEvent,
  ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useReducer, useRef, useState } from "react";

import type { CategoryConfig } from "../categories.ts";
import { costOf, type Pricing, type Scope, type Usage, type UsageState } from "../domain.ts";
import type { ApplyResult, BrowseFilter, Folder, MailboxPage, Message } from "../mailbox.ts";
import type { Triaged } from "../triage.ts";
import { COLORS } from "./theme.ts";
import {
  folderLabel,
  initialState,
  nextBatchIds,
  reducer,
  sidebarEntries,
  visibleRows,
  type State,
} from "./state.ts";

/**
 * Injectable IO boundary for the interactive application.
 */
export type Deps = {
  readonly mailboxes: readonly Folder[];
  readonly categories: readonly CategoryConfig[];
  readonly inboxId: string;
  readonly readOnly: boolean;
  readonly totals: UsageState;
  readonly pricing: Pricing | undefined;
  readonly fetch: (scope: Scope) => Promise<readonly Message[]>;
  readonly browse: (
    mailboxId: string,
    position: number,
    limit: number,
    filter: BrowseFilter,
  ) => Promise<MailboxPage>;
  readonly classify: (
    emails: readonly Message[],
    onResult: (result: Triaged) => void,
  ) => Promise<readonly Triaged[]>;
  readonly apply: (source: string, results: readonly Triaged[]) => Promise<ApplyResult>;
  readonly refreshMailboxes: () => Promise<readonly Folder[]>;
  readonly record: (usage: Usage) => Promise<UsageState>;
};

const sidebarWidth = 27;

// The email list for the current mode: browsed mail, the running batch, or planned results.
function listedEmails(state: State): readonly Message[] {
  if (state.mode === "browse") return state.browseEmails;

  if (state.mode === "classifying") return state.batch;

  return visibleRows(state).map((result) => result.email);
}

const limitError = "Limit must be a positive integer.";

const filters = ["untriaged", "unread", "all"] as const;

const dates = ["24h", "7d", "30d", "any"] as const;

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const money = (value: number | null | undefined) =>
  value == null ? "—" : `$${value.toFixed(value !== 0 && value < 0.0001 ? 8 : 4)}`;

const total = (usage: Usage) => usage.input + usage.output;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const clipped = (text: string, width: number) => {
  if (width <= 0) return "";
  const singleLine = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ");

  if (Bun.stringWidth(singleLine) <= width) return singleLine;
  let result = "";
  let used = 0;

  for (const { segment } of graphemes.segment(singleLine)) {
    const columns = Bun.stringWidth(segment);

    if (used + columns >= width) break;
    result += segment;
    used += columns;
  }

  return `${result}…`;
};

const relativeTime = (date: string | null | undefined) => {
  if (!date) return "";
  const hours = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 3_600_000));

  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

const bar = (probability: number) => {
  const parts = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const eighths = Math.max(0, Math.min(40, Math.round(probability * 40)));

  return "█".repeat(Math.floor(eighths / 8)) + parts[eighths % 8];
};

function Shimmer({ tick }: { tick: number }) {
  const text = "Classifying…";

  return (
    <>
      {[...text].map((character, index) => (
        <span key={index} fg={index === tick % text.length ? COLORS.text : COLORS.ghost}>
          {character}
        </span>
      ))}
    </>
  );
}

function BatchProgress({ state, tick }: { state: State; tick: number }) {
  const done = state.triaged.length;
  const count = state.batch.length;

  if (!count) {
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

    return (
      <text fg={COLORS.accent}>{spinner[tick % spinner.length]} Fetching batch from JMAP…</text>
    );
  }

  const percent = Math.round((done / count) * 100);
  const filled = Math.round((done / count) * 12);

  return (
    <text fg={COLORS.accent} height={1} wrapMode="none">
      {done === count ? "Saving usage" : "Classifying"} {done}/{count} {percent}%{" "}
      {"█".repeat(filled)}
      <span fg={COLORS.dim}>
        {"░".repeat(12 - filled)} · {total(state.usage)} tokens · {Math.floor(tick * 0.12)}s
      </span>
    </text>
  );
}

function EmailList({
  state,
  tick,
  width,
  onNearEnd,
  onSelect,
}: {
  state: State;
  tick: number;
  width: number;
  onNearEnd: () => void;
  onSelect: (index: number) => void;
}) {
  // The list border and scrollbox padding consume two columns each.
  const rowWidth = Math.max(0, width - sidebarWidth - 4);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    if (state.focus === "list" && scroll.current) {
      scroll.current.scrollTop = Math.max(
        0,
        state.listIndex * 2 - Math.floor(scroll.current.height / 2),
      );
    }
  }, [state.focus, state.listIndex]);

  const rows = listedEmails(state);

  const plans =
    state.mode === "planned" || state.mode === "applied" || state.mode === "applying"
      ? visibleRows(state)
      : state.triaged;

  const upcoming = nextBatchIds(state);
  const source = state.mailboxes.find((mailbox) => mailbox.id === state.scope.mailboxId)?.name;

  const emptyBatch =
    state.batchFilter === "all"
      ? `No emails in ${source ?? "this folder"}.`
      : `No ${state.batchFilter} emails in ${source ?? "this folder"}.`;

  return (
    <scrollbox
      ref={scroll}
      flexGrow={1}
      height="100%"
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={(event) => {
        if (
          event.scroll?.direction === "down" &&
          scroll.current &&
          scroll.current.scrollTop + scroll.current.viewport.height >= rows.length * 2 - 4
        )
          onNearEnd();
      }}
    >
      {rows.length === 0 ? (
        <text fg={COLORS.dim}>
          {state.mode === "planned" && state.batch.length === 0 && !state.error
            ? emptyBatch
            : state.browseLoading && state.mode === "browse"
              ? "Loading emails…"
              : "No emails in this view."}
        </text>
      ) : (
        rows.map((email, index) => {
          const result = state.mode === "classifying" ? state.triaged[index] : plans[index];
          const flag = result?.plan.flag;
          const inNextBatch = state.mode === "browse" && upcoming.has(email.id);

          const color =
            flag === "urgent"
              ? COLORS.red
              : flag === "action"
                ? COLORS.orange
                : flag === "review"
                  ? COLORS.grey
                  : inNextBatch
                    ? COLORS.nextBatch
                    : COLORS.dim;

          const selected = state.focus === "list" && state.listIndex === index;

          const sender = clipped(
            email.from?.[0]?.name || email.from?.[0]?.email || "Unknown",
            Math.min(24, Math.max(0, rowWidth - 3)),
          );

          const confidence =
            result?.judgments.category.probabilities[result.judgments.category.choice] ?? 0;

          const selectRow = (event: TuiMouseEvent) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            onSelect(index);
          };

          return (
            <box
              key={email.id}
              flexDirection="column"
              backgroundColor={selected ? COLORS.selected : undefined}
              height={2}
              onMouseDown={selectRow}
            >
              <text
                height={1}
                width="100%"
                wrapMode="none"
                fg={selected ? COLORS.accent : inNextBatch ? COLORS.nextBatch : COLORS.text}
                onMouseDown={selectRow}
              >
                <span fg={color}>{inNextBatch ? "◆ " : "● "}</span>
                {sender}{" "}
                {clipped(email.subject ?? "(no subject)", rowWidth - Bun.stringWidth(sender) - 3)}
              </text>
              <text height={1} width="100%" wrapMode="none" fg={COLORS.dim} onMouseDown={selectRow}>
                {state.mode === "browse" ? (
                  clipped(`${relativeTime(email.receivedAt)}  ${email.preview ?? ""}`, rowWidth)
                ) : result ? (
                  `${result.plan.category ?? "review"} ${bar(confidence)} ${Math.round(confidence * 100)}%  → ${folderLabel(state, result.plan.folderId)}  ${flag ?? "unflagged"}  ${result.plan.markSeen ? "seen" : "unread"}`
                ) : (
                  <Shimmer tick={tick} />
                )}
              </text>
            </box>
          );
        })
      )}
    </scrollbox>
  );
}

function ScopeForm({
  state,
  mailboxes,
  limitText,
  onFocus,
  onFieldClick,
  onLimitInput,
  onLimitSubmit,
  onRun,
  onApply,
}: {
  state: State;
  mailboxes: readonly Folder[];
  limitText: string;
  onFocus: () => void;
  onFieldClick: (index: number) => void;
  onLimitInput: (value: string) => void;
  onLimitSubmit: () => void;
  onRun: () => void;
  onApply: () => void;
}) {
  const source = mailboxes.find((mailbox) => mailbox.id === state.scope.mailboxId)?.name ?? "Inbox";

  const fields = [
    ["Source", source],
    ["Limit", limitText],
    ["Filter", state.scope.filter],
    ["Since", state.scope.since],
  ];

  const busy = state.mode === "classifying" || state.mode === "applying";
  const limitInput = useRef<InputRenderable | null>(null);
  useEffect(() => {
    if (state.focus === "form" && state.formIndex === 1) limitInput.current?.selectAll();
  }, [state.focus, state.formIndex]);

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={state.focus === "form" ? COLORS.accent : COLORS.border}
      title=" Next batch "
      flexGrow={1}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      onMouseUp={(event) => {
        if (event.button === 0 && !busy) onFocus();
      }}
    >
      {fields.map(([label, value], index) => {
        const color =
          state.focus === "form" && state.formIndex === index ? COLORS.text : COLORS.dim;

        const prefix = `${state.focus === "form" && state.formIndex === index ? "▶ " : "  "}${label?.padEnd(8)} ‹ `;

        if (index === 1)
          return (
            <box
              key={label}
              height={1}
              flexDirection="row"
              onMouseUp={(event) => {
                if (event.button !== 0 || busy) return;
                event.stopPropagation();
                onFieldClick(index);
                limitInput.current?.selectAll();
              }}
            >
              <text fg={color}>{prefix}</text>
              <input
                ref={limitInput}
                width={9}
                value={limitText}
                maxLength={16}
                textColor={color}
                focused={state.focus === "form" && state.formIndex === 1 && !busy}
                onInput={onLimitInput}
                onSubmit={onLimitSubmit}
              />
              <text fg={color}> ›</text>
            </box>
          );

        return (
          <text
            key={label}
            fg={color}
            onMouseUp={(event) => {
              if (event.button !== 0 || busy) return;
              event.stopPropagation();
              onFieldClick(index);
            }}
          >
            {prefix}
            {value} ›
          </text>
        );
      })}
      <box flexDirection="row">
        <text
          fg={busy ? COLORS.dim : COLORS.accent}
          onMouseUp={(event) => {
            if (event.button !== 0 || busy) return;
            event.stopPropagation();
            onRun();
          }}
        >
          [ Run batch ]
        </text>
        {state.mode === "planned" && state.triaged.length > 0 ? (
          <text
            fg={COLORS.accent}
            onMouseUp={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              onApply();
            }}
          >
            {state.confirmApply ? " [ Confirm apply ]" : " [ Apply plans ]"}
          </text>
        ) : null}
      </box>
    </box>
  );
}

function SpendPanel({ state, pricing }: { state: State; pricing: Pricing | undefined }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={COLORS.border}
      title=" Spend "
      width={34}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={COLORS.text}>This run {total(state.usage)} tokens</text>
      <text fg={COLORS.dim}>
        in {state.usage.input} · out {state.usage.output}
      </text>
      <text fg={COLORS.accent}>
        {pricing
          ? `${money(costOf(state.usage, pricing))} est. this run`
          : "Cost: pricing unavailable"}
      </text>
      <text fg={COLORS.text}>
        All time {state.totals.inputTokens + state.totals.outputTokens} tokens
      </text>
      <text fg={COLORS.dim}>
        {state.totals.runs} runs ·{" "}
        {money(
          pricing
            ? costOf(
                { input: state.totals.inputTokens, output: state.totals.outputTokens },
                pricing,
              )
            : undefined,
        )}{" "}
        est.
      </text>
    </box>
  );
}

/**
 * Full triage screen with keyboard and mouse navigation and injected side effects.
 */
export function App({ deps }: { deps: Deps }) {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    initialState(deps.mailboxes, deps.inboxId, deps.totals, deps.categories),
  );

  const [tick, setTick] = useState(0);
  const [limitText, setLimitText] = useState(() => String(state.scope.limit));
  const sidebarScroll = useRef<ScrollBoxRenderable | null>(null);
  const runInFlight = useRef(false);
  const browseRequest = useRef(0);
  const pageInFlight = useRef(false);
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const pageSize = Math.max(1, Math.floor((height - 11) / 2));
  const mailboxes = state.mailboxes;
  const entries = sidebarEntries(state);

  const rows = listedEmails(state).length;

  const loadBrowsePage = (
    mailboxId: string,
    position: number,
    request: number,
    append: boolean,
    filter: BrowseFilter,
    limit = pageSize,
  ) => {
    if (pageInFlight.current) return;
    pageInFlight.current = true;

    if (append) dispatch({ type: "browseLoading" });
    void deps
      .browse(mailboxId, position, limit, filter)
      .then((page) => {
        if (request === browseRequest.current) dispatch({ type: "browsePage", page, append });
      })
      .catch((error) => {
        if (request === browseRequest.current)
          dispatch({ type: "browseError", message: errorMessage(error) });
      })
      .finally(() => {
        if (request === browseRequest.current) pageInFlight.current = false;
      });
  };

  const browse = (mailboxId: string, filter = state.browseFilter) => {
    if (mailboxId.startsWith("folder:")) {
      dispatch({ type: "error", message: "Folder has not been created yet." });

      return;
    }

    const request = ++browseRequest.current;
    pageInFlight.current = false;
    dispatch({ type: "browseStart", mailboxId });
    loadBrowsePage(mailboxId, 0, request, false, filter);
  };

  useEffect(() => {
    browse(deps.inboxId);

    return () => {
      ++browseRequest.current;
    };
  }, [deps]);

  useEffect(() => {
    if (
      state.mode !== "browse" ||
      !state.browseHasMore ||
      state.browseLoading ||
      state.browseEmails.length >= pageSize
    )
      return;
    loadBrowsePage(
      state.scope.mailboxId,
      state.browseCursor,
      browseRequest.current,
      true,
      state.browseFilter,
      pageSize - state.browseEmails.length,
    );
  }, [
    pageSize,
    state.mode,
    state.browseHasMore,
    state.browseLoading,
    state.browseEmails.length,
    state.browseCursor,
    state.scope.mailboxId,
    state.browseFilter,
  ]);

  useEffect(() => {
    if (state.focus === "sidebar" && sidebarScroll.current) {
      sidebarScroll.current.scrollTop = Math.max(
        0,
        state.sidebarIndex - Math.floor(sidebarScroll.current.height / 2),
      );
    }
  }, [state.focus, state.sidebarIndex]);

  useEffect(() => {
    if (state.mode !== "classifying") return;
    const timer = setInterval(() => setTick((value) => value + 1), 120);

    return () => clearInterval(timer);
  }, [state.mode]);

  const loadMore = () => {
    if (state.mode !== "browse" || !state.browseHasMore || state.browseLoading) return;
    loadBrowsePage(
      state.scope.mailboxId,
      state.browseCursor,
      browseRequest.current,
      true,
      state.browseFilter,
    );
  };

  const commitLimit = (value = limitText): Scope | undefined => {
    const limit = Number(value);

    if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1) {
      dispatch({ type: "error", message: limitError });

      return;
    }

    setLimitText(String(limit));
    const scope = { ...state.scope, limit };

    if (state.scope.limit !== limit) dispatch({ type: "scope", scope });

    if (state.error === limitError) dispatch({ type: "clearError" });

    return scope;
  };

  const run = (scope: Scope = state.scope) => {
    if (runInFlight.current || state.mode === "classifying" || state.mode === "applying") return;
    runInFlight.current = true;
    ++browseRequest.current;
    dispatch({ type: "start", batch: [] });
    void (async () => {
      const results: Triaged[] = [];
      let failure: string | null = null;

      try {
        const emails = await deps.fetch(scope);
        dispatch({ type: "start", batch: emails });

        if (emails.length === 0) {
          dispatch({ type: "planned", totals: state.totals });

          return;
        }

        await deps.classify(emails, (result) => {
          results.push(result);
          dispatch({ type: "result", result });
        });
      } catch (error) {
        failure = errorMessage(error);
      }

      if (results.length > 0) {
        try {
          const usage = results.reduce(
            (acc, result) => ({
              input: acc.input + result.usage.input,
              output: acc.output + result.usage.output,
            }),
            { input: 0, output: 0 },
          );

          dispatch({ type: "planned", totals: await deps.record(usage) });
        } catch (error) {
          failure = errorMessage(error);
        }
      }

      if (failure) dispatch({ type: "error", message: failure });
    })().finally(() => {
      runInFlight.current = false;
    });
  };

  const apply = () => {
    if (
      (state.error && state.error !== limitError) ||
      state.triaged.length !== state.batch.length
    ) {
      dispatch({
        type: "error",
        message: "Cannot apply an incomplete or failed batch; run it again.",
      });

      return;
    }

    if (deps.readOnly) {
      dispatch({ type: "error", message: "JMAP account is read-only" });

      return;
    }

    if (!state.confirmApply) {
      dispatch({ type: "confirm" });

      return;
    }

    dispatch({ type: "applyStart" });
    void deps
      .apply(state.scope.mailboxId, state.triaged)
      .then(async ({ failed }) => {
        if (Object.keys(failed).length) {
          dispatch({
            type: "error",
            message: `Could not apply ${Object.keys(failed).length} emails; inspect before retrying.`,
          });

          return;
        }

        dispatch({ type: "applied" });

        try {
          dispatch({ type: "mailboxes", mailboxes: await deps.refreshMailboxes() });
        } catch (error) {
          dispatch({
            type: "error",
            message: `Plans applied, but could not refresh folders: ${errorMessage(error)}`,
          });
        }
      })
      .catch((error) => dispatch({ type: "error", message: errorMessage(error) }));
  };

  const changeField = (direction: number, field = state.formIndex, scope = state.scope) => {
    if (field === 1) {
      const limit = Math.max(1, scope.limit + direction);
      setLimitText(String(limit));
      dispatch({
        type: "scope",
        scope: { ...scope, limit },
      });

      return;
    }

    if (field === 0) {
      const index = mailboxes.findIndex((mailbox) => mailbox.id === scope.mailboxId);
      const mailbox = mailboxes[(index + direction + mailboxes.length) % mailboxes.length];

      if (mailbox) browse(mailbox.id);

      return;
    }

    if (field === 2) {
      const index = filters.indexOf(scope.filter);
      dispatch({
        type: "scope",
        scope: {
          ...scope,
          filter: filters[(index + direction + filters.length) % filters.length]!,
        },
      });

      return;
    }

    const index = dates.indexOf(scope.since);
    dispatch({
      type: "scope",
      scope: { ...scope, since: dates[(index + direction + dates.length) % dates.length]! },
    });
  };

  const focus = (target: State["focus"]) => {
    if (state.mode === "classifying" || state.mode === "applying") return;

    if (state.focus === "form" && state.formIndex === 1 && !commitLimit()) return;
    dispatch({ type: "focusTarget", target });
  };

  const onFieldClick = (index: number) => {
    const scope = index === 1 ? state.scope : commitLimit();

    if (!scope) return;
    dispatch({ type: "focusTarget", target: "form" });
    dispatch({ type: "form", index });

    if (index !== 1) changeField(1, index, scope);
  };

  const onSidebarClick = (index: number) => {
    if (state.focus === "form" && state.formIndex === 1 && !commitLimit()) return;
    const entry = entries[index];

    if (!entry) return;
    dispatch({ type: "focusTarget", target: "sidebar" });
    dispatch({ type: "sidebar", index });

    if (entry.section === "mailbox") browse(entry.id);
  };

  const onListClick = (index: number) => {
    if (state.mode === "classifying" || state.mode === "applying") return;

    if (state.focus === "form" && state.formIndex === 1 && !commitLimit()) return;
    dispatch({ type: "focusTarget", target: "list" });
    dispatch({ type: "list", index });

    if (index >= rows - Math.max(1, Math.floor(pageSize / 3))) loadMore();
  };

  const onRun = () => {
    const scope = commitLimit();

    if (scope) run(scope);
  };

  const onApply = () => {
    if (commitLimit()) apply();
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      renderer.destroy();

      return;
    }

    if (state.mode === "classifying" || state.mode === "applying") return;

    if (state.focus === "form" && state.formIndex === 1) {
      if (key.name === "return") {
        key.preventDefault();
        commitLimit();

        return;
      }

      if (key.name === "escape") {
        key.preventDefault();
        setLimitText(String(state.scope.limit));
        dispatch({ type: "form", index: 0 });

        return;
      }

      if (key.name === "tab") {
        key.preventDefault();

        if (commitLimit()) dispatch({ type: "focus" });

        return;
      }

      if (key.name === "up" || key.name === "down") {
        key.preventDefault();

        if (commitLimit())
          dispatch({ type: "form", index: state.formIndex + (key.name === "up" ? -1 : 1) });

        return;
      }

      if (key.name === "left" || key.name === "right") {
        key.preventDefault();
        const scope = commitLimit();

        if (scope) changeField(key.name === "left" ? -1 : 1, 1, scope);
      }

      return;
    }

    if (key.name === "q") {
      renderer.destroy();

      return;
    }

    if (key.name === "u" && state.mode === "browse") {
      const filter = state.browseFilter === "all" ? "untriaged" : "all";
      dispatch({ type: "browseFilter", filter });
      browse(state.scope.mailboxId, filter);

      return;
    }

    if (key.name === "tab") {
      dispatch({ type: "focus" });

      return;
    }

    if (key.name === "escape") {
      dispatch({ type: "back" });
      browse(state.scope.mailboxId);

      return;
    }

    if (key.name === "a" && state.mode === "planned" && state.triaged.length > 0) {
      apply();

      return;
    }

    if (key.name === "return") {
      if (state.focus === "form") onRun();
      else if (state.focus === "sidebar") {
        const entry = entries[state.sidebarIndex];

        if (entry?.section === "mailbox") browse(entry.id);
        else if (entry) dispatch({ type: "sidebar", index: state.sidebarIndex });
      }

      return;
    }

    if (key.name === "up" || key.name === "down") {
      const delta = key.name === "up" ? -1 : 1;

      if (state.focus === "sidebar") {
        const index = Math.max(0, Math.min(entries.length - 1, state.sidebarIndex + delta));
        dispatch({ type: "sidebar", index });
        const entry = entries[index];

        if (state.mode === "browse" && entry?.section === "mailbox") browse(entry.id);
      } else if (state.focus === "form") dispatch({ type: "form", index: state.formIndex + delta });
      else {
        const index = Math.max(0, Math.min(rows - 1, state.listIndex + delta));
        dispatch({ type: "list", index });

        if (delta > 0 && index >= rows - Math.max(1, Math.floor(pageSize / 3))) loadMore();
      }

      return;
    }

    if (state.focus === "form" && (key.name === "left" || key.name === "right"))
      changeField(key.name === "left" ? -1 : 1);
  });

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={COLORS.background}>
      <box flexDirection="row" flexGrow={1} minHeight={4}>
        <box
          border
          borderStyle="rounded"
          borderColor={state.focus === "sidebar" ? COLORS.accent : COLORS.border}
          title=" Folders "
          width={sidebarWidth}
          flexDirection="column"
          paddingLeft={1}
          onMouseUp={(event) => {
            if (event.button === 0) focus("sidebar");
          }}
        >
          <scrollbox ref={sidebarScroll} flexGrow={1} height="100%">
            {entries.map((entry, index) => (
              <text
                key={entry.id}
                onMouseUp={(event) => {
                  if (
                    event.button !== 0 ||
                    state.mode === "classifying" ||
                    state.mode === "applying"
                  )
                    return;
                  event.stopPropagation();
                  onSidebarClick(index);
                }}
                fg={
                  state.sidebarIndex === index && state.focus === "sidebar"
                    ? COLORS.accent
                    : entry.section === "destination"
                      ? COLORS.text
                      : COLORS.dim
                }
              >
                {index === state.sidebarIndex ? "▶" : " "}{" "}
                {entry.section === "destination" ? "↳ " : ""}
                {clipped(entry.label, entry.section === "destination" ? 14 : 16).padEnd(
                  entry.section === "destination" ? 14 : 16,
                )}{" "}
                {entry.count}
              </text>
            ))}
          </scrollbox>
        </box>
        <box
          border
          borderStyle="rounded"
          borderColor={state.focus === "list" ? COLORS.accent : COLORS.border}
          title={` ${state.mode === "browse" ? "Emails" : "Batch"} · ${rows}${state.mode === "browse" && state.browseHasMore ? "+" : ""}${state.mode === "browse" ? ` · ${state.browseFilter} · ◆ next batch` : ""} `}
          flexGrow={1}
          flexDirection="column"
          onMouseUp={(event) => {
            if (event.button === 0) focus("list");
          }}
        >
          {state.mode === "classifying" ? <BatchProgress state={state} tick={tick} /> : null}
          <EmailList
            state={state}
            tick={tick}
            width={width}
            onNearEnd={loadMore}
            onSelect={onListClick}
          />
        </box>
      </box>
      <box flexDirection="row" height={8}>
        <ScopeForm
          state={state}
          mailboxes={mailboxes}
          limitText={limitText}
          onFocus={() => focus("form")}
          onFieldClick={onFieldClick}
          onLimitInput={setLimitText}
          onLimitSubmit={() => {
            commitLimit();
          }}
          onRun={onRun}
          onApply={onApply}
        />
        <SpendPanel state={state} pricing={deps.pricing} />
      </box>
      <text height={1} fg={state.error ? COLORS.red : COLORS.dim}>
        {state.error ??
          (state.confirmApply
            ? `Apply all ${state.triaged.length} plans? Press A or click Confirm apply.`
            : state.mode === "applied"
              ? "Plans applied."
              : state.focus === "form" && state.formIndex === 1
                ? "type limit · ⏎ set · ←→ adjust · ↑↓ field · esc cancel · tab focus"
                : `tab focus · ↑↓ move · ←→ change · ⏎ run · ${state.mode === "browse" ? "u browse filter · " : "A apply · "}esc back · q quit`)}
      </text>
    </box>
  );
}
