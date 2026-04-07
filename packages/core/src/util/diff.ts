type DiffOp = { type: "equal" | "delete" | "insert"; line: string };

const MAX_LINES = 4000;

export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
  contextLines = 3,
): string {
  if (oldText === newText) return "";

  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];

  if (oldLines.length === 0) {
    const adds = newLines.map((l) => `+${l}`).join("\n");
    return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${newLines.length} @@\n${adds}`;
  }

  if (newLines.length === 0) {
    const dels = oldLines.map((l) => `-${l}`).join("\n");
    return `--- a/${path}\n+++ /dev/null\n@@ -1,${oldLines.length} +0,0 @@\n${dels}`;
  }

  if (oldLines.length + newLines.length > MAX_LINES) {
    const delta = newLines.length - oldLines.length;
    return [
      `--- a/${path}`,
      `+++ b/${path}`,
      `Large file diff: ${oldLines.length} → ${newLines.length} lines (${delta >= 0 ? "+" : ""}${delta})`,
    ].join("\n");
  }

  const ops = computeOps(oldLines, newLines);
  return formatHunks(ops, path, contextLines);
}

function computeOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = Array.from<number>({ length: n + 1 }).fill(0);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: "equal", line: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ type: "insert", line: newLines[j - 1]! });
      j--;
    } else {
      ops.push({ type: "delete", line: oldLines[i - 1]! });
      i--;
    }
  }
  return ops.reverse();
}

function formatHunks(ops: DiffOp[], path: string, ctx: number): string {
  const changeIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== "equal") changeIdx.push(i);
  }
  if (changeIdx.length === 0) return "";

  const hunks: Array<{ start: number; end: number }> = [];
  let hStart = Math.max(0, changeIdx[0]! - ctx);
  let hEnd = Math.min(ops.length - 1, changeIdx[0]! + ctx);

  for (let c = 1; c < changeIdx.length; c++) {
    const s = Math.max(0, changeIdx[c]! - ctx);
    const e = Math.min(ops.length - 1, changeIdx[c]! + ctx);
    if (s <= hEnd + 1) {
      hEnd = e;
    } else {
      hunks.push({ start: hStart, end: hEnd });
      hStart = s;
      hEnd = e;
    }
  }
  hunks.push({ start: hStart, end: hEnd });

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];

  for (const hunk of hunks) {
    let oldLine = 1;
    let newLine = 1;
    for (let i = 0; i < hunk.start; i++) {
      if (ops[i]!.type !== "insert") oldLine++;
      if (ops[i]!.type !== "delete") newLine++;
    }

    let oldCount = 0;
    let newCount = 0;
    const hunkLines: string[] = [];

    for (let i = hunk.start; i <= hunk.end; i++) {
      const op = ops[i]!;
      switch (op.type) {
        case "equal":
          hunkLines.push(` ${op.line}`);
          oldCount++;
          newCount++;
          break;
        case "delete":
          hunkLines.push(`-${op.line}`);
          oldCount++;
          break;
        case "insert":
          hunkLines.push(`+${op.line}`);
          newCount++;
          break;
      }
    }

    lines.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    lines.push(...hunkLines);
  }

  return lines.join("\n");
}
