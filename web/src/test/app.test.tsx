import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { payload } from "./fixture";

vi.mock("../lib/highlight", () => ({
  langFor: () => null,
  highlightHunk: async () => new Map(),
  highlightLines: async () => [],
}));
vi.mock("../api", () => ({
  fetchPR: vi.fn(async () => payload),
  fetchVersions: vi.fn(async () => ({ head_sha: payload.pr.head_sha, versions: payload.versions })),
  fetchGuide: vi.fn(),
  fetchFile: vi.fn(async () => Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")),
  fetchTree: vi.fn(async () => [
    "README.md",
    "docs/guide.md",
    "package-lock.json",
    "src/auth/session.ts",
    "src/auth/types.ts",
  ]),
  fetchDefinition: vi.fn(),
  fetchReferences: vi.fn(async () => []),
  fetchAround: vi.fn(async () => {
    throw new Error("offline");
  }),
  fetchTargets: vi.fn(async () => [
    {
      url: payload.pr.url,
      owner: payload.pr.owner,
      repo: payload.pr.repo,
      number: payload.pr.number,
      title: "Add token refresh",
      head_ref: "feature",
      label: "Everything",
      versions: 2,
      chats: 1,
      updated_at: Date.now() / 1000 - 60,
    },
    {
      url: "local:/src/sample#main..demo",
      owner: "local",
      repo: "sample-1234",
      number: 0,
      local: true,
      title: "",
      head_ref: "demo",
      label: "Map test",
      versions: 1,
      chats: 0,
      updated_at: Date.now() / 1000 - 40 * 86400,
    },
  ]),
  fetchReview: vi.fn(async () => ({ available: false })),
  fetchGenerate: vi.fn(async () => ({ state: "none" })),
  startGenerate: vi.fn(async () => ({ state: "running", doing: "" })),
  stopGenerate: vi.fn(async () => ({ state: "stopped" })),
  answerGenerate: vi.fn(async () => {}),
  fetchGenerateHarnesses: vi.fn(async () => ["claude-code", "codex"]),
  reviewAction: vi.fn(async () => ({ available: true, viewer: "jy", threads: [] })),
  fetchInbox: vi.fn(async () => ({
    login: "jy",
    error: null,
    prs: [
      inboxPR(42, "review", { title: "Add token refresh", stack: { id: "s", index: 2, size: 2 }, guides: 2 }),
      inboxPR(41, "yours", { title: "Add a Decision type", stack: { id: "s", index: 1, size: 2 } }),
      inboxPR(44, "yours", {
        title: "Retry budget",
        checks: { state: "failure", failing: 1 },
        reviewers: [{ login: "pk", avatar: "", state: "approved" }],
      }),
      inboxPR(47, "drafts", { title: "Plan mode", draft: true }),
    ],
  })),
}));
function inboxPR(n: number, group: string, extra: object) {
  return {
    url: n === 42 ? payload.pr.url : `https://github.com/acme/web/pull/${n}`,
    owner: "acme",
    repo: "web",
    number: n,
    title: "",
    draft: false,
    group,
    author: "sam",
    author_avatar: "",
    base_ref: "main",
    head_ref: `b${n}`,
    updated_at: Date.now() / 1000 - n * 60,
    comments: 3,
    reviewers: [],
    checks: { state: "success", failing: 0 },
    guides: 0,
    ...extra,
  };
}
// jsdom has no caret-from-point; the clicked name comes from here
const nav = vi.hoisted(() => ({ word: "refreshTokens" }));
vi.mock("../lib/definition", async (orig) => ({
  ...(await orig<typeof import("../lib/definition")>()),
  wordAtPoint: () => nav.word,
}));

const { App } = await import("../App");
const api = await import("../api");
const { useApp } = await import("../store");
const { useUI } = await import("../ui");
const { useChat } = await import("../chat");
const { useReview, useInbox } = await import("../review");

const rows = (sel: string) => [...document.querySelectorAll<HTMLTableRowElement>(`tr.ln${sel}`)];
const nums = (sel: string) =>
  rows(sel).map((r) => `${r.dataset.file!.split("/").pop()}:${r.dataset.new ?? `-${r.dataset.old}`}`);

beforeEach(() => {
  localStorage.clear();
  useReview.setState({ url: "", state: null, hiddenFiles: [], expanded: [], pending: [], error: null, busy: false });
  useInbox.setState({ inbox: null });
  useUI.setState({ mode: "guide", pinStep: null, pinSub: null });
});

async function mount() {
  useApp.setState({ url: payload.pr.url });
  render(<App />);
  await waitFor(() => expect(screen.getByText("Add token refresh")).toBeTruthy());
}

test("home lists past reviews, filters them, opens one, and the brand goes back", async () => {
  useApp.setState({ url: "", pr: null });
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll(".home-r")).toHaveLength(2));
  expect([...document.querySelectorAll(".home-g")].map((g) => g.textContent)).toEqual(["Today", "Older"]);
  const local = document.querySelectorAll(".home-r")[1];
  expect(local.querySelector(".t > span")!.textContent).toBe("Map test");
  expect(local.querySelector(".w")!.textContent).toBe("sample · demo");
  const search = screen.getByPlaceholderText("Search");
  fireEvent.keyDown(document.body, { key: "/" });
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: "sample demo" } });
  expect(document.querySelectorAll(".home-r")).toHaveLength(1);
  fireEvent.keyDown(search, { key: "Escape" });
  expect(document.querySelectorAll(".home-r")).toHaveLength(2);

  fireEvent.click(document.querySelector(".home-r")!);
  await waitFor(() => expect(document.querySelectorAll(".step")).toHaveLength(3));
  expect(new URLSearchParams(location.search).get("pr")).toBe(payload.pr.url);
  fireEvent.click(screen.getByTitle("Home"));
  await waitFor(() => expect(document.querySelectorAll(".home-r")).toHaveLength(2));
  expect(location.search).toBe("");
});

