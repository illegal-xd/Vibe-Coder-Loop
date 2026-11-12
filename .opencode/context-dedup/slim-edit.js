/**
 * Output/definition slimming strategies adapted from OpenSlimedit
 * (https://github.com/ASidorenkoCode/openslimedit, MIT).
 * The upstream MIT notice is preserved in slim-edit.LICENSE.
 *
 * Three independent, opt-out strategies:
 *   1. `toolDescriptions` — replace verbose built-in tool descriptions with
 *      minimal ones. Tool schemas are sent with every API call, so the saving
 *      repeats per request; within one request round it is charged once even
 *      if the runtime rebuilds the schema several times.
 *   2. `compactRead` — shorten absolute read paths and drop the type tag and
 *      footer boilerplate from read output.
 *   3. `lineRangeEdit` — expand `oldString: "55-64"` to the actual file lines
 *      before the native edit tool runs, so the model does not have to
 *      reproduce the content.
 *
 * All hooks are fail-open: a malformed payload, an unreadable file, or a
 * preview run leaves the original value untouched. Statistics use the same
 * funnel as the message-pruning strategies so the token-usage card can render
 * them without a second schema.
 */

import fs from "node:fs";
import path from "node:path";

import { byteLength, estimateTokens } from "./core.js";

/** Minimal descriptions; only existing tools are touched. */
export const DEFAULT_SLIM_TOOL_DESCRIPTIONS = Object.freeze({
  read: "Read file content.",
  edit: "Edit file. oldString can be line range '55-64'.",
  apply_patch: "Apply a patch to files.",
  write: "Write file.",
  bash: "Run shell command.",
  glob: "Find files.",
  grep: "Search in files.",
  list: "List directory.",
  fetch: "Fetch URL.",
  webfetch: "Fetch URL.",
});

/**
 * Hosts and forks name the same built-in differently (`shell` vs `bash`,
 * Claude-style `Read`/`Write`). Without this map every hook silently reports
 * `unsupported_tool` and the strategy looks "implemented but never fires".
 */
export const TOOL_ALIASES = Object.freeze({
  read_file: "read",
  readFile: "read",
  Read: "read",
  write_file: "write",
  writeFile: "write",
  Write: "write",
  edit_file: "edit",
  editFile: "edit",
  Edit: "edit",
  shell: "bash",
  Bash: "bash",
  run_command: "bash",
  search_files: "grep",
  Grep: "grep",
  find_files: "glob",
  Glob: "glob",
});

/** Map a host tool name onto the canonical built-in name. */
export function canonicalToolID(toolID) {
  if (typeof toolID !== "string" || toolID.length === 0) return "";
  // Own-property check: `TOOL_ALIASES["constructor"]` would otherwise resolve
  // through the prototype chain and return a function.
  return Object.hasOwn(TOOL_ALIASES, toolID) ? TOOL_ALIASES[toolID] : toolID;
}

export const SLIM_EDIT_STRATEGIES = Object.freeze([
  "toolDescriptions",
  "compactRead",
  "lineRangeEdit",
]);

export const DEFAULT_SLIM_EDIT = Object.freeze({
  enabled: true,
  preview: null,
  toolDescriptions: true,
  compactRead: true,
  lineRangeEdit: true,
});

const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/;

function skip(stats, reason) {
  stats.skippedReasons[reason] = (stats.skippedReasons[reason] ?? 0) + 1;
}

/** One strategy's funnel counters, in the shape token-usage.js summarizes. */
export function createSlimStats({ enabled = true, preview = false } = {}) {
  return {
    enabled,
    preview,
    recordsTotal: 0,
    eligibleCount: 0,
    candidateCount: 0,
    markedCount: 0,
    changedCount: 0,
    tokenSavingsEstimated: 0,
    tokenSavingsEstimatedIfApplied: 0,
    outputBytesRemovedActual: 0,
    // Tool-description text actually rewritten in this round, in estimated
    // tokens. `before - after` equals `tokenSavingsEstimated`, but reporting
    // both sides lets the usage record show a schema-side delta instead of an
    // unsourced saving (the message-array context delta cannot see them).
    descriptionTokensBefore: 0,
    descriptionTokensAfter: 0,
    skippedReasons: {},
  };
}

