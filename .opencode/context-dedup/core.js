/**
 * Host-neutral deduplication core.
 *
 * This module deliberately knows nothing about OpenCode hooks, sessions, or
 * message shapes. It receives normalized tool records and returns prune
 * decisions plus aggregate statistics. Keeping it host-neutral makes the
 * rules independently testable and reusable by another adapter.
 *
 * Safety policy (v1):
 * - only explicitly whitelisted read-only tools are considered;
 * - only successful, completed, non-empty, non-placeholder outputs;
 * - an older output is pruned only when a newer call has the same tool,
 *   canonical arguments, execution environment, AND byte-identical output;
 * - a non-whitelisted tool call between the two observations is treated as a
 *   dependency barrier;
 * - records whose tool or file path matches the user's protection rules are
 *   never pruned (same guard as the reference implementation);
 * - call-ID references are checked by the adapter because only it can see the
 *   surrounding message text.
 */

export const PRUNE_MARKER = "[vibe-context-dedup]";

export const DEFAULT_PLACEHOLDER =
  `${PRUNE_MARKER} Duplicate read-only tool result omitted; ` +
  "an identical newer result is retained later in the conversation.";

/** Read-only OpenCode built-ins verified from the Tools documentation. */
export const DEFAULT_READ_ONLY_TOOLS = Object.freeze(["read", "grep", "glob"]);

/**
 * Tools that are known to mutate state. They are barriers even if a user
 * accidentally adds them to the read-only whitelist.
 */
export const DEFAULT_MUTATION_TOOLS = Object.freeze([
  "bash",
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
  "task",
  "skill",
  "webfetch",
  "websearch",
  "todowrite",
  "question",
]);

export const TOKEN_COUNTING = "estimate_heuristic_v1";

const PATH_KEYS = new Set(["filePath", "path", "cwd", "directory", "dir", "root", "worktree"]);

/**
 * Tool-specific UI-only arguments that must not split operation identity.
 * OpenCode's bash tool carries a human `description`; retries often change it
 * while the command itself stays identical.
 */
const NON_SEMANTIC_ARGS = Object.freeze({
  bash: Object.freeze(["description"]),
});
const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
// Buffer.byteLength computes UTF-8 length without allocating a Uint8Array.
// TextEncoder.encode (the browser fallback) allocates a buffer the size of the
// string, which is wasteful for multi-megabyte tool payloads.
const nodeByteLength =
  typeof Buffer === "function" && typeof Buffer.byteLength === "function"
    ? (text) => Buffer.byteLength(text, "utf8")
    : null;

/**
 * @typedef {Object} ToolRecord
 * @property {string} id Stable call id (OpenCode: ToolPart.callID).
 * @property {number} order Monotonic position in the request.
 * @property {string} tool Tool name.
 * @property {Record<string, unknown>} args Raw tool input.
 * @property {{cwd: string, root?: string}} env Execution environment.
 * @property {string} status Tool status.
 * @property {string} output Raw tool output.
 */

/**
 * @typedef {Object} DedupDecision
 * @property {string} id Older call id to prune.
 * @property {string} keeperId Newer call id whose identical output is kept.
 * @property {string} tool Tool name.
 * @property {number} order Older call order.
 * @property {number} keeperOrder Newer call order.
 * @property {number} estimatedTokensSaved Estimated savings for this decision.
 */

/**
 * @typedef {Object} DedupStats
 * @property {boolean} enabled
 * @property {boolean} preview
 * @property {number} recordsTotal
 * @property {number} candidateCount Eligible records (pass every safety filter)
 * @property {number} eligibleCount Alias of candidateCount for the funnel
 * @property {number} duplicateGroupCount Groups of >=2 byte-identical outputs
 * @property {number} duplicateCandidateCount Records inside those groups
 * @property {number} uniqueSignatureCount Eligible records with a unique signature
 * @property {number} sameSignatureDifferentOutputCount Eligible records whose
 *   signature matches another call but whose output differs
 * @property {number} sameSignatureDifferentOutputGroups
 * @property {number} markedCount Decisions produced by the planner
 * @property {number} plannedPruneCount
 * @property {number} wouldPruneCount
 * @property {number} prunedCount
 * @property {Record<string, number>} skippedReasons
 * @property {number} tokenSavingsEstimated
 * @property {number} tokenSavingsEstimatedIfApplied
 * @property {string} tokenCounting
 * @property {null} actualTokenSavings
 * @property {number} outputBytesRemovedActual
 * @property {number|null} durationMs
 * @property {boolean} changed
 */

