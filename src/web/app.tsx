/** @jsxImportSource react */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Option, Schema } from "effect";
import { ScopeSince, type Scope, type Usage } from "../domain.ts";
import { PALETTE } from "../categories.ts";
import { Envelope, FolderArtwork, GhostFolder, Shimmer } from "./folder-artwork.tsx";
import { FLIGHT_MS, FLIP_FRAMES, flightFrames, type FlightGeometry } from "./animation.ts";
import {
  CategoriesEditor,
  EmptyCategoryEditor,
  toRows,
  rowDrafts,
  validateRows,
  type CategoryRow,
} from "./categories-editor.tsx";
import {
  DEFAULT_CONCURRENCY,
  destinationsOf,
  formatElapsed,
  percentage,
  readEvents,
  readLoad,
  LOAD_STAGES,
  Batch,
  Bootstrap,
  CategoriesState,
  ErrorBody,
  FolderSummaries,
  type Card,
  type Destination,
  type DestinationInfo,
  type FolderSummary,
  type LoadEvent,
  type LoadProgress,
  type RunPhase,
  type Outcome,
} from "./model.ts";

const money = (value: number) =>
  value === 0 ? "$0.00" : `$${value.toFixed(value < 0.01 ? 5 : 2)}`;

const number = (value: number) => value.toLocaleString();

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// Browsers without View Transitions get the CSS entry animation instead.
// Older browsers (and tests) may lack the method even though the DOM types declare it.
const supportsViewTransitions = Boolean(document.startViewTransition);

function folderStat(value: number | null) {
  if (value === null) return "—";

  return value === 0 ? "None" : number(value);
}

type Step = "categories" | "folders" | "configure" | "sort";

type Mode = "loading" | "ready" | "running" | "done" | "error";

// Heading, subtitle, and eyebrow for each wizard step.
function stepCopy(step: Step, firstRun: boolean, source: string) {
  switch (step) {
    case "categories":
      return {
        title: firstRun ? "Set up your folders." : "Edit your folders.",
        subtitle: "Where sorted mail goes, and what belongs there.",
        eyebrow: firstRun ? "SETUP" : "CATEGORIES",
      };
    case "folders":
      return {
        title: "Choose a folder.",
        subtitle: "Unclassified mail in your current folders.",
        eyebrow: "1 / FOLDERS",
      };
    case "configure":
      return {
        title: `Configure ${source}.`,
        subtitle: "Choose your next batch.",
        eyebrow: "2 / OPTIONS",
      };
    case "sort":
      return {
        title: "A place for every email.",
        subtitle: "Less noise. More room for what matters.",
        eyebrow: "3 / SORTING",
      };
  }
}

// The queue caption under the stack for each batch mode.
function queueCaption(mode: Mode, total: number, sorted: number) {
  switch (mode) {
    case "ready":
      return `Queue · ${number(total)} emails ready`;
    case "running":
      return `Queue · ${number(sorted)} / ${number(total)}`;
    case "done":
      return `${number(total - sorted)} remaining in this batch`;
    case "loading":
    case "error":
      return "Reading the room…";
  }
}

const emptyCounts = (): Record<Destination, number> => ({});

// Internal key for the source-folder tile; never a category id (ids are slugs without dashes).
const STAY_TILE = "stay-in-source";

const privateToken = location.hash.slice(1) || sessionStorage.getItem("jjmap-token") || "";

if (location.hash) {
  sessionStorage.setItem("jjmap-token", privateToken);
  history.replaceState(null, "", location.pathname);
}

// The token header on every call, plus JSON content type and NDJSON accept when asked for.
function apiHeaders(json: boolean, stream: boolean): Headers {
  const headers = new Headers({ "x-jjmap-token": privateToken });

  if (json) headers.set("Content-Type", "application/json");

  if (stream) headers.set("Accept", "application/x-ndjson");

  return headers;
}

// Sends one API call; a JSON `body` makes it a POST. Rejects with the server's error message.
async function request<B>(
  path: string,
  body: B | undefined,
  signal: AbortSignal | undefined = undefined,
  stream = false,
) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: apiHeaders(body !== undefined, stream),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const data = Schema.decodeUnknownOption(ErrorBody)(await response.json().catch(() => null));

    throw new Error(Option.isSome(data) ? data.value.error : `Request failed (${response.status})`);
  }

  return response;
}

// Sends one API call and decodes its JSON result.
async function requestJson<B, T, E>(
  path: string,
  body: B | undefined,
  schema: Schema.Codec<T, E>,
  signal: AbortSignal | undefined = undefined,
): Promise<T> {
  const response = await request(path, body, signal);

  return Schema.decodeUnknownSync(schema)(await response.json());
}

// Same guards as `request`, but asks for NDJSON progress and resolves with the decoded result.
async function loadStream<B, T, E>(
  path: string,
  body: B | undefined,
  schema: Schema.Codec<T, E>,
  onEvent: (event: LoadEvent<T>) => void,
  signal: AbortSignal,
): Promise<T> {
  return readLoad(await request(path, body, signal, true), schema, onEvent);
}

function Percentage({ count, total, reduced }: { count: number; total: number; reduced: boolean }) {
  const target = percentage(count, total);
  const [displayed, setDisplayed] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;

    if (reduced || target < from) {
      current.current = target;
      setDisplayed(target);

      return;
    }

    const started = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / 300);
      current.current = from + (target - from) * progress;
      setDisplayed(current.current);

      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [target, reduced]);

  return (
    <span className="percentage" data-percentage={target.toFixed(1)}>
      {displayed.toFixed(1)}%
    </span>
  );
}

type RunClock = { startedAt: number; finishedAt: number | undefined };

