/**
 * Unified local viewer server: context timeline + token usage + memory.
 *
 * Why one server: the three views share one page, one sidebar and one origin,
 * and all three data sources live outside the browser (JSONL archives and a
 * SQLite database). The server reads them on every API call, so the page
 * always reflects the current state. No snapshot step, no build step, no
 * network access.
 *
 * Endpoints:
 *   GET /                                   -> index.html (single-entry shell)
 *   GET /css/*.css, /js/*.js                -> static assets (allow-list only)
 *   GET /api/injections[?from=&to=&session=] -> conversation-grouped timeline
 *   GET /api/usage[?from=&to=]               -> compact token card payload
 *   GET /api/memory                          -> delx-memory entries (read-only)
 *   GET /api/health                          -> { ok, archive, archives, ... }
 *   POST /api/clear                          -> clear injection archive
 *
 * Usage:
 *   node tools/viewer/server.mjs [--port 8788] [--host 127.0.0.1]
 *                                [--injection-dir <dir>] [--usage-dir <dir>]
 *                                [--memory-db <file>] [--allow-remote]
 *                                [--open timeline|memory|usage]
 *
 * Archives can also be relocated with VIBE_PROMPT_INJECTION_HOME,
 * VIBE_TOKEN_USAGE_HOME and DELX_MEMORY_DB. Binding is loopback-only by
 * default; `--allow-remote` is required for any non-loopback host because the
 * archives and the memory store contain full prompt / memory bodies.
 */

import http from "node:http";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  INJECTION_EVENT,
  MCP_CALL_EVENT,
  SKILL_CALL_EVENT,
  SYSTEM_PROMPT_EVENT,
  TOOL_CALL_EVENT,
  USER_INPUT_EVENT,
  readInjectionLog,
  resolveInjectionHome,
} from "../../.opencode/prompt-injection/log.js";
import {
  readUsageLog,
  resolveUsageHome,
} from "../../.opencode/context-dedup/token-usage-log.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN_SESSION = "__unknown__";
const MAX_PAYLOAD_RECORDS = 5000;
const DEFAULT_PORT = 8788;

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/css/base.css", { file: "css/base.css", type: "text/css; charset=utf-8" }],
  ["/css/timeline.css", { file: "css/timeline.css", type: "text/css; charset=utf-8" }],
  ["/css/usage.css", { file: "css/usage.css", type: "text/css; charset=utf-8" }],
  ["/css/memory.css", { file: "css/memory.css", type: "text/css; charset=utf-8" }],
  ["/js/app.js", { file: "js/app.js", type: "text/javascript; charset=utf-8" }],
  ["/js/timeline.js", { file: "js/timeline.js", type: "text/javascript; charset=utf-8" }],
  ["/js/usage.js", { file: "js/usage.js", type: "text/javascript; charset=utf-8" }],
  ["/js/memory.js", { file: "js/memory.js", type: "text/javascript; charset=utf-8" }],
]);

// ============================================================ usage payload

export const CANONICAL_STRATEGIES = Object.freeze([
  "deduplication",
  "error_purge",
  "supersede_writes",
  "tool_descriptions",
  "compact_read",
  "line_range_edit",
]);

const LABELS = Object.freeze({
  deduplication: "Deduplication",
  error_purge: "Error Purge",
  supersede_writes: "Supersede Writes",
  tool_descriptions: "Tool Descriptions",
  compact_read: "Compact Read",
  line_range_edit: "Line Range Edit",
});

/**
 * Prompt region each strategy's removals live in. The card groups by this so a
 * constant per-request prefix discount is never charted as a share against
 * event-driven pruning. Records carry `scope` themselves; this is the fallback
 * for records written before that field existed.
 */
const STRATEGY_SCOPE = Object.freeze({
  deduplication: "messages",
  error_purge: "messages",
  supersede_writes: "messages",
  tool_descriptions: "tool_schema",
  compact_read: "tool_result",
  line_range_edit: "model_output",
});

