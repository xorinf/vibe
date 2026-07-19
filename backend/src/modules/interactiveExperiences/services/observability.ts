/**
 * Observability — structured logging for the ILE module.
 *
 * Single chokepoint for every log line the module emits. The interface
 * is intentionally tiny (just `ileLog`) so the rest of the module can
 * log without thinking about log levels or fields. What we guarantee:
 *
 *   1. **JSON line** for downstream ingestion (Cloud Logging, Loki, etc.)
 *   2. **No secrets** — the redaction allowlist below strips known
 *      sensitive fields before the line hits stdout.
 *   3. **Stable shape** — every line carries `ts`, `level`, `event`,
 *      `requestId` (when applicable), plus the caller's fields.
 *
 * How to extend: add a new `event` value (e.g. `stream.timeout`) and
 * document it below. Don't add a second sink.
 */

export type IleLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface IleLogFields {
  /** Optional correlation id, propagated from the upstream request. */
  requestId?: string;
  /** Any additional structured fields. MUST NOT contain secrets. */
  [key: string]: unknown;
}

/**
 * The list of field NAMES that always get redacted. The set is
 * intentionally tiny — if a new field needs redaction, add it here
 * AND document why. Do not rely on regex matching against keys.
 */
const REDACTED_KEYS = new Set([
  'apiKey',
  'authorization',
  'auth',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'bearer',
  'cookie',
  'set-cookie',
]);

/**
 * Walk a structured object once. Returns a new object with the same
 * shape minus any field whose name is in the redaction set. Values are
 * replaced with the literal `"[redacted]"` so downstream tooling can
 * tell the difference between a redaction and an empty string.
 */
function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return '[redacted:too-deep]' as unknown as T;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactDeep(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * The redaction set is exported for tests.
 */
export const __testing__redactKeys = REDACTED_KEYS;

/**
 * Stable field shape. The set of fields is fixed so log shippers can
 * index on them. If you need a new field, add it here AND to the
 * redaction allowlist if it might carry secrets.
 */
interface IleLogRecord {
  ts: string;
  level: IleLogLevel;
  event: string;
  requestId?: string;
  fields?: Record<string, unknown>;
}

/**
 * One-line JSON logger. Falls back to `console.log` when stdout is not
 * a TTY; downstream log collectors parse the JSON without needing a
 * custom decoder.
 *
 * @param level   Severity. Use `debug` for noisy tracing, `info` for
 *               normal lifecycle, `warn` for recoverable anomalies,
 *               `error` for things that failed and need investigation.
 * @param event   Short stable name. Convention: `noun.verb`, all
 *               lowercase. Examples: `stream.start`, `stream.complete`,
 *               `stream.cancelled`, `stream.error`, `asset.context.failed`.
 * @param fields  Optional structured fields. Anything in
 *               `REDACTED_KEYS` is replaced with `"[redacted]"` before
 *               the line is written.
 */
export function ileLog(
  level: IleLogLevel,
  event: string,
  fields: IleLogFields = {},
): void {
  const record: IleLogRecord = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (fields.requestId) record.requestId = String(fields.requestId);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'requestId') continue;
    rest[k] = v;
  }
  if (Object.keys(rest).length > 0) {
    record.fields = redactDeep(rest) as Record<string, unknown>;
  }
  // Single-line JSON. Falls back to console.log so the ILE module can
  // be loaded into test runners without setting up a sink.
  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
  } catch {
    // Circular refs in the payload (rare; never expected from ileLog
    // callers but defence in depth) — fall back to a minimal record.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: record.ts,
        level: record.level,
        event: record.event,
        requestId: record.requestId,
        fields: { reason: 'circular_payload' },
      }),
    );
  }
}

/**
 * Generate a short, sortable correlation id. Sticks to lowercase hex
 * + dashes so downstream log filters can match on `requestId=`.
 */
export function newIleRequestId(): string {
  return `ile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