/** @returns {DedupStats} */
export function createStats() {
  return {
    enabled: true,
    preview: false,
    recordsTotal: 0,
    candidateCount: 0,
    eligibleCount: 0,
    duplicateGroupCount: 0,
    duplicateCandidateCount: 0,
    uniqueSignatureCount: 0,
    sameSignatureDifferentOutputCount: 0,
    sameSignatureDifferentOutputGroups: 0,
    markedCount: 0,
    plannedPruneCount: 0,
    wouldPruneCount: 0,
    prunedCount: 0,
    skippedReasons: {},
    tokenSavingsEstimated: 0,
    tokenSavingsEstimatedIfApplied: 0,
    tokenCounting: TOKEN_COUNTING,
    actualTokenSavings: null,
    outputBytesRemovedActual: 0,
    durationMs: null,
    changed: false,
  };
}

export function isPrunedOutput(output) {
  return typeof output === "string" && output.startsWith(PRUNE_MARKER);
}

// Provisional weights: ASCII ~4 chars/token, non-ASCII ~1 token/code point.
const ASCII_WEIGHT = 0.25;
const NON_ASCII_WEIGHT = 1;

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

/**
 * Weighted, unrounded token estimate units for one string.
 *
 * Iterates UTF-16 code units with explicit surrogate-pair handling, which is
 * arithmetically identical to code-point iteration (one weight per Unicode
 * code point) but roughly 3x faster than `for (const char of text)` because it
 * allocates no string iterator. Lone surrogates still count once.
 */
export function textTokenUnits(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let units = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      units += ASCII_WEIGHT;
      continue;
    }
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      const next = text.charCodeAt(index + 1);
      if (next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END) index += 1;
    }
    units += NON_ASCII_WEIGHT;
  }
  return units;
}

/** Unicode code points (a surrogate pair counts once). */
export function countCodePoints(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      const next = text.charCodeAt(index + 1);
      if (next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END) index += 1;
    }
    count += 1;
  }
  return count;
}

/**
 * Conservative token estimate. This is not a real tokenizer.
 * ASCII text is counted as ~4 chars/token; non-ASCII is counted as ~1
 * char/token. Callers must label the result as an estimate.
 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(textTokenUnits(text));
}

export function byteLength(text) {
  if (typeof text !== "string") return 0;
  if (nodeByteLength) return nodeByteLength(text);
  if (textEncoder) return textEncoder.encode(text).length;
  return text.length;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Lexically normalize a path without touching the filesystem or resolving
 * symlinks. This is intentionally conservative: equal strings remain equal,
 * relative and absolute forms of the same path can match, but different case
 * or symlink targets are not guessed.
 */
export function normalizePath(value, base) {
  if (typeof value !== "string" || value.length === 0) return value;
  let pathText = value.replace(/\\/g, "/");
  const unc = pathText.startsWith("//");
  const driveMatch = /^([A-Za-z]:)(?:\/|$)/.exec(pathText);
  const drive = driveMatch ? driveMatch[1] : "";
  if (drive) pathText = pathText.slice(drive.length);

  if (!pathText.startsWith("/") && typeof base === "string" && base.length > 0) {
    pathText = `${base.replace(/\\/g, "/").replace(/\/+$/, "")}/${pathText}`;
  }

  const absolute = pathText.startsWith("/");
  const segments = pathText.split("/");
  const out = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(segment);
    }
  }

  const joined = out.join("/");
  if (drive) return `${drive}/${joined}`;
  if (unc) return `//${joined}`;
  return absolute ? `/${joined}` : joined || ".";
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/;

function escapeRegExpChar(character) {
  return REGEXP_SPECIALS.test(character) ? `\\${character}` : character;
}

/**
 * Match a path against a shell-style glob. Supports `**`, `*` and `?`:
 * - `**` (optionally followed by `/`) spans zero or more directories;
 * - `*` matches within one segment; `?` matches one non-separator character.
 * Both sides are path-normalized (backslashes become `/`). Invalid patterns
 * fail closed (no match) instead of throwing.
 */
