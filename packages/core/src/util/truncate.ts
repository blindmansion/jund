const DEFAULT_LIMIT = 30_000;

export function truncateOutput(
  output: string,
  limit = DEFAULT_LIMIT,
): { text: string; truncated: boolean } {
  if (output.length <= limit) {
    return { text: output, truncated: false };
  }
  const half = Math.floor(limit / 2);
  const omitted = output.length - limit;
  return {
    text: `${output.slice(0, half)}\n\n... (${omitted} characters omitted) ...\n\n${output.slice(-half)}`,
    truncated: true,
  };
}