function intOrZero(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function holderValue(holder) {
  if (holder && typeof holder === "object") {
    const value = holder.value;
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  }
  return 0;
}

function totalInput(record) {
  if ((Number(record.schema_version) || 0) >= 3) return holderValue(record.input_tokens);
  return (
    holderValue(record.input_tokens) +
    holderValue(record.cached_input_tokens) +
    holderValue(record.cache_write_tokens)
  );
}

function totalOutput(record) {
  if ((Number(record.schema_version) || 0) >= 3) return holderValue(record.output_tokens);
  return holderValue(record.output_tokens) + holderValue(record.reasoning_tokens);
}

function strategyKeysOf(record) {
  const pruning =
    record.pruning && typeof record.pruning === "object" && !Array.isArray(record.pruning)
      ? record.pruning
      : {};
  const keys = [];
  if (Array.isArray(pruning.order)) {
    for (const key of pruning.order) {
      if (typeof key === "string" && !keys.includes(key)) keys.push(key);
    }
  }
  for (const [key, payload] of Object.entries(pruning)) {
    if (payload && typeof payload === "object" && "removed_tokens" in payload) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * One card row per strategy:
 * [removed_tokens, scanned_records, candidate_items, removed_items,
 *  eligible_items, marked_items]
 * Older records without eligible/marked fall back to candidate/removed, so a
 * missing field is never invented as zero.
 */
function strategyRow(summary) {
  if (!summary || typeof summary !== "object") return null;
  const candidate = intOrZero(summary.candidate_items);
  const removed = intOrZero(summary.removed_items);
  return [
    holderValue(summary.removed_tokens),
    intOrZero(summary.scanned_records),
    candidate,
    removed,
    intOrZero(summary.eligible_items ?? candidate),
    intOrZero(summary.marked_items ?? removed),
  ];
}

/**
 * Convert raw usage records into the compact payload consumed by usage.js.
 * Pure function: no filesystem access, so it is unit-testable.
 */
export function buildCardPayload(records, options = {}) {
  const files = Array.isArray(options.files) ? options.files : [];
  const invalid = Array.isArray(options.invalid) ? options.invalid : [];
  const archive = typeof options.archive === "string" ? options.archive : "";
  const now = options.now instanceof Date ? options.now : new Date();

  const list = Array.isArray(records) ? records : [];
  const strategyKeys = [...CANONICAL_STRATEGIES];
  const strategyScopes = new Map();
  for (const record of list) {
    const pruning =
      record && record.pruning && typeof record.pruning === "object" ? record.pruning : {};
    for (const key of strategyKeysOf(record)) {
      if (!strategyKeys.includes(key)) strategyKeys.push(key);
      // A record may declare its own scope; the first one wins so a strategy
      // never flips groups mid-range.
      const declared = pruning[key] ? pruning[key].scope : null;
      if (!strategyScopes.has(key) && typeof declared === "string" && declared.length > 0) {
        strategyScopes.set(key, declared);
      }
    }
  }

  // Prefer the project recorded with the usage event; older records do not
  // carry it, so fall back to the injection archive's session -> project map.
  const sessionProjects =
    options.sessionProjects && typeof options.sessionProjects === "object"
      ? options.sessionProjects
      : {};
  const projectOf = (record) => {
    const direct = record && typeof record.project === "string" ? record.project : "";
    if (direct) return direct;
    const sessionId = record && record.session_id;
    return typeof sessionId === "string" && typeof sessionProjects[sessionId] === "string"
      ? sessionProjects[sessionId]
      : "";
  };

  const compact = [];
  for (const record of list) {
    const at = Date.parse(record?.timestamp);
    if (!Number.isFinite(at)) continue;
    const pruning =
      record.pruning && typeof record.pruning === "object" && !Array.isArray(record.pruning)
        ? record.pruning
        : {};
    const perStrategy = strategyKeys.map((key) => strategyRow(pruning[key]));
    const totalRemoved = holderValue(pruning.total_removed_tokens);
    const removed = totalRemoved || perStrategy.reduce((total, row) => total + (row ? row[0] : 0), 0);
    // [timestamp, input, output, cached, removed, strategyRows, model,
    //  session_id, project] — the first six positions are the original
    //  contract; the last three are additive so older readers keep working.
    compact.push([
      at,
      totalInput(record),
      totalOutput(record),
      holderValue(record.cached_input_tokens),
      removed,
      perStrategy,
      typeof record.model === "string" ? record.model : "",
      typeof record.session_id === "string" ? record.session_id : "",
      projectOf(record),
    ]);
  }
  compact.sort((left, right) => left[0] - right[0]);

  return {
    generatedAt: now.toISOString(),
    archive,
    sourceFiles: files.map((file) => path.basename(file)),
    strategies: strategyKeys.map((key) => ({
      key,
      label: LABELS[key] ?? key,
      scope: strategyScopes.get(key) ?? STRATEGY_SCOPE[key] ?? "messages",
    })),
    records: compact,
    diagnostics: {
      records: compact.length,
      invalidLines: invalid.length,
    },
  };
}

/**
 * Read the live archive and build the payload. `dataDir` maps to
 * VIBE_TOKEN_USAGE_HOME; `from`/`to` are inclusive UTC `YYYY-MM-DD` keys.
 */
function withUsageHome(dataDir, env) {
  const trimmed = typeof dataDir === "string" ? dataDir.trim() : "";
  return trimmed ? { ...env, VIBE_TOKEN_USAGE_HOME: trimmed } : env;
}

export async function loadCardPayload(options = {}) {
  const { dataDir, from = null, to = null, now = new Date(), env = process.env } = options;
  const effectiveEnv = withUsageHome(dataDir, env);
  const [result, sessionProjects] = await Promise.all([
    readUsageLog({}, process.cwd(), { from, to, env: effectiveEnv }),
    loadSessionProjects(effectiveEnv),
  ]);
  return buildCardPayload(result.records, {
    files: result.files,
    invalid: result.invalid,
    archive: resolveUsageHome(effectiveEnv),
    now,
    sessionProjects,
  });
}

// session_id -> project, read from the injection archive. The mapping is a
// display nicety, so a missing or unreadable archive degrades to empty instead
// of failing the usage request. Cached briefly so the 15s viewer refresh does
// not re-read the whole archive each tick.
let sessionProjectCache = { at: 0, home: "", map: {} };
const SESSION_PROJECT_TTL_MS = 30000;

async function loadSessionProjects(env) {
  const home = resolveInjectionHome(env);
  const now = Date.now();
  if (sessionProjectCache.home === home && now - sessionProjectCache.at < SESSION_PROJECT_TTL_MS) {
    return sessionProjectCache.map;
  }
  const map = {};
  try {
    const result = await readInjectionLog({ env, limit: 20000 });
    for (const record of result.records || []) {
      const sessionId = record && record.session_id;
      const project = record && record.project;
      if (
        typeof sessionId === "string" &&
        sessionId.length > 0 &&
        typeof project === "string" &&
        project.length > 0 &&
        !map[sessionId]
      ) {
        map[sessionId] = project;
      }
    }
  } catch {
    // Diagnostics only: the usage view still renders without project labels.
  }
  sessionProjectCache = { at: Date.now(), home, map };
  return map;
}

/** Stat one archive path for the health panel; never throws. */
async function describePath(target) {
  try {
    const info = await stat(target);
    return {
      path: target,
      exists: true,
      isDirectory: info.isDirectory(),
      bytes: info.isDirectory() ? null : info.size,
      mtime: info.mtime.toISOString(),
    };
  } catch {
    return { path: target, exists: false, isDirectory: false, bytes: null, mtime: null };
  }
}

// ======================================================== injection payload

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function modelLabel(model) {
  if (!model || typeof model !== "object") return null;
  const provider = stringOr(model.provider_id);
  const id = stringOr(model.model_id);
  if (!provider && !id) return null;
  return { provider_id: provider || null, model_id: id || null };
}

function normalizeCategory(record) {
  if (record.category === "user_input" || record.event === USER_INPUT_EVENT) return "user_input";
  if (record.category === "tool" || record.event === TOOL_CALL_EVENT) return "tool";
  if (record.category === "mcp" || record.event === MCP_CALL_EVENT) return "mcp";
  if (record.category === "skill" || record.event === SKILL_CALL_EVENT) return "skill";
  if (record.category === "context" || record.event === SYSTEM_PROMPT_EVENT) return "context";
  return "injection";
}

function compactEntry(record) {
  return {
    timestamp: record.timestamp,
    sequence: Number.isInteger(record.sequence) ? record.sequence : 0,
    source: stringOr(record.source),
    hook: stringOr(record.hook),
    kind: stringOr(record.kind, "unknown"),
    event: stringOr(record.event),
    category: normalizeCategory(record),
    trigger: typeof record.trigger === "string" ? record.trigger : null,
    target: stringOr(record.target),
    project: stringOr(record.project),
    model: modelLabel(record.model),
    content: stringOr(record.content),
    content_chars: Number(record.content_chars) || 0,
    content_bytes: Number(record.content_bytes) || 0,
    content_truncated: record.content_truncated === true,
    original_content_chars: Number(record.original_content_chars) || 0,
  };
}

function sessionKey(record) {
  return typeof record.session_id === "string" && record.session_id.length > 0
    ? record.session_id
    : UNKNOWN_SESSION;
}

/**
 * Convert raw log records into a conversation-grouped timeline payload.
 * Pure function: no filesystem access, so it is unit-testable.
 */
export function buildInjectionPayload(records, options = {}) {
  const files = Array.isArray(options.files) ? options.files : [];
  const invalid = Array.isArray(options.invalid) ? options.invalid : [];
  const archive = typeof options.archive === "string" ? options.archive : "";
  const now = options.now instanceof Date ? options.now : new Date();

  const eventSet = new Set([
    INJECTION_EVENT,
    USER_INPUT_EVENT,
    TOOL_CALL_EVENT,
    MCP_CALL_EVENT,
    SKILL_CALL_EVENT,
    SYSTEM_PROMPT_EVENT,
  ]);
  const list = (Array.isArray(records) ? records : []).filter(
    (record) => record && eventSet.has(record.event)
  );
  const totalRecords = Number.isInteger(options.total) ? options.total : list.length;
  const truncated = totalRecords > list.length;
  const sessions = new Map();
  const byKind = {};
  const countEvent = (event) => list.filter((record) => record.event === event).length;
  const injectionCount = countEvent(INJECTION_EVENT);
  const userInputCount = countEvent(USER_INPUT_EVENT);
  const toolCallCount = countEvent(TOOL_CALL_EVENT);
  const mcpCallCount = countEvent(MCP_CALL_EVENT);
  const skillCallCount = countEvent(SKILL_CALL_EVENT);
  const systemPromptCount = countEvent(SYSTEM_PROMPT_EVENT);

  for (const record of list) {
    const key = sessionKey(record);
    let session = sessions.get(key);
    if (!session) {
      session = {
        session_id: key,
        first_at: record.timestamp,
        last_at: record.timestamp,
        count: 0,
        projects: new Set(),
        entries: [],
      };
      sessions.set(key, session);
    }
    if (Date.parse(record.timestamp) < Date.parse(session.first_at)) {
      session.first_at = record.timestamp;
    }
    if (Date.parse(record.timestamp) > Date.parse(session.last_at)) {
      session.last_at = record.timestamp;
    }
    session.count += 1;
    const project = stringOr(record.project);
    if (project) session.projects.add(project);
    const entry = compactEntry(record);
    session.entries.push(entry);
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  }

  const grouped = [...sessions.values()]
    .map((session) => ({
      session_id: session.session_id,
      first_at: session.first_at,
      last_at: session.last_at,
      count: session.count,
      projects: [...session.projects],
      entries: session.entries.sort((left, right) => {
        const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
        if (delta !== 0) return delta;
        return left.sequence - right.sequence;
      }),
    }))
    .sort((left, right) => Date.parse(right.last_at) - Date.parse(left.last_at));

  return {
    generatedAt: now.toISOString(),
    archive,
    sourceFiles: files.map((file) => path.basename(file)),
    stats: {
      sessions: grouped.length,
      records: list.length,
      injections: injectionCount,
      userInputs: userInputCount,
      toolCalls: toolCallCount,
      mcpCalls: mcpCallCount,
      skillCalls: skillCallCount,
      systemPrompts: systemPromptCount,
      byKind,
    },
    sessions: grouped,
    diagnostics: {
      records: list.length,
      totalRecords,
      truncated,
      invalidLines: invalid.length,
      invalidTruncated: options.invalidTruncated === true,
    },
  };
}

function withInjectionHome(dataDir, env) {
  const trimmed = typeof dataDir === "string" ? dataDir.trim() : "";
  return trimmed ? { ...env, VIBE_PROMPT_INJECTION_HOME: trimmed } : env;
}

export async function loadInjectionPayload(options = {}) {
  const {
    dataDir,
    from = null,
    to = null,
    sessionID = null,
    limit = MAX_PAYLOAD_RECORDS,
    now = new Date(),
    env = process.env,
  } = options;
  const effectiveEnv = withInjectionHome(dataDir, env);
  const unknownOnly = sessionID === UNKNOWN_SESSION;
  const result = await readInjectionLog({
    from,
    to,
    sessionID: unknownOnly ? null : sessionID,
    // Both categories share one timeline: user input and injected context.
    events: [
      INJECTION_EVENT,
      USER_INPUT_EVENT,
      TOOL_CALL_EVENT,
      MCP_CALL_EVENT,
      SKILL_CALL_EVENT,
      SYSTEM_PROMPT_EVENT,
    ],
    // `__unknown__` needs the pre-slice set so its own total is accurate.
    limit: unknownOnly ? null : limit,
    env: effectiveEnv,
  });
  if (unknownOnly) {
    result.records = result.records.filter(
      (record) => typeof record.session_id !== "string" || record.session_id.length === 0
    );
  }
  const relevantTotal = unknownOnly ? result.records.length : result.total;
  return buildInjectionPayload(result.records, {
    files: result.files,
    invalid: result.invalid,
    invalidTruncated: result.invalidTruncated,
    total: relevantTotal,
    archive: resolveInjectionHome(effectiveEnv),
    now,
  });
}

/** List the prompt-injection JSONL files for this archive home. */
async function listArchiveFiles(env) {
  const home = resolveInjectionHome(env);
  try {
    const names = await readdir(home);
    return names
      .filter((name) => name.startsWith("prompt-injection") && name.endsWith(".jsonl"))
      .map((name) => path.join(home, name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Clear archive data. `all` truncates every daily file; `session` rewrites
 * each file without records from one session, preserving invalid lines and
 * other sessions. This is an explicit destructive operation; the HTTP layer
 * requires a second confirmation in the UI plus a custom header.
 */
export async function clearInjectionArchive(options = {}) {
  const { dataDir, env = process.env, scope, sessionID = "" } = options;
  const effectiveEnv = withInjectionHome(dataDir, env);
  const home = resolveInjectionHome(effectiveEnv);
  const files = await listArchiveFiles(effectiveEnv);
  let removed = 0;
  let touched = 0;

  if (scope === "all") {
    for (const file of files) {
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const count = text.split("\n").filter((line) => line.trim() !== "").length;
      if (count === 0) continue;
      await writeFile(file, "", { mode: 0o600 });
      removed += count;
      touched += 1;
    }
    return { ok: true, scope, removed, files: touched, home };
  }

  if (scope !== "session") throw new TypeError("invalid scope");
  if (typeof sessionID !== "string" || sessionID.trim() === "") {
    throw new TypeError("session is required");
  }
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const kept = [];
    let fileRemoved = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        kept.push(line);
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        kept.push(line);
        continue;
      }
      if (record && record.session_id === sessionID) {
        fileRemoved += 1;
        continue;
      }
      kept.push(line);
    }
    if (fileRemoved === 0) continue;
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, kept.join("\n"), { mode: 0o600 });
    await rename(tmp, file);
    removed += fileRemoved;
    touched += 1;
  }
  return { ok: true, scope, session_id: sessionID, removed, files: touched, home };
}

// ============================================================ memory payload

/** Resolve the delx-memory SQLite path: --memory-db > DELX_MEMORY_DB > default. */
export function resolveMemoryDb(env = process.env) {
  const explicit = typeof env.DELX_MEMORY_DB === "string" ? env.DELX_MEMORY_DB.trim() : "";
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".delx-memory", "db.sqlite");
}

/** delx-memory stores `value` as a JSON string (quotes + escapes); decode it. */
function decodeMemoryValue(raw) {
  if (raw === null || raw === undefined) return "";
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      return text;
    }
  }
  return text;
}