export function matchesGlob(inputPath, pattern) {
  if (typeof inputPath !== "string" || typeof pattern !== "string" || pattern.length === 0) {
    return false;
  }
  const input = inputPath.replace(/\\/g, "/");
  const glob = pattern.replace(/\\/g, "/");
  let regex = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
        continue;
      }
      regex += "[^/]*";
      continue;
    }
    if (character === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegExpChar(character);
  }
  regex += "$";
  try {
    return new RegExp(regex).test(input);
  } catch {
    return false;
  }
}

/** Argument keys that carry a file path in the supported tool inputs. */
export const PATH_ARGUMENT_KEYS = Object.freeze([
  "filePath",
  "path",
  "file",
  "filename",
  "fileName",
]);

const PATCH_PATH_PATTERN = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm;

function collectPathArgs(target, value) {
  if (!isPlainObject(value)) return;
  for (const key of PATH_ARGUMENT_KEYS) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim().length > 0) target.push(raw.trim());
  }
}

/**
 * Every file path a tool record refers to, in raw (unresolved) form.
 *
 * Covers the OpenCode and V2 shapes the reference implementation protects:
 * direct `filePath`/`path`, `multiedit`'s nested `edits[]`, `apply_patch`'s
 * `patchText`, and V2 code-mode nested `metadata.toolCalls`.
 */
export function recordFilePaths(record) {
  const paths = [];
  const args = record && isPlainObject(record.args) ? record.args : null;
  if (args) {
    collectPathArgs(paths, args);
    if (Array.isArray(args.edits)) {
      for (const edit of args.edits) collectPathArgs(paths, edit);
    }
    if (
      typeof args.patchText === "string" &&
      (record.tool === "apply_patch" || record.tool === "patch")
    ) {
      PATCH_PATH_PATTERN.lastIndex = 0;
      let match = PATCH_PATH_PATTERN.exec(args.patchText);
      while (match !== null) {
        const value = match[1].trim();
        if (value.length > 0) paths.push(value);
        match = PATCH_PATH_PATTERN.exec(args.patchText);
      }
    }
  }
  const metadata = record && isPlainObject(record.metadata) ? record.metadata : null;
  if (metadata && Array.isArray(metadata.toolCalls)) {
    for (const call of metadata.toolCalls) {
      if (isPlainObject(call)) collectPathArgs(paths, call.input);
    }
  }
  return [...new Set(paths)];
}

function isToolNameProtected(tool, patterns) {
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    if (pattern === tool) return true;
    if (/[*?]/.test(pattern) && matchesGlob(tool, pattern)) return true;
  }
  return false;
}

/**
 * Shared protection guard (parity with the reference implementation's
 * `isToolProtected`): a record the user marked as protected is never pruned by
 * any strategy. Returns the skip-reason key, or "" when the record is prunable.
 *
 * Path matching runs against both the raw argument and the canonical
 * cwd-resolved path, so `src/**` and `/repo/src/**` both work.
 */
export function protectedReason(record, options = {}) {
  if (!record || typeof record !== "object") return "";
  const tool = typeof record.tool === "string" ? record.tool : "";
  const protectedTools = Array.isArray(options.protectedTools) ? options.protectedTools : [];
  if (tool && protectedTools.length > 0 && isToolNameProtected(tool, protectedTools)) {
    return "protected_tool";
  }
  // V2 code mode keeps one combined output for nested calls; protect it when
  // any nested tool matches, mirroring the reference implementation.
  const metadata = isPlainObject(record.metadata) ? record.metadata : null;
  if (protectedTools.length > 0 && metadata && Array.isArray(metadata.toolCalls)) {
    for (const call of metadata.toolCalls) {
      if (
        isPlainObject(call) &&
        typeof call.tool === "string" &&
        isToolNameProtected(call.tool, protectedTools)
      ) {
        return "protected_tool";
      }
    }
  }

  const patterns = Array.isArray(options.protectedFilePatterns)
    ? options.protectedFilePatterns
    : [];
  if (patterns.length === 0) return "";
  const paths = recordFilePaths(record);
  if (paths.length === 0) return "";

  const cwd =
    record.env && typeof record.env.cwd === "string" && record.env.cwd.length > 0
      ? record.env.cwd
      : "";
  const normalizedCwd = cwd ? normalizePath(cwd, null) : "";
  const cwdPrefix = normalizedCwd ? `${normalizedCwd.replace(/\/+$/, "")}/` : "";
  for (const rawPath of paths) {
    const resolved = cwd ? normalizePath(rawPath, cwd) : rawPath;
    const candidates = [rawPath, resolved];
    // Also match project-relative patterns (`src/**`) against absolute paths.
    if (cwdPrefix && resolved.startsWith(cwdPrefix)) {
      candidates.push(resolved.slice(cwdPrefix.length));
    }
    for (const pattern of patterns) {
      if (candidates.some((candidate) => matchesGlob(candidate, pattern))) {
        return "protected_path";
      }
    }
  }
  return "";
}