test("home's pull requests: grouped like GitHub, stacks as one row, remembered, and a row opens the review", async () => {
  useApp.setState({ url: "", pr: null });
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll(".home-r")).toHaveLength(2));
  fireEvent.click(screen.getByTitle("Pull requests"));
  expect(localStorage.getItem("rv-home-view")).toBe('"prs"');
  const groups = () => [...document.querySelectorAll(".ib-g")].map((g) => g.textContent);
  // the stack (#41 yours, #42 for review) is one row in the first group either layer is in
  expect(groups()).toEqual(["Needs your review2", "Yours1", "Drafts1"]);
  const stack = document.querySelector<HTMLElement>(".ib-stack > .ib-r")!;
  // titled by its bottom PR, and expanded until folded
  expect(stack.querySelector(".t > span")!.textContent).toBe("Add a Decision type");
  expect(stack.querySelector(".w")!.textContent).toBe("web #41 → #42 · 2 PRs · sam");
  expect([...document.querySelectorAll(".kid .lvl")].map((l) => l.textContent)).toEqual(["2", "1"]);
  fireEvent.click(stack);
  expect(document.querySelectorAll(".kid")).toHaveLength(0);
  expect(localStorage.getItem("rv-inbox-folded-stacks")).toBe('["s"]');
  fireEvent.click(stack);
  expect(document.querySelector(".kid [data-tip='Review ready']")).toBeTruthy(); // #42 has a guide
  const retry = screen.getByText("Retry budget").closest(".ib-r")!;
  expect(retry.querySelector(".ci.bad")!.textContent).toBe("1");
  expect(retry.querySelector(".rv")!.getAttribute("data-tip")).toBe("pk approved");
  expect(retry.querySelector(".ci")!.getAttribute("data-tip")).toBe("1 check failing");
  // search covers PRs too; a group folds
  fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "plan" } });
  expect(groups()).toEqual(["Drafts1"]);
  fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "" } });
  fireEvent.click(screen.getByText("Yours"));
  expect(screen.queryByText("Retry budget")).toBeNull();

  // a PR without a review can have one written from here; the row shows the agent at work
  const plan = screen.getByText("Plan mode").closest<HTMLElement>(".ib-r")!;
  fireEvent.click(plan.querySelector('[aria-label="Write a review"]')!);
  expect(api.startGenerate).toHaveBeenCalledWith("https://github.com/acme/web/pull/47", "", "default", "claude-code");
  await waitFor(() => expect(plan.querySelector(".gen.run")).toBeTruthy());
  expect(useApp.getState().url).not.toBe("https://github.com/acme/web/pull/47"); // the row didn't open

  fireEvent.click(screen.getByText("Add token refresh"));
  await waitFor(() => expect(document.querySelectorAll(".step")).toHaveLength(3));
  expect(new URLSearchParams(location.search).get("pr")).toBe(payload.pr.url);
  fireEvent.click(screen.getByTitle("Home"));
  await waitFor(() => expect(screen.getByText("Plan mode")).toBeTruthy()); // still on pull requests
});

test("renders guide, diff in guide order, skippable collapsed", async () => {
  await mount();
  const order = [...document.querySelectorAll<HTMLElement>(".file")].map((f) => f.dataset.path);
  expect(order).toEqual(["src/auth/types.ts", "src/auth/session.ts", "package-lock.json"]);
  expect(document.querySelector('.file[data-path="package-lock.json"]')!.classList.contains("collapsed")).toBe(true);
  expect(document.querySelectorAll(".step")).toHaveLength(3);
  expect(document.querySelector(".tldr code")!.textContent).toBe("tokens");
  expect(document.querySelector(".sec-h")?.textContent).not.toBe("Notes");
  // gutter dots at first row of each ref
  expect([...document.querySelectorAll("td.mark .dot")].map((d) => d.textContent)).toEqual([
    "1",
    "3.2",
    "3.2",
    "3.1",
    "2",
  ]);
});

test("hovering a step highlights exactly its lines; leaving clears", async () => {
  await mount();
  const step2 = document.querySelector<HTMLElement>('.step[data-step="2"]')!;
  fireEvent.mouseEnter(step2);
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.mouseLeave(step2.parentElement!);
  expect(nums(".hl")).toEqual([]);
});