/**
 * Per-plugin state. `enabled`/`preview` are resolved once from config; the
 * counters are mutable and accumulate until the next usage record is written.
 */
export function createSlimEditState(config = DEFAULT_SLIM_EDIT) {
  const enabled = config?.enabled !== false;
  const preview = config?.preview === true;
  return {
    /**
     * Tool ids whose description was already charged to the current round.
     * `tool.definition` carries no request id, so the round itself — every
     * definition emitted before the next transform — is the only boundary the
     * plugin can observe. Reset with the definitions bucket.
     */
    seenToolIDs: new Set(),
    toolDescriptions: createSlimStats({
      enabled: enabled && config?.toolDescriptions !== false,
      preview,
    }),
    compactRead: createSlimStats({
      enabled: enabled && config?.compactRead !== false,
      preview,
    }),
    lineRangeEdit: createSlimStats({
      enabled: enabled && config?.lineRangeEdit !== false,
      preview,
    }),
  };
}

/** Add `source` counters into `target`; used to attach definition savings. */
export function mergeSlimStats(target, source) {
  if (!target || !source) return target;
  for (const key of SLIM_EDIT_STRATEGIES) {
    const from = source[key];
    const to = target[key];
    if (!from || !to) continue;
    to.recordsTotal += from.recordsTotal;
    to.eligibleCount += from.eligibleCount;
    to.candidateCount += from.candidateCount;
    to.markedCount += from.markedCount;
    to.changedCount += from.changedCount;
    to.tokenSavingsEstimated += from.tokenSavingsEstimated;
    to.tokenSavingsEstimatedIfApplied += from.tokenSavingsEstimatedIfApplied;
    to.outputBytesRemovedActual += from.outputBytesRemovedActual;
    to.descriptionTokensBefore = (to.descriptionTokensBefore ?? 0) + (from.descriptionTokensBefore ?? 0);
    to.descriptionTokensAfter = (to.descriptionTokensAfter ?? 0) + (from.descriptionTokensAfter ?? 0);
    for (const [reason, count] of Object.entries(from.skippedReasons ?? {})) {
      to.skippedReasons[reason] = (to.skippedReasons[reason] ?? 0) + count;
    }
  }
  return target;
}

/** True when any strategy observed activity (even a skipped call). */
export function hasSlimActivity(state) {
  if (!state || typeof state !== "object") return false;
  return SLIM_EDIT_STRATEGIES.some((key) => {
    const stats = state[key];
    return stats && stats.recordsTotal > 0;
  });
}

/**
 * Bounded per-session store plus one process-wide definitions bucket.
 * `tool.definition` has no session id, so its saving is attached to the next
 * transform and then to that session's usage record.
 */
export function createSlimEditStore(config = DEFAULT_SLIM_EDIT, options = {}) {
  const maxSessions = Number.isInteger(options.maxSessions) ? options.maxSessions : 64;
  const sessions = new Map();
  let definitions = createSlimEditState(config);

  function session(sessionID) {
    const key = typeof sessionID === "string" && sessionID.length > 0 ? sessionID : "__anonymous__";
    let state = sessions.get(key);
    if (!state) {
      state = createSlimEditState(config);
      sessions.set(key, state);
      while (sessions.size > maxSessions) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
    }
    return state;
  }

  return {
    definitions() {
      return definitions;
    },
    resetDefinitions() {
      definitions = createSlimEditState(config);
    },
    session,
    takeSession(sessionID) {
      const key = typeof sessionID === "string" && sessionID.length > 0 ? sessionID : "__anonymous__";
      const state = sessions.get(key) ?? createSlimEditState(config);
      sessions.delete(key);
      return state;
    },
  };
}

/**
 * Replace a verbose tool description. The model-facing schema is rebuilt for
 * every request, so this saving repeats per request rather than per session.
 *
 * A request may emit the same definition more than once before it is sent (the
 * runtime rebuilds the schema). The rewrite is still applied to every copy —
 * otherwise the verbose text could reach the model — but the saving is charged
 * once per `(round, toolID)`; later copies are recorded as
 * `duplicate_definition` so the funnel still balances.
 */
