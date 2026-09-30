import { Console, Effect, Exit, Layer, Option, Scope } from "effect";
import index from "./index.html";
import { Api, type Backend } from "./api.ts";

/**
 * A running local server and its private link.
 */
export interface WebServer {
  readonly url: string;
}

/**
 * Serves the HTML app and protected API on the selected host and an ephemeral port.
 * Defaults to loopback; the returned private URL determines the exact allowed origin.
 * Dev mode enables browser hot module reloading and echoes browser logs to the terminal.
 * Redact mode swaps card senders, subjects and previews for random filler.
 * Closing the scope refuses new requests, waits for in-flight emails, then stops the server.
 */
export const serveWeb = Effect.fn("serveWeb")(function* (
  hostname: string,
  dev: boolean,
  redact = false,
) {
  const token = crypto.randomUUID();
  let origin = "";
  const api = yield* Api.pipe(Effect.provide(Api.layer(token, () => origin, redact)));

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname,
        port: 0,
        idleTimeout: 0,
        development: dev ? { hmr: true, console: true } : false,
        routes: { "/": index },
        fetch(request) {
          if (!new URL(request.url).pathname.startsWith("/api/"))
            return new Response("Not found", { status: 404 });

          // A client that goes away interrupts its own request; runs listen for this too.
          return Effect.runPromise(api.handle(request), { signal: request.signal }).catch(
            () => new Response(null, { status: 499 }),
          );
        },
      }),
    ),
    (server) =>
      Effect.andThen(
        api.shutdown,
        Effect.promise(() => server.stop(true)),
      ),
  );

  origin = server.url.origin;
  const web: WebServer = { url: `${origin}/#${token}` };

  return web;
});

const OPENERS: Partial<Record<NodeJS.Platform, string>> = { darwin: "open", win32: "explorer.exe" };

// Opens the private link, waiting at most five seconds for the opener to exit.
const openBrowser = Effect.fnUntraced(function* (url: string) {
  const opened = yield* Effect.tryPromise(async () => {
    const child = Bun.spawn([OPENERS[process.platform] ?? "xdg-open", url], {
      stdout: "ignore",
      stderr: "ignore",
    });

    const result = await Promise.race([child.exited, Bun.sleep(5000).then(() => undefined)]);

    if (result === undefined) child.kill();

    return result === 0;
  }).pipe(Effect.orElseSucceed(() => false));

  if (!opened) yield* Console.log("Open the link above in your browser.");
});

// Resolves on the first SIGINT or SIGTERM.
const shutdownSignal = Effect.callback<void>((resume) => {
  const onSignal = () => resume(Effect.void);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return Effect.sync(() => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  });
});

/**
 * Serves until SIGINT/SIGTERM, then shuts down gracefully. Returns `false` when
 * in-flight work did not finish within 30 seconds.
 */
export const runWeb = Effect.fn("runWeb")(function* <E>(
  backend: Layer.Layer<Backend, E>,
  label: string,
  hostname: string,
  dev: boolean,
  redact = false,
) {
  const scope = yield* Scope.make();

  const { url } = yield* serveWeb(hostname, dev, redact).pipe(
    Scope.provide(scope),
    Effect.provide(backend),
  );

  yield* Console.log(`jjmap ${label} · ${url}`);
  yield* Console.log(
    "Keep this terminal open. Ctrl+C stops the server. Treat this link as private.",
  );
  yield* openBrowser(url);
  yield* shutdownSignal;
  yield* Console.log("Stopping after in-flight emails finish…");
  const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.timeoutOption("30 seconds"));

  if (Option.isSome(closed)) return true;

  yield* Console.error(
    "Shutdown timed out after 30s. The last update may have applied; check your mailbox before retrying.",
  );

  return false;
});

/**
 * Launches the browser UI on the selected host (loopback by default).
 * Demo is deliberately isolated from environment loading: it never imports the live backend.
 */
export const launchWeb = Effect.fn("launchWeb")(function* (
  demo: boolean,
  hostname: string,
  dev: boolean,
  redact = false,
) {
  if (demo) {
    const { DemoBackend } = yield* Effect.promise(() => import("./demo.ts"));

    return yield* runWeb(DemoBackend(true), "synthetic demo", hostname, dev, redact);
  }

  const { LiveBackend } = yield* Effect.promise(() => import("./backend.ts"));
  const { Connector } = yield* Effect.promise(() => import("../triage.ts"));
  const { Paths } = yield* Effect.promise(() => import("../usage.ts"));
  const live = LiveBackend.pipe(Layer.provide(Layer.mergeAll(Connector.layer, Paths.layer)));

  return yield* runWeb(live, "live mail", hostname, dev, redact);
});

// A credential-free entry for local animation tests; normal users run jjmap --web.
if (import.meta.main) {
  if (!process.argv.includes("--demo")) throw new Error("Use jjmap --web for live mail");
  const { DemoBackend } = await import("./demo.ts");

  if (process.argv.includes("--no-open")) {
    const configured = !process.argv.includes("--demo-unconfigured");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { url } = yield* serveWeb("127.0.0.1", false);
          yield* Console.log(url);
          yield* Effect.never;
        }),
      ).pipe(Effect.provide(DemoBackend(configured))),
    );
  } else {
    process.exit(
      (await Effect.runPromise(runWeb(DemoBackend(true), "synthetic demo", "127.0.0.1", false)))
        ? 0
        : 1,
    );
  }
}
