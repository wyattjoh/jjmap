import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";

let server: ChildProcess;

let url: string;

// Playwright requires a destructured fixtures argument before testInfo.
// oxlint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, testInfo) => {
  // This entry cannot load live credentials or a live backend.
  const setup = testInfo.tags.includes("@unconfigured") ? ["--demo-unconfigured"] : [];
  server = spawn("bun", ["src/web/server.ts", "--demo", "--no-open", ...setup], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error("Synthetic server startup timed out"));
    }, 15_000);

    let output = "";
    server.stdout!.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#[-a-z0-9]+/);

      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Demo exited: ${code}`));
    });
  });
});

test.afterEach(() => {
  server?.kill();
});

async function open(page: Page, step: "folders" | "configure" = "configure") {
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1")
      throw new Error("Demo attempted an external request");

    return route.fallback();
  });
  await page.goto(url);
  await expect(page.getByText("DEMO · SYNTHETIC MAIL")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose Inbox", exact: true })).toBeVisible();

  if (step === "folders") return;
  await page.getByRole("button", { name: "Choose Inbox", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next", exact: false })).toBeEnabled();
}

async function enterStack(page: Page) {
  if ((await page.locator(".app").getAttribute("data-step")) === "configure")
    await page.getByRole("button", { name: "Next", exact: false }).click();
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "ready");
}

async function start(page: Page) {
  await enterStack(page);
  await page.getByRole("button", { name: "Start sorting" }).click();
}

async function setCount(page: Page, count: number) {
  if ((await page.locator(".app").getAttribute("data-step")) === "sort")
    await page
      .getByRole("button", {
        name:
          (await page.locator(".stage").getAttribute("data-mode")) === "done"
            ? "↻ Load fresh batch"
            : "← Options",
        exact: true,
      })
      .click();
  await page.getByRole("spinbutton", { name: "Email count" }).fill(String(count));
  await expect(page.locator(".batch-preview")).toContainText(`${count} emails ready`);
}

async function holdRun(page: Page) {
  const gate = Promise.withResolvers<void>();
  await page.route("**/api/run", async (route) => {
    const timer = setTimeout(() => gate.reject(new Error("Held Start timed out")), 15000);

    try {
      await gate.promise;
    } finally {
      clearTimeout(timer);
    }

    await route.continue();
  });
  await start(page);
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "running");

  return () => gate.resolve();
}

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("overview streams real load stages and fills folder counts as they settle", async ({
  page,
}) => {
  await page.goto(url);
  const stages = page.getByRole("list", { name: "Connecting to your mailbox" });
  await expect(stages.locator('[aria-current="step"]')).toHaveText(/Connect|Mailboxes|Settings/);
  const counting = page.getByRole("progressbar", { name: "Loading folder counts" });
  await expect(counting).toBeVisible();
  await expect(counting).toHaveAttribute("aria-valuemax", "6");
  await expect(counting).toHaveAttribute("aria-valuenow", /^[1-5]$/);
  const inbox = page.getByRole("button", { name: "Choose Inbox", exact: true });
  await expect(inbox.locator(".total-count")).toHaveText("270");
  await expect(page.locator(".controls-center")).toHaveText("");
  await inbox.click();
  // Chunked reads are brief in the demo, so sample every frame for a determinate value.
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="progressbar"][aria-label="Loading emails"]')
        ?.hasAttribute("aria-valuenow"),
    undefined,
    { polling: "raf" },
  );
  await expect(page.locator(".batch-preview")).toContainText("Inbox · 100 emails ready");
});

test("wizard opens real folders, configures without classifying, and refreshes current contents", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await open(page, "folders");
  const inbox = page.getByRole("button", { name: "Choose Inbox", exact: true });
  await expect(inbox.locator(".unclassified-count")).toHaveText("207");
  await expect(inbox.locator(".total-count")).toHaveText("270");
  await expect(page.locator(".stage")).toHaveCount(0);
  await expect(page.getByRole("spinbutton")).toHaveCount(0);
  expect(requests).not.toContain("/api/preview");
  expect(requests).not.toContain("/api/run");
  await page.screenshot({ path: ".scratch/jjmap-folder-overview.png", fullPage: true });
  await page.setViewportSize({ width: 360, height: 740 });
  await assertNoOverflow(page);
  await page.screenshot({ path: ".scratch/jjmap-folder-overview-mobile.png", fullPage: true });
  await inbox.click();
  await expect(page.locator(".app")).toHaveAttribute("data-step", "configure");
  await setCount(page, 12);
  expect(requests).not.toContain("/api/run");
  await assertNoOverflow(page);
  await page.screenshot({ path: ".scratch/jjmap-configure-mobile.png", fullPage: true });
  await start(page);
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await expect(page.getByLabel("Startup timings")).toContainText("First result");
  await expect(page.getByRole("button", { name: "← Options", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "↻ Load fresh batch", exact: true }).click();
  await page.getByRole("button", { name: "← Folders", exact: true }).click();
  await expect(inbox.locator(".total-count")).toHaveText("262");
  await expect(inbox.locator(".unclassified-count")).toHaveText("195");
});

test("Next previews the falling stack and waits for a separate Start", async ({ page }) => {
  const runs: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/run") runs.push(request.url());
  });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.classList.contains("stack")) performance.mark("pile-entered");

      return animate.call(this, frames, options);
    };
  });
  await open(page);
  await setCount(page, 6);
  await expect(page.getByRole("button", { name: "Start sorting" })).toHaveCount(0);
  await enterStack(page);
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start sorting" })).toBeEnabled();
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "ready");
  await page.waitForTimeout(400); // Entrance and several clock tick intervals pass without Start.
  await expect(page.getByRole("timer")).toHaveText("0.0s");
  await expect(page.getByRole("timer")).toHaveAttribute("data-elapsed-ms", "0");
  await expect(page.locator(".flight")).toHaveCount(0);
  expect(runs).toHaveLength(0);
  expect(await page.evaluate(() => performance.getEntriesByName("pile-entered").length)).toBe(1);
  await page.screenshot({ path: ".scratch/jjmap-stack-before-start.png", fullPage: true });
  await page.getByRole("button", { name: "← Options", exact: true }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-step", "configure");
  await setCount(page, 3);
  await enterStack(page);
  expect(runs).toHaveLength(0);
  expect(await page.evaluate(() => performance.getEntriesByName("pile-entered").length)).toBe(2);
  await start(page);
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await expect(page.getByRole("heading", { name: "3 emails sorted" })).toBeVisible();
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "complete");
  expect(runs).toHaveLength(1);
  expect(await page.evaluate(() => performance.getEntriesByName("pile-entered").length)).toBe(2);
});

test("folder overview distinguishes empty, unknown, and nested folders", async ({ page }) => {
  // The client streams folder loads; the result event carries the settled summaries.
  await page.route("**/api/folders", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({
        type: "result",
        data: [
          { id: "demo-inbox", name: "Inbox", parentId: null, total: null, unclassified: null },
          { id: "demo-archive", name: "Archive", parentId: null, total: 0, unclassified: 0 },
          { id: "demo-receipts", name: "Receipts", parentId: null, total: 4, unclassified: 4 },
          { id: "nested", name: "Receipts", parentId: "demo-inbox", total: 10, unclassified: 3 },
        ],
      })}\n`,
    }),
  );
  await open(page, "folders");
  const inbox = page.getByRole("button", { name: "Choose Inbox", exact: true });
  await expect(inbox.locator(".unclassified-count")).toHaveText("—");
  await expect(inbox.locator(".total-count")).toHaveText("—");
  // The top-level Receipts folder is a sort target; only its nested namesake is a source.
  await expect(page.getByRole("button", { name: "Choose Receipts", exact: true })).toHaveCount(0);
  const empty = page.getByRole("button", { name: "Choose Archive", exact: true });
  await expect(empty.locator(".unclassified-count")).toHaveText("None");
  await expect(empty.locator(".total-count")).toHaveText("None");
  // Nothing left to classify: muted and not selectable. Unknown counts stay selectable.
  await expect(empty).toBeDisabled();
  await expect(inbox).toBeEnabled();
  const nested = page.getByRole("button", { name: "Choose Inbox / Receipts", exact: true });
  await expect(nested.locator(".unclassified-count")).toHaveText("3");
  await expect(nested.locator(".total-count")).toHaveText("10");
  await expect(page.locator(".folder-detail")).toHaveCount(0);
});