export function slimToolDefinition(input, output, state, config = DEFAULT_SLIM_EDIT) {
  const stats = state.toolDescriptions;
  stats.recordsTotal += 1;

  if (!config.enabled || !config.toolDescriptions) {
    skip(stats, "disabled");
    return;
  }
  if (!output || typeof output.description !== "string") {
    skip(stats, "missing_description");
    return;
  }
  const toolID = canonicalToolID(input?.toolID);
  const slim = DEFAULT_SLIM_TOOL_DESCRIPTIONS[toolID];
  if (typeof slim !== "string") {
    skip(stats, "unsupported_tool");
    return;
  }

  const seen = state.seenToolIDs;
  if (seen instanceof Set && seen.has(toolID)) {
    if (!config.preview) {
      try {
        output.description = slim;
      } catch {
        // Best-effort: accounting never turns a failed rewrite into an error.
      }
    }
    skip(stats, "duplicate_definition");
    return;
  }

  stats.eligibleCount += 1;
  if (output.description === slim) {
    skip(stats, "already_slim");
    return;
  }

  const beforeTokens = estimateTokens(output.description);
  const afterTokens = estimateTokens(slim);
  stats.candidateCount += 1;
  const saved = beforeTokens - afterTokens;
  if (saved <= 0) {
    skip(stats, "no_positive_savings");
    return;
  }
  if (seen instanceof Set) seen.add(toolID);
  stats.markedCount += 1;
  stats.tokenSavingsEstimatedIfApplied += saved;

  if (config.preview) {
    skip(stats, "preview");
    return;
  }
  try {
    output.description = slim;
  } catch {
    skip(stats, "output_read_only");
    return;
  }
  stats.changedCount += 1;
  stats.tokenSavingsEstimated += saved;
  stats.descriptionTokensBefore += beforeTokens;
  stats.descriptionTokensAfter += afterTokens;
}

/**
 * Estimated tokens of the tool-description text touched by the definition
 * round, or null when nothing was rewritten. Only `description` is visible to
 * the hook; `parameters` and the rest of the schema are not measured.
 */
export function slimDescriptionEstimates(state) {
  const stats = state?.toolDescriptions;
  if (!stats || !(stats.descriptionTokensBefore > 0)) return null;
  return { before: stats.descriptionTokensBefore, after: stats.descriptionTokensAfter };
}

/**
 * Compact one `read` result. Path shortening is lexically relative to the
 * project directory; no file-system probe is performed.
 */
export function compactReadOutput(directory, input, output, state, config = DEFAULT_SLIM_EDIT) {
  const stats = state.compactRead;
  stats.recordsTotal += 1;

  if (!config.enabled || !config.compactRead) {
    skip(stats, "disabled");
    return;
  }
  if (canonicalToolID(input?.tool) !== "read") {
    skip(stats, "unsupported_tool");
    return;
  }
  if (!output || typeof output.output !== "string") {
    skip(stats, "missing_output");
    return;
  }
  if (output.output.includes("<type>directory</type>")) {
    skip(stats, "directory");
    return;
  }

  const pathMatch = output.output.match(/<path>(.+?)<\/path>/);
  if (!pathMatch) {
    skip(stats, "unparsed_output");
    return;
  }
  stats.eligibleCount += 1;

  const before = output.output;
  const rawPath = pathMatch[1];
  let relative;
  try {
    // `read` normally reports an absolute path, but a relative one must be
    // resolved against the project before computing the relative form.
    const absolute = path.isAbsolute(rawPath)
      ? path.normalize(rawPath)
      : path.resolve(directory, rawPath);
    relative = path.relative(directory, absolute);
  } catch {
    skip(stats, "path_normalize_failed");
    return;
  }
  if (!relative) {
    skip(stats, "empty_relative_path");
    return;
  }

  // Rewrite every `<path>` occurrence. A multi-file read echoes one tag per
  // file, and replacing only the first value left the other absolute paths in
  // place (defeating the point of compaction).
  let text = before.replace(/<path>([^<]*)<\/path>/g, (match, raw) => {
    try {
      const absolute = path.isAbsolute(raw)
        ? path.normalize(raw)
        : path.resolve(directory, raw);
      const relativePath = path.relative(directory, absolute);
      return relativePath ? `<path>${relativePath}</path>` : match;
    } catch {
      return match;
    }
  });
  text = text.replace("<type>file</type>\n", "");
  // The `(End of file - total N lines)` footer is deliberately kept: Supersede
  // Writes uses it as its end-of-file proof (`inspectRead`), so stripping it
  // here would silently disqualify every compacted read as a superseder on
  // hosts that report no structured `truncated`/`display` metadata.

  if (text === before) {
    skip(stats, "no_change");
    return;
  }
  stats.candidateCount += 1;

  const saved = estimateTokens(before) - estimateTokens(text);
  if (text.length >= before.length || saved <= 0) {
    // A relative path can be longer when the file lives outside the project;
    // never trade a larger prompt for a cosmetic path change.
    skip(stats, "no_positive_savings");
    return;
  }
  stats.markedCount += 1;
  stats.tokenSavingsEstimatedIfApplied += saved;

  if (config.preview) {
    skip(stats, "preview");
    return;
  }
  try {
    output.output = text;
  } catch {
    skip(stats, "output_read_only");
    return;
  }
  stats.changedCount += 1;
  stats.tokenSavingsEstimated += saved;
  stats.outputBytesRemovedActual += byteLength(before) - byteLength(text);
}