function decodeMemoryMeta(raw) {
  if (raw === null || raw === undefined || raw === "") return {};
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function splitMemoryTags(raw) {
  if (raw === null || raw === undefined) return [];
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  // tags 列是 ",a,b," 形式的逗号串（见 lesson:delx-memory-tags-storage-format）
  return text.split(",").filter(Boolean);
}

function normalizeMemoryRow(row) {
  const key = String(row.key ?? "");
  const text = decodeMemoryValue(row.value);
  const meta = decodeMemoryMeta(row.metadata);
  const tags = splitMemoryTags(row.tags);
  const fragment = key.includes("#");
  return {
    key,
    type: key.split(":")[0],
    fragment,
    parent: fragment ? key.split("#")[0] : null,
    value: text,
    tags,
    metadata: meta,
    size: Array.from(text).length,
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
    ttl_expires_at: row.ttl_expires_at ? Number(row.ttl_expires_at) : null,
    status: meta.status ?? null,
    layer: meta.layer ?? null,
    weight: tags.find((tag) => tag.startsWith("p_")) ?? null,
  };
}

/**
 * Convert raw `memory` rows into the viewer payload. Pure function:
 * no filesystem access, so it is unit-testable.
 */
export function buildMemoryPayload(rows, options = {}) {
  const source = typeof options.source === "string" ? options.source : "";
  const available = options.available !== false;
  const error = typeof options.error === "string" ? options.error : null;
  const now = options.now instanceof Date ? options.now : new Date();

  const entries = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.key === "string" && row.key.length > 0)
    .map(normalizeMemoryRow)
    .sort((left, right) => right.updated_at - left.updated_at || left.key.localeCompare(right.key));

  const types = {};
  for (const entry of entries) {
    types[entry.type] = (types[entry.type] ?? 0) + 1;
  }

  return {
    generated_at: now.getTime(),
    source,
    available,
    error,
    total: entries.length,
    total_chars: entries.reduce((total, entry) => total + entry.size, 0),
    types,
    entries,
  };
}

