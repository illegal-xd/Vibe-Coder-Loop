/**
 * Host-neutral Supersede Writes core.
 *
 * Goal: after a file write succeeds, a later *full, fresh* read of the same
 * file represents the file's current state. The write's bulky content (the
 * tool input that carried the written text, plus its short output) is then
 * redundant for ongoing reasoning and may be replaced with a placeholder,
 * while the write's identity, status, metadata, and audit history are kept.
 *
 * Safety policy (v1):
 * - only explicitly configured write tools (default write/edit/multiedit/
 *   patch/apply_patch) with a confirmed-success status are candidates;
 * - only a confirmed-success full read (default tool `read`) of the SAME
 *   canonical file, in the SAME workspace (cwd/root), can supersede;
 * - a read is "full" only when it starts at line 1, is not truncated, and
 *   returns content (not metadata-only). The runtime normalizes every read's
 *   input with an explicit `offset`/`limit`, so a bare `limit` is NOT proof of
 *   a partial read: completeness must come from structured EOF evidence
 *   (`metadata.truncated === false`, or a `metadata.display` line range that
 *   covers `totalLines`), with the legacy "no offset/limit" form as fallback;
 * - the read must have started no earlier than the write ended (real
 *   happens-before). Missing or malformed completion timings preserve the
 *   write; overlapping writes invalidate the read for that file;
 * - confirmed successful writes are part of the chain (same-file writes are
 *   superseded too, different-file writes cannot touch this file). Every
 *   other mutation-like record (bash, failed write, unknown tool, unresolved
 *   path) between the write and the read is a barrier, because it might have
 *   touched the file and we cannot prove the read still contains the write's
 *   final result;
 * - write call ids referenced later are protected by the adapter;
 * - writes to user-protected tools or file patterns are never redacted;
 * - estimated saved tokens must exceed the placeholder, otherwise the
 *   rewrite is not worth it.
 *
 * This module is host-neutral: it receives normalized tool records and
 * returns prune decisions plus statistics, exactly like core/error-purge.
 */

import {
  DEFAULT_READ_ONLY_TOOLS,
  PRUNE_MARKER,
  TOKEN_COUNTING,
  byteLength,
  hasOrderInRange,
  isPlainObject,
  isPrunedOutput,
  normalizePath,
  protectedReason,
  textTokenUnits,
} from "./core.js";

export const DEFAULT_SUPERSEDE_PLACEHOLDER =
  `${PRUNE_MARKER} Write context omitted: a later full read of the same file ` +
  "superseded it. The write's success status and file path are retained.";

export const HIGH_CONFIDENCE = "high";

/** Tools whose input carries the written file content. */
export const DEFAULT_WRITE_TOOLS = Object.freeze([
  "write",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
]);

/** Tools that can return a file's full current content. grep/glob are partial. */
export const DEFAULT_SUPERSEDE_READ_TOOLS = Object.freeze(["read"]);

/**
 * Argument keys that carry the bulk write payload. These are the fields that
 * get redacted; path keys and unrelated fields are preserved.
 */
export const CONTENT_KEYS = Object.freeze([
  "content",
  "text",
  "value",
  "oldString",
  "newString",
  "old_string",
  "new_string",
  "edits",
  "patch",
  "diff",
  "input",
]);

const PATH_ARG_KEYS = new Set([
  "filePath",
  "path",
  "file",
  "filename",
  "fileName",
]);

const TRUNCATION_HINTS = [
  "output capped",
  "output truncated",
  "file is too large",
  "showing the first",
  "showing the last",
  "... show more",
  "… show more",
];

function increment(map, key, amount = 1) {
  if (!key || amount <= 0) return;
  map[key] = (map[key] ?? 0) + amount;
}

function validPlaceholder(value, fallback) {
  return typeof value === "string" && value.startsWith(PRUNE_MARKER) ? value : fallback;
}

function asStringSet(list) {
  const set = new Set();
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === "string" && item.trim().length > 0) set.add(item.trim());
    }
  }
  return set;
}

function normalizeOptions(config = {}) {
  const enabled = config.enabled !== false;
  const writeTools = asStringSet(config.writeTools ?? DEFAULT_WRITE_TOOLS);
  const readTools = asStringSet(config.readTools ?? DEFAULT_SUPERSEDE_READ_TOOLS);
  const readOnlyTools = asStringSet(config.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS);
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
    placeholder: validPlaceholder(config.placeholder, DEFAULT_SUPERSEDE_PLACEHOLDER),
    writeTools,
    readTools,
    readOnlyTools,
    preserveAcrossUserTurns: config.preserveAcrossUserTurns === true,
    barrierOnBroadMutations: config.barrierOnBroadMutations !== false,
    protectReferences: config.protectReferences !== false,
    requireFullRead: config.requireFullRead !== false,
    protectedTools,
    protectedFilePatterns,
  };
}