/**
 * Expand `oldString: "55-64"` into the exact lines before the edit tool runs.
 * Literal matches win: a file that really contains "55-64" is never rewritten.
 */
export function expandLineRangeEdit(
  directory,
  input,
  output,
  state,
  config = DEFAULT_SLIM_EDIT,
  options = {},
) {
  const stats = state.lineRangeEdit;
  stats.recordsTotal += 1;

  if (!config.enabled || !config.lineRangeEdit) {
    skip(stats, "disabled");
    return;
  }
  if (input?.tool !== "edit") {
    skip(stats, "unsupported_tool");
    return;
  }
  const args = output && typeof output.args === "object" ? output.args : null;
  if (!args) {
    skip(stats, "missing_args");
    return;
  }
  if (typeof args.oldString !== "string" || args.oldString.length === 0) {
    skip(stats, "missing_old_string");
    return;
  }
  if (typeof args.filePath !== "string" || args.filePath.length === 0) {
    skip(stats, "missing_file_path");
    return;
  }
  stats.eligibleCount += 1;

  const match = args.oldString.trim().match(LINE_RANGE_RE);
  if (!match) {
    skip(stats, "not_line_range");
    return;
  }

  const readFileSync = typeof options.readFileSync === "function" ? options.readFileSync : fs.readFileSync;
  const filePath = path.isAbsolute(args.filePath)
    ? path.normalize(args.filePath)
    : path.resolve(directory, args.filePath);

  let content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    skip(stats, "file_unreadable");
    return;
  }
  if (typeof content !== "string") {
    skip(stats, "file_unreadable");
    return;
  }
  // A literal oldString is authoritative and must not be replaced by a range.
  if (content.includes(args.oldString)) {
    skip(stats, "literal_match");
    return;
  }

  const lines = content.split("\n");
  const startLine = parseInt(match[1], 10);
  const endLine = match[2] ? parseInt(match[2], 10) : startLine;
  if (!(startLine >= 1 && endLine <= lines.length && startLine <= endLine)) {
    skip(stats, "range_out_of_bounds");
    return;
  }

  const expanded = lines.slice(startLine - 1, endLine).join("\n");
  if (expanded.length === 0) {
    skip(stats, "empty_range");
    return;
  }
  stats.candidateCount += 1;

  const saved = estimateTokens(expanded) - estimateTokens(args.oldString);
  if (saved > 0) stats.tokenSavingsEstimatedIfApplied += saved;
  stats.markedCount += 1;

  if (config.preview) {
    skip(stats, "preview");
    return;
  }
  try {
    args.oldString = expanded;
  } catch {
    skip(stats, "args_read_only");
    return;
  }
  stats.changedCount += 1;
  if (saved > 0) stats.tokenSavingsEstimated += saved;
}