/**
 * Read the live delx-memory database (read-only). A missing database, a locked
 * file or a Node build without `node:sqlite` returns an empty payload with
 * `available:false` instead of failing the whole viewer.
 */
export async function loadMemoryPayload(options = {}) {
  const { dbPath, env = process.env, now = new Date() } = options;
  const resolved =
    typeof dbPath === "string" && dbPath.trim() !== ""
      ? path.resolve(dbPath.trim())
      : resolveMemoryDb(env);

  let available = false;
  let error = null;
  let rows = [];

  try {
    await stat(resolved);
  } catch (err) {
    error = err?.code === "ENOENT" ? "database_missing" : "database_unreadable";
    return buildMemoryPayload([], { source: resolved, available, error, now });
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(resolved, { readOnly: true });
    try {
      rows = db
        .prepare(
          "select key,value,tags,metadata,created_at,updated_at,ttl_expires_at from memory"
        )
        .all();
    } finally {
      db.close();
    }
    available = true;
  } catch (err) {
    const message = String(err?.message ?? err);
    error = /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/i.test(message)
      ? "sqlite_unavailable"
      : "database_unreadable";
    if (error !== "sqlite_unavailable") {
      console.error("[viewer] memory read failed:", message);
    }
  }

  return buildMemoryPayload(rows, { source: resolved, available, error, now });
}