test("click pins + expands; clicking again unpins; j/k navigate; Esc clears", async () => {
  await mount();
  fireEvent.click(document.querySelector('.step[data-step="1"]')!);
  expect(nums(".pin")).toEqual(["types.ts:2"]);
  expect(document.querySelector('.step[data-step="1"]')!.classList.contains("active")).toBe(true);
  fireEvent.keyDown(window, { key: "j" });
  expect(nums(".pin")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(nums(".pin")).toEqual([]);
  fireEvent.click(document.querySelector('.step[data-step="2"]')!);
  fireEvent.click(document.querySelector('.step[data-step="2"]')!);
  expect(nums(".pin")).toEqual([]);
});

test("viewed collapses; skippable row expands lockfile; gutter dot focuses step", async () => {
  await mount();
  const types = document.querySelector('.file[data-path="src/auth/types.ts"]')!;
  fireEvent.click(types.querySelector(".viewed")!);
  expect(types.classList.contains("collapsed")).toBe(true);
  fireEvent.click(document.querySelector(".skip-row")!);
  await waitFor(() =>
    expect(document.querySelector('.file[data-path="package-lock.json"]')!.classList.contains("collapsed")).toBe(false),
  );
  fireEvent.click(document.querySelector('td.mark .dot[data-step="2"]')!);
  expect(nums(".pin")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.click(document.querySelector(".step .check")!);
  expect(document.body.textContent).toContain("1/3");
});

test("the diff collapses to a rail in either mode; the rail or going to lines opens it", async () => {
  await mount();
  const app = () => document.querySelector(".app")!.classList.contains("no-diff");
  const collapse = () => fireEvent.click(document.querySelector('.diffpane button[title="Collapse the diff"]')!);
  const rail = () => document.querySelector<HTMLElement>(".diff-rail");
  expect([app(), rail()]).toEqual([false, null]);
  collapse();
  expect(app()).toBe(true);
  expect(rail()!.textContent).toMatch(/Diff · \d+ files?/);
  fireEvent.click(rail()!);
  expect(app()).toBe(false);
  collapse();
  fireEvent.click(document.querySelector('.step[data-step="2"]')!);
  expect(app()).toBe(false);
});

test("mini map boxes show what changed and link both ways with the steps; expand opens the map", async () => {
  await mount();
  const boxes = document.querySelectorAll<SVGGElement>(".mini-map .m-box");
  expect([...boxes].map((b) => [b.dataset.id, b.classList[1]])).toEqual([
    ["start", "added"],
    ["end", "added"],
    ["types", "added"],
    ["login", "context"],
  ]);
  expect(document.querySelectorAll(".mini-map .m-region")).toHaveLength(1);
  fireEvent.mouseEnter(boxes[1]);
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);
  expect(document.querySelector('.step[data-step="2"]')!.classList.contains("hover")).toBe(true);
  fireEvent.mouseLeave(document.querySelector(".mini-map")!);
  expect(document.querySelector(".mini-map svg.dim")).toBeNull();
  fireEvent.mouseEnter(document.querySelector('.step[data-step="1"]')!);
  expect(document.querySelector(".mini-map .m-box.lit")!.getAttribute("data-id")).toBe("types");
  fireEvent.mouseLeave(document.querySelector('.step[data-step="1"]')!);
  fireEvent.click(boxes[1]);
  expect(document.querySelector('.step[data-step="2"]')!.classList.contains("active")).toBe(true);
  expect(nums(".pin")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.click(document.querySelector('button[title="Open the map"]')!);
  expect(document.querySelector(".guide.map")).toBeTruthy();
  expect(document.querySelector(".step")).toBeNull();
});

test("map: scenes walk with j/k and arrows, light their blocks, pin their lines; h/l step through ranges", async () => {
  useUI.setState({ mode: "map" });
  useApp.setState({ url: payload.pr.url });
  render(<App />);
  await waitFor(() => expect(document.querySelector(".guide.map .m-box")).toBeTruthy());
  const card = () => document.querySelector(".map-card")!.textContent;
  const lit = () => [...document.querySelectorAll(".guide.map .m-box.lit")].map((b) => (b as SVGGElement).dataset.id);
  expect(card()).toContain("0/2");
  expect(card()).toContain("Session lifecycle");
  const full = () => document.querySelector(".app")!.classList.contains("no-diff");
  expect(full()).toBe(true); // the map fills the space; the diff opens on demand
  expect(document.querySelector(".guide.map svg")!.classList.contains("dim")).toBe(false);

  fireEvent.keyDown(window, { key: "j" });
  expect(card()).toContain("1/2");
  expect(card()).toContain("Types");
  expect(lit()).toEqual(["types"]);
  expect(nums(".pin")).toEqual(["types.ts:2"]);

  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(card()).toContain("Teardown");
  expect(nums(".pin")).toEqual(["session.ts:5", "session.ts:6", "session.ts:7"]);
  fireEvent.keyDown(window, { key: "l" });
  expect(nums(".flash")).toEqual(["session.ts:5"]);
  fireEvent.keyDown(window, { key: "l" });
  expect(nums(".flash")).toEqual(["session.ts:6", "session.ts:7"]);

  fireEvent.keyDown(window, { key: "k" });
  expect(card()).toContain("Types");
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  expect(card()).toContain("0/2");
  expect(nums(".pin")).toEqual([]);

  // hover peeks every range a block cites; click pins its lines
  const end = document.querySelector<SVGGElement>('.guide.map .m-box[data-id="end"]')!;
  fireEvent.mouseEnter(end);
  expect(document.querySelector(".map-peek")!.textContent).toContain("clearTimeout(this.timer);");
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.mouseLeave(end);
  expect(document.querySelector(".map-peek")).toBeNull();
  fireEvent.click(end);
  expect(end.classList.contains("on")).toBe(true);
  expect(nums(".pin")).toEqual(["session.ts:6", "session.ts:7"]);
  expect(full()).toBe(false); // clicking a box opens the diff at its lines
  fireEvent.click(document.querySelector('.diffpane button[title="Collapse the diff"]')!);
  expect(full()).toBe(true);
  fireEvent.click(document.querySelector(".diff-rail")!);
  expect(full()).toBe(false);

  // leaving on a step's scene pins that step in the steps; coming back opens its scene
  fireEvent.keyDown(window, { key: "j" });
  fireEvent.keyDown(window, { key: "j" });
  expect(card()).toContain("Teardown");
  fireEvent.click(document.querySelector('button[title="Steps"]')!);
  expect(document.querySelectorAll(".step")).toHaveLength(3);
  expect(document.querySelector('.step[data-step="2"]')!.classList.contains("active")).toBe(true);
  fireEvent.click(document.querySelector('.step[data-step="1"]')!);
  fireEvent.click(document.querySelector('button[title="Map"]')!);
  expect(card()).toContain("1/2");
  expect(nums(".pin")).toEqual(["types.ts:2"]);
  // a step with no scene opens the overview
  fireEvent.click(document.querySelector('button[title="Steps"]')!);
  fireEvent.click(document.querySelector('.step[data-step="3"]')!);
  fireEvent.click(document.querySelector('button[title="Map"]')!);
  expect(card()).toContain("0/2");
});

test("substeps: hover/click highlight just their lines (multi-file); j/k walk substeps; gutter dots", async () => {
  await mount();
  const subs = document.querySelectorAll<HTMLElement>(".sub");
  expect([...subs].map((s) => s.querySelector(".sub-n")!.textContent)).toEqual(["3.1", "3.2"]);
  fireEvent.mouseEnter(subs[1]);
  expect(nums(".hl").sort()).toEqual(["session.ts:2", "types.ts:2"]);
  fireEvent.mouseEnter(document.querySelector('.step[data-step="3"]')!);
  expect(nums(".hl")).toHaveLength(3); // step = union of its substeps
  fireEvent.click(subs[0]);
  expect(nums(".pin")).toEqual(["session.ts:5"]);
  expect(subs[0].classList.contains("active")).toBe(true);
  fireEvent.keyDown(window, { key: "j" });
  expect(nums(".pin").sort()).toEqual(["session.ts:2", "types.ts:2"]);
  fireEvent.keyDown(window, { key: "k" });
  fireEvent.keyDown(window, { key: "k" });
  expect(document.querySelector('.step[data-step="3"]')!.classList.contains("active")).toBe(true);
  fireEvent.click(document.querySelector('td.mark .dot[data-step="3"][data-sub="1"]')!);
  expect(nums(".pin")).toEqual(["session.ts:5"]);
});

test("h/l walk the pinned step's line ranges, keeping the pin", async () => {
  await mount();
  useUI.getState().clearPin();
  fireEvent.click(document.querySelector('.step[data-step="3"]')!);
  expect(nums(".pin")).toHaveLength(3);
  fireEvent.keyDown(window, { key: "l" });
  expect(nums(".flash")).toEqual(["session.ts:5"]);
  expect(document.querySelector(".ref.on")!.textContent).toBe("session.ts:5");
  fireEvent.keyDown(window, { key: "l" });
  fireEvent.keyDown(window, { key: "l" });
  expect(nums(".flash")).toEqual(["types.ts:2"]);
  fireEvent.keyDown(window, { key: "l" }); // stays on the last one
  expect(nums(".flash")).toEqual(["types.ts:2"]);
  fireEvent.keyDown(window, { key: "h" });
  expect(nums(".flash")).toEqual(["session.ts:2"]);
  expect(nums(".pin")).toHaveLength(3); // still the whole step
  // j moves on, and h/l start again from the new item's first range
  fireEvent.keyDown(window, { key: "j" });
  expect(document.querySelector(".ref.on")).toBeNull();
  fireEvent.keyDown(window, { key: "l" });
  expect(nums(".flash")).toEqual(["session.ts:5"]);
});

test("comments sit under their last line, highlight it, and can be hidden, resolved, unresolved or asked about", async () => {
  await mount();
  const cmts = () => [...document.querySelectorAll<HTMLElement>("tr.cmt-row")];
  // each comment row follows the last line it cites
  expect(
    cmts().map((r) => [r.querySelector("b")!.textContent, (r.previousElementSibling as HTMLElement).dataset.new]),
  ).toEqual([
    ["No retry", "2"],
    ["Teardown on logout", "7"],
  ]);
  expect(cmts()[0].dataset.tone).toBe("bug");
  fireEvent.mouseEnter(cmts()[1]);
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);

  // Ask opens the popup on the comment's lines, carrying the comment as context
  fireEvent.click(cmts()[1].querySelector('button[title="Ask in chat"]')!);
  const pop = document.querySelector(".ask-pop")!;
  expect(pop.querySelector(".ask-ctx")!.textContent).toContain("Teardown on logout");
  expect(pop.querySelector("textarea")!.getAttribute("placeholder")).toBe("Ask about this comment");
  fireEvent.keyDown(pop.querySelector("textarea")!, { key: "Enter" }); // queue it
  const q = useChat.getState().chat.questions.at(-1)!;
  expect([q.text, q.anchor?.comment, q.anchor?.start, q.anchor?.end]).toEqual([
    "Tell me more about this comment.",
    "Teardown on logout. `end()` runs on logout too.",
    6,
    7,
  ]);

  // the toolbar toggle hides them all; resolving one removes it and the count
  const tg = document.querySelector<HTMLElement>(".cmt-tg")!;
  expect(tg.textContent).toBe("2");
  fireEvent.click(tg);
  expect(cmts()).toHaveLength(0);
  fireEvent.click(tg);
  fireEvent.click(cmts()[0].querySelector('button[title="Resolve"]')!);
  expect(tg.textContent).toBe("1");
  // a resolved comment collapses to one line, and one click on it unresolves
  const closed = cmts()[0];
  expect([closed.classList.contains("closed"), closed.textContent]).toEqual([true, "ResolvedNo retry"]);
  fireEvent.click(closed.querySelector(".cmt-closed")!);
  expect([cmts()[0].querySelector(".cmt-t")!.textContent, tg.textContent]).toEqual(["A 5xx is not retried.", "2"]);
});

const comment = (id: string, author: string, body: string) => ({
  id,
  author,
  avatar: "",
  bot: false,
  body,
  created_at: Date.now() / 1000 - 3600,
  url: "",
});
const thread = (id: string, extra: object) => ({
  id,
  path: "src/auth/session.ts",
  side: "new",
  start: null,
  end: null,
  file_level: false,
  resolved: false,
  outdated: false,
  comments: [comment(`${id}c`, "pk", `${id} first`)],
  ...extra,
});
const ghState = {
  available: true,
  viewer: "jy",
  reviewers: [{ login: "pk", avatar: "", state: "changes" }],
  checks: {
    state: "failure",
    failing: 1,
    list: [
      { name: "test / ubuntu", state: "failure", url: "https://ci/1" },
      { name: "lint", state: "success", url: "https://ci/2" },
    ],
  },
  threads: [
    thread("T1", {
      start: 6,
      end: 7,
      comments: [
        comment("a", "pk", "Why clear here?"),
        comment("b", "jy", "Logout"),
        comment("c", "pk", "And refresh?"),
        comment("d", "sam", "Fixed"),
      ],
    }),
    thread("T2", { start: 2, end: 2, resolved: true }),
    thread("T3", { path: "src/auth/types.ts", file_level: true }),
    thread("T4", { start: 1, end: 1, outdated: true }),
  ],
};

test("GitHub threads sit under their lines with range bars, fold long middles, and list in the popover", async () => {
  vi.mocked(api.fetchReview).mockResolvedValue(ghState as never);
  useApp.setState({ pr: null }); // so the review loads afresh, with GitHub's state
  await mount();
  const card = () => document.querySelector<HTMLElement>('[data-thread="T1"]')!;
  await waitFor(() => expect(card()).toBeTruthy());
  // under the last line it covers (after that line's own comment), with a bar on each covered line (none for the
  // resolved one)
  const above = card().closest("tr")!.previousElementSibling as HTMLElement;
  expect([above.className, (above.previousElementSibling as HTMLElement).dataset.new]).toEqual(["cmt-row", "7"]);
  expect(nums(".rng")).toEqual(["session.ts:6", "session.ts:7"]);
  // first and last comment, the two between folded
  expect([...card().querySelectorAll(".th-c b")].map((b) => b.textContent)).toEqual(["pk", "sam"]);
  fireEvent.click(screen.getByText("2 more replies"));
  expect(card().querySelectorAll(".th-c")).toHaveLength(4);
  fireEvent.mouseEnter(card());
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.mouseLeave(card());
  // resolved: one line until opened; file-level: under the file's header; outdated: not on the diff
  expect(document.querySelector('[data-thread="T2"]')!.classList.contains("th-closed")).toBe(true);
  expect(document.querySelector('.file[data-path="src/auth/types.ts"] .file-th [data-thread="T3"]')).toBeTruthy();
  expect(document.querySelector('[data-thread="T4"]')).toBeNull();

  // the toolbar button counts open threads and lists them by file
  const tg = document.querySelector<HTMLElement>(".cmt-tg")!;
  expect(tg.textContent).toBe("3");
  fireEvent.click(tg);
  const pop = () => document.querySelector<HTMLElement>(".th-pop")!;
  const items = () => [...pop().querySelectorAll(".tl-t .where")].map((w) => w.textContent);
  expect(items()).toEqual(["L6–7 · 4", "outdated", "file"]);
  const seg = (i: number) => pop().querySelectorAll<HTMLElement>(".th-seg button")[i];
  fireEvent.click(seg(1));
  expect(items()).toEqual(["L2"]);
  fireEvent.click(seg(0));
  // hiding a file's threads takes them off the diff
  fireEvent.click(pop().querySelector(".tl-g:last-child .tl-hide")!);
  expect(document.querySelector('[data-thread="T3"]')).toBeNull();
  // folding a file shows its count
  fireEvent.click(pop().querySelector(".tl-fold")!);
  expect(pop().querySelector(".tl-f .n")!.textContent).toBe("2");
  vi.mocked(api.fetchReview).mockResolvedValue({ available: false } as never);
});

test("writing: reply, resolve, edit your own, comment from the line popup, and submit a review", async () => {
  vi.mocked(api.fetchReview).mockResolvedValue({ ...ghState, author: "sam", head_sha: "h1" } as never);
  vi.mocked(api.reviewAction).mockResolvedValue({ ...ghState, author: "sam", head_sha: "h1" } as never);
  useApp.setState({ pr: null });
  await mount();
  const card = () => document.querySelector<HTMLElement>('[data-thread="T1"]')!;
  await waitFor(() => expect(card()).toBeTruthy());
  const acted = () => vi.mocked(api.reviewAction).mock.calls.map((c) => c[1]);

  // reply: a click opens the box, ↵ sends it
  fireEvent.click(card().querySelector(".th-reply")!);
  const box = card().querySelector<HTMLTextAreaElement>(".th-compose textarea")!;
  fireEvent.change(box, { target: { value: "Will do" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(acted()).toEqual([{ kind: "reply", thread: "T1", body: "Will do" }]));
  fireEvent.click(card().querySelector(".th-res")!);
  expect(acted()[1]).toEqual({ kind: "resolve", thread: "T1" });

  // only your own comments can be edited
  fireEvent.click(screen.getByText("2 more replies"));
  const mine = [...card().querySelectorAll<HTMLElement>(".th-c")].filter((c) => c.querySelector(".th-acts"));
  expect(mine.map((c) => c.querySelector("b")!.textContent)).toEqual(["jy"]);
  fireEvent.click(mine[0].querySelector('[data-tip="Edit"]')!);
  const edit = mine[0].querySelector<HTMLTextAreaElement>(".th-compose textarea")!;
  expect(edit.value).toBe("Logout");
  fireEvent.change(edit, { target: { value: "On logout" } });
  fireEvent.keyDown(edit, { key: "Enter" });
  await waitFor(() => expect(acted()[2]).toEqual({ kind: "edit", comment: "b", body: "On logout" }));

  // the line popup: Tab switches to commenting, ↵ adds it to your review
  const rows = [...document.querySelectorAll<HTMLElement>('tr.ln[data-file="src/auth/session.ts"]')];
  Object.defineProperty(document, "elementFromPoint", { value: () => rows[2], configurable: true });
  fireEvent.mouseDown(rows[1].querySelector(".ask-btn")!, { button: 0, clientX: 300, clientY: 100 });
  fireEvent.mouseUp(window, { clientX: 300, clientY: 120 });
  await waitFor(() => expect(document.querySelector(".ask-pop")).toBeTruthy());
  const input = document.querySelector<HTMLTextAreaElement>(".ask-in textarea")!;
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input.getAttribute("placeholder")).toBe("Comment");
  fireEvent.change(input, { target: { value: "Name this better" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const pend = await waitFor(() => document.querySelector<HTMLElement>(".th.pending")!);
  expect(pend.querySelector(".th-tag.pend")!.textContent).toBe("Pending");
  expect(useReview.getState().pending.map((p) => [p.path, p.side, p.start, p.end, p.body])).toEqual([
    ["src/auth/session.ts", "new", 2, 3, "Name this better"],
  ]);

  // the review chip counts it; submitting sends it with a verdict and the head it was written on
  const chip = document.querySelector<HTMLElement>(".rv-btn")!;
  expect(chip.textContent).toBe("Review1");
  fireEvent.click(chip);
  expect([...document.querySelectorAll(".rv-pop .th-seg button")].map((b) => b.textContent)).toEqual([
    "Comment",
    "Approve",
    "Request changes",
  ]);
  fireEvent.change(document.querySelector(".rv-body")!, { target: { value: "Nearly there" } });
  fireEvent.click(screen.getByText("Request changes"));
  fireEvent.click(screen.getByText("Submit"));
  await waitFor(() => expect(useReview.getState().pending).toEqual([]));
  expect(acted()[3]).toEqual({
    kind: "submit",
    event: "request_changes",
    body: "Nearly there",
    commit: "h1",
    comments: [{ path: "src/auth/session.ts", side: "new", start: 2, end: 3, body: "Name this better" }],
  });
  expect(document.querySelector(".rv-pop")).toBeNull();
  vi.mocked(api.fetchReview).mockResolvedValue({ available: false } as never);
  localStorage.removeItem("rv-ask-mode");
});

test("the conversation: description, reviews with the threads they started, commits run together, and commenting", async () => {
  const at = Date.now() / 1000;
  const item = (kind: string, id: string, author: string, ago: number, extra = {}) => ({
    kind,
    id,
    author,
    avatar: "",
    body: "",
    created_at: at - ago,
    ...extra,
  });
  const state = {
    ...ghState,
    id: "PR_7",
    author: "jy",
    threads: ghState.threads.map((t) =>
      t.id === "T1" ? { ...t, comments: t.comments.map((c, i) => (i ? c : { ...c, review: "R1" })) } : t,
    ),
    timeline: [
      item("commit", "c1", "sam", 500, { sha: "aaaaaaa1", body: "Start" }),
      item("commit", "c2", "sam", 400, { sha: "bbbbbbb2", body: "More" }),
      item("review", "R1", "pk", 300, { state: "changes", body: "One problem" }),
      item("comment", "C1", "jy", 200, { body: "On it" }),
    ],
  };
  vi.mocked(api.fetchReview).mockResolvedValue(state as never);
  vi.mocked(api.reviewAction).mockResolvedValue(state as never);
  useApp.setState({ pr: null });
  await mount();
  await waitFor(() => expect(screen.getByTitle("Conversation")).toBeTruthy());
  fireEvent.click(screen.getByTitle("Conversation"));
  const tl = () => [...document.querySelectorAll<HTMLElement>(".conv-tl > *")];
  // the saved review (v1) is older than the PR's events here
  expect(tl().map((e) => e.querySelector("b, span")!.textContent)).toEqual([
    "Review v1",
    "sam pushed 2 commitsaaaaaaa Startbbbbbbb More",
    "pk",
    "jy",
  ]);
  expect(tl()[2].querySelector(".conv-state")!.textContent).toBe("Changes requested");
  // a review's threads link to their lines
  const th = tl()[2].querySelector<HTMLElement>(".conv-th")!;
  expect(th.querySelector(".where")!.textContent).toBe("session.ts L6–7");
  fireEvent.click(th);
  expect(useUI.getState().flash.keys.size).toBeGreaterThan(0);
  // ⌘↵ comments on the PR
  const box = document.querySelector<HTMLTextAreaElement>(".conv-box textarea")!;
  fireEvent.change(box, { target: { value: "Thanks all" } });
  fireEvent.keyDown(box, { key: "Enter", metaKey: true });
  await waitFor(() =>
    expect(vi.mocked(api.reviewAction).mock.calls.at(-1)![1]).toEqual({
      kind: "comment",
      pr: "PR_7",
      body: "Thanks all",
    }),
  );
  // your own comment can be edited (not someone else's review), and its time links to GitHub
  expect(tl()[2].querySelector('[data-tip="Edit"]')).toBeNull();
  fireEvent.click(tl()[3].querySelector<HTMLElement>('[data-tip="Edit"]')!);
  const ed = tl()[3].querySelector<HTMLTextAreaElement>(".conv-edit textarea")!;
  expect(ed.value).toBe("On it");
  fireEvent.change(ed, { target: { value: "On it now" } });
  fireEvent.keyDown(ed, { key: "Enter", metaKey: true });
  await waitFor(() =>
    expect(vi.mocked(api.reviewAction).mock.calls.at(-1)![1]).toEqual({
      kind: "edit",
      comment: "C1",
      body: "On it now",
    }),
  );
  // your own PR's title is edited in place, from the header; its description from beside the text
  fireEvent.click(document.querySelector<HTMLElement>('.pr .pr-acts [data-tip="Edit title"]')!);
  const ti = document.querySelector<HTMLInputElement>(".title-edit input")!;
  expect(ti.value).toBe(useApp.getState().pr!.title);
  fireEvent.change(ti, { target: { value: "New title" } });
  fireEvent.keyDown(ti, { key: "Enter" });
  await waitFor(() =>
    expect(vi.mocked(api.reviewAction).mock.calls.at(-1)![1]).toMatchObject({ kind: "edit_pr", title: "New title" }),
  );
  await waitFor(() => expect(document.querySelector(".pr h1")!.textContent).toBe("New title"));
  fireEvent.click(document.querySelector<HTMLElement>('.conv-desc [data-tip="Edit description"]')!);
  fireEvent.keyDown(document.querySelector(".conv-desc textarea")!, { key: "Escape" });
  expect(document.querySelector(".conv-desc textarea")).toBeNull();
  useUI.getState().setMode("guide");
  vi.mocked(api.fetchReview).mockResolvedValue({ available: false } as never);
});

test("a GitHub PR's top bar: switcher with its stack, checks, reviewers", async () => {
  const failing = {
    name: "test / ubuntu",
    state: "failure",
    url: "https://ci/1",
    annotations: [{ path: "src/auth/session.ts", start: 5, end: 5, title: "", message: "timer leaks" }],
  };
  vi.mocked(api.fetchReview).mockResolvedValue({
    ...ghState,
    mergeable: "conflicting",
    base_ref: "main",
    checks: { ...ghState.checks, list: [failing, ghState.checks.list[1]] },
  } as never);
  vi.mocked(api.fetchInbox).mockResolvedValueOnce({
    login: "jy",
    error: null,
    prs: [
      inboxPR(7, "yours", { title: "Add token refresh", stack: { id: "s", index: 2, size: 2 } }),
      inboxPR(6, "yours", { title: "Session types", stack: { id: "s", index: 1, size: 2 } }),
      inboxPR(9, "review", { title: "Other work" }),
    ],
  } as never);
  useApp.setState({ pr: null });
  await mount();
  await waitFor(() =>
    expect(document.querySelector(".target .stk") && document.querySelector(".ci-chip")).toBeTruthy(),
  );
  expect(document.querySelector(".target .stk")!.textContent).toBe("2/2");
  expect(document.querySelector(".ci-chip")!.textContent).toBe("1");
  expect(document.querySelector('.target .rv[data-tip="pk requested changes"]')).toBeTruthy();
  fireEvent.click(document.querySelector(".ci-chip")!);
  expect([...document.querySelectorAll(".ci-pop .r")].map((r) => r.textContent)).toEqual(["test / ubuntu", "lint"]);
  expect(document.querySelector(".ci-pop .mg")!.textContent).toBe("Conflicts with main");
  // a failing check's note sits on the line it points at
  const ci = document.querySelector<HTMLElement>('[data-thread^="ci:"]')!;
  expect([ci.querySelector(".th-tag")!.textContent, ci.querySelector(".th-x")!.textContent]).toEqual([
    "CI",
    "timer leaks",
  ]);
  expect((ci.closest("tr")!.previousElementSibling as HTMLElement).dataset.new).toBe("5");

  fireEvent.click(document.querySelector(".sw-btn")!);
  const sw = () => [...document.querySelectorAll(".sw-pop .sw-h, .sw-pop .sw-i")].map((e) => e.textContent);
  expect(sw()).toEqual(["Stack", "2Add token refresh#7", "1Session types#6", "Needs your review", "Other work#9"]);
  fireEvent.change(document.querySelector(".sw-q input")!, { target: { value: "other" } });
  expect(sw()).toEqual(["Needs your review", "Other work#9"]);
  fireEvent.click(screen.getByText("Other work"));
  expect(useApp.getState().url).toBe("https://github.com/acme/web/pull/9");
  vi.mocked(api.fetchReview).mockResolvedValue({ available: false } as never);
});

test("file list toggles, nests directories, and opens a picked file", async () => {
  await mount();
  expect(document.querySelector(".rail")).toBeNull();
  fireEvent.click(document.querySelector('.diffpane button[title="Files"]')!);
  const rail = document.querySelector(".rail")!;
  // folders first, single-child chains joined into one row
  expect([...rail.querySelectorAll(".rail-dir")].map((d) => d.textContent)).toEqual(["src/auth"]);
  expect([...rail.querySelectorAll(".rail-f")].map((f) => f.querySelector(".nm")!.textContent)).toEqual([
    "session.ts",
    "types.ts",
    "package-lock.json",
  ]);
  expect(rail.querySelector('[data-path="package-lock.json"]')!.classList.contains("skip")).toBe(true);
  // picking a collapsed file opens it and marks it current
  fireEvent.click(rail.querySelector('[data-path="package-lock.json"]')!);
  await waitFor(() =>
    expect(rail.querySelector('[data-path="package-lock.json"]')!.classList.contains("on")).toBe(true),
  );
  expect(document.querySelector('.file[data-path="package-lock.json"]')!.classList.contains("collapsed")).toBe(false);
  expect(localStorage.getItem("rv-rail")).toBe("true");
});

test("all files: changed folders open, the rest folded; the filter narrows; other files open in tabs", async () => {
  const { useUI } = await import("../ui");
  await mount();
  if (!document.querySelector(".rail")) fireEvent.click(document.querySelector('.diffpane button[title="Files"]')!);
  fireEvent.click(screen.getByTitle("All files"));
  const rail = document.querySelector(".rail")!;
  await waitFor(() => expect(rail.querySelector('[data-path="README.md"]')).toBeTruthy());
  const dirs = () =>
    [...rail.querySelectorAll<HTMLElement>(".rail-dir")].map((d) => [d.textContent, d.getAttribute("aria-expanded")]);
  expect(dirs()).toEqual([
    ["docs", "false"],
    ["src/auth", "true"],
  ]);
  expect(rail.querySelector('[data-path="README.md"]')!.classList.contains("plain")).toBe(true);

  // the filter opens folders to show what matches
  const filter = rail.querySelector<HTMLInputElement>(".rail-q input")!;
  fireEvent.change(filter, { target: { value: "guide" } });
  expect([...rail.querySelectorAll(".rail-f")].map((f) => f.getAttribute("data-path"))).toEqual(["docs/guide.md"]);
  fireEvent.change(filter, { target: { value: "" } });

  // an unchanged file opens in a preview tab, which the next one replaces; the rail follows it
  fireEvent.click(rail.querySelector('[data-path="README.md"]')!);
  await waitFor(() => expect(document.querySelector(".fileview tr.ln")).toBeTruthy());
  const tabs = () => [...document.querySelectorAll<HTMLElement>(".tab")].map((t) => t.textContent);
  expect(tabs()).toEqual(["Diff", "README.md"]);
  expect(document.querySelector<HTMLElement>(".diffpane .diffwrap:not(.fileview)")!.hidden).toBe(true);
  expect(rail.querySelector('[data-path="README.md"]')!.classList.contains("on")).toBe(true);
  fireEvent.click(rail.querySelector(".rail-dir")!); // open docs
  fireEvent.click(rail.querySelector('[data-path="docs/guide.md"]')!);
  await waitFor(() => expect(tabs()).toEqual(["Diff", "guide.md"]));

  // ⌘-click a changed file: a kept tab, with its added lines marked
  fireEvent.click(rail.querySelector('[data-path="src/auth/types.ts"]')!, { metaKey: true });
  await waitFor(() => expect(tabs()).toEqual(["Diff", "guide.md", "types.ts"]));
  expect(useUI.getState().tabs.map((t) => [t.path, t.pinned])).toEqual([
    ["docs/guide.md", false],
    ["src/auth/types.ts", true],
  ]);
  await waitFor(() => expect(document.querySelectorAll(".fileview tr.ln.add").length).toBeGreaterThan(0));
  // a plain click on a changed file goes back to the diff
  fireEvent.click(rail.querySelector('[data-path="src/auth/session.ts"]')!);
  await waitFor(() => expect(useUI.getState().tab).toBeNull());
  expect(document.querySelector(".fileview")).toBeNull();
  // closing tabs
  for (const t of [...document.querySelectorAll<HTMLElement>(".tab .x")]) fireEvent.click(t);
  expect(tabs()).toEqual(["Diff"]);
  useUI.getState().setRailMode("diff");
});

test("expanding a gap fetches the file and reveals numbered context rows", async () => {
  await mount();
  const file = () => document.querySelector<HTMLElement>('.file[data-path="src/auth/session.ts"]')!;
  const ctxNums = () =>
    [...file().querySelectorAll<HTMLElement>("tr.ln.ctx")].map((r) => `${r.dataset.old}/${r.dataset.new}`);
  const before = ctxNums().length;
  // the hunk starts at line 1, so the only expander is the one after it
  expect(file().querySelectorAll("tr.gap")).toHaveLength(1);
  fireEvent.click(file().querySelector("tr.gap .exp-btn")!);
  await waitFor(() => expect(ctxNums().length).toBe(before + 20));
  expect(ctxNums().slice(-20)[0]).toBe("6/9");
  expect(file().querySelector('tr[data-rk="src/auth/session.ts:28"] .src')!.textContent).toBe("line 28");
  // 12 lines left: no more arrows; the row itself opens the rest and goes away
  expect(file().querySelector("tr.gap .exp-btn")).toBeNull();
  expect(file().querySelector("tr.gap .exp-all")!.textContent).toBe("12 more lines");
  fireEvent.click(file().querySelector("tr.gap")!);
  await waitFor(() => expect(ctxNums().at(-1)).toBe("37/40"));
  expect(file().querySelectorAll("tr.gap")).toHaveLength(0);
});

test("full file toggle shows every line, then folds back to the hunks", async () => {
  await mount();
  const file = () => document.querySelector<HTMLElement>('.file[data-path="src/auth/types.ts"]')!;
  const toggle = () =>
    file().querySelector<HTMLElement>(
      '.file-h button[title="Show full file"], .file-h button[title="Show changes only"]',
    )!;
  fireEvent.click(toggle());
  await waitFor(() => expect(file().querySelectorAll("tr.ln")).toHaveLength(40));
  fireEvent.click(toggle());
  expect(file().querySelectorAll("tr.ln")).toHaveLength(3);
});

test("⌘-click on a name previews its definition under the row; Esc closes it", async () => {
  await mount();
  vi.mocked(api.fetchDefinition).mockResolvedValueOnce([
    { path: "src/api/client.ts", line: 3, end: 5, text: "export async function refreshTokens(t) {\n  return t;\n}" },
  ]);
  nav.word = "refreshTokens";
  const row = document.querySelector<HTMLElement>('tr[data-rk="src/auth/session.ts:2"]')!;
  fireEvent.click(row.querySelector(".src")!, { metaKey: true });
  await waitFor(() => expect(document.querySelector(".peek .path")?.textContent).toBe("src/api/client.ts"));
  expect(api.fetchDefinition).toHaveBeenCalledWith(payload.pr.url, "refreshTokens", "src/auth/session.ts");
  expect(row.nextElementSibling!.classList.contains("peek-row")).toBe(true);
  expect([...document.querySelectorAll(".peek-b td.no")].map((td) => td.textContent)).toEqual(["3", "4", "5"]);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(document.querySelector(".peek")).toBeNull());
  // a plain click does nothing
  fireEvent.click(row.querySelector(".src")!);
  expect(document.querySelector(".peek")).toBeNull();
});

test("a definition already in the diff is jumped to instead of previewed", async () => {
  await mount();
  vi.mocked(api.fetchDefinition).mockResolvedValueOnce([
    { path: "src/auth/types.ts", line: 2, end: 2, text: "  expiresAt: number;" },
  ]);
  nav.word = "expiresAt";
  fireEvent.click(document.querySelector('tr[data-rk="src/auth/session.ts:2"] .src')!, { metaKey: true });
  await waitFor(() => expect(nums(".flash")).toEqual(["types.ts:2"]));
  expect(document.querySelector(".peek")).toBeNull();
});

async function mountWith(data: typeof payload) {
  vi.mocked(api.fetchPR).mockResolvedValueOnce(data);
  useApp.setState({ url: data.pr.url, pr: null, guide: null, versions: [] });
  render(<App />);
  await waitFor(() => expect(screen.getByText("Add token refresh")).toBeTruthy());
}

test("version history: shown once there are two, and picking one swaps the guide", async () => {
  const v2 = { ...payload.guide!, version: 2, tldr: "second", label: "Split config" };
  const versions = [
    ...payload.versions,
    { version: 2, label: "Split config", scope: null, source: "chat" as const, created_at: 0 },
  ];
  await mountWith({ ...payload, guide: v2, versions });
  expect(document.querySelector(".tldr")!.textContent).toBe("second");
  fireEvent.click(document.querySelector(".ver-btn")!);
  const items = [...document.querySelectorAll<HTMLElement>(".ver-menu .h-item")];
  expect(items.map((i) => i.querySelector(".h-t")!.textContent)).toEqual(["v2Split config", "v1Guide"]);
  vi.mocked(api.fetchGuide).mockResolvedValueOnce({ ...payload.guide!, version: 1, tldr: "first" });
  fireEvent.click(items[1]);
  await waitFor(() => expect(document.querySelector(".tldr")!.textContent).toBe("first"));
  expect(api.fetchGuide).toHaveBeenCalledWith(payload.pr.url, 1);
  expect(new URLSearchParams(location.search).get("v")).toBe("1");
  expect(useApp.getState().following).toBe(false); // an older version stays put when new ones arrive
});

test("scope chip names what the guide covers", async () => {
  const scoped = { ...payload.guide!, scope: { files: ["src/auth/"], note: "auth only" } };
  await mountWith({ ...payload, guide: scoped });
  expect(document.querySelector(".scope-chip")!.textContent).toBe("auth only");
  expect(document.querySelector(".ver-btn")).toBeNull(); // one version: no history
});

test("no guide yet: write one from here, watch it in the chat, stop it, and see it when it's submitted", async () => {
  await mountWith({ ...payload, guide: null, versions: [] });
  expect(document.querySelector(".no-guide")).toBeNull(); // a GitHub PR gets the card, not the command hint
  // the picker can copy the command, focus included, to run it yourself
  const focus = screen.getByPlaceholderText("Anything to focus on?");
  fireEvent.change(focus, { target: { value: "the refresh timer" } });
  fireEvent.click(document.querySelector(".gen-h")!);
  expect(screen.getByText("Copy command")).toBeTruthy();
  // Codex too, when it's installed
  await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Codex/ })).toBeTruthy());
  fireEvent.click(document.querySelector(".gen-h")!);
  // Generate runs it in the background; the chat shows the run as it goes
  const running = {
    state: "running" as const,
    started_at: Date.now() / 1000 - 75,
    prompt: `/diffusion:review ${payload.pr.url} the refresh timer`,
    log: [{ tool: "Read session.ts" }],
    text: "Starting with the timer.",
    asks: [{ id: "g1", tool: "Bash", summary: "Run npm test", input: { command: "npm test" } }],
  };
  vi.mocked(api.fetchGenerate).mockResolvedValue(running);
  vi.mocked(api.startGenerate).mockResolvedValue(running);
  fireEvent.keyDown(focus, { key: "Enter" });
  expect(api.startGenerate).toHaveBeenCalledWith(payload.pr.url, "the refresh timer", "default", "claude-code");
  await waitFor(() => expect(document.querySelector(".gen-clock")?.textContent).toBe("1:15"));
  expect(document.querySelector(".chat .bubble")!.textContent).toBe(
    `/diffusion:review ${payload.pr.repo}#${payload.pr.number} the refresh timer`,
  );
  expect(document.querySelector(".chat .trace-tool")!.textContent).toContain("session.ts");
  expect(document.querySelector(".chat .ans-t")!.textContent).toBe("Starting with the timer.");
  // what the run's mode doesn't allow is asked in the chat, as in a turn
  expect(document.querySelector(".chat .ask-d")!.textContent).toBe("npm test");
  vi.mocked(api.fetchGenerate).mockResolvedValue({ ...running, asks: [] });
  fireEvent.click(screen.getByTitle("Allow (↵)"));
  expect(api.answerGenerate).toHaveBeenCalledWith("g1", "allow");
  expect(document.querySelector(".chat .ask-card")).toBeNull();
  // Stop ends the run and brings the card back
  vi.mocked(api.fetchGenerate).mockResolvedValue({ state: "stopped" });
  vi.mocked(api.stopGenerate).mockResolvedValue({ state: "stopped" });
  fireEvent.click(document.querySelector('[data-tip="Stop"]')!);
  await waitFor(() => expect(screen.getByPlaceholderText("Anything to focus on?")).toBeTruthy());
  expect(api.stopGenerate).toHaveBeenCalledWith(payload.pr.url);
  // a submitted guide replaces the card
  vi.mocked(api.fetchGenerate).mockResolvedValue({ state: "none" });
  vi.mocked(api.fetchGuide).mockResolvedValueOnce({ ...payload.guide!, version: 1 });
  await useApp.getState().refresh();
  await waitFor(() => expect(document.querySelector(".tldr")).toBeTruthy());
  expect(document.querySelector(".gen-card")).toBeNull();
});