export function createSupersedeWritesStats() {
  return {
    enabled: true,
    preview: false,
    recordsTotal: 0,
    // Observable funnel: writes detected -> writes with a resolved identity
    // (eligible) -> writes that share identity with an accepted full read
    // (candidate) -> decisions (marked) -> applied (changed).
    observedReadCount: 0,
    confirmedReadCount: 0,
    fullReadCount: 0,
    ambiguousWriteCount: 0,
    ambiguousResultCount: 0,
    confirmedWriteCount: 0,
    eligibleCount: 0,
    candidateCount: 0,
    fileMatchCount: 0,
    versionVerifiedCount: 0,
    markedCount: 0,
    plannedPruneCount: 0,
    wouldPruneCount: 0,
    prunedCount: 0,
    preservedCount: 0,
    highConfidencePruneCount: 0,
    decisionKinds: {},
    skippedReasons: {},
    // Why reads were not usable as a superseder (completeness/version gate).
    readRejectedReasons: {},
    tokenSavingsEstimated: 0,
    tokenSavingsEstimatedIfApplied: 0,
    tokenCounting: TOKEN_COUNTING,
    actualTokenSavings: null,
    outputBytesRemovedActual: 0,
    durationMs: null,
    changed: false,
  };
}

function hasFailureMetadata(metadata) {
  if (!isPlainObject(metadata)) return false;
  const rawExit = metadata.exitCode ?? metadata.exit_code ?? metadata.exit ?? metadata.code;
  if (typeof rawExit === "number" && Number.isFinite(rawExit) && rawExit !== 0) return true;
  if (typeof rawExit === "string" && /^-?\d+$/.test(rawExit.trim()) && Number(rawExit) !== 0) {
    return true;
  }
  if (metadata.success === false || metadata.ok === false || metadata.failed === true) return true;
  if (metadata.isError === true || metadata.timedOut === true || metadata.timeout === true) {
    return true;
  }
  if (metadata.aborted === true || metadata.cancelled === true || metadata.canceled === true) return true;
  if (metadata.status === "error" || metadata.status === "failed") return true;
  for (const key of ["error", "exception"]) {
    if (typeof metadata[key] === "string" && metadata[key].trim().length > 0) return true;
  }
  return false;
}

function isConfirmedSuccess(record) {
  return (
    record &&
    record.status === "completed" &&
    !(typeof record.error === "string" && record.error.trim().length > 0) &&
    !hasFailureMetadata(record.metadata)
  );
}

function userSegmentOf(record) {
  return Number.isFinite(record?.userSegment) ? record.userSegment : 0;
}

function timeStart(record) {
  const time = record?.time;
  if (!isPlainObject(time)) return null;
  const start = time.start;
  return typeof start === "number" && Number.isFinite(start) ? start : null;
}

function timeEnd(record) {
  const time = record?.time;
  if (!isPlainObject(time)) return null;
  const end = time.end;
  return typeof end === "number" && Number.isFinite(end) ? end : null;
}

/**
 * Extract the target file path argument from a tool input. Returns the raw
 * string value of the first recognized path key, or "" when none is found.
 */