test("wizard transitions animate forwards and back without delaying Start until they finish", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = document.startViewTransition.bind(document);
    document.startViewTransition = (callback) => {
      performance.mark("wizard-transition-start");
      const transition = original(callback);
      void transition.finished
        .then(() => performance.mark("wizard-transition-finished"))
        .catch(() => {});

      return transition;
    };

    const originalFetch = window.fetch;
    window.fetch = Object.assign((...args: Parameters<typeof originalFetch>) => {
      if (args[0] === "/api/run") performance.mark("wizard-run-request");

      return originalFetch(...args);
    }, originalFetch);
  });
  await open(page, "folders");
  await page.getByRole("button", { name: "Choose Inbox", exact: true }).click();

  const entering = () =>
    [...document.getAnimations()].some(
      (animation) =>
        animation instanceof CSSAnimation &&
        animation.animationName === "wizard-enter" &&
        animation.playState === "running",
    );

  await page.waitForFunction(entering, undefined, { timeout: 3000 });
  await expect(page.getByRole("heading", { name: "Configure Inbox." })).toBeFocused();
  await setCount(page, 6);
  await page.waitForFunction(
    () => performance.getEntriesByName("wizard-transition-finished").length === 1,
    undefined,
    { timeout: 3000 },
  );
  await page.addStyleTag({
    content:
      "::view-transition-group(wizard), ::view-transition-new(wizard) { animation-duration: 1s !important; }",
  });
  await enterStack(page);
  expect(await page.evaluate(() => performance.getEntriesByName("wizard-run-request").length)).toBe(
    0,
  );
  // Invoke Start while the deliberately lengthened transition is still active.
  await page
    .getByRole("button", { name: "Start sorting" })
    .evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForFunction(
    () => performance.getEntriesByName("wizard-run-request").length === 1,
    undefined,
    { timeout: 3000 },
  );
  expect(
    await page.evaluate(() => performance.getEntriesByName("wizard-transition-finished").length),
  ).toBe(1);
  await page.waitForFunction(entering, undefined, { timeout: 3000 });
  await page.screenshot({ path: ".scratch/jjmap-wizard-transition.png" });
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await page.getByRole("button", { name: "↻ Load fresh batch", exact: true }).click();
  await page.getByRole("button", { name: "← Folders", exact: true }).click();
  await page.waitForFunction(entering, undefined, { timeout: 3000 });
  await expect(page.locator(".app")).toHaveAttribute("data-step", "folders");
});