type TimerState = "ready" | "running" | "complete" | "stopped" | "error";

// Clock ticks stay local: they must not rerender the stack or active flights.
const RunTimer = memo(function RunTimer({
  clock,
  state,
}: {
  clock: RunClock | undefined;
  state: TimerState;
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!clock || clock.finishedAt !== undefined) return;
    setNow(performance.now());
    const interval = setInterval(() => setNow(performance.now()), 100);

    return () => clearInterval(interval);
  }, [clock?.startedAt, clock?.finishedAt]);
  const elapsed = clock ? Math.max(0, (clock.finishedAt ?? now) - clock.startedAt) : 0;

  return (
    <div className="run-timer" data-state={state}>
      <span>{state === "error" ? "FAILED" : state.toUpperCase()}</span>
      <time
        role="timer"
        aria-label="Run elapsed time"
        aria-live="off"
        data-elapsed-ms={Math.floor(elapsed)}
      >
        {formatElapsed(elapsed)}
      </time>
    </div>
  );
});

// Startup phases before the first sorted result, in order.
const startupSteps: readonly { stage: RunPhase; label: string }[] = [
  { stage: "preparing", label: "Folders" },
  { stage: "classifying", label: "First classification" },
  { stage: "updating", label: "First update" },
];

const OVERVIEW_STAGES = [...LOAD_STAGES.bootstrap, ...LOAD_STAGES.folders];

const GHOST_TILES = 4;

type StageProgress = { stage: string; done: number | null; total: number | null };

// Ordered stages with the current one highlighted; countable stages fill a determinate bar.
function StageList({
  stages,
  progress,
  label,
  bar,
}: {
  stages: readonly { stage: string; label: string }[];
  progress: StageProgress;
  label: string;
  bar: boolean;
}) {
  const active = stages.findIndex(({ stage }) => stage === progress.stage);
  const { done, total } = progress;
  const counted = done !== null && total !== null;

  return (
    <div className="stage-progress">
      <ol className="phase-steps" aria-label={label}>
        {stages.map((item, index) => (
          <li
            key={item.stage}
            data-state={index < active ? "done" : index === active ? "active" : "pending"}
            aria-current={index === active ? "step" : undefined}
          >
            <i />
            {item.label}
            {index === active && counted && (
              <span className="stage-count">
                {number(done)} / {number(total)}
              </span>
            )}
          </li>
        ))}
      </ol>
      {bar && (
        <div
          className={`progress-track ${counted ? "" : "indeterminate"}`}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={counted ? total : undefined}
          aria-valuenow={counted ? done : undefined}
        >
          <span style={counted ? { width: `${percentage(done, total)}%` } : undefined} />
        </div>
      )}
    </div>
  );
}

const phaseLabels: Record<RunPhase, string> = {
  preparing: "Preparing destination folders…",
  classifying: "Waiting for the first classification…",
  updating: "Waiting for the first mail update…",
  sorting: "Classifying & sorting",
};

// Card content is immutable while working events and sibling flights update.
const EmailCard = memo(function EmailCard({
  card,
  category,
  flag,
}: {
  card: Card;
  category: DestinationInfo | undefined;
  flag: string | null;
}) {
  const date = new Date(card.receivedAt);

  return (
    <>
      <div className="card-date">
        {Number.isNaN(date.getTime())
          ? "EMAIL"
          : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
      </div>
      <div className="card-sender">{card.from}</div>
      <div className="card-subject">{card.subject}</div>
      <div className="card-preview">{card.preview}</div>
      <div className="card-bottom">
        <span className="card-tag" style={{ "--accent": category?.color ?? "#777" }}>
          <i />
          {category ? category.name : "UNSORTED"}
        </span>
        {flag ? <span className="card-flag">{flag}</span> : <Envelope />}
      </div>
    </>
  );
});

type Flight = { outcome: Outcome; geometry: FlightGeometry; serial: number };

const FlyingCard = memo(function FlyingCard({
  flight,
  reduced,
  onLand,
  category,
}: {
  flight: Flight;
  reduced: boolean;
  onLand: (flight: Flight) => void;
  category: DestinationInfo | undefined;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrapper = outer.current!;
    const card = face.current!;
    let finished = false;

    const land = () => {
      if (!finished) {
        finished = true;
        onLand(flight);
      }
    };

    if (reduced) {
      const timer = setTimeout(land, 0);

      return () => clearTimeout(timer);
    }

    const options = { duration: FLIGHT_MS, easing: "linear", fill: "both" as const };
    const movement = wrapper.animate(flightFrames(flight.geometry), options);
    const flip = card.animate(FLIP_FRAMES, options);
    movement.finished.then(land).catch(() => {});
    // Finish cleanly on resize rather than landing in a stale grid location.
    window.addEventListener("resize", land, { once: true });

    return () => {
      finished = true;
      movement.cancel();
      flip.cancel();
      window.removeEventListener("resize", land);
    };
  }, [flight, reduced, onLand]);

  return (
    <div
      className="flight"
      ref={outer}
      data-destination={flight.outcome.destination}
      style={{ zIndex: 1000 - (flight.serial % 900) }}
      aria-hidden="true"
    >
      <div ref={face} className="email-card flying-face">
        <EmailCard card={flight.outcome.card} category={category} flag={flight.outcome.plan.flag} />
      </div>
    </div>
  );
});

// A sticky note on the source-folder tile for one category that keeps mail in place.
function StickyNote({
  id,
  name,
  color,
  count,
  pulse,
}: {
  id: string;
  name: string;
  color: string;
  count: number;
  pulse: number;
}) {
  return (
    <span
      className={`sticky-note ${pulse ? "bumped" : ""}`}
      key={pulse}
      data-note={id}
      style={{ "--note": color }}
    >
      <small>{name}</small>
      <span className="note-count" data-count={count}>
        {number(count)}
      </span>
    </span>
  );
}

