/**
 * Host-neutral Error Purge core.
 *
 * Error Purge only considers a result a confirmed failure when the runtime
 * exposes structured failure state. For OpenCode that is:
 *   ToolPart.state.status === "error" && typeof state.error === "string"
 *
 * It never classifies a completed result as an error just because its output
 * contains words like "error" or "failed". Shell hard-failure detection is an
 * opt-in exception: it defaults to `ambiguous` (never successful, never an
 * error) and only `shellFailureDetection: "error"` treats a match as a
 * confirmed error. Completed shell output is never assumed successful when the
 * host's exit status is unreliable.
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
 *
 * When a rule fires, the failed call's bulky input strings are redacted too
 * (parity with the reference implementation's "prune errored tool inputs").
 * This is lossless by construction: the surviving equivalent call carries the
 * same arguments, so the content still exists later in the conversation. The
 * error message itself is only replaced when that replacement is smaller.
 *
 * An optional, disabled-by-default rule (`staleInputAfterUserTurns`) redacts
 * the input of confirmed errors older than N user turns without touching the
 * error message. The reference implementation prunes on turn age alone; this
 * port keeps that behavior opt-in so the default stays evidence-based.
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
  protectedReason,
  textTokenUnits,
} from "./core.js";

export const DEFAULT_ERROR_PLACEHOLDER =
  `${PRUNE_MARKER} Error output omitted: a later equivalent successful ` +
  "result superseded it. The failure status is retained.";

export const DUPLICATE_ERROR_PLACEHOLDER =
  `${PRUNE_MARKER} Earlier duplicate failure output omitted; ` +
  "the latest equivalent failure is retained.";

export const DEFAULT_ERROR_INPUT_PLACEHOLDER =
  `${PRUNE_MARKER} Failed call input omitted: an equivalent newer call ` +
  "retains the same arguments. The failure status is retained.";

export const DEFAULT_STALE_INPUT_PLACEHOLDER =
  `${PRUNE_MARKER} Failed call input omitted: the failure is older than the ` +
  "retention window. The failure status and error message are retained.";

/** Shell tools whose completed state does not prove success in every host. */
export const SHELL_TOOLS = Object.freeze(["bash"]);

export const DEFAULT_SHELL_FAILURE_DETECTION = "ambiguous";
export const SHELL_FAILURE_DETECTION_MODES = Object.freeze(["off", "ambiguous", "error"]);

/**
 * Conservative hard-failure markers for completed shell output. These are
 * evidence that the call did not succeed; they are never used for formatting
 * or wording. Detection is opt-in as an error (default: ambiguous) because the
 * output is still text, not structured state.
 */
export const DEFAULT_SHELL_FAILURE_PATTERNS = Object.freeze([
  /(?:^|\r?\n)(?:\/bin\/)?(?:ba|z|k|fi)?sh: [^\n]*: command not found(?:\r?\n|$)/,
  /(?:^|\r?\n)grep: [^\n]*: No such file or directory(?:\r?\n|$)/,
  /(?:^|\r?\n)Error: Cannot find module /,
  /(?:^|\r?\n)npm ERR!/,
  /(?:^|\r?\n)ERROR\s+Build failed(?: with errors)?/,
  /(?:^|\r?\n)exit(?: code)?[=:]\s*[1-9]\d*(?:\r?\n|$)/i,
]);

/**
 * Input keys that identify *what* failed (paths, selectors, short labels).
 * They are small and diagnostically useful, so they are never redacted.
 */
const ERROR_INPUT_KEEP_KEYS = new Set([
  "filePath",
  "path",
  "file",
  "filename",
  "fileName",
  "cwd",
  "directory",
  "dir",
  "root",
  "worktree",
  "pattern",
  "glob",
  "include",
  "exclude",
  "query",
  "url",
  "name",
  "id",
  "description",
]);

/**
 * Redact the bulky string values of a failed call's input. Returns null when
 * nothing is worth redacting, otherwise `{ input, savedTokens }`.
 *
 * Only top-level strings larger than the placeholder are replaced, so the
 * object shape and every identifying field stay intact.
 */