for (const mode of ["reduced", "unavailable"] as const) {
  test(`wizard navigation works with ${mode} transition support`, async ({ page }) => {
    if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((mode) => {
      if (mode === "unavailable")
        Object.defineProperty(document, "startViewTransition", { value: undefined });
      else
        document.startViewTransition = () => {
          throw new Error("Reduced motion must skip view transitions");
        };
    }, mode);
    await open(page);
    await expect(page.getByRole("heading", { name: "Configure Inbox." })).toBeFocused();
    await page.getByRole("button", { name: "← Folders", exact: true }).click();
    await expect(page.locator(".app")).toHaveAttribute("data-step", "folders");

    if (mode === "unavailable") {
      await page.getByRole("button", { name: "Choose Inbox", exact: true }).click();
      await setCount(page, 1);
      await start(page);
      await expect(page.locator(".workspace")).toHaveCSS("animation-name", "none");
      await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
      await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "complete");
    }
  });
}

test("slow startup shows preparation immediately and Stop cancels before inference", async ({
  page,
}) => {
  await open(page);
  const release = await holdRun(page);
  const steps = page.getByRole("list", { name: "Preparing destination folders…" });
  await expect(steps).toBeVisible();
  await expect(steps.locator('[aria-current="step"]')).toHaveText("Folders");
  await expect(page.locator(".flight")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop after current" }).click();
  release();
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await expect(page.getByRole("heading", { name: "0 emails sorted" })).toBeVisible();
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "stopped");
  const timer = page.getByRole("timer");
  const frozen = await timer.getAttribute("data-elapsed-ms");
  await page.waitForTimeout(250);
  await expect(timer).toHaveAttribute("data-elapsed-ms", frozen!);
  await expect(page.locator(".run-timer")).toHaveCSS("color", "rgb(179, 155, 107)");
  expect(await page.locator(".folder-grid .total-count").allTextContents()).toEqual([
    "None",
    "None",
    "None",
    "None",
    "None",
  ]);
});

