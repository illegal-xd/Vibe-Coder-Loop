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

/** Count orders with lowerExclusive < order < upperExclusive in O(log n). */
function countBetween(sortedOrders, lowerExclusive, upperExclusive) {
  let low = 0;
  let high = sortedOrders.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sortedOrders[mid] <= lowerExclusive) low = mid + 1;
    else high = mid;
  }
  const start = low;
  high = sortedOrders.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sortedOrders[mid] < upperExclusive) low = mid + 1;
    else high = mid;
  }
  return low - start;
}

/**
 * Precompute the state-change timeline once. `stateChangeOrders` contains
 * every record that could block a supersession; `ordersBySignature` lets the
 * decision pass subtract retries of the candidate's own operation. This turns
 * the previous O(records) barrier scan per candidate/success pair into two
 * binary searches.
 */
function buildBarrierTimeline(records, options) {
  const stateChangeOrders = [];
  const ordersBySignature = new Map();
  let invalidRecord = false;
  for (const record of records) {
    if (!record || typeof record !== "object") {
      invalidRecord = true;
      continue;
    }
    if (!Number.isFinite(record.order)) continue;
    if (typeof record.tool !== "string" || record.tool.length === 0) {
      stateChangeOrders.push(record.order);
      continue;
    }
    if (options.readOnlyTools.has(record.tool)) continue;
    stateChangeOrders.push(record.order);
  }
  stateChangeOrders.sort((left, right) => left - right);
  return { stateChangeOrders, ordersBySignature, invalidRecord };
}

function barrierReason(candidate, newer, options, timeline) {
  if (!options.preserveOnStateChanges) return "";
  if (timeline.invalidRecord) return "unknown_intervening_record";
  const all = countBetween(timeline.stateChangeOrders, candidate.order, newer.order);
  if (all === 0) return "";
  const retries = timeline.ordersBySignature.get(candidate.signature) ?? [];
  const sameOperation = countBetween(retries, candidate.order, newer.order);
  return all > sameOperation ? "intervening_state_change" : "";
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

  // First pass: classify and collect the tools that actually have confirmed
  // errors. Successes of any other tool can never share an error signature, so
  // their (possibly huge) arguments never need to be serialized.
  const classifications = new Array(records.length);
  const candidateTools = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || typeof record !== "object") {
      classifications[index] = "invalid";
      increment(stats.skippedReasons, "invalid_record");
      continue;
    }
    if (isConfirmedError(record) && !hasCancellationMetadata(record)) {
      classifications[index] = "error";
      stats.confirmedErrorCount += 1;
      if (typeof record.tool === "string" && record.tool.length > 0) {
        candidateTools.add(record.tool);
      }
      continue;
    }
    classifications[index] = isConfirmedSuccess(record) ? "success" : "ambiguous";
  }

  const timeline = buildBarrierTimeline(records, options);
  const candidates = [];
  const successesBySignature = new Map();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const kind = classifications[index];
    if (kind === "invalid") continue;
    if (kind === "ambiguous") {
      stats.ambiguousResultCount += 1;
      continue;
    }
    // A confirmed error with a missing tool name is still reported by
    // candidateError; everything else whose tool cannot match a candidate is
    // irrelevant to Error Purge and is skipped without stringification.
    if (kind === "success" && !candidateTools.has(record.tool)) continue;
    if (kind === "error" && (typeof record.tool !== "string" || record.tool.length === 0)) {
      const candidate = candidateError(record, stats, "");
      if (candidate) candidates.push(candidate);
      continue;
    }
    if (!candidateTools.has(record.tool)) continue;

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
      } catch {
        signature = "";
      }
      if (signature && !options.readOnlyTools.has(record.tool)) {
        const list = timeline.ordersBySignature.get(signature);
        if (list) list.push(record.order);
        else timeline.ordersBySignature.set(signature, [record.order]);
      }
    }

    if (kind === "error") {
      const candidate = candidateError(record, stats, signature);
      if (candidate) candidates.push(candidate);
      continue;
    }

    const success = successRecord(record, stats, signature);
    if (!success) continue;
    const list = successesBySignature.get(success.signature);
    if (list) list.push(success);
    else successesBySignature.set(success.signature, [success]);
  }

  for (const list of timeline.ordersBySignature.values()) {
    list.sort((left, right) => left - right);
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
    const allSuccesses = successesBySignature.get(candidate.signature);
    if (!allSuccesses || allSuccesses.length === 0) continue;
    const laterSuccesses = allSuccesses.filter(
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
      const barrier = barrierReason(candidate, success.record, options, timeline);
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
  // Nested maps avoid building `${signature}\0${errorText}` keys, which would
  // copy potentially large error text for every candidate.
  if (options.pruneRepeatedFailures) {
    const groups = new Map(); // signature -> errorText -> candidates[]
    for (const candidate of candidates) {
      if (candidate.decided) continue;
      let byError = groups.get(candidate.signature);
      if (!byError) {
        byError = new Map();
        groups.set(candidate.signature, byError);
      }
      const list = byError.get(candidate.errorText);
      if (list) list.push(candidate);
      else byError.set(candidate.errorText, [candidate]);
    }

    for (const byError of groups.values()) {
      for (const group of byError.values()) {
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
          const barrier = barrierReason(candidate, keeper.record, options, timeline);
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
    }
  } else {
    const seen = new Map(); // signature -> Set(errorText)
    for (const candidate of candidates) {
      if (candidate.decided) continue;
      let byError = seen.get(candidate.signature);
      if (!byError) {
        byError = new Set();
        seen.set(candidate.signature, byError);
      }
      if (byError.has(candidate.errorText) && !candidate.blockedReason) {
        candidate.blockedReason = "repeated_failures_disabled";
      }
      byError.add(candidate.errorText);
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
