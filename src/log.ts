// Minimal structured-ish logger. Single line per event, level-prefixed, so
// hyperdx/loki ingest stays grep-friendly. No deps.
function emit(level: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${level} ${msg}`);
}

export const log = {
  info: (m: string) => emit("INFO", m),
  warn: (m: string) => emit("WARN", m),
  error: (m: string) => emit("ERROR", m),
};