export function redactErrorInput(input, placeholder) {
  if (!isPlainObject(input)) return null;
  const placeholderUnits = textTokenUnits(placeholder);
  const redacted = Object.create(null);
  let savedUnits = 0;
  let changed = false;
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (
      typeof value === "string" &&
      !ERROR_INPUT_KEEP_KEYS.has(key) &&
      textTokenUnits(value) > placeholderUnits
    ) {
      redacted[key] = placeholder;
      savedUnits += textTokenUnits(value) - placeholderUnits;
      changed = true;
      continue;
    }
    redacted[key] = value;
  }
  if (!changed) return null;
  return { input: redacted, savedTokens: Math.ceil(savedUnits) };
}

export const HIGH_CONFIDENCE = "high";
export const MEDIUM_CONFIDENCE = "medium";

export function createErrorPurgeStats() {
  return {
    enabled: true,
    preview: false,
    recordsTotal: 0,
    confirmedErrorCount: 0,
    ambiguousResultCount: 0,
    // Completed shell records that cannot be trusted as successes because the
    // host does not propagate a reliable exit status.
    unverifiedShellCount: 0,
    // Completed shell records whose output matched an explicit hard-failure
    // marker (classified as ambiguous or error according to the mode).
    shellFailureCount: 0,
    shellExitReliable: true,
    shellFailureDetection: DEFAULT_SHELL_FAILURE_DETECTION,
    candidateCount: 0,
    eligibleCount: 0,
    // Candidates that have at least one later same-signature success. This is
    // the funnel step between "eligible" and "marked": failures with no later
    // equivalent success can never be pruned.
    potentialSupersedeCount: 0,
    markedCount: 0,
    plannedPruneCount: 0,
    wouldPruneCount: 0,
    prunedCount: 0,
    preservedCount: 0,
    highConfidencePruneCount: 0,
    mediumConfidencePruneCount: 0,
    decisionKinds: {},
    inputRedactedCount: 0,
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
  const protectedTools = Array.isArray(config.protectedTools)
    ? config.protectedTools.filter((tool) => typeof tool === "string" && tool.trim().length > 0)
    : [];
  const protectedFilePatterns = Array.isArray(config.protectedFilePatterns)
    ? config.protectedFilePatterns.filter(
        (pattern) => typeof pattern === "string" && pattern.trim().length > 0,
      )
    : [];
  const staleInputAfterUserTurns =
    Number.isInteger(config.staleInputAfterUserTurns) && config.staleInputAfterUserTurns > 0
      ? config.staleInputAfterUserTurns
      : 0;
  // Host-neutral default is "trusted" for backward compatibility. The
  // OpenCode adapter resolves `shellExitReliable: false` because that runtime
  // reports exit 0 even for failed commands.
  const shellExitReliable = config.shellExitReliable !== false;
  const shellFailureDetection = SHELL_FAILURE_DETECTION_MODES.includes(
    config.shellFailureDetection,
  )
    ? config.shellFailureDetection
    : DEFAULT_SHELL_FAILURE_DETECTION;

  return {
    enabled,
    placeholder: validPlaceholder(config.placeholder, DEFAULT_ERROR_PLACEHOLDER),
    duplicatePlaceholder: validPlaceholder(
      config.duplicatePlaceholder,
      DUPLICATE_ERROR_PLACEHOLDER,
    ),
    inputPlaceholder: validPlaceholder(
      config.inputPlaceholder,
      DEFAULT_ERROR_INPUT_PLACEHOLDER,
    ),
    staleInputPlaceholder: validPlaceholder(
      config.staleInputPlaceholder,
      DEFAULT_STALE_INPUT_PLACEHOLDER,
    ),
    readOnlyTools,
    preserveAcrossUserTurns: config.preserveAcrossUserTurns !== false,
    preserveOnStateChanges: config.preserveOnStateChanges !== false,
    pruneRepeatedFailures: config.pruneRepeatedFailures !== false,
    minSuccesses,
    redactInputPayload: config.redactInputPayload !== false,
    staleInputAfterUserTurns,
    shellExitReliable,
    shellFailureDetection,
    protectedTools,
    protectedFilePatterns,
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

function isShellTool(tool) {
  return typeof tool === "string" && SHELL_TOOLS.includes(tool);
}

/**
 * Detect a hard shell failure encoded only in output. Only completed shell
 * records are considered; structured errors are handled before this check.
 */
function detectShellFailure(record) {
  if (!record || !isShellTool(record.tool) || record.status !== "completed") {
    return false;
  }
  const output = typeof record.output === "string" ? record.output : "";
  if (!output) return false;
  return DEFAULT_SHELL_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * A completed shell call is not proof of success when the host does not
 * propagate a reliable exit status (OpenCode reports exit 0 for failures).
 * Such records must never act as a superseder.
 */
function isUnverifiedShellSuccess(record, options) {
  return (
    !options.shellExitReliable &&
    record?.status === "completed" &&
    isShellTool(record.tool) &&
    !hasFailureMetadata(record.metadata) &&
    !(typeof record.error === "string" && record.error.trim().length > 0)
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

function candidateError(record, stats, signature, options) {
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
  const protectReason = protectedReason(record, options);
  if (protectReason) {
    increment(stats.skippedReasons, protectReason);
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
    rule1Reason: "",
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
  stats.shellExitReliable = options.shellExitReliable;
  stats.shellFailureDetection = options.shellFailureDetection;

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

    const shellFailure = detectShellFailure(record);
    if (
      shellFailure &&
      options.shellFailureDetection === "error" &&
      !hasCancellationMetadata(record)
    ) {
      classifications[index] = "error";
      stats.confirmedErrorCount += 1;
      stats.shellFailureCount += 1;
      if (typeof record.tool === "string" && record.tool.length > 0) {
        candidateTools.add(record.tool);
      }
      continue;
    }

    if (isConfirmedSuccess(record)) {
      if (shellFailure && options.shellFailureDetection === "ambiguous") {
        classifications[index] = "ambiguous";
        stats.shellFailureCount += 1;
        continue;
      }
      if (isUnverifiedShellSuccess(record, options)) {
        classifications[index] = "unverified_shell";
        stats.unverifiedShellCount += 1;
        continue;
      }
      classifications[index] = "success";
      continue;
    }

    if (shellFailure) stats.shellFailureCount += 1;
    classifications[index] = "ambiguous";
  }

  const timeline = buildBarrierTimeline(records, options);
  const candidates = [];
  const successesBySignature = new Map();
  // Diagnostic only: which tools ever produced a confirmed success and when.
  // Bounded by the tools that actually have a confirmed error.
  const successOrdersByTool = new Map();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const kind = classifications[index];
    if (kind === "invalid") continue;
    if (kind === "unverified_shell") continue;
    if (kind === "ambiguous") {
      stats.ambiguousResultCount += 1;
      continue;
    }
    // A confirmed error with a missing tool name is still reported by
    // candidateError; everything else whose tool cannot match a candidate is
    // irrelevant to Error Purge and is skipped without stringification.
    if (kind === "success" && !candidateTools.has(record.tool)) continue;
    if (kind === "error" && (typeof record.tool !== "string" || record.tool.length === 0)) {
      const candidate = candidateError(record, stats, "", options);
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
      const candidate = candidateError(record, stats, signature, options);
      if (candidate) candidates.push(candidate);
      continue;
    }

    const success = successRecord(record, stats, signature);
    if (!success) continue;
    const list = successesBySignature.get(success.signature);
    if (list) list.push(success);
    else successesBySignature.set(success.signature, [success]);
    let orders = successOrdersByTool.get(record.tool);
    if (orders) orders.push(success.order);
    else successOrdersByTool.set(record.tool, [success.order]);
  }

  for (const list of timeline.ordersBySignature.values()) {
    list.sort((left, right) => left - right);
  }

  const decisions = [];
  // Every candidate that at least one rule could prune. A Set keeps Rule 1
  // (later equivalent success) and Rule 2 (repeated identical failure) from
  // double counting the same record in the funnel.
  const prunableOrders = new Set();

  const decide = (
    candidate,
    keeper,
    kind,
    confidence,
    replacement,
    redactionOverride,
    inputPlaceholderOverride,
  ) => {
    // The error message is only replaced when the replacement is smaller;
    // redacting the input is a separate, independently profitable change.
    const errorSaved = estimateTokens(candidate.errorText) - estimateTokens(replacement);
    const replaceError = errorSaved > 0;
    const inputPlaceholder = inputPlaceholderOverride ?? options.inputPlaceholder;
    const redaction =
      redactionOverride !== undefined
        ? redactionOverride
        : options.redactInputPayload
          ? redactErrorInput(candidate.record.args, inputPlaceholder)
          : null;
    const inputSaved = redaction ? redaction.savedTokens : 0;
    const estimatedTokensSaved = (replaceError ? errorSaved : 0) + inputSaved;
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
      keeperId: keeper?.record?.id,
      keeperOrder: keeper?.order,
      field: "error",
      expectedValue: candidate.errorText,
      replacement: replaceError ? replacement : candidate.errorText,
      replaceError,
      estimatedTokensSaved,
    };
    if (redaction) {
      // Reference, not a copy: the adapter verifies identity before applying
      // and never duplicates the payload as a string.
      decision.expectedInput = candidate.record.args;
      decision.redactedInput = redaction.input;
      decision.inputPlaceholder = inputPlaceholder;
      stats.inputRedactedCount += 1;
    }
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
    if (!allSuccesses || allSuccesses.length === 0) {
      // Diagnostic only: repeated identical failures (Rule 2) may still prune.
      if (!candidate.rule1Reason) {
        const orders = successOrdersByTool.get(candidate.record.tool) ?? [];
        candidate.rule1Reason = orders.some((order) => order > candidate.order)
          ? "later_success_args_changed"
          : "no_success_for_signature";
      }
      continue;
    }
    const laterSuccesses = allSuccesses.filter(
      (success) => success.order > candidate.order,
    );
    if (laterSuccesses.length === 0) {
      if (!candidate.rule1Reason) candidate.rule1Reason = "success_only_before_error";
      continue;
    }
    stats.potentialSupersedeCount += 1;
    prunableOrders.add(candidate.order);

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
        for (const member of group) prunableOrders.add(member.order);
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

  // Optional third rule (parity with the reference implementation's turn-based
  // purge): redact the input payload of confirmed errors older than N user
  // turns while preserving the error message. Disabled by default so the
  // default policy still requires positive evidence that the failure is dead.
  if (options.redactInputPayload && options.staleInputAfterUserTurns > 0) {
    let latestUserSegment = 0;
    for (const record of records) {
      if (record && Number.isFinite(record.userSegment)) {
        latestUserSegment = Math.max(latestUserSegment, record.userSegment);
      }
    }
    for (const candidate of candidates) {
      if (candidate.decided) continue;
      if (latestUserSegment - candidate.userSegment < options.staleInputAfterUserTurns) {
        continue;
      }
      const redaction = redactErrorInput(
        candidate.record.args,
        options.staleInputPlaceholder,
      );
      if (!redaction) continue;
      if (
        decide(
          candidate,
          null,
          "stale_failure_input",
          MEDIUM_CONFIDENCE,
          candidate.errorText,
          redaction,
          options.staleInputPlaceholder,
        )
      ) {
        prunableOrders.add(candidate.order);
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate.decided) continue;
    increment(
      stats.skippedReasons,
      candidate.blockedReason || candidate.rule1Reason || "no_superseding_evidence",
    );
  }

  decisions.sort((left, right) => left.order - right.order);
  stats.candidateCount = candidates.length;
  stats.eligibleCount = candidates.length;
  stats.markedCount = decisions.length;
  stats.prunableCount = prunableOrders.size;
  stats.plannedPruneCount = decisions.length;
  stats.preservedCount = Math.max(0, candidates.length - decisions.length);
  return { decisions, stats };
}