// ================================================================== server

function send(res, status, headers, body, method) {
  res.writeHead(status, headers);
  if (method === "HEAD" || body === null || body === undefined) {
    res.end();
    return;
  }
  res.end(body);
}

// Large archives (timeline payloads carry every entry body) compress well;
// gzip keeps the 15s usage poll and the timeline load off the wire.
const GZIP_MIN_CHARS = 2048;

function acceptsGzip(request) {
  return /gzip/i.test(String(request?.headers?.["accept-encoding"] || ""));
}

function sendJsonText(res, status, text, method, request, gzipHolder) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  let body = text;
  if (request && text.length >= GZIP_MIN_CHARS && acceptsGzip(request)) {
    if (gzipHolder && gzipHolder.gzip) {
      body = gzipHolder.gzip;
    } else {
      const packed = gzipSync(text);
      if (gzipHolder) gzipHolder.gzip = packed;
      body = packed;
    }
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  send(res, status, headers, body, method);
}

function sendJson(res, status, value, method, request) {
  sendJsonText(res, status, JSON.stringify(value), method, request);
}

/* Small FIFO cache of serialized payloads. Entries are only reused when the
   archive signature (file names + sizes + mtimes) is unchanged, so the page
   still reflects the live archive while a poll that found nothing new avoids
   re-reading and re-parsing every JSONL line. */
