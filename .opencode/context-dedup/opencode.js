/**
 * OpenCode message adapter.
 *
 * The only OpenCode-specific knowledge in this file is the message shape:
 *   { info: Message, parts: Part[] }
 * and ToolPart's { callID, tool, state: { status, input, output, ... } }.
 * That shape is taken from the installed @opencode-ai/sdk types, not from
 * documentation examples.
 *
 * The adapter never mutates the input message objects. It extracts normalized
 * records, asks the host-neutral core for decisions, applies only output
 * replacements to cloned parts, validates the result, and otherwise returns
 * the original context unchanged.
 */

import {
  DEFAULT_PLACEHOLDER,
  byteLength,
  createStats,
  PRUNE_MARKER,
  isPrunedOutput,
  planDeduplication,
  textTokenUnits,
} from "./core.js";
import { createErrorPurgeStats, planErrorPurge } from "./error-purge.js";
import { messagesTokenUnits } from "./token-usage.js";

const TOOL_PART = "tool";
const now =
  typeof performance === "object" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

function increment(map, key, amount = 1) {
  if (!key || amount <= 0) return;
  map[key] = (map[key] ?? 0) + amount;
}

function mergeReasons(target, source) {
  if (!source || typeof source !== "object") return;
  for (const [key, value] of Object.entries(source)) {
    if (Number.isFinite(value) && value > 0) increment(target, key, value);
  }
}

function countDropped(dropped, reason) {
  return dropped.filter((item) => item?.reason === reason).length;
}

function countDecisionKinds(decisions) {
  const result = {};
  for (const decision of decisions) {
    const kind = typeof decision?.kind === "string" ? decision.kind : "unknown";
    result[kind] = (result[kind] ?? 0) + 1;
  }
  return result;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function resolveEnvironment(info) {
  // An unknown cwd is ambiguous and must not be treated as equal to the
  // project directory, so there is deliberately no fallback.
  const pathInfo =
    info && typeof info === "object" && info.path && typeof info.path === "object"
      ? info.path
      : null;
  if (!pathInfo) return null;
  const cwd =
    typeof pathInfo.cwd === "string" && pathInfo.cwd.length > 0 ? pathInfo.cwd : "";
  if (!cwd) return null;
  const root =
    typeof pathInfo.root === "string" && pathInfo.root.length > 0 ? pathInfo.root : cwd;
  return { cwd, root };
}

/**
 * Extract normalized tool records from OpenCode messages.
 *
 * Returns `structuralFailure` when any message or tool part is malformed.
 * In that case the caller must fall back to the original context; partially
 * understood history is not safe to prune.
 */
export function extractToolRecords(messages) {
  const records = [];
  const locations = new Map();
  const orderedParts = [];
  const skippedReasons = {};
  let structuralFailure = "";
  let order = 0;
  let userSegment = 0;

  if (!Array.isArray(messages)) {
    return {
      records,
      locations,
      orderedParts,
      skippedReasons,
      structuralFailure: "invalid_messages",
    };
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const info = message && typeof message === "object" ? message.info : null;
    if (
      !message ||
      typeof message !== "object" ||
      !info ||
      typeof info !== "object" ||
      typeof info.id !== "string" ||
      info.id.length === 0 ||
      (info.role !== "user" && info.role !== "assistant") ||
      !Array.isArray(message.parts)
    ) {
      increment(skippedReasons, "invalid_message");
      structuralFailure = "invalid_message";
      continue;
    }

    if (info.role === "user") userSegment += 1;
    const environment = resolveEnvironment(info);

    for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
      const part = message.parts[partIndex];
      const partOrder = order;
      order += 1;
      orderedParts.push({ order: partOrder, messageIndex, partIndex, part, userSegment });

      if (!part || typeof part !== "object" || part.type !== TOOL_PART) continue;

      if (
        typeof part.callID !== "string" ||
        part.callID.length === 0 ||
        typeof part.tool !== "string" ||
        part.tool.length === 0
      ) {
        increment(skippedReasons, "invalid_tool_part");
        structuralFailure = "invalid_tool_part";
        continue;
      }

      const state = part.state;
      if (!state || typeof state !== "object") {
        increment(skippedReasons, "invalid_tool_part");
        structuralFailure = "invalid_tool_part";
        continue;
      }

      const status = typeof state.status === "string" ? state.status : "unknown";
      const output = typeof state.output === "string" ? state.output : "";
      const error = typeof state.error === "string" ? state.error : "";
      const metadata = state.metadata !== undefined ? state.metadata : undefined;
      const record = {
        id: part.callID,
        order: partOrder,
        tool: part.tool,
        args: state.input,
        env: environment ?? { cwd: "" },
        status,
        output,
        error,
        metadata,
        userSegment,
      };
      records.push(record);

      if (locations.has(part.callID)) {
        increment(skippedReasons, "duplicate_call_id");
        structuralFailure = "duplicate_call_id";
        continue;
      }
      locations.set(part.callID, {
        messageIndex,
        partIndex,
        messageID: typeof info.id === "string" ? info.id : "",
        partID: typeof part.id === "string" ? part.id : "",
        callID: part.callID,
        tool: part.tool,
        status,
        output,
        error,
        metadata,
        userSegment,
      });
    }
  }

  return { records, locations, orderedParts, skippedReasons, structuralFailure };
}

