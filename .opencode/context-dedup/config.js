/**
 * Configuration for the context-deduplication plugin.
 *
 * The file format is strict JSON (not JSONC) so this module needs no parser
 * dependency. Unknown keys are ignored for forward compatibility; invalid
 * known keys fail closed in the adapter.
 */

import {
  DEFAULT_MUTATION_TOOLS,
  DEFAULT_PLACEHOLDER,
  DEFAULT_READ_ONLY_TOOLS,
  PRUNE_MARKER,
} from "./core.js";
import {
  DEFAULT_ERROR_PLACEHOLDER,
  DUPLICATE_ERROR_PLACEHOLDER,
} from "./error-purge.js";
import {
  DEFAULT_SUPERSEDE_PLACEHOLDER,
  DEFAULT_SUPERSEDE_READ_TOOLS,
  DEFAULT_WRITE_TOOLS,
} from "./supersede-writes.js";

export const DEFAULT_LOG_MAX_BYTES = 512 * 1024;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  preview: false,
  tools: Object.freeze([...DEFAULT_READ_ONLY_TOOLS]),
  placeholder: DEFAULT_PLACEHOLDER,
  barrierOnNonWhitelistedTools: true,
  protectCallIdReferences: true,
  mutationTools: Object.freeze([...DEFAULT_MUTATION_TOOLS]),
  deduplication: Object.freeze({
    enabled: true,
  }),
  errorPurge: Object.freeze({
    enabled: true,
    preview: null,
    placeholder: DEFAULT_ERROR_PLACEHOLDER,
    duplicatePlaceholder: DUPLICATE_ERROR_PLACEHOLDER,
    preserveAcrossUserTurns: true,
    preserveOnStateChanges: true,
    pruneRepeatedFailures: true,
    protectReferences: true,
    minSuccesses: 1,
  }),
  supersedeWrites: Object.freeze({
    enabled: true,
    preview: null,
    placeholder: DEFAULT_SUPERSEDE_PLACEHOLDER,
    writeTools: Object.freeze([...DEFAULT_WRITE_TOOLS]),
    readTools: Object.freeze([...DEFAULT_SUPERSEDE_READ_TOOLS]),
    preserveAcrossUserTurns: false,
    barrierOnBroadMutations: true,
    protectReferences: true,
    requireFullRead: true,
  }),
  log: Object.freeze({
    enabled: true,
    onlyWhenActive: true,
    path: null,
    maxBytes: DEFAULT_LOG_MAX_BYTES,
  }),
  tokenUsage: Object.freeze({
    enabled: true,
    path: null,
  }),
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isTruthy(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function assertBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${field} must be a boolean`);
  }
  return value;
}

function stringList(value, field, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new ConfigError(`${field} must be an array of strings`);
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ConfigError(`${field} must contain non-empty strings`);
    }
    const normalized = item.trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  if (result.length === 0) {
    throw new ConfigError(`${field} must contain at least one tool`);
  }
  return result;
}

function assertPlaceholder(value, field, fallback) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !value.startsWith(PRUNE_MARKER) ||
    value.length > 500
  ) {
    throw new ConfigError(
      `${field} must be a string starting with ${PRUNE_MARKER} and at most 500 chars`,
    );
  }
  return value;
}

function resolveDeduplication(raw) {
  if (raw === undefined) return { ...DEFAULT_CONFIG.deduplication };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("deduplication must be an object");
  }
  return {
    enabled:
      raw.enabled === undefined
        ? DEFAULT_CONFIG.deduplication.enabled
        : assertBoolean(raw.enabled, "deduplication.enabled"),
  };
}

function resolveErrorPurge(raw, env, globalPreview) {
  env = env ?? {};
  if (raw === undefined) {
    const defaults = DEFAULT_CONFIG.errorPurge;
    return {
      ...defaults,
      enabled: isTruthy(env.VIBE_CONTEXT_ERROR_PURGE_DISABLED)
        ? false
        : defaults.enabled,
      preview: isTruthy(env.VIBE_CONTEXT_ERROR_PURGE_PREVIEW)
        ? true
        : globalPreview,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("errorPurge must be an object");
  }

  const enabled =
    raw.enabled === undefined
      ? DEFAULT_CONFIG.errorPurge.enabled
      : assertBoolean(raw.enabled, "errorPurge.enabled");
  const preview =
    raw.preview === undefined || raw.preview === null
      ? globalPreview
      : assertBoolean(raw.preview, "errorPurge.preview");

  return {
    enabled: isTruthy(env.VIBE_CONTEXT_ERROR_PURGE_DISABLED) ? false : enabled,
    preview: isTruthy(env.VIBE_CONTEXT_ERROR_PURGE_PREVIEW) ? true : preview,
    placeholder: assertPlaceholder(
      raw.placeholder,
      "errorPurge.placeholder",
      DEFAULT_CONFIG.errorPurge.placeholder,
    ),
    duplicatePlaceholder: assertPlaceholder(
      raw.duplicatePlaceholder,
      "errorPurge.duplicatePlaceholder",
      DEFAULT_CONFIG.errorPurge.duplicatePlaceholder,
    ),
    preserveAcrossUserTurns:
      raw.preserveAcrossUserTurns === undefined
        ? DEFAULT_CONFIG.errorPurge.preserveAcrossUserTurns
        : assertBoolean(raw.preserveAcrossUserTurns, "errorPurge.preserveAcrossUserTurns"),
    preserveOnStateChanges:
      raw.preserveOnStateChanges === undefined
        ? DEFAULT_CONFIG.errorPurge.preserveOnStateChanges
        : assertBoolean(raw.preserveOnStateChanges, "errorPurge.preserveOnStateChanges"),
    pruneRepeatedFailures:
      raw.pruneRepeatedFailures === undefined
        ? DEFAULT_CONFIG.errorPurge.pruneRepeatedFailures
        : assertBoolean(raw.pruneRepeatedFailures, "errorPurge.pruneRepeatedFailures"),
    protectReferences:
      raw.protectReferences === undefined
        ? DEFAULT_CONFIG.errorPurge.protectReferences
        : assertBoolean(raw.protectReferences, "errorPurge.protectReferences"),
    minSuccesses:
      raw.minSuccesses === undefined
        ? DEFAULT_CONFIG.errorPurge.minSuccesses
        : Number.isInteger(raw.minSuccesses) && raw.minSuccesses >= 1
          ? raw.minSuccesses
          : (() => {
              throw new ConfigError("errorPurge.minSuccesses must be a positive integer");
            })(),
  };
}

function resolveLog(raw, env) {
  env = env ?? {};
  if (raw === undefined) {
    return {
      ...DEFAULT_CONFIG.log,
      enabled: isTruthy(env.VIBE_CONTEXT_DEDUP_LOG_DISABLED)
        ? false
        : DEFAULT_CONFIG.log.enabled,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("log must be an object");
  }

  const enabled =
    raw.enabled === undefined ? DEFAULT_CONFIG.log.enabled : assertBoolean(raw.enabled, "log.enabled");
  const onlyWhenActive =
    raw.onlyWhenActive === undefined
      ? DEFAULT_CONFIG.log.onlyWhenActive
      : assertBoolean(raw.onlyWhenActive, "log.onlyWhenActive");

  let logPath = DEFAULT_CONFIG.log.path;
  if (raw.path !== undefined && raw.path !== null) {
    if (typeof raw.path !== "string" || raw.path.trim().length === 0) {
      throw new ConfigError("log.path must be a non-empty string or null");
    }
    logPath = raw.path.trim();
  }

  let maxBytes = DEFAULT_CONFIG.log.maxBytes;
  if (raw.maxBytes !== undefined) {
    if (!Number.isInteger(raw.maxBytes) || raw.maxBytes <= 0) {
      throw new ConfigError("log.maxBytes must be a positive integer");
    }
    maxBytes = raw.maxBytes;
  }

  if (isTruthy(env.VIBE_CONTEXT_DEDUP_LOG_DISABLED)) {
    return { enabled: false, onlyWhenActive, path: logPath, maxBytes };
  }
  return { enabled, onlyWhenActive, path: logPath, maxBytes };
}

function resolveSupersedeWrites(raw, env, globalPreview) {
  env = env ?? {};
  if (raw === undefined) {
    const defaults = DEFAULT_CONFIG.supersedeWrites;
    return {
      ...defaults,
      enabled: isTruthy(env.VIBE_CONTEXT_SUPERSEDE_WRITES_DISABLED)
        ? false
        : defaults.enabled,
      preview: isTruthy(env.VIBE_CONTEXT_SUPERSEDE_WRITES_PREVIEW)
        ? true
        : globalPreview,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("supersedeWrites must be an object");
  }

  const enabled =
    raw.enabled === undefined
      ? DEFAULT_CONFIG.supersedeWrites.enabled
      : assertBoolean(raw.enabled, "supersedeWrites.enabled");
  const preview =
    raw.preview === undefined || raw.preview === null
      ? globalPreview
      : assertBoolean(raw.preview, "supersedeWrites.preview");

  return {
    enabled: isTruthy(env.VIBE_CONTEXT_SUPERSEDE_WRITES_DISABLED) ? false : enabled,
    preview: isTruthy(env.VIBE_CONTEXT_SUPERSEDE_WRITES_PREVIEW) ? true : preview,
    placeholder: assertPlaceholder(
      raw.placeholder,
      "supersedeWrites.placeholder",
      DEFAULT_CONFIG.supersedeWrites.placeholder,
    ),
    writeTools: stringList(
      raw.writeTools,
      "supersedeWrites.writeTools",
      DEFAULT_CONFIG.supersedeWrites.writeTools,
    ),
    readTools: stringList(
      raw.readTools,
      "supersedeWrites.readTools",
      DEFAULT_CONFIG.supersedeWrites.readTools,
    ),
    preserveAcrossUserTurns:
      raw.preserveAcrossUserTurns === undefined
        ? DEFAULT_CONFIG.supersedeWrites.preserveAcrossUserTurns
        : assertBoolean(
            raw.preserveAcrossUserTurns,
            "supersedeWrites.preserveAcrossUserTurns",
          ),
    barrierOnBroadMutations:
      raw.barrierOnBroadMutations === undefined
        ? DEFAULT_CONFIG.supersedeWrites.barrierOnBroadMutations
        : assertBoolean(raw.barrierOnBroadMutations, "supersedeWrites.barrierOnBroadMutations"),
    protectReferences:
      raw.protectReferences === undefined
        ? DEFAULT_CONFIG.supersedeWrites.protectReferences
        : assertBoolean(raw.protectReferences, "supersedeWrites.protectReferences"),
    requireFullRead:
      raw.requireFullRead === undefined
        ? DEFAULT_CONFIG.supersedeWrites.requireFullRead
        : assertBoolean(raw.requireFullRead, "supersedeWrites.requireFullRead"),
  };
}

/**
 * Resolve the token-usage log settings. Independent of the pruning switches:
 * disabling pruning must not stop measurement, and disabling measurement must
 * not change pruning.
 */
function resolveTokenUsage(raw, env) {
  env = env ?? {};
  if (isTruthy(env.VIBE_TOKEN_USAGE_LOG_DISABLED)) {
    return { enabled: false, path: DEFAULT_CONFIG.tokenUsage.path };
  }
  if (raw === undefined) return { ...DEFAULT_CONFIG.tokenUsage };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("tokenUsage must be an object");
  }

  const enabled =
    raw.enabled === undefined
      ? DEFAULT_CONFIG.tokenUsage.enabled
      : assertBoolean(raw.enabled, "tokenUsage.enabled");

  let usagePath = DEFAULT_CONFIG.tokenUsage.path;
  if (raw.path !== undefined && raw.path !== null) {
    if (typeof raw.path !== "string" || raw.path.trim().length === 0) {
      throw new ConfigError("tokenUsage.path must be a non-empty string or null");
    }
    usagePath = raw.path.trim();
  }

  return { enabled, path: usagePath };
}

/**
 * Resolve raw JSON config plus environment overrides into a complete config.
 * Throws ConfigError on invalid known fields.
 */
export function resolveConfig(raw = {}, env = process.env) {
  env = env ?? {};
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config root must be an object");
  }

  const enabled =
    raw.enabled === undefined ? DEFAULT_CONFIG.enabled : assertBoolean(raw.enabled, "enabled");
  const preview =
    raw.preview === undefined ? DEFAULT_CONFIG.preview : assertBoolean(raw.preview, "preview");

  const tools = stringList(raw.tools, "tools", DEFAULT_CONFIG.tools);
  const mutationTools = stringList(
    raw.mutationTools,
    "mutationTools",
    DEFAULT_CONFIG.mutationTools,
  );

  const placeholder = assertPlaceholder(
    raw.placeholder,
    "placeholder",
    DEFAULT_CONFIG.placeholder,
  );

  const barrierOnNonWhitelistedTools =
    raw.barrierOnNonWhitelistedTools === undefined
      ? DEFAULT_CONFIG.barrierOnNonWhitelistedTools
      : assertBoolean(raw.barrierOnNonWhitelistedTools, "barrierOnNonWhitelistedTools");

  const protectCallIdReferences =
    raw.protectCallIdReferences === undefined
      ? DEFAULT_CONFIG.protectCallIdReferences
      : assertBoolean(raw.protectCallIdReferences, "protectCallIdReferences");

  const log = resolveLog(raw.log, env);
  const tokenUsage = resolveTokenUsage(raw.tokenUsage, env);
  const deduplication = resolveDeduplication(raw.deduplication);
  const errorPurge = resolveErrorPurge(raw.errorPurge, env, preview);
  const supersedeWrites = resolveSupersedeWrites(raw.supersedeWrites, env, preview);

  return {
    enabled: isTruthy(env.VIBE_CONTEXT_DEDUP_DISABLED) ? false : enabled,
    preview: isTruthy(env.VIBE_CONTEXT_DEDUP_PREVIEW) ? true : preview,
    tools,
    placeholder,
    barrierOnNonWhitelistedTools,
    protectCallIdReferences,
    mutationTools,
    deduplication,
    errorPurge,
    supersedeWrites,
    log,
    tokenUsage,
  };
}
