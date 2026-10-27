import { describe, expect, it } from "vitest";
import type { FileDiff } from "../types";
import { describeActivity } from "./activity";

const file = (path: string, ids: string[]) =>
  ({ path, hunks: ids.map((id) => ({ id, file: path })) }) as unknown as FileDiff;
const files = [file("src/store.ts", ["H1", "H2"]), file("src/api.ts", ["H3"]), file("README.md", ["H4"])];
const t = (name: string, summary: string) => ({ name, summary });

describe("describeActivity", () => {
  it("starts on the diff", () => {
    expect(describeActivity([], files)).toBe("Reading the diff");
  });

  it("names files instead of hunk ids", () => {
    expect(describeActivity([t("get_hunk", "Hunk H2")], files)).toBe("Reading store.ts");
    expect(describeActivity([t("mcp__diffusion__get_hunk", "Hunk H1, H3, H4")], files)).toBe(
      "Reading store.ts and 2 more",
    );
  });

  it("describes other tools without their names", () => {
    expect(describeActivity([t("Read", "Read app.py")], files)).toBe("Reading app.py");
    expect(describeActivity([t("Grep", "Grep foo(")], files)).toBe("Searching the code");
    expect(describeActivity([t("command_execution", "rg foo")], files)).toBe("Exploring the code");
    expect(describeActivity([t("submit_guide", "submit_guide")], files)).toBe("Checking references");
  });
});
