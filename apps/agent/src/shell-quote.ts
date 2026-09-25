export function shellQuote(value: string, platform = process.platform): string {
  if (/^[a-zA-Z0-9_./:@+=,-]+$/.test(value)) return value;
  return platform === "win32" ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
export function nativeCommand(argv: string[], platform = process.platform): string {
  const command = argv.map(value => shellQuote(value, platform)).join(" ");
  return platform === "win32" ? "& " + command + "; exit $LASTEXITCODE" : command;
}