function DestinationTile({
  id,
  name,
  color,
  count,
  sorted,
  pulse,
  reduced,
  folderRef,
  notes,
}: {
  id: string;
  name: string;
  color: string;
  count: number;
  sorted: number;
  pulse: number;
  reduced: boolean;
  folderRef: (node: HTMLDivElement | null) => void;
  notes: ReactNode | undefined;
}) {
  return (
    <div className="destination" style={{ "--accent": color }} data-folder={id}>
      <div className="folder-object" ref={folderRef}>
        <FolderArtwork
          name={name}
          filled={count > 0}
          pulse={pulse}
          count={undefined}
          attachments={notes}
          total={
            <span className="folder-progress folder-total">
              <small>EMAILS</small>
              <span className="folder-stat total-count" data-count={count}>
                {folderStat(count)}
              </span>
            </span>
          }
        >
          <span className="folder-progress">
            <small>SORTED</small>
            <span className="folder-stat sorted-share">
              {count ? <Percentage count={count} total={sorted} reduced={reduced} /> : "None"}
            </span>
          </span>
        </FolderArtwork>
      </div>
    </div>
  );
}

function App() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [step, setStep] = useState<Step>("folders");
  const [categoryRows, setCategoryRows] = useState<CategoryRow[]>([]);
  const [categoryMeta, setCategoryMeta] = useState<Omit<CategoriesState, "drafts">>();
  const [savingCategories, setSavingCategories] = useState(false);
  const [folders, setFolders] = useState<readonly FolderSummary[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [bootProgress, setBootProgress] = useState<LoadProgress>();
  const [folderProgress, setFolderProgress] = useState<LoadProgress>();
  const [previewProgress, setPreviewProgress] = useState<LoadProgress>();
  const [folderError, setFolderError] = useState("");
  const [overviewVersion, setOverviewVersion] = useState(0);
  // Set by Refresh folders so only an explicit refresh bypasses the server's read cache.
  const freshFolders = useRef(false);
  const [phase, setPhase] = useState<RunPhase>("preparing");
  const [timings, setTimings] = useState<Partial<Record<RunPhase, number>>>({});
  const [runClock, setRunClock] = useState<RunClock>();

  const [scope, setScope] = useState<Scope>({
    mailboxId: "",
    limit: 100,
    filter: "untriaged",
    since: "any",
  });

  const [countText, setCountText] = useState("100");
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [batch, setBatch] = useState<Batch>();
  const [mode, setMode] = useState<Mode>("loading");
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const [counts, setCounts] = useState(emptyCounts);
  const [launched, setLaunched] = useState(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [pending, setPending] = useState<Outcome[]>([]);
  const [streamDone, setStreamDone] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState<Outcome[]>([]);
  const [usage, setUsage] = useState<Usage>({ input: 0, output: 0 });
  const [reduced, setReduced] = useState(matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [pulse, setPulse] = useState<Partial<Record<Destination, number>>>({});
  const stage = useRef<HTMLDivElement>(null);
  const pile = useRef<HTMLDivElement>(null);
  const pileEntrance = useRef<Animation | undefined>(undefined);
  const anchor = useRef<HTMLDivElement>(null);
  const folderRefs = useRef<Partial<Record<Destination, HTMLDivElement>>>({});
  const serial = useRef(0);
  const runController = useRef<AbortController | undefined>(undefined);
  const starting = useRef(false);
  const advancing = useRef(false);
  const previewController = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const activeTransition = useRef<ViewTransition | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);
  const destinations = useMemo(() => destinationsOf(boot?.categories ?? []), [boot?.categories]);

  // Mail that stays in the source folder (including review) shares one tile, one note each.
  const stays = useMemo(
    () => destinations.filter(({ folderId }) => folderId === null),
    [destinations],
  );

  const moves = destinations.filter(({ folderId }) => folderId !== null);

  const tileOf = useCallback(
    (destination: Destination) =>
      stays.some(({ id }) => id === destination) ? STAY_TILE : destination,
    [stays],
  );

  const transitionTo = (next: typeof step, update: () => void) => {
    activeTransition.current?.skipTransition();

    const commit = () =>
      flushSync(() => {
        update();
        setStep(next);
      });

    if (reduced || !supportsViewTransitions) {
      commit();

      return Promise.resolve();
    }

    const transition = document.startViewTransition(commit);
    activeTransition.current = transition;
    void transition.ready.catch(() => {});
    void transition.finished
      .catch(() => {})
      .finally(() => {
        if (activeTransition.current === transition) activeTransition.current = undefined;
      });

    // Wait only for the new DOM, never for the visual animation to finish.
    return transition.updateCallbackDone;
  };

  useEffect(() => {
    if (previousStep.current !== step) heading.current?.focus({ preventScroll: true });
    previousStep.current = step;
  }, [step]);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);

    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadStream(
      "bootstrap",
      undefined,
      Bootstrap,
      (event) => {
        if (event.type === "stage") setBootProgress(event);
      },
      controller.signal,
    )
      .then((data) => {
        setBoot(data);
        setScope((value) => ({ ...value, mailboxId: data.inboxId }));

        if (!data.categoriesSaved) {
          // First-run setup is the initial screen, not a navigation, so skip heading focus.
          previousStep.current = "categories";
          setStep("categories");
        }
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setMode("error");
        }
      });

    return () => {
      mounted.current = false;
      activeTransition.current?.skipTransition();
      controller.abort();
      previewController.current?.abort();
      runController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (step !== "folders" || !boot?.inboxId) return;
    const controller = new AbortController();
    setFolderLoading(true);
    setFolderProgress(undefined);
    setFolderError("");

    const listed: readonly FolderSummary[] = boot.mailboxes.map((folder) => ({
      ...folder,
      total: null,
      unclassified: null,
    }));

    const fresh = freshFolders.current;
    freshFolders.current = false;
    void loadStream(
      fresh ? "folders?fresh=1" : "folders",
      undefined,
      FolderSummaries,
      (event) => {
        if (controller.signal.aborted) return;

        if (event.type === "stage") setFolderProgress(event);

        // Each settled count lands on its tile immediately; refreshes keep old counts until then.
        if (event.type === "folder")
          setFolders((value) => {
            const base = value.length ? value : listed;

            return base.some(({ id }) => id === event.folder.id)
              ? base.map((folder) => (folder.id === event.folder.id ? event.folder : folder))
              : [...base, event.folder];
          });
      },
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setFolders(data);
        setBoot((value) =>
          value
            ? {
                ...value,
                mailboxes: data.map(({ id, name, parentId }) => ({ id, name, parentId })),
              }
            : value,
        );
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setFolderError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setFolderLoading(false);
      });

    return () => controller.abort();
  }, [step, boot?.inboxId, overviewVersion]);

  useEffect(() => {
    if (step !== "categories" || !boot) return;
    const controller = new AbortController();
    setCategoryMeta(undefined);
    void requestJson("categories", undefined, CategoriesState, controller.signal)
      .then(({ drafts, ...meta }) => {
        if (controller.signal.aborted) return;
        setCategoryRows(toRows(drafts));
        setCategoryMeta(meta);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });

    return () => controller.abort();
  }, [step, boot?.inboxId]);

  const load = useCallback(async () => {
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setMode("loading");
    setPreviewProgress(undefined);
    setError("");
    setBatch(undefined);
    setCounts(emptyCounts());
    setLaunched(0);
    setFailed([]);
    setPulse({});
    setUsage({ input: 0, output: 0 });
    setStopped(false);
    setStopping(false);

    try {
      const data = await loadStream(
        "preview",
        scope,
        Batch,
        (event) => {
          if (event.type === "stage" && !controller.signal.aborted) setPreviewProgress(event);
        },
        controller.signal,
      );

      if (controller.signal.aborted) return;
      setBatch(data);
      setMode("ready");
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(messageOf(e));
        setMode("error");
      }
    }
  }, [scope]);

  useEffect(() => {
    if (step !== "configure" || !scope.mailboxId) return;
    // Mark stale previews unusable immediately, before the debounce or request completes.
    setBatch(undefined);
    setMode("loading");
    const timer = setTimeout(() => void load(), 300);

    return () => {
      clearTimeout(timer);
      previewController.current?.abort();
    };
  }, [load, scope.mailboxId, step]);

  useLayoutEffect(() => {
    if (step !== "sort" || reduced || !pile.current) return;

    const animation = pile.current.animate(
      [{ transform: `translateY(-${innerHeight}px)` }, { transform: "translateY(0)" }],
      // The short delay lets the outgoing step clear before the pile lands on it.
      { duration: 220, delay: 90, fill: "backwards", easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );

    pileEntrance.current = animation;
    void animation.finished
      .then(() => {
        if (pileEntrance.current === animation) pileEntrance.current = undefined;
      })
      .catch(() => {});

    return () => {
      animation.cancel();

      if (pileEntrance.current === animation) pileEntrance.current = undefined;
    };
  }, [step, batch?.id, reduced]);

  const finishClock = () => {
    const finishedAt = performance.now();
    setRunClock((clock) =>
      clock && clock.finishedAt === undefined ? { ...clock, finishedAt } : clock,
    );
  };

  const land = useCallback((flight: Flight) => {
    const { destination } = flight.outcome;
    setCounts((value) => ({ ...value, [destination]: (value[destination] ?? 0) + 1 }));
    setPulse((value) => ({ ...value, [destination]: (value[destination] ?? 0) + 1 }));
    setFlights((value) => value.filter((item) => item.serial !== flight.serial));
  }, []);

  useEffect(() => {
    if (!pending.length) return;

    if (!stage.current || !anchor.current) return;
    // Fast results settle the entrance immediately; loading never queues confirmed flights.
    pileEntrance.current?.finish();
    pileEntrance.current = undefined;
    const bounds = stage.current.getBoundingClientRect();
    const start = anchor.current.getBoundingClientRect();

    // Drain every available result immediately: classification sets the pace,
    // never a timer. Several arrivals in one network chunk can fly together.
    const ready = pending.map((outcome) => {
      const end = folderRefs.current[tileOf(outcome.destination)]!.getBoundingClientRect();

      const geometry = {
        x: start.left - bounds.left,
        y: start.top - bounds.top,
        targetX: end.left - bounds.left + end.width / 2 - start.width / 2,
        targetY: end.top - bounds.top - 5,
      };

      return { outcome, geometry, serial: serial.current++ };
    });

    if (reduced) for (const flight of ready) land(flight);
    else setFlights((value) => [...value, ...ready]);
    setLaunched((value) => value + ready.length);
    // Remove only this render's arrivals. Functional updates preserve results
    // that arrive before React commits, even when the queue length is unchanged.
    setPending((value) => value.slice(pending.length));
  }, [pending, reduced, land, tileOf]);

  useEffect(() => {
    if (mode === "running" && streamDone && !pending.length && !flights.length) setMode("done");
  }, [mode, streamDone, pending.length, flights.length]);

  const showStack = async () => {
    if (advancing.current || step !== "configure" || mode !== "ready" || !batch) return;
    advancing.current = true;

    try {
      await transitionTo("sort", () => {
        setRunClock(undefined);
        setPhase("preparing");
        setTimings({});
        setStreamDone(false);
        setError("");
        setStopping(false);
        setStopped(false);
        setCounts(emptyCounts());
        setLaunched(0);
        setFailed([]);
        setPulse({});
        setPending([]);
        setWorking("");
        setUsage({ input: 0, output: 0 });
      });
    } finally {
      advancing.current = false;
    }
  };

  const start = async () => {
    if (
      starting.current ||
      step !== "sort" ||
      !batch ||
      mode !== "ready" ||
      !batch.cards.length ||
      boot?.readOnly
    )
      return;
    starting.current = true;
    setMode("running");
    setRunClock({ startedAt: performance.now(), finishedAt: undefined });
    const controller = new AbortController();
    runController.current = controller;

    try {
      const response = await request(
        "run",
        { batchId: batch.id, confirm: true, concurrency },
        controller.signal,
      );

      await readEvents(response, (event) => {
        if (!mounted.current) return;

        if (event.type === "phase") {
          setPhase(event.phase);
          setTimings((value) => ({ ...value, [event.phase]: event.elapsedMs }));
        }

        if (event.type === "working") setWorking(event.id);

        if (event.type === "result") {
          // Paid tokens count whether or not the mail update succeeded.
          setUsage((value) => ({
            input: value.input + event.usage.input,
            output: value.output + event.usage.output,
          }));

          if (event.outcome.applied) {
            setPending((value) => [...value, event.outcome]);
          } else {
            setFailed((value) => [...value, event.outcome]);
            setError(event.outcome.error || "Mail update failed");
          }
        }

        if (event.type === "error") setError(event.message);

        if (event.type === "done") {
          finishClock();
          setUsage(event.usage);
          setStopped(event.stopped);

          if (event.totals)
            setBoot((value) => (value ? { ...value, totals: event.totals! } : value));
        }
      });
    } catch (e) {
      if (!controller.signal.aborted) setError(messageOf(e));
    } finally {
      starting.current = false;

      if (mounted.current) {
        finishClock();
        setStreamDone(true);
        setWorking("");
      }
    }
  };

  const stop = async () => {
    setStopping(true);

    try {
      await request("stop", {});
    } catch (e) {
      setError(messageOf(e));
      setStopping(false);
    }
  };

  const total = batch?.cards.length ?? 0;
  const sorted = Object.values(counts).reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, total - launched);
  const layers = Math.min(remaining, 78);
  const depth = `calc(min(calc(${total * 3.8} * var(--unit)), var(--stack-depth)) * ${remaining / (total || 1)})`;
  const top = `calc(var(--stack-floor) - ${depth})`;
  const running = mode === "running";
  const invalidCount = !Number.isSafeInteger(Number(countText)) || Number(countText) < 1;
  const source = boot?.mailboxes.find(({ id }) => id === scope.mailboxId)?.name || "Inbox";
  const current = batch?.cards.find(({ id }) => id === working) ?? batch?.cards[launched];
  const complete = mode === "done" && sorted === total && total > 0 && !error;

  const overviewFolders: readonly FolderSummary[] = folders.length
    ? folders
    : (boot?.mailboxes ?? []).map((folder) => ({
        ...folder,
        total: null,
        unclassified: null,
      }));

  // Sort targets appear only on the sorting page, never as a source.
  const targetIds = new Set((boot?.categories ?? []).flatMap(({ folderId }) => folderId ?? []));
  const sourceFolders = overviewFolders.filter(({ id }) => !targetIds.has(id));
  const overviewPending = !sourceFolders.length && ((!boot && !error) || folderLoading);

  // Two balanced rows: the first row takes the odd tile and the second is centered under it.
  const overviewColumns = Math.max(
    1,
    Math.ceil((overviewPending ? GHOST_TILES : sourceFolders.length) / 2),
  );

  // Unknown counts shimmer only while a fetch is in flight; settled values fade in once.
  const overviewStat = (value: number | null) =>
    value === null && folderLoading ? (
      <Shimmer width="2.5em" />
    ) : (
      <span className="stat-value">{folderStat(value)}</span>
    );

  const firstRun = boot?.categoriesSaved === false;
  const copy = stepCopy(step, firstRun, source);
  const categoryCheck = validateRows(categoryRows, new Set(overviewFolders.map(({ id }) => id)));
  const folderMap = new Map(overviewFolders.map((folder) => [folder.id, folder]));

  const folderPath = (folder: FolderSummary) => {
    const names = [folder.name];
    const seen = new Set([folder.id]);
    let parentId = folder.parentId;

    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = folderMap.get(parentId);

      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parentId;
    }

    return names.join(" / ");
  };

  const openCategories = () =>
    transitionTo("categories", () => {
      setError("");
      setCategoryRows([]);
    });

  const saveCategories = async () => {
    if (savingCategories || !categoryCheck.valid) return;
    setSavingCategories(true);
    setError("");

    try {
      await request("categories", { categories: rowDrafts(categoryRows) });
      const data = await requestJson("bootstrap", undefined, Bootstrap);
      await transitionTo("folders", () => {
        setBoot(data);
        setBatch(undefined);
        setFolders([]);
        setOverviewVersion((value) => value + 1);
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSavingCategories(false);
    }
  };

  const backToFolders = () =>
    transitionTo("folders", () => {
      setError("");
      setBatch(undefined);
      setOverviewVersion((value) => value + 1);
    });

  const configure = () =>
    transitionTo("configure", () => {
      setBatch(undefined);
      setMode("loading");
    });

  const estimatedCost = boot?.pricing
    ? (usage.input * boot.pricing.inputPerMTok + usage.output * boot.pricing.outputPerMTok) /
      1_000_000
    : undefined;

  return (
    <main className="app" data-step={step}>
      <header className="header">
        <a className="wordmark" href="/" aria-label="jjmap home">
          <Envelope />
          <span>jjmap</span>
          <span className="wordmark-divider">/</span>
          <span className="wordmark-sub">mail sorter</span>
        </a>
        <div
          className={`connection ${boot ? (boot.demo ? "demo" : "") : error ? "" : "connecting"}`}
        >
          <i />
          {boot ? (boot.demo ? "DEMO · SYNTHETIC MAIL" : "LOCAL · LIVE MAIL") : "CONNECTING"}
        </div>
      </header>
      <section
        key={step}
        className={`workspace ${!reduced && !supportsViewTransitions ? "step-enter" : ""}`}
        aria-label="Email sorting workspace"
      >
        <div className="workspace-heading">
          <h1 ref={heading} tabIndex={-1}>
            {copy.title}
          </h1>
          <p>{copy.subtitle}</p>
        </div>
        <nav className="wizard-nav" aria-label="Sorting steps">
          <span>{copy.eyebrow}</span>
        </nav>
        {step === "folders" && (
          <div
            className="folder-overview folder-rows"
            style={{ "--columns": overviewColumns }}
            aria-label="Mail folders"
            aria-busy={overviewPending || folderLoading}
          >
            {overviewPending &&
              Array.from({ length: GHOST_TILES }, (_, index) => (
                <GhostFolder key={index} index={index} />
              ))}
            {sourceFolders.map((folder, index) => {
              const total = folder.total ?? 0;
              const path = folderPath(folder);
              const accent = PALETTE[index % PALETTE.length];

              return (
                <button
                  key={folder.id}
                  className="folder-choice destination"
                  aria-label={`Choose ${path}`}
                  title={path}
                  disabled={folder.unclassified === 0}
                  style={{
                    "--accent": accent,
                    "--i": index,
                  }}
                  onClick={() => {
                    setScope((value) => ({ ...value, mailboxId: folder.id }));
                    setError("");
                    configure();
                  }}
                >
                  <div className="folder-object">
                    <FolderArtwork
                      name={folder.name}
                      filled={total > 0}
                      pulse={0}
                      attachments={undefined}
                      count={undefined}
                      total={
                        <span className="folder-progress folder-total">
                          <small>EMAILS</small>
                          <span className="folder-stat total-count">
                            {overviewStat(folder.total)}
                          </span>
                        </span>
                      }
                    >
                      <span className="folder-progress">
                        <small>UNCLASSIFIED</small>
                        <span className="folder-stat unclassified-count">
                          {overviewStat(folder.unclassified)}
                        </span>
                      </span>
                    </FolderArtwork>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {step === "categories" && (
          <div className="category-setup" aria-busy={!categoryMeta}>
            {!categoryMeta ? (
              <>
                {firstRun && <span className="section-label">LOADING CATEGORIES…</span>}
                <div className="category-workbench">
                  <div className="folder-overview category-tiles" aria-label="Loading categories">
                    {Array.from(
                      { length: (boot?.categories.length || GHOST_TILES) + 1 },
                      (_, index) => (
                        <GhostFolder key={index} index={index} />
                      ),
                    )}
                  </div>
                  <EmptyCategoryEditor loading />
                </div>
              </>
            ) : (
              <>
                {!categoryMeta.saved && (
                  <span className="section-label">
                    FOUND {categoryMeta.detected} OF {categoryMeta.expected} FOLDERS
                  </span>
                )}
                <CategoriesEditor
                  rows={categoryRows}
                  onChange={setCategoryRows}
                  folders={overviewFolders.map((folder) => ({
                    id: folder.id,
                    path: folderPath(folder),
                  }))}
                  errors={categoryCheck.rows}
                  disabled={savingCategories}
                />
              </>
            )}
          </div>
        )}
        {step === "configure" && (
          <div className="batch-preview" role="status">
            <h2>
              {mode === "loading" && (
                <>
                  <span className="visually-hidden">Loading emails…</span>
                  <span aria-hidden="true">
                    {source} · <Shimmer width="2.5ch" /> emails
                  </span>
                </>
              )}
              {mode === "error" && "Couldn’t load this batch."}
              {mode !== "loading" && mode !== "error" && (
                <>
                  {source} · <span className="stat-value">{number(total)}</span> emails ready
                </>
              )}
            </h2>
          </div>
        )}
        {step === "sort" && (
          <div className="stage" ref={stage} data-mode={mode}>
            <div className="stack-zone">
              <div className="section-label">
                QUEUE
                <span>
                  {number(total - sorted)} ·{" "}
                  <Percentage count={total - sorted} total={total} reduced={reduced} />
                </span>
              </div>
              {mode !== "done" && (
                <div className="stack-entry-window" aria-hidden="true">
                  <div className="stack" ref={pile}>
                    {Array.from({ length: layers }, (_, index) => {
                      const fromBottom = layers - index - 1;
                      const fraction = layers > 1 ? fromBottom / (layers - 1) : 0;
                      const y = `calc(var(--stack-floor) - ${depth} * ${fraction})`;

                      return (
                        <div
                          className="stack-sheet"
                          key={index}
                          style={{
                            top: y,
                            left: `calc(50% - var(--card-width) / 2 + ${Math.sin(index * 7.3) * 1.4}px)`,
                            zIndex: layers - index,
                            transform: `perspective(850px) rotateX(87deg) rotateY(0deg) rotateZ(${Math.sin(index * 2) * 0.18}deg)`,
                          }}
                        />
                      );
                    })}
                    {current && (
                      <div
                        className={`email-card waiting-card ${running ? "is-working" : ""}`}
                        style={{ top }}
                      >
                        <EmailCard card={current} category={undefined} flag={null} />
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="stack-anchor" ref={anchor} style={{ top }} />
              {mode === "loading" && (
                <div className="empty-stack">
                  <span className="loading-orbit" />
                  <span>{boot ? "Reading your mail…" : "Connecting to your mailbox…"}</span>
                </div>
              )}
              {mode === "ready" && total === 0 && (
                <div className="empty-stack">
                  <Envelope />
                  <span>All clear here.</span>
                  <small>No emails match this scope.</small>
                </div>
              )}
              {mode === "error" && (
                <div className="empty-stack">
                  <Envelope />
                  <span>Couldn’t load this stack.</span>
                </div>
              )}
              {mode === "done" && (
                <div className="summary">
                  <span className="summary-check">{complete ? "✓" : "—"}</span>
                  <h2>
                    {number(sorted)} emails {boot?.demo ? "sorted" : "updated"}
                  </h2>
                  <p>
                    {complete
                      ? "Everything in its place."
                      : stopped
                        ? "Stopped after in-flight emails finished."
                        : "Batch ended. Review the status below."}
                  </p>
                  <div className="summary-table">
                    {destinations.map((item) => (
                      <div key={item.id}>
                        <span>
                          <i style={{ background: item.color }} />
                          {item.name}
                        </span>
                        <span>{counts[item.id] ?? 0}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="stack-caption" aria-live="polite">
                {queueCaption(mode, total, sorted)}
                {running && (stopping || streamDone || phase === "sorting") && (
                  <span className="activity-label">
                    {stopping
                      ? "Finishing in-flight emails…"
                      : streamDone
                        ? "Putting things in place…"
                        : phaseLabels[phase]}
                  </span>
                )}
              </div>
            </div>
            <div className="destinations">
              <div className="classification-heading">
                <RunTimer
                  clock={runClock}
                  state={
                    !runClock
                      ? "ready"
                      : runClock.finishedAt === undefined
                        ? "running"
                        : error
                          ? "error"
                          : stopped
                            ? "stopped"
                            : "complete"
                  }
                />
                <div className="section-label">
                  EST. COST
                  <span data-cost={estimatedCost}>
                    {number(usage.input + usage.output)} tokens ·{" "}
                    {estimatedCost === undefined ? "—" : money(estimatedCost)}
                  </span>
                </div>
                <div className="section-label">
                  CLASSIFIED
                  <span>
                    {number(sorted)} / {number(total)} ·{" "}
                    <Percentage count={sorted} total={total} reduced={reduced} />
                  </span>
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label="Classification progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Number(percentage(sorted, total).toFixed(1))}
                >
                  <span style={{ width: `${percentage(sorted, total)}%` }} />
                </div>
              </div>
              <div
                className="folder-grid folder-rows"
                style={{
                  "--columns": Math.ceil((moves.length + (stays.length > 0 ? 1 : 0)) / 2),
                }}
              >
                {stays.length > 0 && (
                  <DestinationTile
                    id={STAY_TILE}
                    name={source}
                    color="#8a8c84"
                    count={stays.reduce((sum, { id }) => sum + (counts[id] ?? 0), 0)}
                    sorted={sorted}
                    pulse={stays.reduce((sum, { id }) => sum + (pulse[id] ?? 0), 0)}
                    reduced={reduced}
                    folderRef={(node) => {
                      if (node) folderRefs.current[STAY_TILE] = node;
                    }}
                    notes={stays.map((item) => (
                      <StickyNote
                        key={item.id}
                        id={item.id}
                        name={item.name}
                        color={item.color}
                        count={counts[item.id] ?? 0}
                        pulse={pulse[item.id] ?? 0}
                      />
                    ))}
                  />
                )}
                {moves.map((item) => (
                  <DestinationTile
                    key={item.id}
                    id={item.id}
                    name={item.name}
                    color={item.color}
                    count={counts[item.id] ?? 0}
                    sorted={sorted}
                    pulse={pulse[item.id] ?? 0}
                    reduced={reduced}
                    folderRef={(node) => {
                      if (node) folderRefs.current[item.id] = node;
                    }}
                    notes={undefined}
                  />
                ))}
              </div>
            </div>
            <div className="flight-layer">
              {flights.map((flight) => (
                <FlyingCard
                  key={flight.serial}
                  flight={flight}
                  reduced={reduced}
                  onLand={land}
                  category={destinations.find(({ id }) => id === flight.outcome.destination)}
                />
              ))}
            </div>
          </div>
        )}
        {step === "configure" && (
          <div className="scope-controls">
            <label>
              EMAILS
              <input
                aria-label="Email count"
                type="number"
                min="1"
                step="1"
                value={countText}
                aria-invalid={invalidCount}
                disabled={running}
                onChange={(event) => {
                  const value = event.target.value;
                  setCountText(value);

                  if (Number.isSafeInteger(Number(value)) && Number(value) > 0)
                    setScope({ ...scope, limit: Number(value) });
                }}
              />
            </label>
            <label className="range-control">
              WHEN
              <select
                aria-label="Date range"
                value={scope.since}
                disabled={running}
                onChange={(event) =>
                  setScope({
                    ...scope,
                    since: Option.getOrElse(
                      Schema.decodeUnknownOption(ScopeSince)(event.target.value),
                      () => scope.since,
                    ),
                  })
                }
              >
                <option value="any">Any time</option>
                <option value="24h">Last day</option>
                <option value="7d">Last week</option>
                <option value="30d">Last month</option>
              </select>
            </label>
            <label>
              WORKERS
              <select
                aria-label="Concurrent workers"
                value={concurrency}
                disabled={running}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              >
                {[1, 2, 4, 8].map((value) => (
                  <option key={value} value={value}>
                    {value}× parallel
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="controls">
          <div className="controls-start">
            {step === "categories" ? (
              firstRun ? (
                <span role="status">
                  {categoryCheck.list ??
                    (categoryCheck.valid
                      ? "Review each folder, then save."
                      : "Fix the highlighted categories.")}
                </span>
              ) : (
                <button className="text-button" disabled={savingCategories} onClick={backToFolders}>
                  ← Folders
                </button>
              )
            ) : step === "folders" ? (
              <button
                className="text-button"
                disabled={!boot || folderLoading}
                onClick={() => {
                  freshFolders.current = true;
                  setOverviewVersion((value) => value + 1);
                }}
              >
                ↻ Refresh folders
              </button>
            ) : step === "configure" ? (
              <button className="text-button" onClick={backToFolders}>
                ← Folders
              </button>
            ) : mode === "done" ? (
              <button className="text-button" disabled={!boot} onClick={configure}>
                <span>↻</span> Load fresh batch
              </button>
            ) : (
              <button className="text-button" disabled={running} onClick={configure}>
                ← Options
              </button>
            )}
          </div>
          <div className="controls-center">
            {step === "folders" ? (
              (!boot && !error) || folderLoading ? (
                <StageList
                  stages={OVERVIEW_STAGES}
                  progress={
                    folderProgress ??
                    (boot
                      ? { stage: "list", done: null, total: null }
                      : (bootProgress ?? { stage: "connect", done: null, total: null }))
                  }
                  label={boot ? "Loading folder counts" : "Connecting to your mailbox"}
                  bar
                />
              ) : (
                <span role="status">
                  {folderError || (boot && !overviewFolders.length ? "No folders available" : "")}
                </span>
              )
            ) : step === "configure" && mode === "loading" ? (
              <StageList
                stages={LOAD_STAGES.preview}
                progress={previewProgress ?? { stage: "check", done: null, total: null }}
                label="Loading emails"
                bar
              />
            ) : running && !stopping && !streamDone && phase !== "sorting" ? (
              <StageList
                stages={startupSteps}
                progress={{ stage: phase, done: null, total: null }}
                label={phaseLabels[phase]}
                bar={false}
              />
            ) : null}
          </div>
          <div className="controls-end">
            {step === "categories" ? (
              <button
                className="start-button"
                disabled={!categoryMeta || !categoryCheck.valid || savingCategories}
                onClick={() => void saveCategories()}
              >
                {savingCategories ? "Saving…" : firstRun ? "Save & continue" : "Save"}{" "}
                <span>→</span>
              </button>
            ) : step === "folders" ? (
              <button className="text-button" disabled={!boot} onClick={openCategories}>
                Categories
              </button>
            ) : step === "sort" && mode === "done" ? null : running ? (
              <button
                className="start-button stop-button"
                disabled={stopping || streamDone}
                onClick={() => void stop()}
              >
                <span>■</span>
                {stopping ? "Stopping…" : streamDone ? "Finishing…" : "Stop after current"}
              </button>
            ) : step === "configure" ? (
              mode === "error" ? (
                <button
                  className="start-button"
                  disabled={!boot || invalidCount}
                  onClick={() => void load()}
                >
                  Load fresh batch <span>↻</span>
                </button>
              ) : (
                <button
                  className="start-button"
                  disabled={mode !== "ready" || invalidCount}
                  onClick={() => void showStack()}
                >
                  Next <span>→</span>
                </button>
              )
            ) : (
              <button
                className="start-button"
                disabled={mode !== "ready" || !total || boot?.readOnly || invalidCount}
                onClick={() => void start()}
              >
                Start sorting <span>↗</span>
              </button>
            )}
          </div>
        </div>
        {(step === "configure" || step === "sort") && (
          <>
            {(invalidCount || boot?.readOnly) && (
              <div className="footnote">
                {invalidCount
                  ? "Enter a positive whole number of emails."
                  : "Read-only account. Live sorting is unavailable."}
              </div>
            )}
            {step === "sort" && (
              <div className="startup-timings" aria-label="Startup timings">
                {timings.classifying !== undefined && (
                  <span>
                    Preparation{" "}
                    {((timings.classifying - (timings.preparing ?? 0)) / 1000).toFixed(2)}s
                  </span>
                )}
                {timings.updating !== undefined && (
                  <span>
                    First classification{" "}
                    {((timings.updating - (timings.classifying ?? 0)) / 1000).toFixed(2)}s
                  </span>
                )}
                {timings.sorting !== undefined && (
                  <span>
                    First update {((timings.sorting - (timings.updating ?? 0)) / 1000).toFixed(2)}s
                    · First result {(timings.sorting / 1000).toFixed(2)}s
                  </span>
                )}
              </div>
            )}
          </>
        )}
        {error && (
          <div className="error-message" role="alert">
            <span>{error}</span>
            {failed.map((outcome) => (
              <span key={outcome.card.id}>{outcome.card.subject} — not counted as sorted</span>
            ))}
            {!boot && (
              <button className="text-button" onClick={() => location.reload()}>
                Retry connection
              </button>
            )}
          </div>
        )}
      </section>
      <footer>
        <span>LESS INBOX. MORE INTENTION.</span>
        <span>{boot?.demo ? "jjmap / demo" : "JMAP + Jev"}</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
