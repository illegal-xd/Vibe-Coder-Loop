/**
 * Token usage measurement and JSONL record schema (schema_version 1).
 *
 * This module is pure: no filesystem, no host hooks, no network. It turns the
 * runtime's normalized assistant-message usage plus the pruning statistics into
 * one compact record. Every measurement carries its own provenance so actual
 * provider usage can never be confused with a local estimate.
 *
 * Deliberately excluded from records: prompts, tool outputs, raw responses,
 * error text, file paths, credentials.
 */

import { countCodePoints, textTokenUnits } from "./core.js";

export { countCodePoints };

export const TOKEN_USAGE_SCHEMA_VERSION = 2;
export const TOKEN_USAGE_EVENT_TYPE = "model_request_usage";

/**
 * Identifier of the char-weight estimator. Bump it whenever the weights in
 * `textTokenUnits` change so old and new estimates stay distinguishable.
 */
export const TOKEN_ESTIMATOR_ID = "char_weight_v1";

export const SOURCE = Object.freeze({
  PROVIDER_USAGE: "provider_usage",
  /** Arithmetic on provider-reported numbers (e.g. input + output). */
  PROVIDER_DERIVED: "provider_usage_derived",
  TOKENIZER: "tokenizer_estimate",
  /** Estimated token count derived from a character-weight heuristic. */
  ESTIMATED_TOKENS_FROM_CHARS: "estimated_tokens_from_chars",
  /** Raw Unicode code-point count, when a character count is stored as-is. */
  CHAR_COUNT: "estimated_char_count",
  UNAVAILABLE: "unavailable",
});

/**
 * Valid record-level usage statuses.
 * - `actual`: complete, provider-reported, and consistency checks passed.
 * - `partial`: some provider-reported fields are present but others missing.
 * - `missing`: no usable provider-reported usage is available.
 * - `unverified`: fields are present but failed a consistency check, so they
 *   must not be aggregated as trustworthy actual usage.
 * - `estimated`: only local estimates are available (no provider usage).
 */
export const USAGE_STATUS = Object.freeze([
  "actual",
  "partial",
  "missing",
  "unverified",
  "estimated",
]);

export function unavailableMeasure() {
  return { value: null, source: SOURCE.UNAVAILABLE };
}

/**
 * Normalize one measurement. Anything that is not a finite non-negative
 * number becomes an explicit "unavailable" measurement instead of a zero, so
 * an unknown value is never reported as a measured one.
 */
export function measure(value, source = SOURCE.UNAVAILABLE) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return unavailableMeasure();
  }
  return { value: Math.round(value), source };
}

function safeJson(value) {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/** Rough token estimate for one string. Never reported as actual usage. */
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(textTokenUnits(text));
}

/** Wrap already-computed weighted units as a token estimate from chars. */
export function estimateFromUnits(units) {
  if (typeof units !== "number" || !Number.isFinite(units) || units < 0) {
    return unavailableMeasure();
  }
  return measure(Math.ceil(units), SOURCE.ESTIMATED_TOKENS_FROM_CHARS);
}

function partTokenUnits(part) {
  if (!part || typeof part !== "object") return 0;
  if (part.type === "text") {
    return typeof part.text === "string" ? textTokenUnits(part.text) : 0;
  }
  if (part.type === "subtask") {
    return typeof part.prompt === "string" ? textTokenUnits(part.prompt) : 0;
  }
  if (part.type === "tool") {
    const state = part.state;
    if (!state || typeof state !== "object") return 0;
    let units = 0;
    if (typeof state.output === "string") units += textTokenUnits(state.output);
    if (typeof state.error === "string") units += textTokenUnits(state.error);
    if (state.input !== undefined) units += textTokenUnits(safeJson(state.input));
    return units;
  }
  return 0;
}

/**
 * Weighted units for the parts of a request that are actually reachable from
 * the message list. System prompts, tool schemas, provider serialization and
 * multimodal payloads are not visible here and are therefore not counted.
 */
export function messagesTokenUnits(messages) {
  if (!Array.isArray(messages)) return null;
  let units = 0;
  for (const message of messages) {
    const parts = message && Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      units += partTokenUnits(part);
    }
  }
  return units;
}

