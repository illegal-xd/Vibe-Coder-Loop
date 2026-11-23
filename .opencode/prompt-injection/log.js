/**
 * Async, append-only log for prompt-injection events emitted by the OpenCode
 * adapter (`vibe-bridge`).
 *
 * Why a separate archive: token usage answers "how many tokens were spent";
 * this log answers "what text did the adapter inject into the prompt, when,
 * and into which conversation". Mixing both would force every usage reader to
 * understand prompt bodies, so the two archives stay independent.
 *
 * Storage layout (one JSON object per line, UTC day from the record itself):
 *   ~/.config/opencode/prompt-injection/prompt-injection-YYYY-MM-DD.jsonl
 *
 * Guarantees:
 * - `record()` is synchronous and never throws. It performs only cheap shape
 *   checks, appends a compact entry to a bounded queue, and schedules a flush
 *   with `setImmediate`; a chat hook never awaits disk I/O and never pays for
 *   JSON serialization or code-point/byte counting on the hot path. Those run
 *   in the background flush.
 * - Flushes are serialized in-process; records are grouped by UTC day and a
 *   failure on one day retries only that day (successful days are never
 *   appended twice). Failed flushes retry with exponential backoff.
 * - The queue is bounded. Overflow drops the oldest pending record and reports
 *   the count in the next batch as a `prompt_injection_log_dropped` record.
 * - Existing files are appended to, never truncated or rewritten.
 * - Directory `0700`, files `0600`; writes never fail a model request.
 * - `VIBE_PROMPT_INJECTION_HOME` relocates the archive (tests / custom homes);
 *   `VIBE_PROMPT_INJECTION_LOG_DISABLED` disables writes.
 *
 * Concurrency scope: one writer per plugin load serializes appends in-process.
 * Cross-process appends rely on POSIX `O_APPEND` atomicity for a single small
 * write on local filesystems.
 */

import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const INJECTION_SCHEMA_VERSION = 1;
export const INJECTION_EVENT = "prompt_injection";
export const USER_INPUT_EVENT = "user_input";
export const TOOL_CALL_EVENT = "tool_call";
export const MCP_CALL_EVENT = "mcp_call";
export const SKILL_CALL_EVENT = "skill_call";
export const SYSTEM_PROMPT_EVENT = "system_prompt";
export const CATEGORY_INJECTION = "injection";
export const CATEGORY_USER_INPUT = "user_input";
export const CATEGORY_TOOL = "tool";
export const CATEGORY_MCP = "mcp";
export const CATEGORY_SKILL = "skill";
export const CATEGORY_CONTEXT = "context";
export const DROPPED_EVENT = "prompt_injection_log_dropped";
/** Per-record content cap, measured in Unicode code points (≈64K chars). */
export const DEFAULT_MAX_CONTENT_CHARS = 64 * 1024;
export const DEFAULT_MAX_QUEUE = 1000;

const JSONL_EXTENSION = ".jsonl";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** UTC designator or numeric offset; a zone-less timestamp is ambiguous. */
const ZONE_SUFFIX_PATTERN = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const MAX_INVALID_DIAGNOSTICS = 200;

function envFlag(env, name) {
  const value = env?.[name];
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  return text !== "" && text !== "0" && text !== "false" && text !== "no";
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** Default archive directory, shared by every project on this machine. */
export function resolveInjectionHome(env = process.env) {
  const configured = env?.VIBE_PROMPT_INJECTION_HOME;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(expandHome(configured.trim()));
  }
  return path.join(os.homedir(), ".config", "opencode", "prompt-injection");
}

/** Base path; daily files derive from it (`prompt-injection.jsonl` → `-YYYY-MM-DD`). */
export function resolveInjectionLogPath(env = process.env) {
  return path.join(resolveInjectionHome(env), "prompt-injection.jsonl");
}

function dateKeyToBase(basePath, dateKey) {
  const name = path.basename(basePath);
  const stem = name.toLowerCase().endsWith(JSONL_EXTENSION)
    ? name.slice(0, -JSONL_EXTENSION.length)
    : name;
  return path.join(path.dirname(basePath), `${stem}-${dateKey}${JSONL_EXTENSION}`);
}

/** Daily file path for one validated `YYYY-MM-DD` key. */
export function resolveInjectionLogFile(dateKey, env = process.env) {
  if (!isValidDateKey(dateKey)) {
    throw new TypeError("dateKey must be a valid YYYY-MM-DD date");
  }
  return dateKeyToBase(resolveInjectionLogPath(env), dateKey);
}