test("falling stack entrance never holds up Start or confirmed flights", async ({ page }) => {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const stack = this.classList.contains("stack");
      const animation = animate.call(this, frames, stack ? { duration: 10000 } : options);

      if (stack) {
        performance.mark("stack-entrance");
        animation.pause();
        const finish = animation.finish.bind(animation);
        animation.finish = () => {
          performance.mark("stack-settled");
          finish();
        };
      }

      if (this.classList.contains("flight")) performance.mark("flight-launched");

      return animation;
    };
  });
  await open(page);
  await setCount(page, 6);
  const release = await holdRun(page);

  const entry = await page.locator(".stack").evaluate((stack) => {
    const animation = stack.getAnimations()[0]!;

    return {
      state: animation.playState,
      frames: animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [],
    };
  });

  expect(entry.state).toBe("paused");
  expect(entry.frames[0]!.transform).toMatch(/translateY\(-\d+px\)/);
  expect(entry.frames.at(-1)!.transform).toBe("translateY(0px)");
  expect(
    await page.locator(".stage").evaluate((stage) => getComputedStyle(stage).viewTransitionName),
  ).toBe("sorting-scene");
  // A transparent scene lets the outgoing step fade out instead of being cut off.
  await expect(page.locator(".stage")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  release();
  await page.waitForFunction(
    () => performance.getEntriesByName("flight-launched").length > 0,
    undefined,
    { timeout: 5000 },
  );

  const marks = await page.evaluate(() => ({
    settled: performance.getEntriesByName("stack-settled")[0]!.startTime,
    launched: performance.getEntriesByName("flight-launched")[0]!.startTime,
  }));

  expect(marks.settled).toBeLessThanOrEqual(marks.launched);
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
});

test("elapsed timer starts immediately, freezes before visual flights finish, and resets", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      return animate.call(
        this,
        frames,
        this.matches(".flight, .flying-face") ? { duration: 10000, fill: "both" } : options,
      );
    };
  });
  await open(page);
  await setCount(page, 1);
  const release = await holdRun(page);
  const timer = page.getByRole("timer", { name: "Run elapsed time" });
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "running");
  await expect
    .poll(async () => Number(await timer.getAttribute("data-elapsed-ms")))
    .toBeGreaterThanOrEqual(200);
  const runningColor = await timer.evaluate((node) => getComputedStyle(node).color);

  const [clockRect, progressRect] = await Promise.all([
    timer.boundingBox(),
    page.getByRole("progressbar").boundingBox(),
  ]);

  expect(clockRect!.y + clockRect!.height).toBeLessThan(progressRect!.y);
  release();
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "complete");
  await expect(page.locator(".flight")).toHaveCount(1);
  const frozen = await timer.getAttribute("data-elapsed-ms");
  await page.waitForTimeout(250); // Observe several display ticks after processing has finished.
  await expect(timer).toHaveAttribute("data-elapsed-ms", frozen!);
  expect(await timer.evaluate((node) => getComputedStyle(node).color)).not.toBe(runningColor);

  const finishFlights = () =>
    page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;

        if (target instanceof Element && target.matches(".flight, .flying-face"))
          animation.finish();
      }
    });

  await finishFlights();
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await setCount(page, 1);
  const releaseAgain = await holdRun(page);
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "running");
  expect(Number(await timer.getAttribute("data-elapsed-ms"))).toBeLessThan(Number(frozen));
  releaseAgain();
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "complete");
  await finishFlights();
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
});

