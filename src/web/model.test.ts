import { describe, expect, test } from "bun:test";
import { Exit, Schema } from "effect";
import {
  Concurrency,
  destinationOf,
  destinationsOf,
  formatElapsed,
  percentage,
  readEvents,
  ScopeRequest,
  type RunEvent,
} from "./model.ts";
import { flightFrames, FLIP_FRAMES } from "./animation.ts";

const scope = { mailboxId: "inbox", limit: 100, filter: "untriaged", since: "any" } as const;

describe("browser model", () => {
  const parseScope = Schema.decodeUnknownSync(ScopeRequest);

  test("default 100 and configurable positive counts are accepted", () => {
    expect(parseScope(scope)).toEqual(scope);
    expect(parseScope({ ...scope, limit: 1001 }).limit).toBe(1001);
  });
  test("percentages preserve tenths and handle empty batches", () => {
    expect(percentage(1, 1000).toFixed(1)).toBe("0.1");
    expect(percentage(1, 3).toFixed(1)).toBe("33.3");
    expect(percentage(3, 3).toFixed(1)).toBe("100.0");
    expect(percentage(0, 0)).toBe(0);
    expect(percentage(4, 3)).toBe(100);
  });
  test("worker count is bounded to one through eight independently of email count", () => {
    const decode = Schema.decodeUnknownExit(Concurrency);
    expect(decode(1)).toEqual(Exit.succeed(1));
    expect(decode(8)).toEqual(Exit.succeed(8));

    for (const value of [0, -1, 9, 1.5, "4", null])
      expect(Exit.isFailure(decode(value))).toBe(true);
  });
  test("invalid scope values fail closed", () => {
    for (const value of [
      null,
      {},
      { ...scope, limit: NaN },
      { ...scope, limit: Infinity },
      { ...scope, mailboxId: "" },
      { ...scope, filter: "junk" },
      { ...scope, filter: "unread" },
      { ...scope, filter: "all" },
      { ...scope, since: "yesterday" },
    ])
      expect(() => parseScope(value)).toThrow();
  });
  test("review stays put, every configured category keeps its own destination", () => {
    const plan = { category: null, folderId: null, flag: null, markSeen: false, reason: "test" };
    expect(destinationOf(plan)).toBe("review");
    expect(destinationOf({ ...plan, category: "personal" })).toBe("personal");
    expect(destinationOf({ ...plan, category: "travel", folderId: "trips" })).toBe("travel");
  });
  test("destinations list configured categories in order, then review", () => {
    const travel = { id: "travel", name: "Travel", color: "#5fb3c4", folderId: "trips" };
    expect(destinationsOf([travel]).map(({ id }) => id)).toEqual(["travel", "review"]);
  });
  test("stream decoder handles split unicode, multiple events, and final newline omission", async () => {
    const events: RunEvent[] = [
      { type: "working", id: "📨" },
      { type: "done", stopped: false, usage: { input: 1, output: 1 }, totals: undefined },
    ];

    const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n"));

    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );

    const output: RunEvent[] = [];
    await readEvents(response, (event) => output.push(event));
    expect(output).toEqual(events.map((event) => JSON.parse(JSON.stringify(event))));
  });
  test("malformed events are rejected rather than trusted", async () => {
    await expect(
      readEvents(new Response('{"type":"result","outcome":{}}\n'), () => {}),
    ).rejects.toThrow();
  });
  test("truncated streams are not reported as completed", async () => {
    await expect(
      readEvents(new Response('{"type":"working","id":"1"}\n'), () => {}),
    ).rejects.toThrow("Connection interrupted");
  });
  test("desktop and mobile flights land on measured folder mouths", () => {
    for (const geometry of [
      { x: 80, y: 90, targetX: 600, targetY: 300 },
      { x: 100, y: 60, targetX: 20, targetY: 690 },
    ]) {
      const frames = flightFrames(geometry);
      expect(frames[0]?.transform).toBe(`translate3d(${geometry.x}px, ${geometry.y}px, 0)`);
      expect(frames.at(-1)).toMatchObject({
        opacity: 0,
        transform: `translate3d(${geometry.targetX}px, ${geometry.targetY + 22}px, 0)`,
      });
      expect(frames.map((frame) => frame.offset)).toEqual(
        frames.map((frame) => frame.offset).sort(),
      );
    }

    expect(FLIP_FRAMES[0]?.transform).toContain("rotateX(87deg) rotateY(0deg) rotateZ(0deg)");
    expect(FLIP_FRAMES[1]?.transform).toContain("rotateX(0deg)");
  });
  test("flights keep moving smoothly through the upright flip", () => {
    for (const targetX of [600, 20]) {
      const frames = flightFrames({ x: 100, y: 90, targetX, targetY: 300 });

      const positions = frames.map((frame) =>
        Number(String(frame.transform).match(/translate3d\(([-\d.]+)px/)![1]),
      );

      const steps = positions.slice(1).map((x, i) => Math.abs(x - positions[i]!));
      // The old peel/hold/arc handoff produced a large speed jump near 36%.
      const middle = steps.slice(6, 38);
      expect(Math.min(...middle)).toBeGreaterThan(Math.abs(targetX - 100) / 100);

      for (let i = 1; i < middle.length; i++)
        expect(middle[i]! / middle[i - 1]!).toBeLessThan(1.15);
    }
  });
  test.each([
    [-50, "0.0s"],
    [0, "0.0s"],
    [1234, "1.2s"],
    [59999, "59.9s"],
    [60000, "1m 00.0s"],
    [3600123, "60m 00.1s"],
  ])("elapsed clock formats %d ms as %s", (milliseconds, formatted) => {
    expect(formatElapsed(milliseconds)).toBe(formatted);
  });
});