/** UTC calendar day of an ISO 8601 timestamp, or null when unusable. */
export function injectionLogDateKey(timestamp) {
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

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("invalid timestamp");
    return value.toISOString();
  }
  if (typeof value !== "string" || !ZONE_SUFFIX_PATTERN.test(value.trim())) {
    throw new TypeError("timestamp must carry an explicit Z or numeric offset");
  }
  const at = Date.parse(value.trim());
  if (!Number.isFinite(at)) throw new TypeError("invalid timestamp");
  return new Date(at).toISOString();
}

export function countCodePoints(text) {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * Truncate by Unicode code points (not UTF-16 code units), without splitting a
 * surrogate pair. `knownCount` lets callers reuse the full count they already
 * computed. The full length is kept on the record so the viewer can say
 * "1,234 / 2,000 chars shown".
 */
function truncateContent(text, maxCodePoints, knownCount) {
  const fullCount = Number.isInteger(knownCount) ? knownCount : countCodePoints(text);
  if (fullCount <= maxCodePoints) return { content: text, truncated: false };
  let end = 0;
  let count = 0;
  for (const char of text) {
    end += char.length;
    count += 1;
    if (count >= maxCodePoints) break;
  }
  return { content: text.slice(0, end), truncated: true };
}

function normalizeModel(model) {
  if (!model || typeof model !== "object") return null;
  const provider =
    model.providerID ?? model.provider_id ?? model.providerId ?? model.provider;
  const id = model.id ?? model.modelID ?? model.model_id ?? model.model;
  const providerId = typeof provider === "string" && provider.length > 0 ? provider : null;
  const modelId = typeof id === "string" && id.length > 0 ? id : null;
  if (!providerId && !modelId) return null;
  return { provider_id: providerId, model_id: modelId };
}

/**
 * Pure record builder (exported for tests and future injection sites).
 * Throws on malformed input; the logger catches and reports, never the hook.
 */
export function buildInjectionRecord(input = {}) {
  const {
    sessionID = null,
    messageID = null,
    hook,
    kind,
    trigger = null,
    target,
    content,
    model = null,
    project = "",
    sequence = 0,
    timestamp = new Date().toISOString(),
    source = "vibe-bridge",
    event = INJECTION_EVENT,
    category = CATEGORY_INJECTION,
    maxContentChars = DEFAULT_MAX_CONTENT_CHARS,
  } = input;

  if (typeof hook !== "string" || hook.trim() === "") {
    throw new TypeError("hook is required");
  }
  if (typeof kind !== "string" || kind.trim() === "") {
    throw new TypeError("kind is required");
  }
  if (typeof target !== "string" || target.trim() === "") {
    throw new TypeError("target is required");
  }
  if (typeof content !== "string" || content.length === 0) {
    throw new TypeError("content is required");
  }
  if (typeof event !== "string" || event.trim() === "") {
    throw new TypeError("event is required");
  }
  if (typeof category !== "string" || category.trim() === "") {
    throw new TypeError("category is required");
  }

  const normalizedAt = normalizeTimestamp(timestamp);
  const fullChars = countCodePoints(content);
  const limit = Number.isInteger(maxContentChars) && maxContentChars > 0
    ? maxContentChars
    : DEFAULT_MAX_CONTENT_CHARS;
  const clipped = truncateContent(content, limit, fullChars);
  const clippedChars = clipped.truncated ? limit : fullChars;

  return {
    schema_version: INJECTION_SCHEMA_VERSION,
    event: event.trim(),
    category: category.trim(),
    timestamp: normalizedAt,
    session_id: typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null,
    message_id: typeof messageID === "string" && messageID.length > 0 ? messageID : null,
    source,
    hook,
    kind,
    trigger: typeof trigger === "string" && trigger.length > 0 ? trigger : null,
    target,
    project: typeof project === "string" ? project : "",
    model: normalizeModel(model),
    content: clipped.content,
    content_chars: clippedChars,
    content_bytes: Buffer.byteLength(clipped.content, "utf8"),
    content_truncated: clipped.truncated,
    original_content_chars: fullChars,
    sequence: Number.isInteger(sequence) && sequence > 0 ? sequence : 0,
  };
}

/** Build a user-message record (category `user_input`, not an injection). */
export function buildUserInputRecord(input = {}) {
  return buildInjectionRecord({
    ...input,
    hook: "chat.message",
    kind: "user_input",
    trigger: "user_message",
    target: "user_message",
    event: USER_INPUT_EVENT,
    category: CATEGORY_USER_INPUT,
  });
}

/**
 * Create one logger per plugin load. `record()` is the only hot-path call and
 * it never awaits. `flush()` is exposed for tests and explicit shutdown.
 */
export function createInjectionLogger(options = {}) {
  const {
    env = process.env,
    now = () => new Date(),
    onFailure = null,
    maxQueue = DEFAULT_MAX_QUEUE,
    maxContentChars = DEFAULT_MAX_CONTENT_CHARS,
    retryBaseMs = 1000,
  } = options;

  const enabled = !envFlag(env, "VIBE_PROMPT_INJECTION_LOG_DISABLED");
  const basePath = resolveInjectionLogPath(env);
  const queueLimit = Number.isInteger(maxQueue) && maxQueue > 0 ? maxQueue : DEFAULT_MAX_QUEUE;
  const retryBase = Number.isFinite(retryBaseMs) && retryBaseMs > 0 ? retryBaseMs : 1000;

  let queue = [];
  let queueHead = 0;
  let dropped = 0;
  let sequence = 0;
  let failed = 0;
  let lastError = null;
  let flushPromise = null;
  let scheduled = false;
  let retryAttempt = 0;
  let retryTimer = null;
  let directoryReady = false;

  function pendingCount() {
    return queue.length - queueHead;
  }

  /**
   * O(1) append. When the bound is reached, advance the head instead of
   * shifting the array, so a stalled flush cannot turn every injection into an
   * O(n) operation. Compact lazily to keep the backing array finite.
   */
  function enqueue(item) {
    if (pendingCount() >= queueLimit) {
      queueHead += 1;
      dropped += 1;
      if (queueHead > queueLimit * 2) {
        queue = queue.slice(queueHead);
        queueHead = 0;
      }
    }
    queue.push(item);
  }

  function drainQueue() {
    if (queueHead === 0) {
      const batch = queue;
      queue = [];
      return batch;
    }
    const batch = queue.slice(queueHead);
    queue = [];
    queueHead = 0;
    return batch;
  }

  function report(error) {
    if (typeof onFailure !== "function") return;
    try {
      onFailure(error);
    } catch {
      // A diagnostic callback must never break the hook that called it.
    }
  }

  function noteFailure(error) {
    failed += 1;
    lastError =
      error && typeof error.message === "string"
        ? error.message.replace(/\s+/g, " ").trim().slice(0, 240)
        : "unknown_error";
    report(error);
  }

  /** Copy only the fields the record needs; never retain the caller object. */
  function queueEntry(entry, timestamp, seq) {
    return {
      sessionID: entry.sessionID,
      messageID: entry.messageID,
      hook: entry.hook,
      kind: entry.kind,
      trigger: entry.trigger,
      target: entry.target,
      content: entry.content,
      model: entry.model,
      project: entry.project,
      source: entry.source,
      event: entry.event,
      category: entry.category,
      timestamp,
      sequence: seq,
    };
  }

  async function ensureDirectory(dir) {
    if (directoryReady) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    directoryReady = true;
  }

  /**
   * Write built records grouped by UTC day. A failure on one day must not
   * requeue records that already landed in another day: return only the
   * failed items so the caller can retry exactly those.
   */
  async function writeRecords(records) {
    const byDate = new Map();
    for (const item of records) {
      const items = byDate.get(item.dateKey);
      if (items) items.push(item);
      else byDate.set(item.dateKey, [item]);
    }
    if (byDate.size === 0) return { failed: [], error: null };
    await ensureDirectory(path.dirname(basePath));
    const failed = [];
    let lastError = null;
    for (const [dateKey, items] of byDate) {
      try {
        await appendFile(
          dateKeyToBase(basePath, dateKey),
          items.map((item) => item.line).join(""),
          { encoding: "utf8", mode: 0o600 }
        );
      } catch (error) {
        lastError = error;
        failed.push(...items);
      }
    }
    return { failed, error: lastError };
  }

  async function flushOnce() {
    const batch = drainQueue();
    const droppedCount = dropped;
    dropped = 0;

    const records = [];
    if (droppedCount > 0) {
      let diagnosticTimestamp;
      try {
        diagnosticTimestamp = now().toISOString();
      } catch {
        // A custom clock must not be able to drop the whole batch.
        diagnosticTimestamp = new Date().toISOString();
      }
      const diagnostic = {
        schema_version: INJECTION_SCHEMA_VERSION,
        event: DROPPED_EVENT,
        timestamp: diagnosticTimestamp,
        dropped_count: droppedCount,
      };
      const dateKey = injectionLogDateKey(diagnostic.timestamp);
      if (dateKey) {
        records.push({
          dateKey,
          line: `${JSON.stringify(diagnostic)}\n`,
          isDropDiagnostic: true,
          droppedCount,
        });
      }
    }

    // Heavy work (validation, code-point counting, truncation, JSON
    // serialization) happens here, off the chat hook. Invalid entries are
    // reported and discarded; they must not block valid records.
    for (const item of batch) {
      let built;
      try {
        built = buildInjectionRecord({
          ...item,
          timestamp: item.timestamp,
          sequence: item.sequence,
          maxContentChars,
        });
      } catch (error) {
        noteFailure(error);
        continue;
      }
      const dateKey = injectionLogDateKey(built.timestamp);
      if (dateKey === null) {
        noteFailure(new TypeError("record timestamp has no usable UTC date"));
        continue;
      }
      try {
        records.push({ dateKey, line: `${JSON.stringify(built)}\n`, source: item });
      } catch (error) {
        noteFailure(error);
      }
    }

    if (records.length === 0) {
      retryAttempt = 0;
      return;
    }

    let result;
    try {
      result = await writeRecords(records);
    } catch (error) {
      // Directory creation or an unexpected writer failure: every record failed.
      result = { failed: records, error };
    }

    if (result.failed.length > 0) {
      const requeue = [];
      for (const item of result.failed) {
        if (item.isDropDiagnostic) {
          // The diagnostic line will be regenerated with the restored count.
          dropped += item.droppedCount;
        } else if (item.source) {
          requeue.push(item.source);
        }
      }
      const pending = requeue.concat(queue.slice(queueHead));
      queue = pending;
      queueHead = 0;
      if (pending.length > queueLimit) {
        dropped += pending.length - queueLimit;
        queue = pending.slice(-queueLimit);
      }
      throw result.error || new Error("prompt_injection_log_write_failed");
    }
    retryAttempt = 0;
  }

  /** Exponential backoff: a broken archive must not spin or disappear. */
  function scheduleRetry() {
    if (retryTimer) return;
    if (pendingCount() === 0 && dropped === 0) return;
    retryAttempt += 1;
    const delay = Math.min(60_000, retryBase * 2 ** Math.min(retryAttempt - 1, 6));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (pendingCount() > 0 || dropped > 0) schedule();
    }, delay);
    if (typeof retryTimer.unref === "function") retryTimer.unref();
  }

  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      try {
        while (pendingCount() > 0 || dropped > 0) {
          await flushOnce();
        }
        retryAttempt = 0;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      } catch (error) {
        noteFailure(error);
        scheduleRetry();
      } finally {
        flushPromise = null;
      }
    })();
    return flushPromise;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      void flush();
    };
    if (typeof setImmediate === "function") setImmediate(run);
    else setTimeout(run, 0);
  }

  /**
   * Enqueue one injection record. Synchronous and non-throwing by contract.
   *
   * Hot path: cheap shape checks + a bounded queue push + one `setImmediate`.
   * No JSON.stringify, no code-point/byte counting, no disk I/O. Those happen
   * in `flushOnce`, where a failure can only affect the archive.
   */
  function record(input = {}) {
    if (!enabled) return false;
    const entry = input && typeof input === "object" ? input : {};
    if (
      typeof entry.hook !== "string" ||
      entry.hook.trim() === "" ||
      typeof entry.kind !== "string" ||
      entry.kind.trim() === "" ||
      typeof entry.target !== "string" ||
      entry.target.trim() === "" ||
      typeof entry.content !== "string" ||
      entry.content.length === 0
    ) {
      noteFailure(new TypeError("incomplete injection record"));
      return false;
    }

    const timestamp = entry.timestamp ?? now();
    if (typeof timestamp === "string" && !ZONE_SUFFIX_PATTERN.test(timestamp.trim())) {
      noteFailure(new TypeError("timestamp must carry an explicit Z or numeric offset"));
      return false;
    }

    const nextSequence = sequence + 1;
    sequence = nextSequence;
    enqueue(queueEntry(entry, timestamp, nextSequence));
    schedule();
    return true;
  }

  return {
    enabled,
    basePath,
    record,
    flush,
    stats() {
      return {
        pending: pendingCount(),
        dropped,
        sequence,
        failed,
        lastError,
      };
    },
  };
}