function makeJsonCache(limit) {
  const store = new Map();
  return {
    get(key) {
      return store.get(key) || null;
    },
    set(key, text) {
      const entry = { text, gzip: null };
      store.set(key, entry);
      if (store.size > limit) store.delete(store.keys().next().value);
      return entry;
    },
  };
}

/* Cheap freshness probe: stat only, never reads the archive bodies. */
async function archiveSignature(directory) {
  try {
    const names = await readdir(directory);
    const parts = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const info = await stat(path.join(directory, name));
        parts.push(`${name}:${info.size}:${Math.floor(info.mtimeMs)}`);
      } catch {
        parts.push(`${name}:missing`);
      }
    }
    parts.sort();
    return parts.join("|");
  } catch {
    return "unreadable";
  }
}

function validateDate(value, label) {
  if (value === null || value === undefined) return null;
  if (!DATE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a YYYY-MM-DD date`);
  }
  return value;
}

function readJsonBody(request, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/**
 * Create the HTTP server without listening. Tests use this directly.
 * `injectionDir` maps to VIBE_PROMPT_INJECTION_HOME, `usageDir` to
 * VIBE_TOKEN_USAGE_HOME, `memoryDb` to the SQLite path.
 */
export function createViewerServer(options = {}) {
  const {
    injectionDir,
    usageDir,
    memoryDb,
    env = process.env,
  } = options;
  const injectionEnv = withInjectionHome(injectionDir, env);
  const usageEnv = withUsageHome(usageDir, env);
  const jsonCache = makeJsonCache(8);

  return http.createServer(async (request, response) => {
    const method = request.method ?? "GET";
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(response, 400, { error: "invalid_url" }, method);
      return;
    }

    if (method === "POST" && url.pathname === "/api/clear") {
      const contentType = String(request.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        sendJson(response, 415, { error: "json_required" }, method);
        return;
      }
      if (request.headers["x-requested-with"] !== "prompt-injection-viewer") {
        sendJson(response, 403, { error: "missing_confirm_header" }, method);
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: "invalid_body" }, method);
        return;
      }
      const scope = body?.scope;
      const sessionID = typeof body?.session === "string" ? body.session.trim() : "";
      if (scope !== "all" && scope !== "session") {
        sendJson(response, 400, { error: "invalid_scope" }, method);
        return;
      }
      if (scope === "session" && (!sessionID || sessionID.length > 512 || /[\r\n]/.test(sessionID))) {
        sendJson(response, 400, { error: "invalid_session" }, method);
        return;
      }
      try {
        const result = await clearInjectionArchive({
          dataDir: injectionDir,
          env,
          scope,
          sessionID,
        });
        sendJson(response, 200, result, method);
      } catch {
        sendJson(response, 500, { error: "clear_failed" }, method);
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, 405, { error: "method_not_allowed" }, method);
      return;
    }

    if (url.pathname === "/api/injections") {
      let from;
      let to;
      try {
        from = validateDate(url.searchParams.get("from"), "from");
        to = validateDate(url.searchParams.get("to"), "to");
        if (from && to && from > to) {
          sendJson(response, 400, { error: "range_reversed" }, method);
          return;
        }
        const sessionParam = url.searchParams.get("session");
        const sessionID =
          typeof sessionParam === "string" && sessionParam.trim() !== ""
            ? sessionParam.trim()
            : null;
        const signature = await archiveSignature(resolveInjectionHome(injectionEnv));
        const cacheKey = ["injections", from || "", to || "", sessionID || "", signature].join("|");
        let entry = jsonCache.get(cacheKey);
        if (!entry) {
          const payload = await loadInjectionPayload({
            dataDir: injectionDir,
            from,
            to,
            sessionID,
            env,
          });
          entry = jsonCache.set(cacheKey, JSON.stringify(payload));
        }
        sendJsonText(response, 200, entry.text, method, request, entry);
      } catch (error) {
        const invalid = error instanceof TypeError;
        if (!invalid) {
          console.error("[viewer] injection read failed:", error?.message ?? error);
        }
        sendJson(
          response,
          invalid ? 400 : 500,
          { error: invalid ? "invalid_range" : "archive_unreadable" },
          method
        );
      }
      return;
    }

    if (url.pathname === "/api/usage") {
      let from;
      let to;
      try {
        from = validateDate(url.searchParams.get("from"), "from");
        to = validateDate(url.searchParams.get("to"), "to");
        if (from && to && from > to) {
          sendJson(response, 400, { error: "range_reversed" }, method);
          return;
        }
        // Keep the project-label cache warm so the key reflects it: labels come
        // from the injection archive and change when that archive does.
        await loadSessionProjects(usageEnv);
        const signature = await archiveSignature(resolveUsageHome(usageEnv));
        const cacheKey = [
          "usage",
          from || "",
          to || "",
          signature,
          sessionProjectCache.at,
        ].join("|");
        let entry = jsonCache.get(cacheKey);
        if (!entry) {
          const payload = await loadCardPayload({ dataDir: usageDir, from, to, env });
          entry = jsonCache.set(cacheKey, JSON.stringify(payload));
        }
        sendJsonText(response, 200, entry.text, method, request, entry);
      } catch (error) {
        const invalid = error instanceof TypeError;
        if (!invalid) {
          console.error("[viewer] usage read failed:", error?.message ?? error);
        }
        sendJson(
          response,
          invalid ? 400 : 500,
          { error: invalid ? "invalid_range" : "archive_unreadable" },
          method
        );
      }
      return;
    }

    if (url.pathname === "/api/memory") {
      try {
        const payload = await loadMemoryPayload({ dbPath: memoryDb, env });
        sendJson(response, 200, payload, method);
      } catch (error) {
        console.error("[viewer] memory read failed:", error?.message ?? error);
        sendJson(response, 500, { error: "memory_unreadable" }, method);
      }
      return;
    }

    if (url.pathname === "/api/health") {
      const archives = {
        injection: resolveInjectionHome(injectionEnv),
        usage: resolveUsageHome(usageEnv),
        memory: memoryDb ? path.resolve(memoryDb) : resolveMemoryDb(env),
      };
      const checks = {};
      for (const name of Object.keys(archives)) {
        checks[name] = await describePath(archives[name]);
      }
      sendJson(
        response,
        200,
        {
          ok: true,
          archive: archives.usage,
          archives,
          checks,
          generatedAt: new Date().toISOString(),
        },
        method
      );
      return;
    }

    // Browsers request this automatically; answer quietly instead of 404.
    if (url.pathname === "/favicon.ico") {
      send(response, 204, { "Cache-Control": "no-cache" }, null, method);
      return;
    }

    const asset = STATIC_FILES.get(url.pathname);
    if (!asset) {
      sendJson(response, 404, { error: "not_found" }, method);
      return;
    }
    const filePath = path.join(HERE, asset.file);
    try {
      const info = await stat(filePath);
      const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const headers = {
        "Content-Type": asset.type,
        "Cache-Control": "no-cache",
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "connect-src 'self'; img-src 'self' data:; base-uri 'none'; " +
          "frame-ancestors 'none'; object-src 'none'",
      };
      // Revalidation is a 304 instead of re-sending ~10k lines of CSS/JS.
      if (request.headers["if-none-match"] === etag) {
        send(response, 304, headers, null, method);
        return;
      }
      const body = await readFile(filePath);
      send(response, 200, headers, body, method);
    } catch (error) {
      console.error("[viewer] static read failed:", error?.message ?? error);
      sendJson(response, 500, { error: "asset_unreadable" }, method);
    }
  });
}

/** Loopback-only by default: archives and memory contain full prompt bodies. */
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const text = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (text === "localhost") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(text)) return true;
  if (text === "::1" || text === "0:0:0:0:0:0:0:1") return true;
  if (text === "::ffff:7f00:1" || text.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * Start listening. `port: 0` picks a free port (tests).
 * @returns {Promise<{server: import("node:http").Server, host: string, port: number, url: string}>}
 */
export async function startViewerServer(options = {}) {
  const {
    host = "127.0.0.1",
    port = DEFAULT_PORT,
    injectionDir,
    usageDir,
    memoryDb,
    env = process.env,
    allowRemote = false,
  } = options;
  if (!allowRemote && !isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind ${host}: the archives and the memory store contain ` +
        "prompt / memory bodies; pass --allow-remote only on a trusted network"
    );
  }
  const server = createViewerServer({ injectionDir, usageDir, memoryDb, env });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { server, host, port: actualPort, url: `http://${urlHost}:${actualPort}/` };
}