function canonicalize(value, key, cwd, seen = new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string") {
    return PATH_KEYS.has(key) ? normalizePath(value, cwd) : value;
  }
  if (type === "number") return Number.isFinite(value) ? value : String(value);
  if (type === "boolean") return value;
  if (type === "undefined") return undefined;
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) throw new Error("circular tool arguments");
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map((item) => {
          const normalized = canonicalize(item, key, cwd, seen);
          return normalized === undefined ? null : normalized;
        })
      : (() => {
          const out = Object.create(null);
          for (const childKey of Object.keys(value).sort()) {
            if (value[childKey] === undefined) continue;
            const normalized = canonicalize(value[childKey], childKey, cwd, seen);
            if (normalized !== undefined) out[childKey] = normalized;
          }
          return out;
        })();
    seen.delete(value);
    return result;
  }
  return String(value);
}

export function buildOperationSignature(record) {
  const env = record.env ?? {};
  const cwd = typeof env.cwd === "string" ? env.cwd : "";
  const root = typeof env.root === "string" ? env.root : "";
  const args = canonicalize(record.args, "", cwd) ?? {};
  const ignoredArgs = NON_SEMANTIC_ARGS[record.tool];
  if (ignoredArgs && isPlainObject(args)) {
    for (const key of ignoredArgs) delete args[key];
  }
  const argsJson = JSON.stringify(args);
  const argCwd =
    isPlainObject(record.args) && typeof record.args.cwd === "string"
      ? normalizePath(record.args.cwd, cwd)
      : "";
  return [
    record.tool,
    argsJson,
    normalizePath(cwd, null),
    normalizePath(root, null),
    argCwd,
  ].join("\u0000");
}

/**
 * Does any order in a sorted array fall strictly inside (lower, upper)?
 * Used by all strategies to answer barrier/supersession range questions in
 * O(log n) instead of rescanning the whole record list per pair.
 */
export function hasOrderInRange(sortedOrders, lowerExclusive, upperExclusive) {
  let low = 0;
  let high = sortedOrders.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sortedOrders[mid] <= lowerExclusive) low = mid + 1;
    else high = mid;
  }
  return low < sortedOrders.length && sortedOrders[low] < upperExclusive;
}

function normalizeOptions(config = {}) {
  const enabled = config.enabled !== false;
  const rawTools = Array.isArray(config.tools) ? config.tools : DEFAULT_READ_ONLY_TOOLS;
  const tools = rawTools
    .filter((tool) => typeof tool === "string" && tool.trim().length > 0)
    .map((tool) => tool.trim());
  const toolSet = new Set(tools);
  const rawMutationTools = Array.isArray(config.mutationTools)
    ? config.mutationTools
    : DEFAULT_MUTATION_TOOLS;
  const mutationTools = new Set(
    rawMutationTools
      .filter((tool) => typeof tool === "string" && tool.trim().length > 0)
      .map((tool) => tool.trim()),
  );
  const placeholder =
    typeof config.placeholder === "string" && config.placeholder.startsWith(PRUNE_MARKER)
      ? config.placeholder
      : DEFAULT_PLACEHOLDER;
  const protectedTools = Array.isArray(config.protectedTools)
    ? config.protectedTools.filter((tool) => typeof tool === "string" && tool.trim().length > 0)
    : [];
  const protectedFilePatterns = Array.isArray(config.protectedFilePatterns)
    ? config.protectedFilePatterns.filter(
        (pattern) => typeof pattern === "string" && pattern.trim().length > 0,
      )
    : [];
  return {
    enabled,
    toolSet,
    mutationTools,
    placeholder,
    barrierOnNonWhitelistedTools: config.barrierOnNonWhitelistedTools !== false,
    protectedTools,
    protectedFilePatterns,
  };
}