/**
 * Conservatively detect whether a later part references an older call id.
 * A hit only blocks pruning (fail-safe), so false positives are acceptable.
 *
 * Implemented on top of a per-request reference index built once from all
 * searchable part text. The original per-decision scan walked every later
 * part and re-stringified its metadata for each decision, which was the
 * dominant cost in error-heavy conversations (≈14ms / 120 decisions).
 */
export function referencesCallId(orderedParts, callId, fromOrderExclusive, toOrderExclusive) {
  if (!Array.isArray(orderedParts) || typeof callId !== "string" || callId.length === 0) {
    return false;
  }
  const index = buildReferenceIndex(orderedParts, [callId], fromOrderExclusive);
  return indexHasReference(index, callId, fromOrderExclusive, toOrderExclusive);
}

/** Scan every part after the error for a reference to its call id. */
export function referencesCallIdAfter(orderedParts, callId, fromOrderExclusive) {
  return referencesCallId(orderedParts, callId, fromOrderExclusive, Number.POSITIVE_INFINITY);
}

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(text) {
  return text.replace(REGEX_ESCAPE, "\\$&");
}

function searchableStrings(part) {
  if (!part || typeof part !== "object") return null;
  const candidates = [];
  if (typeof part.text === "string") candidates.push(part.text);
  if (part.type === "subtask" && typeof part.prompt === "string") candidates.push(part.prompt);
  if (part.type === TOOL_PART) {
    if (part.metadata !== undefined) candidates.push(safeStringify(part.metadata));
    const state = part.state;
    if (state && typeof state === "object") {
      if (typeof state.output === "string") candidates.push(state.output);
      if (typeof state.error === "string") candidates.push(state.error);
      if (state.input !== undefined) candidates.push(safeStringify(state.input));
      if (state.metadata !== undefined) candidates.push(safeStringify(state.metadata));
    }
  }
  return candidates.length > 0 ? candidates : null;
}

/**
 * Build a map from call id to the ascending list of `order`s whose part text
 * contains that id. `startOrderExclusive` prunes the scan to parts that could
 * ever matter (no decision can be referenced before it is made). A single
 * alternation regex matches every id in one pass per part instead of one pass
 * per id per part.
 */
export function buildReferenceIndex(orderedParts, callIds, startOrderExclusive = -Infinity) {
  const refsById = new Map();
  if (!Array.isArray(orderedParts) || !Array.isArray(callIds) || callIds.length === 0) {
    return { refsById };
  }
  const unique = new Set();
  for (const id of callIds) {
    if (typeof id === "string" && id.length > 0) unique.add(id);
  }
  if (unique.size === 0) return { refsById };

  const pattern = new RegExp([...unique].map(escapeRegex).join("|"), "g");

  for (const item of orderedParts) {
    if (!item || !Number.isFinite(item.order) || item.order <= startOrderExclusive) continue;
    const strings = searchableStrings(item.part);
    if (!strings) continue;
    for (const text of strings) {
      if (typeof text !== "string" || text.length === 0) continue;
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match !== null) {
        const matched = match[0];
        if (matched.length === 0) {
          pattern.lastIndex += 1;
          match = pattern.exec(text);
          continue;
        }
        let orders = refsById.get(matched);
        if (!orders) {
          orders = [];
          refsById.set(matched, orders);
        }
        if (orders[orders.length - 1] !== item.order) orders.push(item.order);
        match = pattern.exec(text);
      }
    }
  }
  return { refsById };
}