function rawPathArg(args) {
  if (!isPlainObject(args)) return "";
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

/**
 * Canonical file identity: normalized path resolved against cwd, plus the
 * workspace (cwd/root). Two paths match only when they resolve to the same
 * location within the same workspace. Returns "" when identity is uncertain.
 */
export function fileIdentityOf(record) {
  if (!record || !isPlainObject(record.args)) return "";
  const env = record.env ?? {};
  const cwd = typeof env.cwd === "string" && env.cwd.length > 0 ? env.cwd : "";
  const root = typeof env.root === "string" && env.root.length > 0 ? env.root : "";
  if (!cwd) return "";
  const raw = rawPathArg(record.args);
  if (!raw) return "";
  const normalized = normalizePath(raw, cwd);
  if (!normalized) return "";
  return [normalized, normalizePath(cwd, null), normalizePath(root, null)].join("\u0000");
}

/** Normalized path component only, for logging. Never logs raw content. */
function safePathLabel(identity) {
  if (typeof identity !== "string" || identity.length === 0) return "";
  const path = identity.split("\u0000")[0];
  return path;
}

function contentString(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Build a redacted copy of a write input: path keys and unrelated fields are
 * preserved; every content key is replaced by the placeholder string so the
 * model still sees the file path but not the written payload.
 */
export function redactWriteInput(input, placeholder) {
  if (!isPlainObject(input)) return input;
  const out = Object.create(null);
  for (const key of Object.keys(input)) {
    if (CONTENT_KEYS.includes(key)) {
      out[key] = placeholder;
    } else {
      out[key] = input[key];
    }
  }
  return out;
}

function isPrunedOrPlaceholderOutput(output) {
  return typeof output !== "string" || output.length === 0 || isPrunedOutput(output);
}

function isConfirmedWrite(record, options) {
  if (!record) return false;
  if (typeof record.tool !== "string" || !options.writeTools.has(record.tool)) return false;
  if (!isConfirmedSuccess(record)) return false;
  if (!isPlainObject(record.args)) return false;
  return true;
}

function isReadCandidate(record, options) {
  if (!record) return false;
  if (typeof record.tool !== "string" || !options.readTools.has(record.tool)) return false;
  if (!isConfirmedSuccess(record)) return false;
  if (isPrunedOrPlaceholderOutput(record.output)) return false;
  if (!isPlainObject(record.args)) return false;
  return true;
}

/** Structured line range reported by the runtime for a file read, if any. */
function readLineRange(metadata) {
  const display = isPlainObject(metadata) ? metadata.display : null;
  if (!isPlainObject(display)) return null;
  const lineStart = display.lineStart;
  const lineEnd = display.lineEnd;
  const totalLines = display.totalLines;
  if (![lineStart, lineEnd, totalLines].every((value) => Number.isFinite(value))) return null;
  if (totalLines <= 0) return null;
  return { lineStart, lineEnd, totalLines };
}

/**
 * Classify a read record for supersession. Returns `{ full, reason }` where
 * `reason` explains why a read cannot act as a superseder.
 *
 * The runtime normalizes every `read` input with an explicit `offset`
 * (1-indexed, default 1) and `limit` (computed cap), so a `limit` alone cannot
 * mean "partial". Completeness therefore has to come from structured EOF
 * evidence, in this order:
 *   1. `metadata.truncated === false` for a read that started at line 1;
 *   2. `metadata.display` range covering `[1, totalLines]`;
 *   3. legacy records that carry neither offset nor limit.
 * Anything weaker is treated as incomplete and never supersedes a write.
 */
function inspectRead(record, options) {
  if (!isReadCandidate(record, options)) {
    return { full: false, reason: "read_invalid_candidate" };
  }

  const args = record.args;
  const rawOffset = args.offset ?? args.line ?? args.startLine ?? args.from;
  if (rawOffset !== undefined && rawOffset !== null) {
    const numeric = Number(rawOffset);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return { full: false, reason: "read_invalid_offset" };
    }
    // OpenCode's read tool documents offset as 1-indexed, so 0/1 both start
    // at the beginning; anything larger is an explicit slice.
    if (numeric > 1) return { full: false, reason: "read_partial_offset" };
  }
  const limit = args.limit ?? args.lines ?? args.count ?? args.maxLines;

  const metadata = isPlainObject(record.metadata) ? record.metadata : {};
  if (metadata.truncated === true) return { full: false, reason: "read_truncated" };
  if (metadata.loaded === false) return { full: false, reason: "read_not_loaded" };
  if (metadata.partial === true) return { full: false, reason: "read_partial" };
  if (metadata.complete === false) return { full: false, reason: "read_incomplete" };
  if (isPlainObject(metadata.display) && metadata.display.truncated === true) {
    return { full: false, reason: "read_truncated" };
  }

  // Conservative text sniff: only used to reject, never to accept. The
  // runtime appends its cap notice at the end ("Output capped at ..."), so
  // inspect both ends of the output.
  const output = record.output;
  if (typeof output === "string") {
    const head = output.slice(0, 512).toLowerCase();
    const tail = output.slice(-512).toLowerCase();
    for (const hint of TRUNCATION_HINTS) {
      if (head.includes(hint) || tail.includes(hint)) {
        return { full: false, reason: "read_truncated_hint" };
      }
    }
  }

  // Proof 1: the runtime explicitly reports that the read was not truncated.
  // Combined with the offset <= 1 check above, the read covered the whole file
  // even though the runtime also stamped a `limit`.
  if (metadata.truncated === false) return { full: true, reason: "" };

  // Proof 2: a structured range. When the runtime reports one it is
  // authoritative: either it covers the whole file or the read was partial.
  const range = readLineRange(metadata);
  if (range) {
    if (range.lineStart <= 1 && range.lineEnd >= range.totalLines) {
      return { full: true, reason: "" };
    }
    return { full: false, reason: "read_partial_range" };
  }

  // Legacy fallback: no explicit slice. Offset 0/1 is the beginning of the
  // file; a bare `limit` without EOF proof stays conservative because it may
  // be a real cap.
  const startsAtBeginning =
    rawOffset === undefined || rawOffset === null || Number(rawOffset) <= 1;
  if (startsAtBeginning && (limit === undefined || limit === null)) {
    return { full: true, reason: "" };
  }

  return {
    full: false,
    reason: limit !== undefined && limit !== null ? "read_limited" : "read_unverified",
  };
}

/**
 * Precompute the barrier timeline once per request.
 *
 * A record is a barrier when it could have touched the file and is not a
 * confirmed successful write:
 * - reads / configured read-only tools never modify files;
 * - confirmed successful writes with a resolvable path are either a same-file
 *   link in the chain (superseded too) or target a different file;
 * - every other tool (bash, task, failed write, unknown tool, unresolved path)
 *   is conservatively treated as a potential mutation.
 *
 * Confirmed writes and their identities are returned so the classification
 * pass does not normalize the same path twice.
 */
function buildBarrierTimeline(records, options) {
  const barrierOrders = [];
  const confirmedWrites = new Set();
  const identityByOrder = new Map();
  let invalidRecord = false;

  const collectBarriers = options.barrierOnBroadMutations;

  for (const record of records) {
    if (!record || typeof record !== "object") {
      if (collectBarriers) invalidRecord = true;
      continue;
    }
    if (!Number.isFinite(record.order)) continue;
    if (typeof record.tool !== "string") {
      if (collectBarriers) barrierOrders.push(record.order);
      continue;
    }
    if (options.readTools.has(record.tool) || options.readOnlyTools.has(record.tool)) continue;
    if (options.writeTools.has(record.tool)) {
      if (!isConfirmedWrite(record, options)) {
        if (collectBarriers) barrierOrders.push(record.order);
        continue;
      }
      // Always collect confirmed writes, even when barriers are disabled.
      confirmedWrites.add(record.order);
      const identity = fileIdentityOf(record);
      if (identity) identityByOrder.set(record.order, identity);
      else if (collectBarriers) barrierOrders.push(record.order);
      continue;
    }
    // Any other tool may modify the file; fail safe.
    if (collectBarriers) barrierOrders.push(record.order);
  }

  if (collectBarriers) barrierOrders.sort((left, right) => left - right);
  return { barrierOrders, confirmedWrites, identityByOrder, invalidRecord };
}

/**
 * Decide whether `read` reliably reflects the file state after `write`
 * completed. Requires real happens-before: the read must have started no
 * earlier than the write ended. Missing or malformed timings preserve the
 * write rather than falling back to emission order.
 */
function readCoversWrite(write, read) {
  const writeStart = timeStart(write);
  const writeEnd = timeEnd(write);
  const readStart = timeStart(read);
  const readEnd = timeEnd(read);
  // Without both completion timestamps there is no proof of happens-before:
  // emission order alone cannot rule out parallel calls. Preserve the write.
  if (writeEnd === null || readStart === null) return false;
  // Reject malformed intervals instead of trusting them.
  if (writeStart !== null && writeEnd < writeStart) return false;
  if (readEnd !== null && readEnd < readStart) return false;
  return readStart >= writeEnd;
}

/**
 * True when a same-file write overlaps the read: the write had not finished
 * before the read started, so the read may have observed an in-flight state.
 */
function sameFileWriteOverlapsRead(write, read) {
  const writeEnd = timeEnd(write);
  const readStart = timeStart(read);
  if (writeEnd === null || readStart === null) return false;
  return writeEnd > readStart;
}

/**
 * Pure Supersede Writes rule engine.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {Record<string, unknown>} [config]
 * @returns {{ decisions: Array<Record<string, unknown>>, stats: ReturnType<typeof createSupersedeWritesStats> }}
 */
export function planSupersedeWrites(records, config = {}) {
  config = config ?? {};
  const options = normalizeOptions(config);
  const stats = createSupersedeWritesStats();
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

  const timeline = buildBarrierTimeline(records, options);
  const writesByFile = new Map();
  const readsByFile = new Map();
  // Diagnostic only: every successful read with a resolvable identity, even
  // when it is not a complete read. Lets a preserved write explain whether the
  // file was never read, only read partially, or read before the write.
  const allReadsByFile = new Map();
  const placeholderTokens = textTokenUnits(options.placeholder);

  const rememberRead = (map, identity, read) => {
    const list = map.get(identity);
    if (list) list.push(read);
    else map.set(identity, [read]);
  };

  for (const record of records) {
    if (!record || typeof record !== "object") {
      increment(stats.skippedReasons, "invalid_record");
      continue;
    }
    if (!Number.isFinite(record.order)) {
      increment(stats.skippedReasons, "invalid_order");
      continue;
    }

    if (typeof record.tool === "string" && options.writeTools.has(record.tool)) {
      if (!timeline.confirmedWrites.has(record.order)) {
        stats.ambiguousWriteCount += 1;
        stats.ambiguousResultCount += 1;
        continue;
      }
      stats.confirmedWriteCount += 1;
      const protectReason = protectedReason(record, options);
      if (protectReason) {
        increment(stats.skippedReasons, protectReason);
        continue;
      }
      const identity = timeline.identityByOrder.get(record.order) ?? fileIdentityOf(record);
      if (!identity) {
        increment(stats.skippedReasons, "write_unresolved_path");
        continue;
      }
      const candidate = {
        record,
        identity,
        order: record.order,
        userSegment: userSegmentOf(record),
        blockedReason: "",
        decided: false,
      };
      const list = writesByFile.get(identity);
      if (list) list.push(candidate);
      else writesByFile.set(identity, [candidate]);
      continue;
    }

    if (typeof record.tool === "string" && options.readTools.has(record.tool)) {
      stats.observedReadCount += 1;
      const inspection = options.requireFullRead
        ? inspectRead(record, options)
        : { full: isReadCandidate(record, options), reason: "read_partial" };
      const identity = fileIdentityOf(record);
      if (!inspection.full) {
        stats.ambiguousResultCount += 1;
        increment(stats.readRejectedReasons, inspection.reason || "read_incomplete");
        // A rejected read still proves the file was inspected; classify it for
        // the per-write diagnostics only when it was a confirmed success.
        if (identity && isReadCandidate(record, options)) {
          rememberRead(allReadsByFile, identity, {
            record,
            identity,
            order: record.order,
            userSegment: userSegmentOf(record),
          });
        }
        continue;
      }
      stats.confirmedReadCount += 1;
      stats.fullReadCount += 1;
      if (!identity) {
        increment(stats.skippedReasons, "read_unresolved_path");
        continue;
      }
      const read = {
        record,
        identity,
        order: record.order,
        userSegment: userSegmentOf(record),
      };
      rememberRead(readsByFile, identity, read);
      rememberRead(allReadsByFile, identity, read);
    }
  }

  // Eligible = confirmed writes with a resolvable canonical file identity.
  // Candidate = eligible write whose file identity also has an accepted full
  // read (the version relation is checked later, per read).
  stats.candidateCount = 0;
  for (const [identity, list] of writesByFile.entries()) {
    stats.candidateCount += list.length;
    if ((readsByFile.get(identity)?.length ?? 0) > 0) stats.fileMatchCount += list.length;
  }
  stats.eligibleCount = stats.candidateCount;

  const decisions = [];
  const decide = (candidate, read) => {
    const originalInput = candidate.record.args;
    const redactedInput = redactWriteInput(originalInput, options.placeholder);
    const originalInputJson = contentString(originalInput);
    const redactedInputJson = contentString(redactedInput);
    const originalInputTokens = textTokenUnits(originalInputJson);
    const redactedInputTokens = textTokenUnits(redactedInputJson);
    const outputTokens =
      typeof candidate.record.output === "string" ? textTokenUnits(candidate.record.output) : 0;
    const savedTokens =
      originalInputTokens - redactedInputTokens + outputTokens - placeholderTokens;
    if (savedTokens <= 0) {
      if (!candidate.blockedReason) candidate.blockedReason = "no_token_benefit";
      return;
    }
    const bytesRemoved =
      byteLength(originalInputJson) -
        byteLength(redactedInputJson) +
        byteLength(candidate.record.output) -
        byteLength(options.placeholder);
    const estimatedTokensSaved = Math.ceil(savedTokens);
    const decision = {
      id: candidate.record.id,
      kind: "superseded_by_read",
      confidence: HIGH_CONFIDENCE,
      tool: candidate.record.tool,
      order: candidate.order,
      keeperId: read.record.id,
      keeperOrder: read.order,
      keeperTool: read.record.tool,
      field: "input+output",
      fileIdentity: candidate.identity,
      filePath: safePathLabel(candidate.identity),
      // Keep a reference to the existing input object for apply-time
      // verification; never duplicate the file content as a string.
      expectedInput: originalInput,
      expectedOutput: candidate.record.output,
      redactedInput,
      replacement: options.placeholder,
      estimatedTokensSaved,
      tokenUnitsRemoved: savedTokens,
      bytesRemoved: Math.max(0, bytesRemoved),
    };
    decisions.push(decision);
    candidate.decided = true;
    stats.tokenSavingsEstimatedIfApplied += estimatedTokensSaved;
    increment(stats.decisionKinds, decision.kind);
  };

  if (!timeline.invalidRecord) {
    for (const [identity, writes] of writesByFile.entries()) {
      const reads = readsByFile.get(identity) ?? [];
      if (reads.length === 0) continue;
      writes.sort((left, right) => left.order - right.order);
      reads.sort((left, right) => left.order - right.order);

      for (const read of reads) {
        const pendingWrites = writes.filter(
          (candidate) => !candidate.decided && candidate.order < read.order,
        );
        if (pendingWrites.length === 0) continue;

        // If any pending same-file write overlaps this read, the read is
        // unreliable for the whole file: skip it as a superseder.
        const overlap = pendingWrites.some((candidate) =>
          sameFileWriteOverlapsRead(candidate.record, read.record),
        );
        if (overlap) {
          increment(stats.skippedReasons, "concurrent_write_overlap");
          continue;
        }

        for (const candidate of pendingWrites) {
          if (candidate.decided) continue;
          if (candidate.order >= read.order) continue; // write after read: retained (Case C)
          if (!readCoversWrite(candidate.record, read.record)) {
            if (!candidate.blockedReason) candidate.blockedReason = "read_not_after_write";
            continue;
          }
          if (options.preserveAcrossUserTurns && candidate.userSegment !== read.userSegment) {
            if (!candidate.blockedReason) candidate.blockedReason = "across_user_turn";
            continue;
          }
          if (hasOrderInRange(timeline.barrierOrders, candidate.order, read.order)) {
            if (!candidate.blockedReason) candidate.blockedReason = "intervening_broad_mutation";
            continue;
          }
          // Reached this point only after the read is complete, the file
          // identity matches, and the version relation (happens-before, no
          // overlap, no intervening mutation) is verified.
          stats.versionVerifiedCount += 1;
          decide(candidate, read);
        }
      }
    }
  } else {
    for (const writes of writesByFile.values()) {
      for (const candidate of writes) {
        if (!candidate.blockedReason) candidate.blockedReason = "unknown_intervening_record";
      }
    }
  }

  // Count every preserved candidate exactly once, for every file (including
  // files that never had a full read). When no guard fired, classify the
  // evidence gap: no read, only partial reads, or full reads that all happened
  // before the write. This keeps "candidate > 0, changed = 0" explainable.
  for (const writes of writesByFile.values()) {
    for (const candidate of writes) {
      if (candidate.decided) continue;
      let reason = candidate.blockedReason;
      if (!reason) {
        const fullReads = readsByFile.get(candidate.identity) ?? [];
        const anyReads = allReadsByFile.get(candidate.identity) ?? [];
        if (fullReads.length > 0) {
          reason = fullReads.some((read) => read.order > candidate.order)
            ? "no_superseding_read"
            : "read_before_write";
        } else if (anyReads.length > 0) {
          reason = "read_not_full";
        } else {
          reason = "no_superseding_read";
        }
      }
      increment(stats.skippedReasons, reason);
    }
  }

  decisions.sort((left, right) => left.order - right.order);
  stats.markedCount = decisions.length;
  stats.prunableCount = stats.fileMatchCount;
  stats.plannedPruneCount = decisions.length;
  stats.preservedCount = Math.max(0, stats.candidateCount - decisions.length);
  stats.highConfidencePruneCount = decisions.length;
  return { decisions, stats };
}
