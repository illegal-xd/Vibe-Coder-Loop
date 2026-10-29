/**
 * Append-only writer and read helper for the token-usage JSONL log.
 *
 * Storage layout (after the per-day split):
 * - one central archive, independent of the project being edited:
 *   `~/.config/opencode/token-usage/token-usage-YYYY-MM-DD.jsonl`;
 * - the day is derived from the record's own `timestamp` (event time), never
 *   from the wall clock, so backfilled and replayed events land in their own
 *   day;
 * - timestamps must carry an explicit `Z` or numeric offset; a zone-less
 *   timestamp is rejected instead of silently using the device time zone;
 * - the archive's pre-split single file (`token-usage.jsonl`) is never
 *   rewritten or deleted and remains readable through `readUsageLog`;
 * - `VIBE_TOKEN_USAGE_HOME` relocates the archive (tests, non-standard homes);
 *   `tokenUsage.path` still overrides the exact base file.
 *
 * Guarantees:
 * - one `appendFile` call per record, so a record can never be split by a
 *   second writer inside this process (concurrent appends are serialized on a
 *   promise chain; no buffering beyond the pending writes);
 * - the parent directory is created once, lazily;
 * - existing daily files are appended to, never truncated, and the writer
 *   never scans history to pick a file;
 * - nothing is thrown to the caller: a broken log path cannot fail a request.
 *
 * Concurrency scope: one writer instance per plugin load serializes every
 * append in-process. Cross-process appends rely on POSIX `O_APPEND` atomicity
 * for a single small write; that holds on local filesystems, not necessarily
 * on network filesystems. No lock service, daemon, or database is used.
 */

import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { isTruthy } from "./config.js";
import { serializeUsageRecord } from "./token-usage.js";

const JSONL_EXTENSION = ".jsonl";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Bound the diagnostics array for corrupt archives. */
const MAX_INVALID_DIAGNOSTICS = 200;
/** UTC designator or numeric offset; a zone-less timestamp is ambiguous. */
const ZONE_SUFFIX_PATTERN = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** Default central archive directory, shared by every project on this machine. */
export function resolveUsageHome(env = process.env) {
  const configured = env?.VIBE_TOKEN_USAGE_HOME;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(expandHome(configured.trim()));
  }
  return path.join(os.homedir(), ".config", "opencode", "token-usage");
}

/**
 * Base path used before the per-day split. New writes never use it directly;
 * it stays the anchor for daily files and remains readable when it exists.
 * Default: `<usage home>/token-usage.jsonl`, where the usage home is
 * `~/.config/opencode/token-usage`. `tokenUsage.path` overrides the base file
 * (relative to the project directory, `~` supported).
 */
export function resolveUsageLogPath(config, directory, env = process.env) {
  const configured = config?.tokenUsage?.path;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(directory, expandHome(configured.trim()));
  }
  return path.join(resolveUsageHome(env), "token-usage.jsonl");
}

/**
 * UTC calendar day (`YYYY-MM-DD`) of an ISO 8601 timestamp, or null when the
 * value is missing, unparsable, or has no explicit zone.
 *
 * Examples (UTC day):
 * - `2026-10-28T23:59:59.999Z` → `2026-10-28`
 * - `2026-10-29T00:00:00.000Z` → `2026-10-29`
 * - `2026-10-28T23:30:00-02:00` → `2026-10-29`
 */