// ------------------------------------------------------------------ reading

function dateKeyFromFileName(name, stem) {
  const pattern = new RegExp(`^${stem}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  const match = pattern.exec(name);
  return match ? match[1] : null;
}

async function listDailyFiles(basePath, from, to) {
  const dir = path.dirname(basePath);
  const stem = path.basename(basePath).replace(/\.jsonl$/i, "");
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const dates = [];
  for (const name of names) {
    const dateKey = dateKeyFromFileName(name, stem);
    if (!dateKey || !isValidDateKey(dateKey)) continue;
    if (from && dateKey < from) continue;
    if (to && dateKey > to) continue;
    dates.push(dateKey);
  }
  dates.sort();
  return dates.map((dateKey) => ({ date: dateKey, file: path.join(dir, `${stem}-${dateKey}.jsonl`) }));
}

function readLines(file, onLine) {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: "utf8" });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    reader.on("line", (line) => {
      lineNumber += 1;
      onLine(line, lineNumber);
    });
    reader.on("close", () => finish(true));
    reader.on("error", () => finish(false));
    stream.on("error", () => finish(false));
  });
}

/**
 * Read records for a UTC date window. Invalid lines are reported, never
 * silently accepted. Returns records sorted by event time then sequence.
 */
export async function readInjectionLog(options = {}) {
  const {
    env = process.env,
    from = null,
    to = null,
    sessionID = null,
    event = null,
    events = null,
    limit = null,
  } = options;

  for (const [label, value] of [
    ["from", from],
    ["to", to],
  ]) {
    if (value !== null && value !== undefined && !isValidDateKey(value)) {
      throw new TypeError(`${label} must be a YYYY-MM-DD date`);
    }
  }
  if (from && to && from > to) {
    return {
      records: [],
      files: [],
      invalid: [],
      invalidTruncated: false,
      total: 0,
      totalInjections: 0,
      home: resolveInjectionHome(env),
    };
  }

  const allowedEvents =
    Array.isArray(events) && events.length > 0
      ? new Set(events.filter((item) => typeof item === "string" && item.length > 0))
      : null;
  const basePath = resolveInjectionLogPath(env);
  const dailyFiles = await listDailyFiles(basePath, from, to);
  const records = [];
  const files = [];
  const invalid = [];
  let invalidTruncated = false;
  let totalInjections = 0;
  let totalUserInputs = 0;

  const pushInvalid = (file, line, reason) => {
    if (invalid.length < MAX_INVALID_DIAGNOSTICS) {
      invalid.push({ file, line, reason });
    } else {
      invalidTruncated = true;
    }
  };

  for (const entry of dailyFiles) {
    const read = await readLines(entry.file, (line, lineNumber) => {
      const text = line.trim();
      if (text.length === 0) return;
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        pushInvalid(entry.file, lineNumber, "invalid_json");
        return;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        pushInvalid(entry.file, lineNumber, "invalid_record");
        return;
      }
      const dateKey = injectionLogDateKey(record.timestamp);
      if (dateKey === null) {
        pushInvalid(entry.file, lineNumber, "invalid_timestamp");
        return;
      }
      if (dateKey !== entry.date) {
        pushInvalid(entry.file, lineNumber, "file_date_mismatch");
        return;
      }
      if (from && dateKey < from) return;
      if (to && dateKey > to) return;
      if (sessionID) {
        const sid = typeof record.session_id === "string" ? record.session_id : "";
        if (sid !== sessionID) return;
      }
      if (typeof event === "string" && event.length > 0 && record.event !== event) return;
      if (allowedEvents && !allowedEvents.has(record.event)) return;
      records.push(record);
      if (record.event === INJECTION_EVENT) totalInjections += 1;
      if (record.event === USER_INPUT_EVENT) totalUserInputs += 1;
    });
    if (read) files.push(entry.file);
    else pushInvalid(entry.file, 0, "unreadable_file");
  }

  records.sort((left, right) => {
    const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (delta !== 0) return delta;
    return (left.sequence ?? 0) - (right.sequence ?? 0);
  });
  const total = records.length;
  const sliced = Number.isInteger(limit) && limit > 0 && records.length > limit
    ? records.slice(-limit)
    : records;

  return {
    records: sliced,
    files,
    invalid,
    invalidTruncated,
    total,
    totalInjections,
    totalUserInputs,
    home: resolveInjectionHome(env),
  };
}

/** Exported for tests that need to assert a file exists without a full read. */
export async function injectionLogExists(dateKey, env = process.env) {
  try {
    await access(resolveInjectionLogFile(dateKey, env));
    return true;
  } catch {
    return false;
  }
}