test("reduced motion skips the stack drop but retains the elapsed timer", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.matches(".stack, .flight, .flying-face"))
        throw new Error("Reduced motion must not animate the pile or cards");

      return animate.call(this, frames, options);
    };
  });
  await open(page);
  await setCount(page, 1);
  await start(page);
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "complete");
});

test("interrupted streams freeze the timer in its error state", async ({ page }) => {
  await open(page);
  await page.route("**/api/run", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"type":"working","id":"synthetic"}\n',
    }),
  );
  await start(page);
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "error");
  const timer = page.getByRole("timer");
  const frozen = await timer.getAttribute("data-elapsed-ms");
  await page.waitForTimeout(250);
  await expect(timer).toHaveAttribute("data-elapsed-ms", frozen!);
  await expect(page.getByRole("alert")).toContainText("Connection interrupted");
});

test("reference viewport: stacked 3D choreography, complete counts, and no paid calls", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const formatDate = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function (...args: Parameters<typeof formatDate>) {
      performance.mark("card-date-format");

      return formatDate.apply(this, args);
    };
  });
  await open(page);
  await expect(page.getByRole("spinbutton")).toHaveValue("100");
  await expect(page.getByRole("combobox", { name: "Concurrent workers" })).toHaveValue("4");
  await start(page);
  await expect(page.locator(".stack-zone > .section-label")).toContainText("QUEUE");
  await expect(page.locator(".stack-caption")).toContainText("Queue ·");
  // Mail that stays put shares the source-folder tile, with one sticky note per category.
  const stay = page.locator('[data-folder="stay-in-source"]');
  await expect(stay.locator(".folder-name")).toHaveText("Inbox");
  await expect(stay.locator(".sticky-note small")).toHaveText(["Personal", "Needs review"]);
  await expect(page.getByText("Keep in source", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".scratch/jjmap-desktop-ready.png" });
  await assertNoOverflow(page);
  expect(
    await page.evaluate(
      () =>
        document.querySelector(".folder-grid")!.getBoundingClientRect().bottom <
        document.querySelector(".controls")!.getBoundingClientRect().top,
    ),
  ).toBe(true);
  await page.waitForFunction(() => document.querySelectorAll(".flight").length >= 3, undefined, {
    timeout: 10_000,
  });

  const choreography = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".flying-face")];

    return {
      transforms: cards.map((card) => getComputedStyle(card).transform),
      moving: document.getAnimations().filter((animation) => animation.playState === "running")
        .length,
    };
  });

  expect(choreography.moving).toBeGreaterThanOrEqual(6);
  expect(choreography.transforms.every((transform) => transform.startsWith("matrix3d"))).toBe(true);
  await page.screenshot({ path: ".scratch/jjmap-desktop-flight.png" });
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done", { timeout: 40_000 });

  const total = await page
    .locator(".folder-grid .total-count")
    .evaluateAll((nodes) =>
      nodes.reduce((sum, node) => sum + Number(node.getAttribute("data-count")), 0),
    );

  expect(total).toBe(100);
  await expect(page.getByRole("heading", { name: "100 emails sorted" })).toBeVisible();
  await expect(page.locator(".summary-table").getByText("Personal", { exact: true })).toBeVisible();
  await expect(page.locator(".flight")).toHaveCount(0);
  await expect(page.getByRole("progressbar", { name: "Classification progress" })).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  await expect(page.locator(".classification-heading > .section-label .percentage")).toHaveText(
    "100.0%",
  );
  await expect(page.locator(".stack-zone > .section-label .percentage")).toHaveText("0.0%");
  expect(await page.locator(".folder-grid .sorted-share").allTextContents()).toEqual([
    "33.0%",
    "17.0%",
    "17.0%",
    "17.0%",
    "16.0%",
  ]);
  expect(await stay.locator(".note-count").allTextContents()).toEqual(["25", "8"]);
  await page.screenshot({ path: ".scratch/jjmap-desktop-done.png" });
  // Unchanged waiting/in-flight cards must not reformat their dates on every
  // working event, arrival, and landing. Allow initial/preview renders as well.
  expect(
    await page.evaluate(() => performance.getEntriesByName("card-date-format").length),
  ).toBeLessThanOrEqual(300);
  expect(errors).toEqual([]);
});

