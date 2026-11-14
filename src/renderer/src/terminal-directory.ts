const unsafeCharacters = /[\p{Cc}\p{Bidi_Control}]/u;

// Read only the path. The file browser always uses the current SSH connection.
export function parseTerminalDirectory(report: string): string | undefined {
  if (report.length > 16384) return undefined;
  const match = /^file:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])?(\/[^?#]*)$/i.exec(report);
  if (!match || unsafeCharacters.test(report)) return undefined;
  try {
    const path = decodeURIComponent(match[1]);
    if (path.length > 4096 || unsafeCharacters.test(path)) return undefined;
    return path;
  } catch {
    return undefined;
  }
}
