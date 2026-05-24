/**
 * In-app console capture: mirrors console.error / console.warn (plus uncaught
 * errors and unhandled promise rejections) into a small pub-sub store so they
 * can be read and COPIED straight from the panel — no DevTools needed.
 *
 * Same idiom as loadStats: lives outside React (events fire from async, non-
 * render code paths), App subscribes once and mirrors snapshots into state.
 *
 * `install()` is idempotent and patches the real console once. The originals are
 * still called, so DevTools output is unchanged for when it IS open.
 */

export type LogLevel = "error" | "warn";
export type LogEntry = { level: LogLevel; text: string; count: number; at: number };

const MAX_ENTRIES = 200;
const entries: LogEntry[] = [];
const listeners = new Set<(e: LogEntry[]) => void>();

function emit() {
  const snap = entries.slice();
  for (const l of listeners) l(snap);
}

// Render console args the way DevTools roughly would: strings as-is, Errors with
// their stack, everything else JSON (falling back to String for cyclic/odd vals).
function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function push(level: LogLevel, text: string) {
  const last = entries[entries.length - 1];
  // Collapse identical consecutive lines (deck/luma can spam the same warning
  // every frame) into a single entry with a repeat count.
  if (last && last.level === level && last.text === text) {
    last.count += 1;
    last.at = Date.now();
  } else {
    entries.push({ level, text, count: 1, at: Date.now() });
    if (entries.length > MAX_ENTRIES) entries.shift();
  }
  emit();
}

let installed = false;

export function installConsoleCapture() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    push("error", format(args));
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    push("warn", format(args));
    origWarn(...args);
  };

  window.addEventListener("error", (e) => {
    push("error", e.error?.stack || e.message || String(e));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    push("error", `Unhandled rejection: ${r instanceof Error ? (r.stack || r.message) : String(r)}`);
  });
}

export function clearConsoleCapture() {
  entries.length = 0;
  emit();
}

export function subscribeConsole(fn: (e: LogEntry[]) => void): () => void {
  listeners.add(fn);
  fn(entries.slice());
  return () => {
    listeners.delete(fn);
  };
}