test("folder names and unclassified counts fit on their fronts", async ({ page }) => {
  await open(page, "folders");
  // Sort targets are hidden, leaving the two source folders.
  await expect(page.locator(".folder-front .unclassified-count")).toHaveCount(2);

  const tints = await page
    .locator(".folder-front")
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundImage));

  expect(new Set(tints).size).toBe(2);

  for (const [width, height] of [
    [360, 740],
    [390, 844],
    [1166, 692],
    [2560, 1440],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });

    const folders = await page.locator(".destination").evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = (selector: string) => node.querySelector(selector)!.getBoundingClientRect();
        const front = rect(".folder-front");
        const percentage = rect(".folder-front .unclassified-count");
        const name = rect(".folder-name");

        return {
          percentageFits:
            percentage.left >= front.left &&
            percentage.right <= front.right &&
            percentage.top >= front.top &&
            percentage.bottom <= front.bottom,
          nameTopLeft:
            name.left >= front.left &&
            name.right <= front.right &&
            name.top >= front.top &&
            name.left - front.left < 16 &&
            name.top - front.top < 16 &&
            name.bottom <= percentage.top,
        };
      }),
    );

    for (const folder of folders) {
      expect(folder).toEqual({ percentageFits: true, nameTopLeft: true });
    }

    await assertNoOverflow(page);
  }
});

test("wide desktops fill the viewport instead of a fixed top-centered box", async ({ page }) => {
  await open(page);
  const release = await holdRun(page);

  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
    [2560, 1440],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });

    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();

      return {
        workspaceWidth: rect(".workspace").width,
        footerBottom: rect("footer").bottom,
        sceneHeight: rect(".stage").height,
        cardWidth: rect(".stack-anchor").width,
        stackCenter: rect(".stack-anchor").left + rect(".stack-anchor").width / 2,
        columnCenter: rect(".stack-zone").left + rect(".stack-zone").width / 2,
      };
    });

    expect(layout.workspaceWidth).toBeGreaterThan(width! * 0.8);
    expect(Math.abs(layout.footerBottom - height!)).toBeLessThan(2);
    expect(layout.sceneHeight).toBeGreaterThan(height! * 0.5);
    expect(layout.cardWidth).toBeGreaterThan(180);
    expect(Math.abs(layout.stackCenter - layout.columnCenter)).toBeLessThan(1);
    await assertNoOverflow(page);
    await page.screenshot({ path: `.scratch/jjmap-desktop-${width}.png` });
  }

  release();
  await page.waitForFunction(() => document.querySelectorAll(".flight").length > 1, undefined, {
    timeout: 10000,
  });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole("button", { name: "Stop after current" }).click();
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await assertNoOverflow(page);
});

