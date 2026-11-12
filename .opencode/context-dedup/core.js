/**
 * Host-neutral deduplication core.
 *
 * This module deliberately knows nothing about OpenCode hooks, sessions, or
 * message shapes. It receives normalized tool records and returns prune
 * decisions plus aggregate statistics. Keeping it host-neutral makes the
 * rules independently testable and reusable by another adapter.
 *
 * Safety policy (v2):
 * - only tools in the deduplication whitelist are considered (read-only
 *   built-ins plus shell); the adapter passes the resolved list;
 * - only successful, completed, non-empty, non-placeholder outputs;
 * - failed shell calls (non-zero exit in metadata) are never candidates,
 *   because their output is the failure evidence;
 * - an older output is pruned only when a newer call has the same tool,
 *   canonical arguments, execution environment, AND byte-identical output;
 *   identical output proves the observable result did not change, so no
 *   intervening-call barrier is needed;
 * - records whose tool or file path matches the user's protection rules are
 *   never pruned (same guard as the reference implementation);
 * - call-ID references are checked by the adapter because only it can see the
 *   surrounding message text.
 */

export const PRUNE_MARKER = "[vibe-context-dedup]";

export const DEFAULT_PLACEHOLDER =
  `${PRUNE_MARKER} Duplicate tool result omitted; ` +
  "an identical newer result is retained later in the conversation.";

/** Read-only OpenCode built-ins verified from the Tools documentation. */
export const DEFAULT_READ_ONLY_TOOLS = Object.freeze(["read", "grep", "glob"]);

/**
 * Deduplication scope. Shell output is eligible too: two calls with identical
 * arguments and byte-identical output carry the same information, so pruning
 * the older result is lossless. Failed shell calls are excluded separately by
 * the metadata failure check below.
 */
export const DEFAULT_DEDUP_TOOLS = Object.freeze([
  ...DEFAULT_READ_ONLY_TOOLS,
  "bash",
]);

/**
 * Shell tools whose exit status (not the output text) decides success.
 * Only used by deduplication to exclude failed calls; error-purge owns the
 * full failure classification.
 */
export const DEFAULT_SHELL_TOOLS = Object.freeze(["bash"]);

/**
 * Tools that are known to mutate state. Kept for Error Purge, where a state
 * change between a failure and a later success invalidates the supersession,
 * and to keep shell/orchestration tools out of the read-only set.
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

/** Tools whose input carries written file content (shared by error-purge and supersede-writes). */
export const DEFAULT_WRITE_TOOLS = Object.freeze([
  "write",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
]);

export const TOKEN_COUNTING = "estimate_heuristic_v1";

/**
 * Rules revision stamped into every JSONL record. It makes "is the running
 * plugin the code I just edited?" answerable from the log alone, instead of
 * inferring it from an all-zero counter.
 */
export const DEDUP_RULES_REVISION = "2026-11-12.3";

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
    // Windowed reads of one file: a later read whose line range strictly covers
    // an earlier one makes the earlier result redundant (same file, no
    // intervening mutation).
    readWindowCandidateCount: 0,
    readWindowCollapseCount: 0,
    /** Top repeated targets (bounded): drives the next optimization decision. */
    repeatedTargets: [],
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
 * Every file path a tool record states in its structured arguments, in raw
 * (unresolved) form.
 *
 * Covers the OpenCode and V2 shapes the reference implementation protects:
 * direct `filePath`/`path`, `multiedit`'s nested `edits[]`, `apply_patch`'s
 * `patchText`, and V2 code-mode nested `metadata.toolCalls`.
 *
 * Shell commands are deliberately not parsed: a path quoted inside
 * `bash.command` is not extracted, so `protectedFilePatterns` cannot protect a
 * file that is only touched through `bash` (protect the tool with
 * `protectedTools` instead).
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
  const rawTools = Array.isArray(config.tools) ? config.tools : DEFAULT_DEDUP_TOOLS;
  const tools = rawTools
    .filter((tool) => typeof tool === "string" && tool.trim().length > 0)
    .map((tool) => tool.trim());
  const toolSet = new Set(tools);
  const rawShellTools = Array.isArray(config.shellTools)
    ? config.shellTools
    : DEFAULT_SHELL_TOOLS;
  const shellTools = new Set(
    rawShellTools
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
  const normalizeRead =
    config.normalizeReadOutput === true ||
    config.deduplication?.normalizeReadOutput === true;
  const collapseReadWindows =
    config.collapseReadWindows === undefined &&
    config.deduplication?.collapseReadWindows === undefined
      ? true
      : config.collapseReadWindows === true ||
        config.deduplication?.collapseReadWindows === true;
  return {
    enabled,
    toolSet,
    shellTools,
    placeholder,
    protectedTools,
    protectedFilePatterns,
    normalizeReadOutput: normalizeRead,
    collapseReadWindows,
  };
}


