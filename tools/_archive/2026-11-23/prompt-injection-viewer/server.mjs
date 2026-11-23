/**
 * Local HTTP server for the prompt-injection timeline.
 *
 * Why a server: the archive lives under the user's home directory and is
 * append-only JSONL. A browser page cannot read it directly, so this server
 * reads the archive on every API call and returns a conversation-grouped
 * payload. No snapshot step, no build step, no network access.
 *
 * Endpoints:
 *   GET /                              -> index.html
 *   GET /app.js, /styles.css           -> static assets (allow-list only)
 *   GET /api/injections[?from=&to=&session=] -> grouped timeline payload
 *   GET /api/health                    -> { ok, archive, generatedAt }
 *
 * Usage:
 *   node tools/prompt-injection-viewer/server.mjs [--port 8788]
 *                                                [--host 127.0.0.1]
 *                                                [--data-dir <archive dir>]
 *                                                [--allow-remote]
 *
 * The archive can also be relocated with VIBE_PROMPT_INJECTION_HOME.
 * Binding is loopback-only by default; `--allow-remote` is required for any
 * non-loopback host because the archive contains full injected prompt text.
 */

import http from "node:http";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN_SESSION = "__unknown__";
const MAX_PAYLOAD_RECORDS = 5000;

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

// ---------------------------------------------------------------- payload

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

// ------------------------------------------------------------------ server

function send(res, status, headers, body, method) {
  res.writeHead(status, headers);
  if (method === "HEAD" || body === null || body === undefined) {
    res.end();
    return;
  }
  res.end(body);
}

function sendJson(res, status, value, method) {
  send(
    res,
    status,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
    JSON.stringify(value),
    method
  );
}

function validateDate(value, label) {
  if (value === null || value === undefined) return null;
  if (!DATE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a YYYY-MM-DD date`);
  }
  return value;
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

/** Create the HTTP server without listening. Tests use this directly. */
export function createInjectionServer(options = {}) {
  const { dataDir, env = process.env } = options;

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
        const result = await clearInjectionArchive({ dataDir, env, scope, sessionID });
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
        const payload = await loadInjectionPayload({ dataDir, from, to, sessionID, env });
        sendJson(response, 200, payload, method);
      } catch (error) {
        const invalid = error instanceof TypeError;
        if (!invalid) {
          console.error("[prompt-injection-viewer] read failed:", error?.message ?? error);
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

    if (url.pathname === "/api/health") {
      sendJson(
        response,
        200,
        {
          ok: true,
          archive: resolveInjectionHome(withInjectionHome(dataDir, env)),
          generatedAt: new Date().toISOString(),
        },
        method
      );
      return;
    }

    if (url.pathname === "/favicon.ico") {
      send(response, 204, { "Cache-Control": "no-cache" }, null, method);
      return;
    }

    const asset = STATIC_FILES.get(url.pathname);
    if (!asset) {
      sendJson(response, 404, { error: "not_found" }, method);
      return;
    }
    try {
      const body = await readFile(path.join(HERE, asset.file));
      send(
        response,
        200,
        {
          "Content-Type": asset.type,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
        },
        body,
        method
      );
    } catch (error) {
      console.error("[prompt-injection-viewer] static read failed:", error?.message ?? error);
      sendJson(response, 500, { error: "asset_unreadable" }, method);
    }
  });
}

/**
 * Start listening. `port: 0` picks a free port (tests).
 * @returns {Promise<{server: import("node:http").Server, host: string, port: number, url: string}>}
 */
/** Loopback-only by default: the archive contains full injected prompt text. */
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const text = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (text === "localhost") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(text)) return true;
  if (text === "::1" || text === "0:0:0:0:0:0:0:1") return true;
  if (text === "::ffff:7f00:1" || text.startsWith("::ffff:127.")) return true;
  return false;
}

export async function startInjectionServer(options = {}) {
  const {
    host = "127.0.0.1",
    port = 8788,
    dataDir,
    env = process.env,
    allowRemote = false,
  } = options;
  if (!allowRemote && !isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind ${host}: the injection archive contains prompt bodies; ` +
        "pass --allow-remote only on a trusted network"
    );
  }
  const server = createInjectionServer({ dataDir, env });
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

// --------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const options = { port: 8788, host: "127.0.0.1", dataDir: undefined, allowRemote: false };
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
    } else if (flag === "--data-dir") {
      options.dataDir = takeValue();
    } else if (flag === "--allow-remote") {
      options.allowRemote = true;
    } else if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/prompt-injection-viewer/server.mjs [options]

Options:
  -p, --port <n>       listen port (default 8788; 0 = random)
      --host <addr>    bind address (default 127.0.0.1)
      --data-dir <dir> archive directory (default VIBE_PROMPT_INJECTION_HOME
                       or ~/.config/opencode/prompt-injection)
      --allow-remote   allow a non-loopback bind (exposes prompt bodies;
                       trusted networks only)
  -h, --help           show this help`);
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[prompt-injection-viewer] ${error.message}`);
    process.exitCode = 2;
  }
  if (options?.help) {
    printHelp();
  } else if (options) {
    const archive = resolveInjectionHome(withInjectionHome(options.dataDir, process.env));
    if (!isLoopbackHost(options.host)) {
      console.warn(
        `[prompt-injection-viewer] WARNING: binding ${options.host}; ` +
          "the archive contains full injected prompt text."
      );
    }
    startInjectionServer(options).then(
      ({ server, url }) => {
        console.log(`Prompt injection timeline → ${url}`);
        console.log(`Archive                    → ${archive}`);
        console.log(`Home dir                   → ${os.homedir()}`);
        console.log("Press Ctrl+C to stop.");
        const shutdown = () => {
          server.close(() => process.exit(0));
          setTimeout(() => process.exit(0), 2000).unref();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      },
      (error) => {
        console.error(`[prompt-injection-viewer] failed to start: ${error.message}`);
        process.exitCode = 1;
      }
    );
  }
}