test("phone: two-column folder grid, touch controls, and measured mobile flights", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await setCount(page, 24);
  expect(
    (await page.getByRole("button", { name: "Next" }).boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  expect(
    (await page.getByRole("combobox", { name: "Date range" }).boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  const release = await holdRun(page);
  await assertNoOverflow(page);
  expect(
    await page
      .locator(".folder-grid")
      .evaluate(
        (element) =>
          [...element.children].filter(
            (tile) =>
              tile instanceof HTMLElement &&
              element.firstElementChild instanceof HTMLElement &&
              tile.offsetTop === element.firstElementChild.offsetTop,
          ).length,
      ),
  ).toBe(2);
  await page.screenshot({ path: ".scratch/jjmap-mobile-ready.png", fullPage: true });
  release();
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForFunction(() => document.querySelectorAll(".flight").length >= 3, undefined, {
    timeout: 10_000,
  });
  await page.screenshot({ path: ".scratch/jjmap-mobile-flight.png" });
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await expect(page.getByRole("heading", { name: "24 emails sorted" })).toBeVisible();
  await assertNoOverflow(page);
  await page.screenshot({ path: ".scratch/jjmap-mobile-done.png", fullPage: true });
});

test("Stop finishes the current mock email and prevents the remaining batch", async ({ page }) => {
  await open(page);
  await start(page);
  await page.waitForFunction(() => document.querySelectorAll(".flight").length > 0, undefined, {
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Stop after current" }).click();
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await expect(page.getByText("Stopped after in-flight emails finished.")).toBeVisible();

  const total = await page
    .locator(".folder-grid .total-count")
    .evaluateAll((nodes) =>
      nodes.reduce((sum, node) => sum + Number(node.getAttribute("data-count")), 0),
    );

  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThan(100);
  await page.getByRole("button", { name: "Load fresh batch" }).click();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("reduced motion and narrow phones retain every confirmed result", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  await page.getByRole("combobox", { name: "Concurrent workers" }).selectOption("8");

  // Repeated high-concurrency runs exercise adjacent arrivals whose queue length
  // can stay unchanged across a React commit; no result may become stranded.
  for (const count of [12, 50, 100]) {
    await setCount(page, count);
    await start(page);
    await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
    await expect(page.getByRole("heading", { name: `${count} emails sorted` })).toBeVisible();
    await assertNoOverflow(page);
  }
});

test("invalid count disables Start; changing folders prepares a new batch", async ({ page }) => {
  await open(page);
  await page.getByRole("spinbutton").fill("0");
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Source folder" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Email filter" })).toHaveCount(0);
  await page.getByRole("button", { name: "← Folders", exact: true }).click();
  await page.getByRole("button", { name: "Choose Archive", exact: true }).click();
  await setCount(page, 6);
  await expect(page.locator(".batch-preview")).toContainText("Archive · 6 emails ready");
  await start(page);
  await expect(page.locator('[data-folder="stay-in-source"] .folder-name')).toHaveText("Archive");
  await expect(page.locator('[data-note="personal"]')).toBeVisible();
  await expect(page.locator(".folder-grid .total-count")).toHaveCount(5);
  await expect(page.locator('.flight[data-destination="personal"] .card-tag')).toHaveText(
    "Personal",
  );
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  await expect(page.locator(".summary-table").getByText("Personal", { exact: true })).toBeVisible();
});

test("bursts launch immediately without an animation cadence backlog", async ({ page }) => {
  await open(page);
  await setCount(page, 24);
  await page.route("**/api/run", async (route) => {
    const events = Array.from({ length: 24 }, (_, index) => ({
      type: "result",
      outcome: {
        card: {
          id: `burst-${index}`,
          from: "Synthetic sender",
          subject: "Burst fixture",
          preview: "",
          receivedAt: "2026-06-12",
        },
        destination: "receipts",
        applied: true,
        plan: {
          category: "receipts",
          folderId: "demo-receipts",
          flag: null,
          markSeen: true,
          reason: "fixture",
        },
      },
      usage: { input: 0, output: 0 },
    }));

    await route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [...events, { type: "done", stopped: false, usage: { input: 0, output: 0 } }]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
    });
  });
  const started = Date.now();
  await start(page);
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done", { timeout: 2000 });
  expect(Date.now() - started).toBeLessThan(2000);
  await expect(page.getByRole("heading", { name: "24 emails sorted" })).toBeVisible();
});

test("mock write failure is visible and never flies into a success folder", async ({ page }) => {
  await open(page);
  await page.route("**/api/run", async (route) => {
    const response = await page.request.post(`${new URL(url).origin}/api/preview`, {
      headers: { "x-jjmap-token": new URL(url).hash.slice(1), origin: new URL(url).origin },
      data: { mailboxId: "demo-inbox", limit: 1, filter: "untriaged", since: "any" },
    });

    const batch = await response.json();

    const result = {
      type: "result",
      outcome: {
        card: batch.cards[0],
        destination: "receipts",
        applied: false,
        error: "Synthetic write failure",
        plan: {
          category: "receipts",
          folderId: "demo-receipts",
          flag: null,
          markSeen: true,
          reason: "fixture",
        },
      },
      usage: { input: 1_000_000, output: 0 },
    };

    await route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify(result)}\n${JSON.stringify({ type: "done", stopped: false, usage: { input: 1_000_000, output: 0 } })}\n`,
    });
  });
  await start(page);
  await expect(page.getByRole("alert")).toContainText("Synthetic write failure");
  await expect(page.locator(".run-timer")).toHaveAttribute("data-state", "error");
  await expect(page.locator(".run-timer")).toHaveCSS("color", "rgb(208, 173, 150)");
  await expect(page.locator("[data-cost]")).toHaveText("1,000,000 tokens · $0.04");
  await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
  expect(await page.locator(".folder-grid .total-count").allTextContents()).toEqual([
    "None",
    "None",
    "None",
    "None",
    "None",
  ]);
  await expect(page.locator(".flight")).toHaveCount(0);
});

test(
  "first-run setup gates the overview, then custom targets sort live",
  { tag: "@unconfigured" },
  async ({ page }) => {
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).hostname !== "127.0.0.1")
        throw new Error("Demo attempted an external request");

      return route.fallback();
    });
    await page.goto(url);
    await expect(page.locator(".app")).toHaveAttribute("data-step", "categories");
    await expect(page.getByText("FOUND 4 OF 4 FOLDERS")).toBeVisible();
    await expect(page.getByRole("button", { name: "← Folders" })).toHaveCount(0);
    await expect(page.locator(".category-tiles [data-category]")).toHaveCount(5);

    await page.getByRole("button", { name: "Add category", exact: true }).click();
    const save = page.getByRole("button", { name: /Save & continue/ });
    await expect(save).toBeDisabled();
    await page.getByRole("textbox", { name: "Category name" }).fill("Travel");
    await expect(page.getByRole("textbox", { name: "New folder name" })).toHaveValue("Travel");
    await page.getByRole("textbox", { name: "Description" }).fill("Flights and hotels");
    await expect(save).toBeEnabled();
    await save.click();

    await expect(page.locator(".app")).toHaveAttribute("data-step", "folders");
    await expect(page.locator(".folder-choice")).toHaveCount(2);

    for (const target of ["Alerts", "Receipts", "Travel"])
      await expect(page.getByRole("button", { name: `Choose ${target}`, exact: true })).toHaveCount(
        0,
      );

    await page.getByRole("button", { name: "Choose Inbox", exact: true }).click();
    await setCount(page, 8);
    await start(page);
    const travel = page.locator('[data-folder="travel"]');
    await expect(travel.locator(".folder-name")).toHaveText("Travel");
    await expect(page.locator(".stage")).toHaveAttribute("data-mode", "done");
    // Demo routes every fourth email to a user-added category: 2 of 8.
    await expect(travel.locator(".total-count")).toHaveText("2");
    await expect(travel.locator(".sorted-share")).toHaveText("25.0%");

    await page.getByRole("button", { name: "↻ Load fresh batch" }).click();
    await page.getByRole("button", { name: "← Folders", exact: true }).click();
    await page.getByRole("button", { name: "Categories" }).click();
    await expect(page.locator(".category-tiles [data-category]")).toHaveCount(6);
    await expect(page.getByRole("button", { name: "← Folders" })).toBeVisible();
  },
);
