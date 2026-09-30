import { describe, expect, test } from "bun:test";
import { parseOptions } from "./main.tsx";

describe("CLI launch options — no credentials or services", () => {
  test("defaults to terminal mode and loopback", () => {
    expect(parseOptions([])).toEqual({
      web: false,
      demo: false,
      dev: false,
      help: false,
      host: "127.0.0.1",
    });
    expect(parseOptions(["--web", "--demo", "--dev"]).dev).toBe(true);
    expect(parseOptions(["--web"]).host).toBe("127.0.0.1");
    expect(parseOptions(["-h"]).help).toBe(true);
  });

  test("accepts an explicit Tailscale address for live or demo web mode", () => {
    expect(parseOptions(["--web", "--host", "100.64.0.1"])).toEqual({
      web: true,
      demo: false,
      dev: false,
      help: false,
      host: "100.64.0.1",
    });
    expect(parseOptions(["--web", "--demo", "--host=100.64.0.1"]).demo).toBe(true);
  });

  test("rejects invalid options before credentials can load", () => {
    for (const args of [
      ["--demo"],
      ["--dev"],
      ["--host", "100.64.0.1"],
      ["--web", "--host"],
      ["--web", "--host", ""],
      ["--web", "--host", "0.0.0.0"],
      ["--web", "--host", "::"],
      ["--web", "--host", "attacker.example"],
      ["--web", "--host", "999.64.0.1"],
      ["--unknown"],
    ]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });
});