export function usageLogDateKey(timestamp) {
  if (typeof timestamp !== "string") return null;
  const text = timestamp.trim();
  if (text.length === 0) return null;
  if (!DATE_KEY_PATTERN.test(text) && !ZONE_SUFFIX_PATTERN.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toISOString().slice(0, 10);
}

function isValidDateKey(value) {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

function dateKeyToBase(basePath, dateKey) {
  const name = path.basename(basePath);
  const stem = name.toLowerCase().endsWith(JSONL_EXTENSION)
    ? name.slice(0, -JSONL_EXTENSION.length)
    : name;
  return path.join(path.dirname(basePath), `${stem}-${dateKey}${JSONL_EXTENSION}`);
}

/** Daily file path for one validated `YYYY-MM-DD` key. */
export function resolveUsageLogFile(config, directory, dateKey, env = process.env) {
  if (!isValidDateKey(dateKey)) {
    throw new TypeError("dateKey must be a valid YYYY-MM-DD date");
  }
  return dateKeyToBase(resolveUsageLogPath(config, directory, env), dateKey);
}

export function isUsageLogEnabled(config, env = process.env) {
  if (isTruthy(env?.VIBE_TOKEN_USAGE_LOG_DISABLED)) return false;
  return config?.tokenUsage?.enabled !== false;
}

function sanitizeError(error) {
  const text =
    error && typeof error.message === "string" ? error.message : String(error ?? "unknown_error");
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Create one writer instance per plugin load. Reuse it for every record so
 * writes stay ordered.
 */
export function createUsageLogger({
  directory,
  config,
  env = process.env,
  onFailure = null,
} = {}) {
  let chain = Promise.resolve();
  let directoryReady = false;
  let failureCount = 0;
  let lastError = null;

  async function writeRecord(record) {
    const dateKey = usageLogDateKey(record?.timestamp);
    if (dateKey === null) throw new Error("record_timestamp_invalid");
    const line = serializeUsageRecord(record);
    if (line === null) throw new Error("record_serialization_failed");
    const file = resolveUsageLogFile(config, directory, dateKey, env);
    if (!directoryReady) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      directoryReady = true;
    }
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  }

  const enabled = isUsageLogEnabled(config, env);

  return {
    enabled,
    /** Legacy single-file path; kept for compatibility, not written by this writer. */
    path: enabled ? resolveUsageLogPath(config, directory, env) : null,
    /** Target daily file for one `YYYY-MM-DD` key; pure path computation. */
    pathFor(dateKey) {
      return resolveUsageLogFile(config, directory, dateKey, env);
    },
    /** Resolves to an outcome object; never rejects. */
    append(record) {
      if (!enabled) return Promise.resolve({ ok: false, error: "disabled" });
      const next = chain.then(() => writeRecord(record));
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next.then(
        () => ({ ok: true }),
        (error) => {
          failureCount += 1;
          lastError = sanitizeError(error);
          if (typeof onFailure === "function") {
            try {
              onFailure(lastError);
            } catch {
              // Diagnostics must not affect logging or the model request.
            }
          }
          return { ok: false, error: lastError };
        },
      );
    },
    /** Wait for every queued write; used by tests and shutdown paths. */
    idle() {
      return chain;
    },
    stats() {
      return { failureCount, lastError };
    },
  };
}

// ------------------------------------------------------------------ reading

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dailyFilePattern(basePath) {
  const name = path.basename(basePath);
  const stem = name.toLowerCase().endsWith(JSONL_EXTENSION)
    ? name.slice(0, -JSONL_EXTENSION.length)
    : name;
  return new RegExp(`^${escapeRegExp(stem)}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
}

async function readLines(file, onLine) {
  let stream;
  try {
    stream = createReadStream(file, { encoding: "utf8" });
  } catch {
    return false;
  }
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      onLine(line, lineNumber);
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  } finally {
    reader.close();
    stream.destroy();
  }
  return true;
}

async function listDailyFiles(basePath, from, to) {
  const directory = path.dirname(basePath);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const pattern = dailyFilePattern(basePath);
  const files = [];
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const date = match[1];
    if (!isValidDateKey(date)) continue;
    if (from && date < from) continue;
    if (to && date > to) continue;
    files.push({ date, file: path.join(directory, name) });
  }
  files.sort((left, right) => left.date.localeCompare(right.date));
  return files;
}

/**
 * Read token-usage records from the daily files and, when present, the legacy
 * single file. Dates are inclusive `YYYY-MM-DD` keys; omit both for all
 * history.
 *
 * - only files matching `token-usage-YYYY-MM-DD.jsonl` are considered, so
 *   backups (`*.jsonl.1`), temp files, and unrelated names are ignored;
 * - the legacy file has no date index, so it is scanned on every call and its
 *   records are filtered by their own timestamp;
 * - every non-empty line is parsed independently; broken lines, non-object
 *   values, invalid timestamps, and records stored under the wrong day are
 *   reported in `invalid` and never coerced into valid records;
 * - byte-identical lines found in more than one file are counted once.
 *
 * @returns {Promise<{records: object[], files: string[], invalid: {file: string, line: number, reason: string}[]}>}
 */
export async function readUsageLog(
  config,
  directory,
  { from = null, to = null, env = process.env } = {},
) {
  for (const [label, value] of [
    ["from", from],
    ["to", to],
  ]) {
    if (value !== null && value !== undefined && !isValidDateKey(value)) {
      throw new TypeError(`${label} must be a YYYY-MM-DD date`);
    }
  }
  if (from && to && from > to) return { records: [], files: [], invalid: [] };

  const basePath = resolveUsageLogPath(config, directory, env);
  const dailyFiles = await listDailyFiles(basePath, from, to);

  const records = [];
  const files = [];
  const invalid = [];

  // Exact cross-file dedupe is only meaningful when the legacy single file
  // still shares records with the daily files. Keeping every full line in a
  // Set for the whole window doubled the retained memory; scan the legacy file
  // once and only then keep a dedupe set.
  let legacyExists = false;
  try {
    await access(basePath);
    legacyExists = true;
  } catch {
    legacyExists = false;
  }
  const seenLines = legacyExists ? new Set() : null;

  async function scan(file, fileDate) {
    const read = await readLines(file, (line, lineNumber) => {
      const text = line.trim();
      if (text.length === 0) return;
      const pushInvalid = (reason) => {
        if (invalid.length < MAX_INVALID_DIAGNOSTICS) {
          invalid.push({ file, line: lineNumber, reason });
        }
      };
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        pushInvalid("invalid_json");
        return;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        pushInvalid("invalid_record");
        return;
      }
      const dateKey = usageLogDateKey(record.timestamp);
      if (dateKey === null) {
        pushInvalid("invalid_timestamp");
        return;
      }
      if (fileDate !== null && dateKey !== fileDate) {
        pushInvalid("file_date_mismatch");
        return;
      }
      if (from && dateKey < from) return;
      if (to && dateKey > to) return;
      if (seenLines) {
        if (seenLines.has(text)) return;
        seenLines.add(text);
      }
      records.push(record);
    });
    if (read) files.push(file);
  }

  if (legacyExists) await scan(basePath, null);
  for (const entry of dailyFiles) {
    await scan(entry.file, entry.date);
  }

  return { records, files, invalid };
}
