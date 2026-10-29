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
  isPlainObject,
  isPrunedOutput,
  planDeduplication,
  textTokenUnits,
} from "./core.js";
import { createErrorPurgeStats, planErrorPurge } from "./error-purge.js";
import {
  CONTENT_KEYS,
  DEFAULT_WRITE_TOOLS,
  createSupersedeWritesStats,
  planSupersedeWrites,
} from "./supersede-writes.js";
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
      const time =
        state.time && typeof state.time === "object" && !Array.isArray(state.time) ? state.time : null;
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
        time,
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

function searchableStrings(part, skipPayloadTools) {
  if (!part || typeof part !== "object") return null;
  const candidates = [];
  if (typeof part.text === "string") candidates.push(part.text);
  if (part.type === "subtask" && typeof part.prompt === "string") candidates.push(part.prompt);
  if (part.type === TOOL_PART) {
    // Write payloads (file content / diffs) are data, not conversational
    // references. Serializing megabytes of content here is both expensive and
    // prone to false positives, so skip input/metadata for write-like tools.
    const skipPayload =
      skipPayloadTools !== null &&
      skipPayloadTools !== undefined &&
      typeof part.tool === "string" &&
      skipPayloadTools.has(part.tool);
    if (part.metadata !== undefined && !skipPayload) candidates.push(safeStringify(part.metadata));
    const state = part.state;
    if (state && typeof state === "object") {
      if (typeof state.output === "string") candidates.push(state.output);
      if (typeof state.error === "string") candidates.push(state.error);
      if (state.input !== undefined && !skipPayload) candidates.push(safeStringify(state.input));
      if (state.metadata !== undefined && !skipPayload) {
        candidates.push(safeStringify(state.metadata));
      }
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
export function buildReferenceIndex(orderedParts, callIds, startOrderExclusive = -Infinity, options = {}) {
  const refsById = new Map();
  const skipPayloadTools =
    options && options.skipPayloadTools instanceof Set ? options.skipPayloadTools : null;
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
    const strings = searchableStrings(item.part, skipPayloadTools);
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

/**
 * Map a parts array without allocating a new array (or copying unchanged part
 * references) when no part changes. Messages with no target parts therefore
 * keep their original array and object.
 */
function mapPartsLazily(parts, transform) {
  let result = null;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const next = transform(part, index);
    if (next !== part) {
      if (!result) result = parts.slice(0, index);
      result.push(next);
    } else if (result) {
      result.push(part);
    }
  }
  return result;
}

function applyFieldDecisions(messages, decisions, locations, field) {
  const byId = new Map();
  for (const decision of decisions) {
    if (!decision || typeof decision.id !== "string" || decision.field !== field) continue;
    if (!byId.has(decision.id)) byId.set(decision.id, decision);
  }

  if (byId.size === 0) {
    return { messages, changed: false, applied: [], dropped: [], validation: null };
  }

  const applied = [];
  const dropped = [];
  const appliedIds = new Set();
  const replacements = new Map();

  const result = messages.map((message, messageIndex) => {
    if (!message || !Array.isArray(message.parts)) return message;

    const parts = mapPartsLazily(message.parts, (part, partIndex) => {
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

      applied.push({
        ...decision,
        previousValue: part.state[field],
        replacement,
      });
      appliedIds.add(part.callID);
      replacements.set(part.callID, replacement);
      return { ...part, state: { ...part.state, [field]: replacement } };
    });

    return parts ? { ...message, parts } : message;
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
 * Validate a Supersede Writes transform. Unlike the single-field validators,
 * this allows `state.input` and `state.output` to change on target parts
 * (input content redacted, output replaced by placeholder) while every other
 * field — status, title, metadata, time, attachments, callID, tool, message
 * identity, message/part counts — must be byte-for-byte unchanged.
 */
function validateSupersedeStructure(before, after, appliedIds, redactions) {
  const failures = [];
  if (before.length !== after.length) failures.push("message_count");

  const unchangedStateKeys = ["status", "title", "metadata", "time", "attachments", "error", "raw"];
  const unchangedPartKeys = ["id", "sessionID", "messageID", "type", "callID", "tool", "metadata"];

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
      const isTarget =
        beforePart?.type === TOOL_PART &&
        typeof beforePart.callID === "string" &&
        appliedIds.has(beforePart.callID);

      if (beforePart === afterPart) {
        if (isTarget) failures.push(`target_not_cloned:${messageIndex}:${partIndex}`);
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

      const redaction = redactions.get(beforePart.callID);
      if (!redaction) {
        failures.push(`redaction_missing:${messageIndex}:${partIndex}`);
      } else {
        if (!sameValue(afterState.input, redaction.redactedInput)) {
          failures.push(`input_redaction:${messageIndex}:${partIndex}`);
        }
        if (afterState.output !== redaction.replacement) {
          failures.push(`output_replacement:${messageIndex}:${partIndex}`);
        }
      }

      for (const key of unchangedStateKeys) {
        if (!sameValue(beforeState[key], afterState[key])) {
          failures.push(`state_${key}_changed:${messageIndex}:${partIndex}`);
        }
      }
      for (const key of unchangedPartKeys) {
        if (!sameValue(beforePart[key], afterPart[key])) {
          failures.push(`part_${key}_changed:${messageIndex}:${partIndex}`);
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Supersede Writes decisions: redact the bulky content fields of a write
 * tool's `state.input` and replace its `state.output` with a placeholder.
 * The file path, status, metadata, and audit identity are preserved.
 */
export function applySupersedeWriteDecisions(messages, decisions, locations) {
  const byId = new Map();
  for (const decision of decisions) {
    if (!decision || typeof decision.id !== "string") continue;
    if (decision.field !== "input+output") continue;
    if (!byId.has(decision.id)) byId.set(decision.id, decision);
  }

  if (byId.size === 0) {
    return { messages, changed: false, applied: [], dropped: [], validation: null };
  }

  const applied = [];
  const dropped = [];
  const appliedIds = new Set();
  const redactions = new Map();

  const result = messages.map((message, messageIndex) => {
    if (!message || !Array.isArray(message.parts)) return message;

    const parts = mapPartsLazily(message.parts, (part, partIndex) => {
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

      if (!part.state || part.state.status !== "completed") {
        dropped.push({ id: part.callID, reason: "state_mismatch" });
        return part;
      }
      // Prefer the original input reference captured by the planner: it avoids
      // duplicating large file content as a JSON string. Keep the legacy JSON
      // comparison for decisions built by older callers/tests.
      const inputMatches =
        decision.expectedInput !== undefined
          ? part.state.input === decision.expectedInput
          : safeStringify(part.state.input) === decision.expectedInputJson;
      if (
        typeof part.state.output !== "string" ||
        part.state.output !== decision.expectedOutput ||
        !inputMatches
      ) {
        dropped.push({ id: part.callID, reason: "state_mismatch" });
        return part;
      }
      if (isPrunedOutput(part.state.output) && isPrunedInput(part.state.input, decision.replacement)) {
        dropped.push({ id: part.callID, reason: "already_pruned" });
        return part;
      }
      if (
        part.state.output === decision.replacement &&
        safeStringify(part.state.input) === safeStringify(decision.redactedInput)
      ) {
        dropped.push({ id: part.callID, reason: "no_change" });
        return part;
      }

      applied.push({
        ...decision,
        previousOutput: part.state.output,
        previousInput: part.state.input,
      });
      appliedIds.add(part.callID);
      redactions.set(part.callID, {
        redactedInput: decision.redactedInput,
        replacement: decision.replacement,
      });
      return {
        ...part,
        state: {
          ...part.state,
          input: decision.redactedInput,
          output: decision.replacement,
        },
      };
    });

    return parts ? { ...message, parts } : message;
  });

  for (const id of byId.keys()) {
    if (!appliedIds.has(id) && !dropped.some((item) => item.id === id)) {
      dropped.push({ id, reason: "target_missing" });
    }
  }

  if (applied.length === 0) {
    return { messages, changed: false, applied, dropped, validation: null };
  }

  const validation = validateSupersedeStructure(messages, result, appliedIds, redactions);
  if (!validation.ok) {
    return { messages, changed: false, applied: [], dropped, validation };
  }

  return { messages: result, changed: true, applied, dropped, validation };
}

/** Removal metrics for one applied Supersede Writes decision. */
function supersedeRemovalMetrics(decision) {
  if (Number.isFinite(decision.bytesRemoved) && Number.isFinite(decision.tokenUnitsRemoved)) {
    return {
      bytes: Math.max(0, decision.bytesRemoved),
      units: Math.max(0, decision.tokenUnitsRemoved),
    };
  }
  // Legacy decision shape (no precomputed metrics): derive once here.
  const previousInputJson = safeStringify(decision.previousInput);
  const redactedInputJson = safeStringify(decision.redactedInput);
  return {
    bytes: Math.max(
      0,
      byteLength(decision.previousOutput) +
        byteLength(previousInputJson) -
        byteLength(decision.replacement) -
        byteLength(redactedInputJson),
    ),
    units:
      textTokenUnits(previousInputJson) -
      textTokenUnits(redactedInputJson) +
      textTokenUnits(decision.previousOutput) -
      textTokenUnits(decision.replacement),
  };
}

function isPrunedInput(input, placeholder) {
  if (!isPlainObject(input)) return false;
  for (const key of CONTENT_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && (value === placeholder || value.startsWith(PRUNE_MARKER))) {
      continue;
    }
    return false;
  }
  return true;
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
    errorPurgeConfig.preview !== undefined && errorPurgeConfig.preview !== null
      ? errorPurgeConfig.preview === true
      : stats.preview;
  stats.deduplicationEnabled = dedupEnabled;
  stats.errorPurge = createErrorPurgeStats();
  stats.errorPurge.enabled = errorPurgeEnabled;
  stats.errorPurge.preview = errorPurgePreview;

  const supersedeConfig = config.supersedeWrites ?? {};
  const supersedeEnabled = stats.enabled && supersedeConfig.enabled !== false;
  const supersedePreview =
    supersedeConfig.preview !== undefined && supersedeConfig.preview !== null
      ? supersedeConfig.preview === true
      : stats.preview;
  stats.supersedeWrites = createSupersedeWritesStats();
  stats.supersedeWrites.enabled = supersedeEnabled;
  stats.supersedeWrites.preview = supersedePreview;
  // Referencing a write call id from inside another write's file content is
  // not a conversational reference; avoid serializing those payloads.
  const writePayloadTools = new Set(
    Array.isArray(supersedeConfig.writeTools)
      ? supersedeConfig.writeTools
      : DEFAULT_WRITE_TOOLS,
  );

  const placeholder =
    typeof config.placeholder === "string" && config.placeholder.startsWith(PRUNE_MARKER)
      ? config.placeholder
      : DEFAULT_PLACEHOLDER;

  const finish = () => {
    stats.durationMs = Number((now() - started).toFixed(3));
    stats.errorPurge.durationMs = stats.durationMs;
    stats.supersedeWrites.durationMs = stats.durationMs;
    return stats;
  };

  if (!Array.isArray(messages)) {
    increment(stats.skippedReasons, "invalid_messages");
    finish();
    return {
      messages,
      changed: false,
      stats,
      decisions: [],
      errorPurgeDecisions: [],
      supersedeWritesDecisions: [],
    };
  }

  if (!stats.enabled) {
    increment(stats.skippedReasons, "disabled", messages.length);
    stats.errorPurge.skippedReasons.disabled = messages.length;
    stats.supersedeWrites.skippedReasons.disabled = messages.length;
    finish();
    return {
      messages,
      changed: false,
      stats,
      decisions: [],
      errorPurgeDecisions: [],
      supersedeWritesDecisions: [],
    };
  }

  if (messages.length === 0) {
    finish();
    return {
      messages,
      changed: false,
      stats,
      decisions: [],
      errorPurgeDecisions: [],
      supersedeWritesDecisions: [],
    };
  }

  const extraction = extractToolRecords(messages);
  mergeReasons(stats.skippedReasons, extraction.skippedReasons);
  if (extraction.structuralFailure) {
    stats.error = extraction.structuralFailure;
    stats.errorPurge.error = extraction.structuralFailure;
    stats.supersedeWrites.error = extraction.structuralFailure;
    finish();
    return {
      messages,
      changed: false,
      stats,
      decisions: [],
      errorPurgeDecisions: [],
      supersedeWritesDecisions: [],
    };
  }

  // Compute every plan before applying anything: the plans only read the
  // extracted records, and doing this up front lets the reference guard scan
  // the message list once instead of once per strategy.
  const errorPlan = planErrorPurge(extraction.records, {
    ...errorPurgeConfig,
    enabled: errorPurgeEnabled,
    readOnlyTools: config.tools,
    mutationTools: config.mutationTools,
  });
  const supersedePlan = planSupersedeWrites(extraction.records, {
    ...supersedeConfig,
    enabled: supersedeEnabled,
    mutationTools: config.mutationTools,
    readOnlyTools: config.tools,
  });

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
  const protectErrorReferences = errorPurgeConfig.protectReferences !== false;
  const protectSupersedeReferences = supersedeConfig.protectReferences !== false;

  // One reference index for all three strategies. The scan starts at the
  // earliest decision order because nothing earlier can reference a decision.
  const referenceIds = [];
  const referenceOrders = [];
  for (const [enabled, decisions] of [
    [protectCallIds, dedupPlan.decisions],
    [protectErrorReferences, errorPlan.decisions],
    [protectSupersedeReferences, supersedePlan.decisions],
  ]) {
    if (!enabled) continue;
    for (const decision of decisions) {
      if (typeof decision.id !== "string" || decision.id.length === 0) continue;
      referenceIds.push(decision.id);
      if (Number.isFinite(decision.order)) referenceOrders.push(decision.order);
    }
  }
  let referenceStartOrder = Number.POSITIVE_INFINITY;
  for (const order of referenceOrders) {
    if (order < referenceStartOrder) referenceStartOrder = order;
  }
  if (!Number.isFinite(referenceStartOrder)) referenceStartOrder = -Infinity;
  const referenceIndex =
    referenceIds.length > 0
      ? buildReferenceIndex(
          extraction.orderedParts,
          referenceIds,
          referenceStartOrder,
          { skipPayloadTools: writePayloadTools },
        )
      : null;

  const dedupDecisions = [];
  for (const decision of dedupPlan.decisions) {
    if (
      protectCallIds &&
      indexHasReference(referenceIndex, decision.id, decision.order, decision.keeperOrder)
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
  stats.errorPurge = {
    ...errorPlan.stats,
    enabled: errorPurgeEnabled,
    preview: errorPurgePreview,
    tokenSavingsEstimated: errorPurgePreview ? 0 : errorPlan.stats.tokenSavingsEstimated,
  };

  const errorDecisions = [];
  for (const decision of errorPlan.decisions) {
    if (
      protectErrorReferences &&
      indexHasReference(referenceIndex, decision.id, decision.order, Number.POSITIVE_INFINITY)
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

  // ---------------------------------------------------------------------
  // Strategy 3: Supersede Writes (independent switch and preview)
  // ---------------------------------------------------------------------
  stats.supersedeWrites = {
    ...supersedePlan.stats,
    enabled: supersedeEnabled,
    preview: supersedePreview,
    tokenSavingsEstimated: supersedePreview ? 0 : supersedePlan.stats.tokenSavingsEstimated,
  };

  const supersedeDecisions = [];
  for (const decision of supersedePlan.decisions) {
    if (
      protectSupersedeReferences &&
      indexHasReference(referenceIndex, decision.id, decision.order, Number.POSITIVE_INFINITY)
    ) {
      increment(stats.supersedeWrites.skippedReasons, "referenced_later");
      continue;
    }
    supersedeDecisions.push(decision);
  }
  stats.supersedeWrites.wouldPruneCount = supersedeDecisions.length;
  stats.supersedeWrites.preservedCount = Math.max(
    0,
    stats.supersedeWrites.candidateCount - supersedeDecisions.length,
  );
  stats.supersedeWrites.highConfidencePruneCount = supersedeDecisions.filter(
    (decision) => decision.confidence === "high",
  ).length;
  stats.supersedeWrites.decisionKinds = countDecisionKinds(supersedeDecisions);
  stats.supersedeWrites.tokenSavingsEstimatedIfApplied = supersedeDecisions.reduce(
    (total, decision) => total + decision.estimatedTokensSaved,
    0,
  );

  let supersedeChanged = false;
  if (!supersedePreview) {
    const supersedeApplication = applySupersedeWriteDecisions(
      currentMessages,
      supersedeDecisions,
      extraction.locations,
    );
    mergeReasons(stats.supersedeWrites.skippedReasons, {
      apply_location_mismatch: countDropped(supersedeApplication.dropped, "location_mismatch"),
      apply_state_mismatch: countDropped(supersedeApplication.dropped, "state_mismatch"),
      apply_already_pruned: countDropped(supersedeApplication.dropped, "already_pruned"),
      apply_target_missing: countDropped(supersedeApplication.dropped, "target_missing"),
      apply_no_change: countDropped(supersedeApplication.dropped, "no_change"),
    });
    if (supersedeApplication.validation && !supersedeApplication.validation.ok) {
      increment(
        stats.supersedeWrites.skippedReasons,
        "apply_validation_failed",
        supersedeApplication.validation.failures.length,
      );
      stats.supersedeWrites.error = "apply_validation_failed";
    }
    stats.supersedeWrites.prunedCount = supersedeApplication.applied.length;
    stats.supersedeWrites.changed = supersedeApplication.changed;
    stats.supersedeWrites.tokenSavingsEstimated = supersedeApplication.applied.reduce(
      (total, decision) => total + Math.max(0, decision.estimatedTokensSaved ?? 0),
      0,
    );
    let supersededBytesRemoved = 0;
    for (const decision of supersedeApplication.applied) {
      const metrics = supersedeRemovalMetrics(decision);
      supersededBytesRemoved += metrics.bytes;
      if (measureContext) removedUnits += metrics.units;
    }
    stats.supersedeWrites.outputBytesRemovedActual = supersededBytesRemoved;
    stats.supersedeWrites.preservedCount = Math.max(
      0,
      stats.supersedeWrites.candidateCount - supersedeApplication.applied.length,
    );
    stats.supersedeWrites.highConfidencePruneCount = supersedeApplication.applied.filter(
      (decision) => decision.confidence === "high",
    ).length;
    stats.supersedeWrites.decisionKinds = countDecisionKinds(supersedeApplication.applied);
    supersedeChanged = supersedeApplication.changed;
    currentMessages = supersedeApplication.messages;
  }

  stats.changed = dedupChanged || errorChanged || supersedeChanged;
  if (contextUnits) contextUnits.after = contextUnits.before - removedUnits;
  finish();
  return {
    messages: currentMessages,
    changed: stats.changed,
    stats,
    decisions: dedupDecisions,
    errorPurgeDecisions: errorDecisions,
    supersedeWritesDecisions: supersedeDecisions,
    contextUnits,
  };
}