function earliestOrder(decisions) {
  let earliest = Number.POSITIVE_INFINITY;
  for (const decision of decisions) {
    if (Number.isFinite(decision?.order) && decision.order < earliest) {
      earliest = decision.order;
    }
  }
  return Number.isFinite(earliest) ? earliest : -Infinity;
}

function lowerBound(orders, target) {
  let low = 0;
  let high = orders.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (orders[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Does any part with `order` strictly inside (from, to) reference `callId`? */
export function indexHasReference(index, callId, fromOrderExclusive, toOrderExclusive) {
  if (!index || !index.refsById) return false;
  const orders = index.refsById.get(callId);
  if (!orders || orders.length === 0) return false;
  const position = lowerBound(orders, fromOrderExclusive);
  return position < orders.length && orders[position] < toOrderExclusive;
}

function sameValue(left, right) {
  return Object.is(left, right);
}

function validateStructure(before, after, appliedIds, field, replacements) {
  const failures = [];
  if (before.length !== after.length) failures.push("message_count");

  const stateKeys = [
    "status",
    "title",
    "input",
    "output",
    "metadata",
    "time",
    "attachments",
    "error",
    "raw",
  ].filter((key) => key !== field);

  const limit = Math.min(before.length, after.length);
  for (let messageIndex = 0; messageIndex < limit; messageIndex += 1) {
    const beforeMessage = before[messageIndex];
    const afterMessage = after[messageIndex];
    if (!beforeMessage || !afterMessage) {
      failures.push(`message_missing:${messageIndex}`);
      continue;
    }
    if (beforeMessage.info?.id !== afterMessage.info?.id) {
      failures.push(`message_id:${messageIndex}`);
    }

    const beforeParts = Array.isArray(beforeMessage.parts) ? beforeMessage.parts : [];
    const afterParts = Array.isArray(afterMessage.parts) ? afterMessage.parts : [];
    if (beforeParts.length !== afterParts.length) {
      failures.push(`part_count:${messageIndex}`);
      continue;
    }

    for (let partIndex = 0; partIndex < beforeParts.length; partIndex += 1) {
      const beforePart = beforeParts[partIndex];
      const afterPart = afterParts[partIndex];
      if (beforePart === afterPart) {
        if (beforePart?.type === TOOL_PART && appliedIds.has(beforePart.callID)) {
          failures.push(`target_not_cloned:${messageIndex}:${partIndex}`);
        }
        continue;
      }

      if (
        !beforePart ||
        !afterPart ||
        beforePart.type !== TOOL_PART ||
        afterPart.type !== TOOL_PART ||
        beforePart.callID !== afterPart.callID ||
        !appliedIds.has(beforePart.callID)
      ) {
        failures.push(`unexpected_part_change:${messageIndex}:${partIndex}`);
        continue;
      }

      const beforeState = beforePart.state;
      const afterState = afterPart.state;
      if (!beforeState || !afterState) {
        failures.push(`state_missing:${messageIndex}:${partIndex}`);
        continue;
      }
      if (afterState[field] !== replacements.get(beforePart.callID)) {
        failures.push(`replacement_missing:${messageIndex}:${partIndex}`);
      }
      for (const key of stateKeys) {
        if (!sameValue(beforeState[key], afterState[key])) {
          failures.push(`state_${key}_changed:${messageIndex}:${partIndex}`);
        }
      }
      for (const key of ["id", "sessionID", "messageID", "type", "callID", "tool", "metadata"]) {
        if (!sameValue(beforePart[key], afterPart[key])) {
          failures.push(`part_${key}_changed:${messageIndex}:${partIndex}`);
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

function applyFieldDecisions(messages, decisions, locations, field) {
  const byId = new Map();
  for (const decision of decisions) {
    if (!decision || typeof decision.id !== "string" || decision.field !== field) continue;
    if (!byId.has(decision.id)) byId.set(decision.id, decision);
  }

  const applied = [];
  const dropped = [];
  const appliedIds = new Set();
  const replacements = new Map();

  const result = messages.map((message, messageIndex) => {
    if (!message || !Array.isArray(message.parts)) return message;
    let changed = false;

    const parts = message.parts.map((part, partIndex) => {
      if (!part || part.type !== TOOL_PART || typeof part.callID !== "string") return part;
      const decision = byId.get(part.callID);
      if (!decision) return part;

      const location = locations.get(part.callID);
      if (
        !location ||
        location.messageIndex !== messageIndex ||
        location.partIndex !== partIndex ||
        location.tool !== part.tool
      ) {
        dropped.push({ id: part.callID, reason: "location_mismatch" });
        return part;
      }

      const expected =
        decision.expectedValue !== undefined ? decision.expectedValue : location[field];
      const replacement = decision.replacement;
      const expectedStatus =
        decision.expectedStatus ?? (field === "output" ? "completed" : "error");
      if (
        !part.state ||
        part.state.status !== expectedStatus ||
        typeof part.state[field] !== "string" ||
        part.state[field] !== expected ||
        typeof replacement !== "string"
      ) {
        dropped.push({ id: part.callID, reason: "state_mismatch" });
        return part;
      }
      if (isPrunedOutput(part.state[field])) {
        dropped.push({ id: part.callID, reason: "already_pruned" });
        return part;
      }
      if (part.state[field] === replacement) {
        dropped.push({ id: part.callID, reason: "no_change" });
        return part;
      }

      changed = true;
      applied.push({
        ...decision,
        previousValue: part.state[field],
        replacement,
      });
      appliedIds.add(part.callID);
      replacements.set(part.callID, replacement);
      return { ...part, state: { ...part.state, [field]: replacement } };
    });

    return changed ? { ...message, parts } : message;
  });

  for (const id of byId.keys()) {
    if (!appliedIds.has(id) && !dropped.some((item) => item.id === id)) {
      dropped.push({ id, reason: "target_missing" });
    }
  }

  if (applied.length === 0) {
    return { messages, changed: false, applied, dropped, validation: null };
  }

  const validation = validateStructure(messages, result, appliedIds, field, replacements);
  if (!validation.ok) {
    return {
      messages,
      changed: false,
      applied: [],
      dropped,
      validation,
    };
  }

  return { messages: result, changed: true, applied, dropped, validation };
}

/**
 * Dedup compatibility wrapper: output-field decisions.
 */
export function applyDecisions(messages, decisions, locations, placeholder) {
  const normalized = decisions.map((decision) => ({
    ...decision,
    field: "output",
    expectedStatus: decision.expectedStatus ?? "completed",
    expectedValue:
      decision.expectedValue !== undefined ? decision.expectedValue : locations.get(decision.id)?.output,
    replacement: decision.replacement ?? placeholder,
  }));
  return applyFieldDecisions(messages, normalized, locations, "output");
}

/**
 * Error Purge decisions: replace the structured error string only.
 */
export function applyErrorPurgeDecisions(messages, decisions, locations) {
  return applyFieldDecisions(messages, decisions, locations, "error");
}

/**
 * Full request transformation: extract once, then run independent dedup and
 * error-purge plans. Each strategy has its own preview switch and statistics.
 * The function never mutates the input message objects and falls back to the
 * original array on any structural or validation uncertainty.
 */
export function transformMessages(messages, config = {}) {
  config = config ?? {};
  const started = now();
  const stats = createStats();
  stats.enabled = config.enabled !== false;
  stats.preview = config.preview === true;

  // When the caller asks for context-token measurement, compute the "before"
  // estimate once here and derive "after" from the applied decisions, so the
  // plugin never has to walk the whole message list a second time.
  const measureContext = config.measureContext === true;
  const contextUnits = measureContext
    ? { before: messagesTokenUnits(messages) ?? 0, after: 0 }
    : null;
  let removedUnits = 0;

  const dedupEnabled = stats.enabled && config.deduplication?.enabled !== false;
  const errorPurgeConfig = config.errorPurge ?? {};
  const errorPurgeEnabled = stats.enabled && errorPurgeConfig.enabled !== false;
  const errorPurgePreview =
    errorPurgeConfig.preview !== undefined
      ? errorPurgeConfig.preview === true
      : stats.preview;
  stats.deduplicationEnabled = dedupEnabled;
  stats.errorPurge = createErrorPurgeStats();
  stats.errorPurge.enabled = errorPurgeEnabled;
  stats.errorPurge.preview = errorPurgePreview;

  const placeholder =
    typeof config.placeholder === "string" && config.placeholder.startsWith(PRUNE_MARKER)
      ? config.placeholder
      : DEFAULT_PLACEHOLDER;

  const finish = () => {
    stats.durationMs = Number((now() - started).toFixed(3));
    stats.errorPurge.durationMs = stats.durationMs;
    return stats;
  };

  if (!Array.isArray(messages)) {
    increment(stats.skippedReasons, "invalid_messages");
    finish();
    return { messages, changed: false, stats, decisions: [], errorPurgeDecisions: [] };
  }

  if (!stats.enabled) {
    increment(stats.skippedReasons, "disabled", messages.length);
    stats.errorPurge.skippedReasons.disabled = messages.length;
    finish();
    return { messages, changed: false, stats, decisions: [], errorPurgeDecisions: [] };
  }

  if (messages.length === 0) {
    finish();
    return { messages, changed: false, stats, decisions: [], errorPurgeDecisions: [] };
  }

  const extraction = extractToolRecords(messages);
  mergeReasons(stats.skippedReasons, extraction.skippedReasons);
  if (extraction.structuralFailure) {
    stats.error = extraction.structuralFailure;
    stats.errorPurge.error = extraction.structuralFailure;
    finish();
    return { messages, changed: false, stats, decisions: [], errorPurgeDecisions: [] };
  }

  // ---------------------------------------------------------------------
  // Strategy 1: deduplication (existing behavior, preserved)
  // ---------------------------------------------------------------------
  const dedupPlan = planDeduplication(extraction.records, {
    ...config,
    enabled: dedupEnabled,
    placeholder,
  });
  stats.recordsTotal = dedupPlan.stats.recordsTotal;
  stats.candidateCount = dedupPlan.stats.candidateCount;
  stats.duplicateGroupCount = dedupPlan.stats.duplicateGroupCount;
  stats.sameSignatureDifferentOutputGroups = dedupPlan.stats.sameSignatureDifferentOutputGroups;
  stats.plannedPruneCount = dedupPlan.stats.plannedPruneCount;
  mergeReasons(stats.skippedReasons, dedupPlan.stats.skippedReasons);

  const protectCallIds = config.protectCallIdReferences !== false;
  // Build the reference index once for all dedup decisions instead of scanning
  // the message list once per decision. The scan starts at the earliest
  // decision order because nothing earlier can reference a decision id.
  const dedupRefIndex = protectCallIds && dedupPlan.decisions.length > 0
    ? buildReferenceIndex(
        extraction.orderedParts,
        dedupPlan.decisions.map((decision) => decision.id),
        earliestOrder(dedupPlan.decisions),
      )
    : null;

  const dedupDecisions = [];
  for (const decision of dedupPlan.decisions) {
    if (
      protectCallIds &&
      indexHasReference(dedupRefIndex, decision.id, decision.order, decision.keeperOrder)
    ) {
      increment(stats.skippedReasons, "referenced_later");
      continue;
    }
    dedupDecisions.push(decision);
  }
  stats.wouldPruneCount = dedupDecisions.length;
  stats.tokenSavingsEstimatedIfApplied = dedupDecisions.reduce(
    (total, decision) => total + decision.estimatedTokensSaved,
    0,
  );

  let currentMessages = messages;
  let dedupChanged = false;
  if (!stats.preview) {
    const application = applyDecisions(
      currentMessages,
      dedupDecisions,
      extraction.locations,
      placeholder,
    );
    mergeReasons(stats.skippedReasons, {
      apply_location_mismatch: countDropped(application.dropped, "location_mismatch"),
      apply_state_mismatch: countDropped(application.dropped, "state_mismatch"),
      apply_already_pruned: countDropped(application.dropped, "already_pruned"),
      apply_target_missing: countDropped(application.dropped, "target_missing"),
      apply_no_change: countDropped(application.dropped, "no_change"),
    });
    if (application.validation && !application.validation.ok) {
      increment(
        stats.skippedReasons,
        "apply_validation_failed",
        application.validation.failures.length,
      );
      stats.error = "apply_validation_failed";
    }
    stats.prunedCount = application.applied.length;
    stats.changed = application.changed;
    stats.tokenSavingsEstimated = application.applied.reduce((total, decision) => {
      return total + Math.max(0, decision.estimatedTokensSaved ?? 0);
    }, 0);
    stats.outputBytesRemovedActual = application.applied.reduce((total, decision) => {
      return total + Math.max(0, byteLength(decision.previousValue) - byteLength(placeholder));
    }, 0);
    if (measureContext) {
      for (const decision of application.applied) {
        removedUnits += textTokenUnits(decision.previousValue) - textTokenUnits(decision.replacement);
      }
    }
    dedupChanged = application.changed;
    currentMessages = application.messages;
  }

  // ---------------------------------------------------------------------
  // Strategy 2: Error Purge (independent switch and preview)
  // ---------------------------------------------------------------------
  const errorPlan = planErrorPurge(extraction.records, {
    ...errorPurgeConfig,
    enabled: errorPurgeEnabled,
    readOnlyTools: config.tools,
    mutationTools: config.mutationTools,
  });
  stats.errorPurge = {
    ...errorPlan.stats,
    enabled: errorPurgeEnabled,
    preview: errorPurgePreview,
    tokenSavingsEstimated: errorPurgePreview ? 0 : errorPlan.stats.tokenSavingsEstimated,
  };

  const protectErrorReferences = errorPurgeConfig.protectReferences !== false;
  const errorRefIndex = protectErrorReferences && errorPlan.decisions.length > 0
    ? buildReferenceIndex(
        extraction.orderedParts,
        errorPlan.decisions.map((decision) => decision.id),
        earliestOrder(errorPlan.decisions),
      )
    : null;

  const errorDecisions = [];
  for (const decision of errorPlan.decisions) {
    if (
      protectErrorReferences &&
      indexHasReference(errorRefIndex, decision.id, decision.order, Number.POSITIVE_INFINITY)
    ) {
      increment(stats.errorPurge.skippedReasons, "referenced_later");
      continue;
    }
    errorDecisions.push(decision);
  }
  stats.errorPurge.wouldPruneCount = errorDecisions.length;
  stats.errorPurge.preservedCount = Math.max(
    0,
    stats.errorPurge.candidateCount - errorDecisions.length,
  );
  stats.errorPurge.highConfidencePruneCount = errorDecisions.filter(
    (decision) => decision.confidence === "high",
  ).length;
  stats.errorPurge.mediumConfidencePruneCount = errorDecisions.filter(
    (decision) => decision.confidence === "medium",
  ).length;
  stats.errorPurge.decisionKinds = countDecisionKinds(errorDecisions);
  stats.errorPurge.tokenSavingsEstimatedIfApplied = errorDecisions.reduce(
    (total, decision) => total + decision.estimatedTokensSaved,
    0,
  );

  let errorChanged = false;
  if (!errorPurgePreview) {
    const errorApplication = applyErrorPurgeDecisions(
      currentMessages,
      errorDecisions,
      extraction.locations,
    );
    mergeReasons(stats.errorPurge.skippedReasons, {
      apply_location_mismatch: countDropped(errorApplication.dropped, "location_mismatch"),
      apply_state_mismatch: countDropped(errorApplication.dropped, "state_mismatch"),
      apply_already_pruned: countDropped(errorApplication.dropped, "already_pruned"),
      apply_target_missing: countDropped(errorApplication.dropped, "target_missing"),
      apply_no_change: countDropped(errorApplication.dropped, "no_change"),
    });
    if (errorApplication.validation && !errorApplication.validation.ok) {
      increment(
        stats.errorPurge.skippedReasons,
        "apply_validation_failed",
        errorApplication.validation.failures.length,
      );
      stats.errorPurge.error = "apply_validation_failed";
    }
    stats.errorPurge.prunedCount = errorApplication.applied.length;
    stats.errorPurge.changed = errorApplication.changed;
    stats.errorPurge.tokenSavingsEstimated = errorApplication.applied.reduce(
      (total, decision) => total + Math.max(0, decision.estimatedTokensSaved ?? 0),
      0,
    );
    stats.errorPurge.outputBytesRemovedActual = errorApplication.applied.reduce(
      (total, decision) => {
        return total + Math.max(0, byteLength(decision.previousValue) - byteLength(decision.replacement));
      },
      0,
    );
    if (measureContext) {
      for (const decision of errorApplication.applied) {
        removedUnits += textTokenUnits(decision.previousValue) - textTokenUnits(decision.replacement);
      }
    }
    stats.errorPurge.preservedCount = Math.max(
      0,
      stats.errorPurge.candidateCount - errorApplication.applied.length,
    );
    stats.errorPurge.highConfidencePruneCount = errorApplication.applied.filter(
      (decision) => decision.confidence === "high",
    ).length;
    stats.errorPurge.mediumConfidencePruneCount = errorApplication.applied.filter(
      (decision) => decision.confidence === "medium",
    ).length;
    stats.errorPurge.decisionKinds = countDecisionKinds(errorApplication.applied);
    errorChanged = errorApplication.changed;
    currentMessages = errorApplication.messages;
  }

  stats.changed = dedupChanged || errorChanged;
  if (contextUnits) contextUnits.after = contextUnits.before - removedUnits;
  finish();
  return {
    messages: currentMessages,
    changed: stats.changed,
    stats,
    decisions: dedupDecisions,
    errorPurgeDecisions: errorDecisions,
    contextUnits,
  };
}