function keeperTokens(entry) {
  if (entry.estimatedTokens === undefined) {
    entry.estimatedTokens = estimateTokens(entry.output);
  }
  return entry.estimatedTokens;
}

/**
 * Cheap "same target" key for near-miss diagnostics: tool name plus the first
 * explicit path argument. Unlike `buildOperationSignature` it ignores the rest
 * of the arguments, so two windowed reads of the same file compare equal even
 * when the runtime stamped different `offset`/`limit` values.
 */
function targetKeyOf(record) {
  const args = record && isPlainObject(record.args) ? record.args : null;
  if (!args) return "";
  for (const key of PATH_ARGUMENT_KEYS) {
    const raw = args[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      const cwd =
        record.env && typeof record.env.cwd === "string" ? record.env.cwd : "";
      return `${record.tool}\u0000${normalizePath(raw.trim(), cwd)}`;
    }
  }
  return "";
}

function increment(map, key, amount = 1) {
  if (!key || amount <= 0) return;
  map[key] = (map[key] ?? 0) + amount;
}

/**
 * Pure rule engine.
 *
 * @param {ToolRecord[]} records
 * @param {Record<string, unknown>} [config]
 * @returns {{ decisions: DedupDecision[], stats: DedupStats }}
 */
export function planDeduplication(records, config = {}) {
  config = config ?? {};
  const options = normalizeOptions(config);
  const stats = createStats();
  stats.enabled = options.enabled;

  if (!Array.isArray(records)) {
    increment(stats.skippedReasons, "invalid_input");
    return { decisions: [], stats };
  }

  stats.recordsTotal = records.length;
  if (!options.enabled) {
    increment(stats.skippedReasons, "disabled", records.length);
    return { decisions: [], stats };
  }

  // Barrier timeline is independent of the duplicate pair, so build it once.
  // A mutation tool, or any non-whitelisted tool when that guard is enabled,
  // blocks every duplicate group that spans it.
  const barrierOrders = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (!Number.isFinite(record.order)) continue;
    if (options.mutationTools.has(record.tool)) {
      barrierOrders.push(record.order);
      continue;
    }
    if (options.barrierOnNonWhitelistedTools && !options.toolSet.has(record.tool)) {
      barrierOrders.push(record.order);
    }
  }
  barrierOrders.sort((left, right) => left - right);

  const eligible = [];
  const seenIds = new Set();

  for (const record of records) {
    if (!record || typeof record !== "object") {
      increment(stats.skippedReasons, "invalid_record");
      continue;
    }
    if (typeof record.id !== "string" || record.id.length === 0) {
      increment(stats.skippedReasons, "invalid_call_id");
      continue;
    }
    if (
      typeof record.tool !== "string" ||
      !options.toolSet.has(record.tool) ||
      options.mutationTools.has(record.tool)
    ) {
      increment(stats.skippedReasons, "unsupported_tool");
      continue;
    }
    if (record.status !== "completed") {
      increment(stats.skippedReasons, "not_completed");
      continue;
    }
    if (typeof record.output !== "string" || record.output.length === 0) {
      increment(stats.skippedReasons, "empty_output");
      continue;
    }
    if (isPrunedOutput(record.output)) {
      increment(stats.skippedReasons, "already_pruned");
      continue;
    }
    if (!isPlainObject(record.args)) {
      increment(stats.skippedReasons, "invalid_args");
      continue;
    }
    if (
      !record.env ||
      typeof record.env.cwd !== "string" ||
      record.env.cwd.length === 0
    ) {
      increment(stats.skippedReasons, "missing_environment");
      continue;
    }
    if (!Number.isFinite(record.order)) {
      increment(stats.skippedReasons, "invalid_order");
      continue;
    }
    if (seenIds.has(record.id)) {
      increment(stats.skippedReasons, "duplicate_call_id");
      continue;
    }
    seenIds.add(record.id);

    const protectReason = protectedReason(record, options);
    if (protectReason) {
      increment(stats.skippedReasons, protectReason);
      continue;
    }

    let signature;
    try {
      signature = buildOperationSignature(record);
    } catch {
      increment(stats.skippedReasons, "invalid_args");
      continue;
    }

    // Token estimation is deferred: only records inside a duplicate group need
    // it (37 of 120 eligible records in the long fixture), and unique outputs
    // are common in long conversations.
    eligible.push({
      record,
      signature,
      output: record.output,
      order: record.order,
      estimatedTokens: undefined,
    });
  }

  stats.candidateCount = eligible.length;
  stats.eligibleCount = eligible.length;

  const bySignature = new Map();
  for (const entry of eligible) {
    const group = bySignature.get(entry.signature);
    if (group) group.push(entry);
    else bySignature.set(entry.signature, [entry]);
  }

  const decisions = [];
  const uniqueEntries = [];
  const placeholderTokens = estimateTokens(options.placeholder);
  for (const signatureGroup of bySignature.values()) {
    // Classify every eligible record so zero contribution is explainable:
    // a unique signature has nothing to deduplicate, and a matching signature
    // with a different output cannot be deduplicated without changing meaning.
    if (signatureGroup.length === 1) {
      stats.uniqueSignatureCount += 1;
      uniqueEntries.push(signatureGroup[0]);
      continue;
    }

    const distinctOutputs = new Set(signatureGroup.map((entry) => entry.output));
    if (distinctOutputs.size > 1) stats.sameSignatureDifferentOutputGroups += 1;

    const byOutput = new Map();
    for (const entry of signatureGroup) {
      const group = byOutput.get(entry.output);
      if (group) group.push(entry);
      else byOutput.set(entry.output, [entry]);
    }

    for (const outputGroup of byOutput.values()) {
      if (outputGroup.length < 2) {
        stats.sameSignatureDifferentOutputCount += outputGroup.length;
        increment(stats.skippedReasons, "same_signature_different_output", outputGroup.length);
        continue;
      }
      stats.duplicateGroupCount += 1;
      stats.duplicateCandidateCount += outputGroup.length;
      outputGroup.sort((left, right) => left.order - right.order);

      let keeper = outputGroup[0];
      for (let index = 1; index < outputGroup.length; index += 1) {
        const next = outputGroup[index];
        if (hasOrderInRange(barrierOrders, keeper.order, next.order)) {
          increment(stats.skippedReasons, "intervening_side_effect");
          keeper = next;
          continue;
        }

        const estimatedTokensSaved = keeperTokens(keeper) - placeholderTokens;
        if (estimatedTokensSaved <= 0) {
          increment(stats.skippedReasons, "no_token_benefit");
          keeper = next;
          continue;
        }
        decisions.push({
          id: keeper.record.id,
          keeperId: next.record.id,
          tool: keeper.record.tool,
          order: keeper.record.order,
          keeperOrder: next.record.order,
          estimatedTokensSaved,
        });
        keeper = next;
      }
    }
  }

  decisions.sort((left, right) => left.order - right.order);
  stats.markedCount = decisions.length;

  // Near-miss diagnostics for unique signatures: records that point at the
  // same target (tool + explicit path) but still have different canonical
  // arguments. This is the common "read the same file four times" case, where
  // a windowed `offset`/`limit` changes the signature and byte equality can
  // never hold.
  if (uniqueEntries.length > 0) {
    const byTarget = new Map();
    for (const entry of uniqueEntries) {
      const key = targetKeyOf(entry.record);
      if (!key) {
        increment(stats.skippedReasons, "unique_signature");
        continue;
      }
      const group = byTarget.get(key);
      if (group) group.push(entry);
      else byTarget.set(key, [entry]);
    }
    for (const group of byTarget.values()) {
      increment(
        stats.skippedReasons,
        group.length > 1 ? "same_target_args_changed" : "unique_signature",
        group.length,
      );
    }
  }

  stats.prunableCount = stats.duplicateCandidateCount;
  stats.plannedPruneCount = decisions.length;
  stats.tokenSavingsEstimated = decisions.reduce(
    (total, decision) => total + decision.estimatedTokensSaved,
    0,
  );
  return { decisions, stats };
}