/**
 * Estimated tokens for a message list at the request boundary.
 * The value is an estimated TOKEN count derived from `char_weight_v1`, not a
 * character count. Returns null when the input is not a message array.
 */
export function estimateMessagesTokens(messages) {
  const units = messagesTokenUnits(messages);
  if (units === null) return null;
  return estimateFromUnits(units);
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Extract provider-reported usage from a runtime assistant message.
 *
 * The runtime normalizes every provider into
 * `tokens: { input, output, reasoning, cache: { read, write } }`; the raw
 * provider payload is never exposed to plugins. The runtime maps:
 *   - OpenAI `prompt_tokens_details.cached_tokens` → `cache.read`
 *   - DeepSeek `prompt_cache_hit_tokens` → `cache.read`
 *   - Anthropic `cache_read_input_tokens` → `cache.read`
 *
 * Evidence from the opencode binary (`ax()` function) confirms the runtime
 * treats `input + cache.read + cache.write + output + reasoning` as **additive
 * disjoint components** (`measured = c.input + c.cache.read + c.cache.write +
 * c.output + c.reasoning`). For DeepSeek specifically, `prompt_tokens`
 * (uncached) and `prompt_cache_hit_tokens` (cached) are disjoint: `input` is
 * the uncached prompt portion and `cache.read` is the cached portion. Therefore
 * `cache.read > input` is **expected** (large cached prefix, small new suffix),
 * not a mapping error or anomaly.
 *
 * Consequences:
 * - No subset check (`cache.read <= input`) is applied — they are additive.
 * - No subset check (`reasoning <= output`) is applied — same additive model.
 * - `total_tokens` = additive sum of all available components (not `input +
 *   output`), matching the runtime's own formula.
 * - `uncached_input_tokens` = `input` under the additive model (input excludes
 *   cache). Confirmed for DeepSeek; consistent with the runtime's additive
 *   total formula for all providers.
 * - A 0 in any field within a confirmed-usage record is kept as
 *   `provider_usage(0)`: the runtime normalizes all fields to numbers, and a 0
 *   is the effective billing value (it may be a provider-omitted field
 *   defaulted to 0 by the runtime, but it cannot be distinguished from an
 *   explicit 0).
 * - If ALL components are 0, the record is marked `unverified` because the
 *   runtime initializes `tokens` to 0 and an all-zero terminal message almost
 *   always means usage was never populated by the provider.
 *
 * @param {unknown} info Assistant message info object.
 * @param {{transport?: string, terminal?: boolean}} [options]
 */
export function extractProviderUsage(info, options = {}) {
  const transport =
    typeof options.transport === "string" && options.transport.length > 0
      ? options.transport
      : SOURCE.UNAVAILABLE;
  const terminal = options.terminal !== false;
  const errors = [];

  const usage = {
    provider: null,
    model: null,
    transport,
    usage_status: "missing",
    input_tokens: unavailableMeasure(),
    output_tokens: unavailableMeasure(),
    total_tokens: unavailableMeasure(),
    cached_input_tokens: unavailableMeasure(),
    uncached_input_tokens: unavailableMeasure(),
    reasoning_tokens: unavailableMeasure(),
    errors,
  };

  if (!terminal) {
    errors.push("stream_ended_without_usage");
    return usage;
  }

  if (!info || typeof info !== "object") {
    errors.push("message_info_missing");
    return usage;
  }

  if (typeof info.providerID === "string" && info.providerID.length > 0) {
    usage.provider = info.providerID;
  }
  if (typeof info.modelID === "string" && info.modelID.length > 0) {
    usage.model = info.modelID;
  }

  const tokens = info.tokens;
  if (!tokens || typeof tokens !== "object") {
    errors.push("usage_missing");
    return usage;
  }

  const input = nonNegativeNumber(tokens.input);
  const output = nonNegativeNumber(tokens.output);
  const reasoning = nonNegativeNumber(tokens.reasoning);
  let cacheRead = null;
  let cacheWrite = null;
  const cache = tokens.cache;
  if (cache && typeof cache === "object") {
    cacheRead = nonNegativeNumber(cache.read);
    cacheWrite = nonNegativeNumber(cache.write);
  }

  // All available fields are recorded as-is (including zeros). Within a
  // confirmed-usage record a 0 is the effective billing value; the runtime
  // normalizes all fields to numbers and cannot distinguish "provider omitted"
  // from "explicit 0".
  if (input !== null) {
    usage.input_tokens = measure(input, SOURCE.PROVIDER_USAGE);
    // Under the additive model, input is the uncached prompt portion.
    usage.uncached_input_tokens = measure(input, SOURCE.PROVIDER_USAGE);
  }
  if (output !== null) {
    usage.output_tokens = measure(output, SOURCE.PROVIDER_USAGE);
  }
  if (reasoning !== null) {
    usage.reasoning_tokens = measure(reasoning, SOURCE.PROVIDER_USAGE);
  }
  if (cacheRead !== null) {
    usage.cached_input_tokens = measure(cacheRead, SOURCE.PROVIDER_USAGE);
  }
  if (cacheWrite !== null && cacheWrite > 0) {
    usage.cache_write_tokens = measure(cacheWrite, SOURCE.PROVIDER_USAGE);
  }

  // Total: additive sum of all available components, matching the runtime's
  // own ax() formula. The previous derivation (input + output) undercounted by
  // omitting cache.read, cache.write and reasoning.
  const components = [input, cacheRead, cacheWrite, output, reasoning].filter(
    (value) => value !== null,
  );
  if (components.length > 0) {
    const total = components.reduce((sum, value) => sum + value, 0);
    usage.total_tokens = measure(total, SOURCE.PROVIDER_DERIVED);
  }

  // If every available component is 0, usage was almost certainly never
  // populated by the provider (the runtime initializes tokens to all-zeros).
  const allZero = components.length > 0 && components.every((value) => value === 0);
  if (allZero) {
    errors.push("usage_zero_unverified");
    usage.usage_status = "unverified";
  } else if (input !== null && output !== null) {
    usage.usage_status = "actual";
  } else if (components.length > 0) {
    usage.usage_status = "partial";
  } else {
    usage.usage_status = "missing";
    errors.push("usage_missing");
  }

  return usage;
}

function intOrNull(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/**
 * Skip-reason buckets, each with a single consistent unit:
 * - `record_scan`: tool records inspected but not promoted to candidates
 *   (e.g. `unsupported_tool` counts every scanned bash/edit/read-only-failure
 *   call). These naturally exceed `candidate_items`.
 * - `candidate`: eligible candidates (or duplicate groups) that were not
 *   pruned by a guard (`referenced_later`, `no_token_benefit`, ...).
 * - `application`: decisions dropped while applying to the message array.
 */
const RECORD_SCAN_REASONS = new Set([
  "unsupported_tool",
  "not_completed",
  "empty_output",
  "already_pruned",
  "invalid_args",
  "missing_environment",
  "invalid_order",
  "duplicate_call_id",
  "invalid_record",
  "invalid_tool",
  "invalid_call_id",
  "invalid_success",
  "invalid_input",
  "invalid_messages",
  "disabled",
]);

const APPLICATION_REASONS = new Set([
  "apply_location_mismatch",
  "apply_state_mismatch",
  "apply_already_pruned",
  "apply_target_missing",
  "apply_no_change",
  "apply_validation_failed",
  "apply_array_mutation_failed",
]);

function partitionSkippedReasons(reasons) {
  const recordScan = {};
  const candidate = {};
  const application = {};
  if (!reasons || typeof reasons !== "object") {
    return { record_scan: recordScan, candidate, application };
  }
  for (const [key, value] of Object.entries(reasons)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const rounded = Math.round(value);
    if (RECORD_SCAN_REASONS.has(key)) recordScan[key] = rounded;
    else if (APPLICATION_REASONS.has(key)) application[key] = rounded;
    else candidate[key] = rounded;
  }
  return { record_scan: recordScan, candidate, application };
}

/**
 * One pruning strategy. Rules and preview only replace text with a
 * placeholder, so `removed_tokens` is the net saving (content minus
 * placeholder) already computed by the existing pipeline; it is an estimated
 * TOKEN count derived from `char_weight_v1`, never a billed-usage delta.
 */
function strategySummary(stats, fallbackEnabled) {
  if (!stats || typeof stats !== "object") return null;
  const removedItems = intOrNull(stats.prunedCount) ?? 0;
  const candidates = intOrNull(stats.candidateCount) ?? 0;
  const preserved =
    intOrNull(stats.preservedCount) ?? Math.max(0, candidates - removedItems);
  const removed = nonNegativeNumber(stats.tokenSavingsEstimated);
  return {
    enabled: stats.enabled !== false && fallbackEnabled !== false,
    preview: stats.preview === true,
    scanned_records: intOrNull(stats.recordsTotal) ?? 0,
    candidate_items: candidates,
    removed_items: removedItems,
    preserved_items: preserved,
    candidate_tokens: unavailableMeasure(),
    removed_tokens: removed !== null ? measure(removed, SOURCE.ESTIMATED_TOKENS_FROM_CHARS) : unavailableMeasure(),
    preserved_tokens: unavailableMeasure(),
    skipped: partitionSkippedReasons(stats.skippedReasons),
  };
}

/**
 * Attribute removals to the strategies in their real execution order.
 *
 * Dedup only rewrites `state.output` of completed read-only calls; Error Purge
 * only rewrites `state.error` of failed calls. The two rule sets therefore
 * cannot act on the same record, so sequential summation does not double
 * count. Attribution is summed from the applied decisions, not from candidate
 * size, so a candidate that was preserved contributes nothing.
 */
export function summarizePruning(stats) {
  if (!stats || typeof stats !== "object") return null;

  const deduplication = strategySummary(
    {
      enabled: stats.deduplicationEnabled,
      preview: stats.preview,
      recordsTotal: stats.recordsTotal,
      candidateCount: stats.candidateCount,
      prunedCount: stats.prunedCount,
      tokenSavingsEstimated: stats.tokenSavingsEstimated,
      skippedReasons: stats.skippedReasons,
    },
    stats.deduplicationEnabled,
  );
  const errorPurge = strategySummary(stats.errorPurge);

  if (!deduplication && !errorPurge) return null;

  const parts = [deduplication, errorPurge].filter(Boolean);
  let total = 0;
  let measured = true;
  for (const part of parts) {
    if (part.removed_items > 0 && part.removed_tokens.value === null) {
      measured = false;
      break;
    }
    total += part.removed_tokens.value ?? 0;
  }

  return {
    order: ["deduplication", "error_purge"],
    deduplication: deduplication ?? null,
    error_purge: errorPurge ?? null,
    total_removed_tokens: measured ? measure(total, SOURCE.ESTIMATED_TOKENS_FROM_CHARS) : unavailableMeasure(),
    measurement_source: SOURCE.ESTIMATED_TOKENS_FROM_CHARS,
    attribution: "incremental_sequential",
    token_unit_note:
      "removed_tokens and total_removed_tokens are estimated token counts from char_weight_v1, not character counts or billed usage.",
  };
}

function isoOrNull(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toISOString();
}

function shortId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function knownErrors(errors) {
  if (!Array.isArray(errors)) return [];
  const result = [];
  for (const error of errors) {
    if (typeof error === "string" && error.length > 0 && !result.includes(error)) {
      result.push(error.slice(0, 64));
    }
  }
  return result;
}

function measureOrUnavailable(value) {
  if (!value || typeof value !== "object") return unavailableMeasure();
  return measure(value.value, typeof value.source === "string" ? value.source : SOURCE.UNAVAILABLE);
}

function contextEstimate(value) {
  if (!value || typeof value !== "object") return null;
  return {
    value: Number.isFinite(value.value) ? Math.round(value.value) : null,
    source: typeof value.source === "string" ? value.source : SOURCE.UNAVAILABLE,
  };
}

/**
 * Build the versioned record. Unknown input keys are dropped by construction:
 * only the fields listed here can ever reach the log.
 */
export function buildUsageRecord(input = {}) {
  const usage = input.usage ?? {};
  const estimates = input.context_estimates ?? null;
  const pruning = input.pruning ?? null;

  const before = estimates ? contextEstimate(estimates.before_pruning) : null;
  const after = estimates ? contextEstimate(estimates.after_pruning) : null;

  const record = {
    schema_version: TOKEN_USAGE_SCHEMA_VERSION,
    event_type: TOKEN_USAGE_EVENT_TYPE,
    timestamp: isoOrNull(input.timestamp) ?? new Date().toISOString(),
    session_id: shortId(input.session_id),
    request_id: shortId(input.request_id),
    provider: shortId(usage.provider),
    model: shortId(usage.model),
    transport:
      typeof usage.transport === "string" && usage.transport.length > 0
        ? usage.transport
        : SOURCE.UNAVAILABLE,
    usage_status: USAGE_STATUS.includes(usage.usage_status)
      ? usage.usage_status
      : "missing",
    input_tokens: measureOrUnavailable(usage.input_tokens),
    output_tokens: measureOrUnavailable(usage.output_tokens),
    total_tokens: measureOrUnavailable(usage.total_tokens),
    cached_input_tokens: measureOrUnavailable(usage.cached_input_tokens),
    uncached_input_tokens: measureOrUnavailable(usage.uncached_input_tokens),
    reasoning_tokens: measureOrUnavailable(usage.reasoning_tokens),
    context_estimates:
      before || after
        ? { before_pruning: before, after_pruning: after }
        : { before_pruning: null, after_pruning: null },
    pruning,
    errors: knownErrors([...(Array.isArray(usage.errors) ? usage.errors : []), ...(input.errors ?? [])]),
  };

  if (usage.cache_write_tokens) {
    record.cache_write_tokens = measureOrUnavailable(usage.cache_write_tokens);
  }
  if (before || after || (pruning && pruning.measurement_source)) {
    record.estimator = TOKEN_ESTIMATOR_ID;
  }

  return record;
}

/** One complete JSON object plus a newline, or null when the record is unusable. */
export function serializeUsageRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.schema_version !== TOKEN_USAGE_SCHEMA_VERSION) return null;
  if (record.event_type !== TOKEN_USAGE_EVENT_TYPE) return null;
  if (isoOrNull(record.timestamp) === null) return null;
  try {
    const line = JSON.stringify(record);
    if (typeof line !== "string") return null;
    if (line.includes("\n") || line.includes("\r")) return null;
    return `${line}\n`;
  } catch {
    return null;
  }
}

