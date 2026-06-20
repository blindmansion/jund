// ── Shared options for filesystem/shell-backed tools ─────────────────────────

export interface FileToolOptions {
  /** Directory that relative paths and shell commands resolve against. */
  workdir: string;
}

/**
 * A single guideline line describing the working directory. The prompt builder
 * deduplicates guidelines, so the coder tools can each include this and it
 * renders once.
 */
export function workdirGuideline(workdir: string): string {
  return `Working directory is ${workdir}; relative paths and shell commands resolve against it.`;
}