// ===================================================================== CLI

const VIEW_NAMES = new Set(["timeline", "memory", "usage"]);

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    host: "127.0.0.1",
    injectionDir: undefined,
    usageDir: undefined,
    memoryDb: undefined,
    allowRemote: false,
    open: "timeline",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const takeValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === "--port" || flag === "-p") {
      const value = Number(takeValue());
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      options.port = value;
    } else if (flag === "--host") {
      options.host = takeValue();
    } else if (flag === "--injection-dir") {
      options.injectionDir = takeValue();
    } else if (flag === "--usage-dir" || flag === "--data-dir") {
      // `--data-dir` is kept as the token-usage archive alias.
      options.usageDir = takeValue();
    } else if (flag === "--memory-db") {
      options.memoryDb = takeValue();
    } else if (flag === "--allow-remote") {
      options.allowRemote = true;
    } else if (flag === "--open") {
      const value = takeValue();
      if (!VIEW_NAMES.has(value)) {
        throw new Error("--open must be timeline, memory or usage");
      }
      options.open = value;
    } else if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/viewer/server.mjs [options]

Options:
  -p, --port <n>         listen port (default ${DEFAULT_PORT}; 0 = random)
      --host <addr>      bind address (default 127.0.0.1)
      --injection-dir    prompt-injection archive directory
                         (default VIBE_PROMPT_INJECTION_HOME or
                          ~/.config/opencode/prompt-injection)
      --usage-dir        token-usage archive directory
                         (default VIBE_TOKEN_USAGE_HOME or
                          ~/.config/opencode/token-usage)
      --data-dir <dir>   alias of --usage-dir
      --memory-db <file> delx-memory SQLite path
                         (default DELX_MEMORY_DB or ~/.delx-memory/db.sqlite)
      --allow-remote     allow a non-loopback bind (exposes prompt and memory
                         bodies; trusted networks only)
      --open <view>      print the URL for timeline|memory|usage (default
                         timeline)
  -h, --help             show this help`);
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[viewer] ${error.message}`);
    process.exitCode = 2;
  }
  if (options?.help) {
    printHelp();
  } else if (options) {
    const injectionArchive = resolveInjectionHome(withInjectionHome(options.injectionDir, process.env));
    const usageArchive = resolveUsageHome(withUsageHome(options.usageDir, process.env));
    const memoryDb = options.memoryDb ? path.resolve(options.memoryDb) : resolveMemoryDb(process.env);
    if (!isLoopbackHost(options.host)) {
      console.warn(
        `[viewer] WARNING: binding ${options.host}; the archives and the memory ` +
          "store contain full prompt / memory bodies."
      );
    }
    startViewerServer(options).then(
      ({ server, url }) => {
        const suffix = options.open === "timeline" ? "" : `#${options.open}`;
        console.log(`Viewer              → ${url}${suffix}`);
        console.log(`Injection archive   → ${injectionArchive}`);
        console.log(`Token usage archive → ${usageArchive}`);
        console.log(`Memory database     → ${memoryDb}`);
        console.log(`Home dir            → ${os.homedir()}`);
        console.log("Press Ctrl+C to stop.");
        const shutdown = () => {
          server.close(() => process.exit(0));
          setTimeout(() => process.exit(0), 2000).unref();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      },
      (error) => {
        console.error(`[viewer] failed to start: ${error.message}`);
        process.exitCode = 1;
      }
    );
  }
}