/**
 * Bounded, time-limited association between the pruning measured at the
 * request boundary and the assistant message that later reports usage.
 * `take` consumes the entry, so one transform measurement is attached to at
 * most one usage record (no double counting on retries or extra steps).
 */
export function createPendingPruneStore(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 10 * 60 * 1000;
  const maxSessions = Number.isInteger(options.maxSessions) ? options.maxSessions : 64;
  const clock = typeof options.now === "function" ? options.now : () => Date.now();
  const map = new Map();

  function sweep() {
    const at = clock();
    for (const [key, entry] of map) {
      if (at - entry.at > ttlMs) map.delete(key);
    }
  }

  return {
    set(sessionID, value) {
      if (typeof sessionID !== "string" || sessionID.length === 0) return false;
      sweep();
      map.delete(sessionID);
      map.set(sessionID, { value, at: clock() });
      while (map.size > maxSessions) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
      return true;
    },
    take(sessionID) {
      if (typeof sessionID !== "string" || sessionID.length === 0) return null;
      const entry = map.get(sessionID);
      if (!entry) return null;
      map.delete(sessionID);
      if (clock() - entry.at > ttlMs) return null;
      return entry.value;
    },
    size() {
      sweep();
      return map.size;
    },
  };
}

/** Bounded insert-only set used to log each terminal message exactly once. */
export function createSeenIdSet(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 2048;
  const seen = new Set();
  const order = [];
  return {
    has(id) {
      return seen.has(id);
    },
    add(id) {
      if (typeof id !== "string" || id.length === 0) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      order.push(id);
      while (order.length > limit) {
        const oldest = order.shift();
        seen.delete(oldest);
      }
      return true;
    },
    size() {
      return seen.size;
    },
  };
}
