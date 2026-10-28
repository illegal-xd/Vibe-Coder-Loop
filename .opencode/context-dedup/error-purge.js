/**
 * Host-neutral Error Purge core.
 *
 * Error Purge only considers a result a confirmed failure when the runtime
 * exposes structured failure state. For OpenCode that is:
 *   ToolPart.state.status === "error" && typeof state.error === "string"
 *
 * It never classifies a completed result as an error just because its output
 * contains words like "error" or "failed".
 *
 * An earlier confirmed error is pruned only when:
 * - a later equivalent operation (same tool, canonical args, cwd/root)
 *   completed successfully; and
 * - the later success is in the same user turn (default); and
 * - no state-changing tool ran between them (default); and
 * - the estimated error text is larger than the replacement placeholder.
 *
 * Repeated identical failures are a separate, medium-confidence rule: older
 * duplicates may be pruned while the newest equivalent failure is retained.
 * If no later evidence exists, the error is preserved.
 */

import {
  DEFAULT_MUTATION_TOOLS,
  DEFAULT_READ_ONLY_TOOLS,
  PRUNE_MARKER,
  TOKEN_COUNTING,
  buildOperationSignature,
  estimateTokens,
  isPlainObject,
  isPrunedOutput,
} from "./core.js";

export const DEFAULT_ERROR_PLACEHOLDER =
  `${PRUNE_MARKER} Error output omitted: a later equivalent successful ` +
  "result superseded it. The failure status is retained.";

export const DUPLICATE_ERROR_PLACEHOLDER =
  `${PRUNE_MARKER} Earlier duplicate failure output omitted; ` +
  "the latest equivalent failure is retained.";

export const HIGH_CONFIDENCE = "high";
export const MEDIUM_CONFIDENCE = "medium";

