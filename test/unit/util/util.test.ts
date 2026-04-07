import { describe, test, expect } from "bun:test";
import { unifiedDiff } from "../../../src/util/diff.ts";
import { truncateOutput } from "../../../src/util/truncate.ts";
import { generateId } from "../../../src/util/id.ts";
import { resolvePath } from "../../../src/util/path.ts";

// ── unifiedDiff ─────────────────────────────────────────────────────────────

describe("unifiedDiff", () => {
  test("returns empty string when texts are identical", () => {
    expect(unifiedDiff("hello\nworld", "hello\nworld", "file.txt")).toBe("");
  });

  test("shows all additions for a new file", () => {
    const diff = unifiedDiff("", "line 1\nline 2\nline 3", "new.ts");
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/new.ts");
    expect(diff).toContain("@@ -0,0 +1,3 @@");
    expect(diff).toContain("+line 1");
    expect(diff).toContain("+line 2");
    expect(diff).toContain("+line 3");
  });

  test("shows all deletions for a deleted file", () => {
    const diff = unifiedDiff("line 1\nline 2", "", "old.ts");
    expect(diff).toContain("--- a/old.ts");
    expect(diff).toContain("+++ /dev/null");
    expect(diff).toContain("@@ -1,2 +0,0 @@");
    expect(diff).toContain("-line 1");
    expect(diff).toContain("-line 2");
  });

  test("shows a simple single-line change", () => {
    const diff = unifiedDiff("hello\nworld", "hello\nearth", "greet.txt");
    expect(diff).toContain("--- a/greet.txt");
    expect(diff).toContain("+++ b/greet.txt");
    expect(diff).toContain("-world");
    expect(diff).toContain("+earth");
    expect(diff).toContain(" hello");
  });

  test("shows insertions", () => {
    const diff = unifiedDiff("a\nc", "a\nb\nc", "file.txt");
    expect(diff).toContain("+b");
    expect(diff).toContain(" a");
    expect(diff).toContain(" c");
  });

  test("shows deletions", () => {
    const diff = unifiedDiff("a\nb\nc", "a\nc", "file.txt");
    expect(diff).toContain("-b");
    expect(diff).toContain(" a");
    expect(diff).toContain(" c");
  });

  test("produces separate hunks for distant changes", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const oldText = lines.join("\n");

    const modified = [...lines];
    modified[1] = "CHANGED 2";
    modified[18] = "CHANGED 19";
    const newText = modified.join("\n");

    const diff = unifiedDiff(oldText, newText, "big.txt");
    const hunkHeaders = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunkHeaders.length).toBe(2);
  });

  test("merges nearby hunks within context range", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g"];
    const oldText = lines.join("\n");

    const modified = [...lines];
    modified[1] = "B";
    modified[5] = "F";
    const newText = modified.join("\n");

    const diff = unifiedDiff(oldText, newText, "file.txt");
    const hunkHeaders = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunkHeaders.length).toBe(1);
  });

  test("handles large file fallback", () => {
    const bigOld = Array.from({ length: 2500 }, (_, i) => `old line ${i}`).join("\n");
    const bigNew = Array.from({ length: 2500 }, (_, i) => `new line ${i}`).join("\n");
    const diff = unifiedDiff(bigOld, bigNew, "huge.txt");
    expect(diff).toContain("Large file diff");
    expect(diff).toContain("2500");
  });

  test("handles completely replaced content", () => {
    const diff = unifiedDiff("aaa\nbbb", "xxx\nyyy\nzzz", "file.txt");
    expect(diff).toContain("-aaa");
    expect(diff).toContain("-bbb");
    expect(diff).toContain("+xxx");
    expect(diff).toContain("+yyy");
    expect(diff).toContain("+zzz");
  });
});

// ── truncateOutput ──────────────────────────────────────────────────────────

describe("truncateOutput", () => {
  test("returns unchanged text under the limit", () => {
    const result = truncateOutput("short text", 100);
    expect(result.text).toBe("short text");
    expect(result.truncated).toBe(false);
  });

  test("truncates long text with omission notice", () => {
    const long = "x".repeat(200);
    const result = truncateOutput(long, 100);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("... (");
    expect(result.text).toContain("characters omitted");
    expect(result.text.length).toBeLessThan(long.length);
  });

  test("preserves beginning and end of truncated text", () => {
    const text = "START" + "x".repeat(200) + "END";
    const result = truncateOutput(text, 100);
    expect(result.text).toContain("START");
    expect(result.text).toContain("END");
  });

  test("uses default limit of 30000", () => {
    const short = "hello";
    const result = truncateOutput(short);
    expect(result.truncated).toBe(false);
  });

  test("text at exactly the limit is not truncated", () => {
    const text = "x".repeat(100);
    const result = truncateOutput(text, 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });
});

// ── generateId ──────────────────────────────────────────────────────────────

describe("generateId", () => {
  test("returns a string", () => {
    expect(typeof generateId()).toBe("string");
  });

  test("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  test("returns UUID format", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ── resolvePath ─────────────────────────────────────────────────────────────

describe("resolvePath", () => {
  test("returns absolute paths unchanged", () => {
    expect(resolvePath("/project", "/etc/hosts")).toBe("/etc/hosts");
  });

  test("resolves relative paths against workdir", () => {
    expect(resolvePath("/project", "src/main.ts")).toBe("/project/src/main.ts");
  });

  test("handles workdir with trailing slash", () => {
    expect(resolvePath("/project/", "src/main.ts")).toBe("/project/src/main.ts");
  });

  test("handles empty workdir", () => {
    expect(resolvePath("", "src/main.ts")).toBe("src/main.ts");
  });
});
