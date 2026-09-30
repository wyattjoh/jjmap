import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { App, type Deps } from "./app.tsx";
import { COLORS } from "./theme.ts";

/**
 * Renders immediately while JMAP connects and mailbox data loads, then mounts the triage screen.
 */
export function Startup({
  load,
}: {
  load: (progress: (message: string) => void) => Promise<Deps>;
}) {
  const [status, setStatus] = useState("Connecting to JMAP…");
  const [deps, setDeps] = useState<Deps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  useEffect(() => {
    let active = true;
    void load((message) => {
      if (active) setStatus(message);
    })
      .then((value) => {
        if (active) setDeps(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    if (deps || error) return;
    const timer = setInterval(() => setTick((value) => value + 1), 120);

    return () => clearInterval(timer);
  }, [deps, error]);

  useKeyboard((key) => {
    if (!deps && (key.name === "q" || (key.ctrl && key.name === "c"))) renderer.destroy();
  });

  if (deps) return <App deps={deps} />;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  return (
    <box
      width={width}
      height={height}
      backgroundColor={COLORS.background}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <text fg={COLORS.accent}>jjmap</text>
      <text fg={error ? COLORS.red : COLORS.text}>
        {error ? `JMAP load failed: ${error}` : `${frames[tick % frames.length]} ${status}`}
      </text>
      <text fg={COLORS.dim}>{error ? "Check connection and credentials · q quit" : "q quit"}</text>
    </box>
  );
}