export function createErrorPurgeStats() {
  return {
    enabled: true,
    preview: false,
    recordsTotal: 0,
    confirmedErrorCount: 0,
    ambiguousResultCount: 0,
    candidateCount: 0,
    plannedPruneCount: 0,
    wouldPruneCount: 0,
    prunedCount: 0,
    preservedCount: 0,
    highConfidencePruneCount: 0,
    mediumConfidencePruneCount: 0,
    decisionKinds: {},
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

function increment(map, key, amount = 1) {
  if (!key || amount <= 0) return;
  map[key] = (map[key] ?? 0) + amount;
}

function validPlaceholder(value, fallback) {
  return typeof value === "string" && value.startsWith(PRUNE_MARKER) ? value : fallback;
}

function normalizeOptions(config = {}) {
  const enabled = config.enabled !== false;
  const rawReadOnly = Array.isArray(config.readOnlyTools)
    ? config.readOnlyTools
    : DEFAULT_READ_ONLY_TOOLS;
  const rawMutation = Array.isArray(config.mutationTools)
    ? config.mutationTools
    : DEFAULT_MUTATION_TOOLS;
  const mutationTools = new Set(
    rawMutation.filter((tool) => typeof tool === "string" && tool.trim().length > 0),
  );
  const readOnlyTools = new Set(
    rawReadOnly
      .filter((tool) => typeof tool === "string" && tool.trim().length > 0)
      .map((tool) => tool.trim())
      .filter((tool) => !mutationTools.has(tool)),
  );
  const minSuccesses =
    Number.isInteger(config.minSuccesses) && config.minSuccesses >= 1
      ? config.minSuccesses
      : 1;

  return {
    enabled,
    placeholder: validPlaceholder(config.placeholder, DEFAULT_ERROR_PLACEHOLDER),
    duplicatePlaceholder: validPlaceholder(
      config.duplicatePlaceholder,
      DUPLICATE_ERROR_PLACEHOLDER,
    ),
    readOnlyTools,
    preserveAcrossUserTurns: config.preserveAcrossUserTurns !== false,
    preserveOnStateChanges: config.preserveOnStateChanges !== false,
    pruneRepeatedFailures: config.pruneRepeatedFailures !== false,
    minSuccesses,
  };
}

function userSegmentOf(record) {
  return Number.isFinite(record?.userSegment) ? record.userSegment : 0;
}

function isConfirmedError(record) {
  return (
    record &&
    record.status === "error" &&
    typeof record.error === "string" &&
    record.error.trim().length > 0
  );
}

function hasCancellationMetadata(record) {
  const metadata = record?.metadata;
  if (!isPlainObject(metadata)) return false;
  return (
    metadata.cancelled === true ||
    metadata.canceled === true ||
    metadata.aborted === true
  );
}

/**
 * A completed result with an explicit failure signal in structured metadata
 * is ambiguous: the runtime says completed, metadata says failure. It must
 * not be used as a successful superseder. Text such as "error" is ignored.
 */
function hasFailureMetadata(metadata) {
  if (!isPlainObject(metadata)) return false;
  const rawExit = metadata.exitCode ?? metadata.exit_code ?? metadata.exit ?? metadata.code;
  if (typeof rawExit === "number" && Number.isFinite(rawExit) && rawExit !== 0) return true;
  if (typeof rawExit === "string" && /^-?\d+$/.test(rawExit.trim()) && Number(rawExit) !== 0) {
    return true;
  }
  if (metadata.success === false || metadata.ok === false || metadata.failed === true) {
    return true;
  }
  if (metadata.isError === true || metadata.timedOut === true) return true;
  if (metadata.aborted === true || metadata.cancelled === true || metadata.canceled === true) {
    return true;
  }
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

function isStateChange(record, options, signature, signaturesByOrder) {
  if (!record || typeof record !== "object") return true;
  if (typeof record.tool !== "string" || record.tool.length === 0) return true;
  if (signaturesByOrder.get(record.order) === signature) return false; // same operation retry
  if (options.readOnlyTools.has(record.tool)) return false;
  return true;
}

function barrierReason(records, older, newer, options, signature, signaturesByOrder) {
  if (!options.preserveOnStateChanges) return "";
  for (const record of records) {
    if (!record || typeof record !== "object") {
      return "unknown_intervening_record";
    }
    if (!Number.isFinite(record.order)) continue;
    if (record.order <= older.order || record.order >= newer.order) continue;
    if (isStateChange(record, options, signature, signaturesByOrder)) {
      return "intervening_state_change";
    }
  }
  return "";
}

function candidateError(record, stats, signature) {
  if (typeof record.tool !== "string" || record.tool.length === 0) {
    increment(stats.skippedReasons, "invalid_tool");
    return null;
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    increment(stats.skippedReasons, "invalid_call_id");
    return null;
  }
  if (!Number.isFinite(record.order)) {
    increment(stats.skippedReasons, "invalid_order");
    return null;
  }
  if (!isPlainObject(record.args)) {
    increment(stats.skippedReasons, "invalid_args");
    return null;
  }
  if (
    !record.env ||
    typeof record.env.cwd !== "string" ||
    record.env.cwd.length === 0
  ) {
    increment(stats.skippedReasons, "missing_environment");
    return null;
  }
  if (isPrunedOutput(record.error)) {
    increment(stats.skippedReasons, "already_pruned");
    return null;
  }
  if (!signature) {
    increment(stats.skippedReasons, "invalid_args");
    return null;
  }

  return {
    record,
    signature,
    errorText: record.error,
    userSegment: userSegmentOf(record),
    order: record.order,
    blockedReason: "",
    decided: false,
  };
}

function successRecord(record, stats, signature) {
  if (typeof record.tool !== "string" || record.tool.length === 0) {
    increment(stats.skippedReasons, "invalid_success");
    return null;
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    increment(stats.skippedReasons, "invalid_success");
    return null;
  }
  if (!Number.isFinite(record.order)) {
    increment(stats.skippedReasons, "invalid_success");
    return null;
  }
  if (!isPlainObject(record.args)) {
    increment(stats.skippedReasons, "invalid_success");
    return null;
  }
  if (!record.env || typeof record.env.cwd !== "string" || record.env.cwd.length === 0) {
    increment(stats.skippedReasons, "invalid_success");
    return null;
  }
  if (!signature) {
    increment(stats.skippedReasons, "invalid_success");
    return null;
  }
  return {
    record,
    signature,
    order: record.order,
    userSegment: userSegmentOf(record),
  };
}

/**
 * Pure Error Purge rule engine.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {Record<string, unknown>} [config]
 * @returns {{ decisions: Array<Record<string, unknown>>, stats: ReturnType<typeof createErrorPurgeStats> }}
 */
export function planErrorPurge(records, config = {}) {
  config = config ?? {};
  const options = normalizeOptions(config);
  const stats = createErrorPurgeStats();
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

  const candidates = [];
  const successesBySignature = new Map();
  const signaturesByOrder = new Map();

  for (const record of records) {
    if (!record || typeof record !== "object") {
      increment(stats.skippedReasons, "invalid_record");
      continue;
    }

    let signature = "";
    if (
      Number.isFinite(record.order) &&
      isPlainObject(record.args) &&
      record.env &&
      typeof record.env.cwd === "string" &&
      record.env.cwd.length > 0
    ) {
      try {
        signature = buildOperationSignature(record);
        signaturesByOrder.set(record.order, signature);
      } catch {
        signature = "";
      }
    }

    if (isConfirmedError(record) && !hasCancellationMetadata(record)) {
      stats.confirmedErrorCount += 1;
      const candidate = candidateError(record, stats, signature);
      if (candidate) candidates.push(candidate);
      continue;
    }

    if (isConfirmedSuccess(record)) {
      const success = successRecord(record, stats, signature);
      if (!success) continue;
      const list = successesBySignature.get(success.signature);
      if (list) list.push(success);
      else successesBySignature.set(success.signature, [success]);
      continue;
    }

    stats.ambiguousResultCount += 1;
  }

  const decisions = [];

  const decide = (candidate, keeper, kind, confidence, replacement) => {
    const estimatedTokensSaved =
      estimateTokens(candidate.errorText) - estimateTokens(replacement);
    if (estimatedTokensSaved <= 0) {
      if (!candidate.blockedReason) candidate.blockedReason = "no_token_benefit";
      return false;
    }
    const decision = {
      id: candidate.record.id,
      kind,
      confidence,
      tool: candidate.record.tool,
      order: candidate.order,
      keeperId: keeper.record.id,
      keeperOrder: keeper.order,
      field: "error",
      expectedValue: candidate.errorText,
      replacement,
      estimatedTokensSaved,
    };
    decisions.push(decision);
    candidate.decided = true;
    stats.tokenSavingsEstimated += estimatedTokensSaved;
    if (confidence === HIGH_CONFIDENCE) stats.highConfidencePruneCount += 1;
    else stats.mediumConfidencePruneCount += 1;
    increment(stats.decisionKinds, kind);
    return true;
  };

  // Rule 1: a later equivalent success supersedes an earlier failure.
  for (const candidate of candidates) {
    const laterSuccesses = (successesBySignature.get(candidate.signature) ?? []).filter(
      (success) => success.order > candidate.order,
    );
    if (laterSuccesses.length === 0) continue;

    let blockedReason = "";
    const qualifying = [];
    for (const success of laterSuccesses) {
      if (
        options.preserveAcrossUserTurns &&
        success.userSegment !== candidate.userSegment
      ) {
        if (!blockedReason) blockedReason = "across_user_turn";
        continue;
      }
      const barrier = barrierReason(
        records,
        candidate.record,
        success.record,
        options,
        candidate.signature,
        signaturesByOrder,
      );
      if (barrier) {
        if (!blockedReason) blockedReason = barrier;
        continue;
      }
      qualifying.push(success);
    }

    if (qualifying.length >= options.minSuccesses) {
      const keeper = qualifying[qualifying.length - 1];
      decide(candidate, keeper, "superseded_by_success", HIGH_CONFIDENCE, options.placeholder);
    } else if (!blockedReason) {
      blockedReason = "insufficient_successes";
    }
    if (!candidate.decided && blockedReason && !candidate.blockedReason) {
      candidate.blockedReason = blockedReason;
    }
  }

  // Rule 2: repeated identical failures. Keep the newest equivalent failure.
  if (options.pruneRepeatedFailures) {
    const groups = new Map();
    for (const candidate of candidates) {
      if (candidate.decided) continue;
      const key = `${candidate.signature}\u0000${candidate.errorText}`;
      const list = groups.get(key);
      if (list) list.push(candidate);
      else groups.set(key, [candidate]);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((left, right) => left.order - right.order);
      const keeper = group[group.length - 1];
      for (const candidate of group.slice(0, -1)) {
        if (candidate.decided) continue;
        if (
          options.preserveAcrossUserTurns &&
          candidate.userSegment !== keeper.userSegment
        ) {
          if (!candidate.blockedReason) candidate.blockedReason = "across_user_turn";
          continue;
        }
        const barrier = barrierReason(
          records,
          candidate.record,
          keeper.record,
          options,
          candidate.signature,
          signaturesByOrder,
        );
        if (barrier) {
          if (!candidate.blockedReason) candidate.blockedReason = barrier;
          continue;
        }
        decide(
          candidate,
          keeper,
          "duplicate_failure",
          MEDIUM_CONFIDENCE,
          options.duplicatePlaceholder,
        );
      }
      if (!keeper.decided && !keeper.blockedReason) {
        keeper.blockedReason = "latest_failure_retained";
      }
    }
  } else {
    const seen = new Set();
    for (const candidate of candidates) {
      if (candidate.decided) continue;
      const key = `${candidate.signature}\u0000${candidate.errorText}`;
      if (seen.has(key) && !candidate.blockedReason) {
        candidate.blockedReason = "repeated_failures_disabled";
      }
      seen.add(key);
    }
  }

  for (const candidate of candidates) {
    if (candidate.decided) continue;
    increment(stats.skippedReasons, candidate.blockedReason || "no_superseding_evidence");
  }

  decisions.sort((left, right) => left.order - right.order);
  stats.candidateCount = candidates.length;
  stats.plannedPruneCount = decisions.length;
  stats.preservedCount = Math.max(0, candidates.length - decisions.length);
  return { decisions, stats };
}
