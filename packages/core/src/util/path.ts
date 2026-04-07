export function resolvePath(workdir: string, filePath: string): string {
  if (filePath.startsWith("/")) return filePath;
  if (!workdir) return filePath;
  return workdir.endsWith("/") ? workdir + filePath : `${workdir}/${filePath}`;
}
