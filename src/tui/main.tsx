#!/usr/bin/env bun

import { isIPv4 } from "node:net";
import { parseArgs } from "node:util";

/**
 * Parses CLI arguments into launch options, defaulting web access to loopback.
 * An explicit host must name one IPv4 interface, never all network interfaces.
 */
export function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      web: { type: "boolean", default: false },
      demo: { type: "boolean", default: false },
      dev: { type: "boolean", default: false },
      redact: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      host: { type: "string" },
    },
  });

  if (values.demo && !values.web) throw new Error("--demo requires --web");

  if (values.host !== undefined && !values.web) throw new Error("--host requires --web");

  if (values.dev && !values.web) throw new Error("--dev requires --web");

  if (values.redact && !values.web) throw new Error("--redact requires --web");
  const host = values.host ?? "127.0.0.1";

  if (!isIPv4(host) || host === "0.0.0.0")
    throw new Error("--host must be a specific IPv4 address (not 0.0.0.0)");

  return { ...values, host };
}

// Keep the web path free of terminal renderers, and the demo free of credentials.
if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));

    if (options.help) {
      console.log(
        "Usage: jjmap [--web [--demo] [--dev] [--redact] [--host IP]]\n\n  --web      Open the email sorting app\n  --demo     Synthetic web animation; no credentials, spending, or mail changes\n  --dev      Hot-reload the browser UI while editing\n  --redact   Hide card senders, subjects and previews (for screen recordings)\n  --host IP  Bind to a specific IPv4 address (default: 127.0.0.1)",
      );
    } else {
      if (!options.demo) await import("varlock/auto-load");

      if (options.web) {
        const { Effect } = await import("effect");
        const { launchWeb } = await import("../web/server.ts");

        const clean = await Effect.runPromise(
          launchWeb(options.demo, options.host, options.dev, options.redact),
        );

        process.exit(clean ? 0 : 1);
      } else {
        await (await import("./terminal.tsx")).runTerminal();
      }
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