/** The runtime's own end-of-file notice, emitted only when the read reached EOF. */
const EOF_TOTAL_RE = /\(End of file - total (\d+) lines\)\s*$/;

function eofTotalLines(output) {
  if (typeof output !== "string") return null;
  const match = output.trimEnd().match(EOF_TOTAL_RE);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Highest line number present in the runtime's rendered read output. OpenCode
 * renders `N: <line>`, which is authoritative: it reflects what was actually
 * returned, so a capped read cannot claim lines it never showed. Scanning the
 * tail keeps this O(1) for large files.
 */
function maxLineNumberInOutput(output) {
  if (typeof output !== "string" || output.length === 0) return null;
  const tail = output.length > 200_000 ? output.slice(-200_000) : output;
  const re = /^[ \t]*(\d+): /gm;
  let max = null;
  let match;
  while ((match = re.exec(tail)) !== null) {
    const numeric = Number(match[1]);
    if (Number.isFinite(numeric) && (max === null || numeric > max)) max = numeric;
  }
  return max;
}

/** Does the host claim this read returned less than its window implies? */
function claimsPartialRead(record) {
  const metadata = isPlainObject(record.metadata) ? record.metadata : {};
  if (metadata.partial === true) return true;
  if (metadata.complete === false) return true;
  if (metadata.truncated === true) return true;
  return isPlainObject(metadata.display) && metadata.display.truncated === true;
}

/**
 * Line window covered by a `read` call, or null when it cannot be determined.
 */
function readWindowOf(record) {
  const args = record && isPlainObject(record.args) ? record.args : null;
  if (!args) return null;
  const rawStart = args.offset ?? args.line ?? args.startLine ?? args.from;
  let start = 1;
  if (rawStart !== undefined && rawStart !== null) {
    const numeric = Number(rawStart);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    start = numeric <= 1 ? 1 : numeric;
  }
  const rawLimit = args.limit ?? args.lines ?? args.count ?? args.maxLines;
  // Lines the runtime actually rendered, independent of the requested window.
  const actualEnd = maxLineNumberInOutput(record.output);
  let end;
  if (rawLimit !== undefined && rawLimit !== null) {
    const numeric = Number(rawLimit);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    end = start + numeric - 1;
  } else {
    // No explicit limit: the END-OF-FILE notice or the rendered line numbers
    // prove how far the read reached.
    end = eofTotalLines(record.output) ?? actualEnd;
    if (end === null) return null;
  }
  if (actualEnd !== null) {
    // The rendered range wins: a capped read must not claim lines it never
    // showed, and this keeps the collapse rule safe without trusting a host
    // flag whose meaning differs between hosts.
    end = Math.min(end, actualEnd);
  } else if (claimsPartialRead(record)) {
    // No line numbers and the host says the read is incomplete: the window is
    // unknown, so do not participate.
    return null;
  }
  if (end < start) return null;
  return { start, end };
}

/** Does `later` cover a strictly larger window than `earlier`? */
function windowStrictlyCovers(later, earlier) {
  if (!later || !earlier) return false;
  if (later.start > earlier.start) return false;
  if (later.end < earlier.end) return false;
  // An identical window is handled by byte-identical deduplication; a differing
  // body means the file changed outside the conversation, so keep both.
  return !(later.start === earlier.start && later.end === earlier.end);
}

/**
 * Collapse windowed reads of the same file: when a later read covers a
 * strictly larger line range and nothing mutated in between, the earlier
 * window's content is fully contained in the later one.
 */
function collapseCoveredReads(records, eligible, options, stats, decisions, placeholderTokens) {
  const collapsedIds = new Set();
  const groups = new Map();
  for (const entry of eligible) {
    if (entry.record.tool !== "read") continue;
    const window = readWindowOf(entry.record);
    if (!window) continue;
    const key = targetKeyOf(entry.record);
    if (!key) continue;
    stats.readWindowCandidateCount += 1;
    const list = groups.get(key);
    if (list) list.push({ entry, window });
    else groups.set(key, [{ entry, window }]);
  }
  if (groups.size === 0) return collapsedIds;

  // Reads and other read-only tools cannot change the file; anything else can.
  const mutationOrders = [];
  for (const record of records) {
    if (!record || !Number.isFinite(record.order)) continue;
    if (typeof record.tool !== "string") continue;
    if (DEFAULT_READ_ONLY_TOOLS.includes(record.tool)) continue;
    mutationOrders.push(record.order);
  }
  mutationOrders.sort((left, right) => left - right);

  const decided = new Set(decisions.map((decision) => decision.id));
  for (const group of groups.values()) {
    group.sort((left, right) => left.entry.order - right.entry.order);
    for (let index = 0; index < group.length; index += 1) {
      const earlier = group[index];
      if (decided.has(earlier.entry.record.id)) continue;
      for (let next = index + 1; next < group.length; next += 1) {
        const later = group[next];
        if (!windowStrictlyCovers(later.window, earlier.window)) continue;
        if (hasOrderInRange(mutationOrders, earlier.entry.order, later.entry.order)) continue;
        const estimatedTokensSaved = keeperTokens(earlier.entry) - placeholderTokens;
        if (estimatedTokensSaved <= 0) break;
        decisions.push({
          id: earlier.entry.record.id,
          keeperId: later.entry.record.id,
          tool: earlier.entry.record.tool,
          order: earlier.entry.order,
          keeperOrder: later.entry.order,
          kind: "read_window_subsumed",
          estimatedTokensSaved,
        });
        decided.add(earlier.entry.record.id);
        collapsedIds.add(earlier.entry.record.id);
        stats.readWindowCollapseCount += 1;
        break;
      }
    }
  }
  return collapsedIds;
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

export function increment(map, key, amount = 1) {
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

  // Earlier outputs are pruned only when a newer call has the same tool,
  // canonical arguments, environment, AND byte-identical output. Identical
  // output proves the observable result did not change, so a tool call in
  // between cannot invalidate the duplicate pair; references to the old call
  // id are guarded separately by the adapter (`protectCallIdReferences`).
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
    if (typeof record.tool !== "string" || !options.toolSet.has(record.tool)) {
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
    // A failed shell call's output is the failure evidence, not a duplicate
    // read of otherwise-available data. Keep it until Error Purge decides.
    if (options.shellTools.has(record.tool) && hasFailureMetadata(record.metadata)) {
      increment(stats.skippedReasons, "shell_failure");
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
  // Targets that were read several times with a changed body (file edited in
  // between). They never reach `uniqueEntries`, yet they are the most valuable
  // optimization signal, so they are aggregated below.
  const sameSignatureTargets = [];
  const placeholderTokens = estimateTokens(options.placeholder);
  const outputKey = (entry) => {
    if (options.normalizeReadOutput && entry.record?.tool === "read") {
      return normalizeReadOutput(entry.output);
    }
    return entry.output;
  };

  for (const signatureGroup of bySignature.values()) {
    // Classify every eligible record so zero contribution is explainable:
    // a unique signature has nothing to deduplicate, and a matching signature
    // with a different output cannot be deduplicated without changing meaning.
    if (signatureGroup.length === 1) {
      stats.uniqueSignatureCount += 1;
      uniqueEntries.push(signatureGroup[0]);
      continue;
    }

    const distinctOutputs = new Set(signatureGroup.map((entry) => outputKey(entry)));
    if (distinctOutputs.size > 1) stats.sameSignatureDifferentOutputGroups += 1;

    const byOutput = new Map();
    for (const entry of signatureGroup) {
      const key = outputKey(entry);
      const group = byOutput.get(key);
      if (group) group.push(entry);
      else byOutput.set(key, [entry]);
    }

    for (const outputGroup of byOutput.values()) {
      if (outputGroup.length < 2) {
        stats.sameSignatureDifferentOutputCount += outputGroup.length;
        increment(stats.skippedReasons, "same_signature_different_output", outputGroup.length);
        if (outputGroup.length > 0) {
          sameSignatureTargets.push({ entry: outputGroup[0], count: outputGroup.length });
        }
        continue;
      }
      stats.duplicateGroupCount += 1;
      stats.duplicateCandidateCount += outputGroup.length;
      outputGroup.sort((left, right) => left.order - right.order);

      let keeper = outputGroup[0];
      for (let index = 1; index < outputGroup.length; index += 1) {
        const next = outputGroup[index];
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

  const collapsedReadIds =
    options.collapseReadWindows && options.enabled
      ? collapseCoveredReads(
          records,
          eligible,
          options,
          stats,
          decisions,
          placeholderTokens,
        )
      : new Set();

  decisions.sort((left, right) => left.order - right.order);
  stats.markedCount = decisions.length;

  // Near-miss diagnostics for unique signatures: records that point at the
  // same target (tool + explicit path) but still have different canonical
  // arguments. This is the common "read the same file four times" case, where
  // a windowed `offset`/`limit` changes the signature and byte equality can
  // never hold.
  const repeatedEntries = [];
  if (uniqueEntries.length > 0) {
    const byTarget = new Map();
    for (const entry of uniqueEntries) {
      if (collapsedReadIds.has(entry.record.id)) {
        increment(stats.skippedReasons, "read_window_subsumed");
        continue;
      }
      const key = targetKeyOf(entry.record);
      if (!key) {
        increment(stats.skippedReasons, "unique_signature");
        continue;
      }
      const group = byTarget.get(key);
      if (group) group.push(entry);
      else byTarget.set(key, [entry]);
    }
    for (const [key, group] of byTarget.entries()) {
      increment(
        stats.skippedReasons,
        group.length > 1 ? "same_target_args_changed" : "unique_signature",
        group.length,
      );
      if (group.length > 1) {
        repeatedEntries.push({
          key,
          count: group.length,
          cwd: group[0]?.record?.env?.cwd ?? "",
        });
      }
    }
  }
  // Same arguments, different body: the file was edited between two reads. This
  // is the strongest "read the same file repeatedly" signal, and it never
  // reaches `uniqueEntries`.
  for (const item of sameSignatureTargets) {
    const key = targetKeyOf(item.entry.record);
    if (!key) continue;
    repeatedEntries.push({
      key,
      count: item.count,
      cwd: item.entry.record?.env?.cwd ?? "",
    });
  }
  if (repeatedEntries.length > 0) {
    const merged = new Map();
    for (const item of repeatedEntries) {
      const previous = merged.get(item.key);
      if (previous) previous.count += item.count;
      else merged.set(item.key, { count: item.count, cwd: item.cwd });
    }
    const repeated = [];
    for (const [key, info] of merged.entries()) {
      let target = key.split("\u0000").slice(1).join("\u0000");
      // Report project-relative paths: the log is a local diagnostic and the
      // absolute form would embed the user's home directory.
      const prefix = info.cwd ? `${info.cwd.replace(/\/+$/, "")}/` : "";
      if (prefix && target.startsWith(prefix)) {
        target = target.slice(prefix.length);
      } else if (target.startsWith("/")) {
        target = `<external>/${target.split("/").pop() || target}`;
      }
      repeated.push({ target, count: info.count });
    }
    repeated.sort((left, right) => right.count - left.count);
    stats.repeatedTargets = repeated.slice(0, 5);
  }

  stats.prunableCount = stats.duplicateCandidateCount + collapsedReadIds.size;
  stats.plannedPruneCount = decisions.length;
  stats.tokenSavingsEstimated = decisions.reduce(
    (total, decision) => total + decision.estimatedTokensSaved,
    0,
  );
  return { decisions, stats };
}

/**
 * A completed result with an explicit failure signal in structured metadata
 * is ambiguous: the runtime says completed, metadata says failure.
 * Unified implementation supporting both error-purge and supersede-writes.
 */
export function hasFailureMetadata(metadata) {
  return hasHardFailureMetadata(metadata) || hasDiagnosticFailureMetadata(metadata);
}

/**
 * Failure signals that describe the execution itself (status/exit/timeout).
 * These always win, even when a caller also sets a success flag.
 */
export function hasHardFailureMetadata(metadata) {
  if (!isPlainObject(metadata)) return false;
  const rawExit = metadata.exitCode ?? metadata.exit_code ?? metadata.exit ?? metadata.code;
  if (typeof rawExit === "number" && Number.isFinite(rawExit) && rawExit !== 0) return true;
  if (typeof rawExit === "string" && /^-?\d+$/.test(rawExit.trim()) && Number(rawExit) !== 0) {
    return true;
  }
  if (metadata.success === false || metadata.ok === false || metadata.failed === true) {
    return true;
  }
  if (metadata.isError === true || metadata.timedOut === true || metadata.timeout === true) {
    return true;
  }
  if (metadata.aborted === true || metadata.cancelled === true || metadata.canceled === true) {
    return true;
  }
  if (metadata.status === "error" || metadata.status === "failed") return true;
  return false;
}

/**
 * Diagnostic text attached to a completed call (stderr echo, warning note).
 * It is real failure evidence only when no structured state says otherwise,
 * so it never overrides an explicit success marker.
 */
export function hasDiagnosticFailureMetadata(metadata) {
  if (!isPlainObject(metadata)) return false;
  for (const key of ["error", "exception"]) {
    if (typeof metadata[key] === "string" && metadata[key].trim().length > 0) return true;
  }
  return false;
}

/**
 * Explicit success markers the runtime may expose on a completed call.
 * Only affirmative flags count: a bare `failed: false` / `isError: false`
 * next to a diagnostic string is contradictory, so it stays unresolved
 * (preserved) rather than being read as success.
 */
export function hasExplicitSuccessMetadata(metadata) {
  if (!isPlainObject(metadata)) return false;
  return metadata.success === true || metadata.ok === true;
}

export function isConfirmedSuccess(record) {
  if (
    !record ||
    record.status !== "completed" ||
    (typeof record.error === "string" && record.error.trim().length > 0)
  ) {
    return false;
  }
  if (!hasFailureMetadata(record.metadata)) return true;
  // A diagnostic string alone must not veto an explicit success marker: some
  // runtimes attach stderr/warning text to successful calls. Hard failure
  // fields (exit code, timeouts, cancellation) still win.
  return hasExplicitSuccessMetadata(record.metadata) && !hasHardFailureMetadata(record.metadata);
}

export function validPlaceholder(value, fallback) {
  return typeof value === "string" && value.startsWith(PRUNE_MARKER) ? value : fallback;
}

/**
 * Strip wrapper metadata from tool read outputs for normalized comparison.
 */
export function normalizeReadOutput(output) {
  if (typeof output !== "string") return output;
  return output
    .replace(/<path>.*?<\/path>\n?/g, "")
    .replace(/<type>file<\/type>\n?/g, "")
    .replace(/\n*\(End of file - total \d+ lines\)\n?/g, "")
    .trim();
}

