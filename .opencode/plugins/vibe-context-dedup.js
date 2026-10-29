/**
 * OpenCode local plugin: request-scoped deduplication of read-only tool
 * results, plus append-only token-usage measurement.
 *
 * The plugin is loaded automatically from .opencode/plugins/ by OpenCode.
 * It never writes the session store; it only replaces output strings on the
 * request copy handed to experimental.chat.messages.transform.
 *
 * Measurement is strictly one-way: pruning decisions are read from the
 * existing pipeline, never influenced by logging, and a logging failure can
 * never fail a model request.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CONFIG, isTruthy, resolveConfig } from "../context-dedup/config.js";
import { appendStats } from "../context-dedup/log.js";
import { transformMessages } from "../context-dedup/opencode.js";
import {
  buildUsageRecord,
  createPendingPruneStore,
  createSeenIdSet,
  estimateFromUnits,
  estimateMessagesTokens,
  extractProviderUsage,
  summarizePruning,
} from "../context-dedup/token-usage.js";
import { createUsageLogger } from "../context-dedup/token-usage-log.js";

const USAGE_FAILURE_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** Transport label: usage arrives through the runtime's provider layer. */
const USAGE_TRANSPORT = "opencode_provider";

function sanitizeError(error, directory = "") {
  let text = error && typeof error.message === "string" ? error.message : String(error);
  if (directory) text = text.split(directory).join("<project>");
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

async function loadConfig(directory) {
  if (isTruthy(process.env.VIBE_CONTEXT_DEDUP_DISABLED)) {
    return { ...DEFAULT_CONFIG, enabled: false };
  }

  const explicit = process.env.VIBE_CONTEXT_DEDUP_CONFIG;
  const explicitPath = typeof explicit === "string" && explicit.trim().length > 0;
  const configPath = explicitPath
    ? path.resolve(directory, explicit.trim())
    : path.join(directory, ".opencode", "context-dedup.json");

  let raw = {};
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT" && !explicitPath) {
      raw = {};
    } else {
      throw error;
    }
  }
  return resolveConfig(raw, process.env);
}

function sessionIdOf(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index] && messages[index].info;
    if (info && typeof info.sessionID === "string" && info.sessionID.length > 0) {
      return info.sessionID;
    }
  }
  return null;
}

/**
 * Named export is the form documented for local OpenCode plugins. Keep this
 * file free of other exported functions so the loader cannot mistake a helper
 * for a second plugin.
 */
export const VibeContextDedupPlugin = async (input = {}) => {
  const directory =
    typeof input.directory === "string" && input.directory.length > 0
      ? input.directory
      : process.cwd();
  let config;
  let configError = "";
  try {
    config = await loadConfig(directory);
  } catch (error) {
    config = { ...DEFAULT_CONFIG, enabled: false };
    configError =
      error && error.name === "ConfigError" ? "invalid_config" : "config_unreadable";
  }

  let configErrorLogged = false;

  const usageLogger = createUsageLogger({
    directory,
    config,
    onFailure: (reason) => {
      void reportUsageFailure(reason);
    },
  });
  const measuring = usageLogger.enabled;
  const pendingPrune = createPendingPruneStore();
  const loggedMessages = createSeenIdSet();
  /**
   * Retry attempt per assistant message id. The runtime reuses the same
   * assistant message for automatic retries and clears `time.completed`
   * before the next attempt, so a message id alone cannot distinguish two
   * provider requests. `session.retry.scheduled` carries the next attempt.
   */
  const attempts = new Map();
  const MAX_TRACKED_ATTEMPTS = 2048;
  let lastUsageFailureAt = 0;

  function rememberAttempt(messageID, attempt) {
    if (typeof messageID !== "string" || messageID.length === 0) return;
    if (!Number.isInteger(attempt) || attempt < 1) return;
    attempts.set(messageID, attempt);
    while (attempts.size > MAX_TRACKED_ATTEMPTS) {
      const oldest = attempts.keys().next();
      if (oldest.done) break;
      attempts.delete(oldest.value);
    }
  }

  /** Rate-limited: one diagnostic per interval, through the existing log. */
  async function reportUsageFailure(reason) {
    const at = Date.now();
    if (at - lastUsageFailureAt < USAGE_FAILURE_MIN_INTERVAL_MS) return;
    lastUsageFailureAt = at;
    await appendStats(
      { directory, config },
      {
        enabled: true,
        preview: false,
        changed: false,
        candidateCount: 0,
        error: `token_usage_log_failed:${reason}`.slice(0, 240),
      },
    );
  }

  /**
   * Existing pruning path, unchanged. Returns the pruning summary measured
   * from the already-computed statistics (or null when nothing was measured).
   */
  async function applyTransform(output) {
    if (!output || !Array.isArray(output.messages)) return null;

    if (!config.enabled) {
      if (configError && !configErrorLogged) {
        configErrorLogged = true;
        await appendStats(
          { directory, config, configError },
          {
            enabled: false,
            preview: false,
            changed: false,
            candidateCount: 0,
            error: "config_error",
          },
        );
      }
      return null;
    }

    let result;
    try {
      result = transformMessages(output.messages, { ...config, measureContext: measuring });
    } catch (error) {
      await appendStats(
        { directory, config },
        {
          enabled: true,
          preview: config.preview,
          changed: false,
          candidateCount: 0,
          error: sanitizeError(error, directory),
        },
      );
      return null;
    }

    if (result.changed) {
      const original = output.messages.slice();
      try {
        // The hook contract modifies output.messages in place. Never mutate
        // the original message objects: transformMessages already cloned the
        // affected messages and tool parts.
        output.messages.length = 0;
        for (const message of result.messages) output.messages.push(message);
        if (
          output.messages.length !== result.messages.length ||
          output.messages.some((message, index) => message !== result.messages[index])
        ) {
          throw new Error("hook output did not accept the transformed messages");
        }
      } catch {
        try {
          output.messages.length = 0;
          for (const message of original) output.messages.push(message);
        } catch {
          // A frozen or otherwise read-only hook output is left untouched;
          // there is no safe way to modify it.
        }
        result.stats.changed = false;
        result.stats.prunedCount = 0;
        result.stats.tokenSavingsEstimated = 0;
        result.stats.outputBytesRemovedActual = 0;
        // The request copy was not accepted, so no strategy's removals reached
        // the model; keep nested counters consistent with reality.
        for (const strategy of ["errorPurge", "supersedeWrites"]) {
          if (!result.stats[strategy]) continue;
          result.stats[strategy].changed = false;
          result.stats[strategy].prunedCount = 0;
          result.stats[strategy].tokenSavingsEstimated = 0;
          result.stats[strategy].outputBytesRemovedActual = 0;
        }
        result.stats.error = "apply_array_mutation_failed";
        result.stats.skippedReasons = {
          ...result.stats.skippedReasons,
          apply_validation_failed:
            (result.stats.skippedReasons?.apply_validation_failed ?? 0) + 1,
        };
        await appendStats({ directory, config }, result.stats);
        return { pruning: summarizePruning(result.stats), contextUnits: result.contextUnits ?? null };
      }
    }

    await appendStats({ directory, config }, result.stats);
    return { pruning: summarizePruning(result.stats), contextUnits: result.contextUnits ?? null };
  }

  /**
   * One JSONL record per terminal assistant-message attempt. Non-terminal
   * streaming updates are ignored. Repeated callbacks for the same attempt
   * are suppressed; an automatic retry is a separate provider request and is
   * recorded with `attempt` > 1 instead of replacing or suppressing the
   * successful attempt.
   */
  async function recordUsageEvent(event) {
    if (!event || typeof event !== "object" || event.type !== "message.updated") return;
    const info = event.properties && event.properties.info;
    if (!info || typeof info !== "object" || info.role !== "assistant") return;
    if (typeof info.id !== "string" || info.id.length === 0) return;

    const completed =
      info.time && typeof info.time === "object" && Number.isFinite(info.time.completed);
    const failed = Boolean(info.error);
    if (!completed && !failed) return;

    // A failed update may already carry `retry` for the next attempt. In that
    // case this message belongs to the previous attempt, not the retry.
    const retry = info.retry && typeof info.retry === "object" ? info.retry : null;
    const retryAttempt =
      failed && retry && Number.isInteger(retry.attempt) && retry.attempt > 0
        ? retry.attempt
        : null;
    if (retryAttempt !== null) rememberAttempt(info.id, retryAttempt);
    const attempt =
      retryAttempt !== null
        ? Math.max(1, retryAttempt - 1)
        : (attempts.get(info.id) ?? 1);

    const seenKey = `${info.id}:${attempt}`;
    if (loggedMessages.has(seenKey)) return;

    const sessionID =
      typeof info.sessionID === "string" && info.sessionID.length > 0 ? info.sessionID : null;
    const pending = sessionID ? pendingPrune.take(sessionID) : null;

    const usage = extractProviderUsage(info, {
      transport: USAGE_TRANSPORT,
      terminal: completed === true,
    });

    const errors = [...usage.errors];
    if (!pending || !pending.pruning) errors.push("pruning_unavailable");

    const record = buildUsageRecord({
      session_id: sessionID,
      request_id: info.id,
      attempt,
      usage,
      context_estimates: pending ? pending.context_estimates : null,
      pruning: pending ? pending.pruning : null,
      errors,
    });

    // Failure is reported through the rate-limited diagnostic callback; the
    // model request is unaffected. Only mark the attempt as logged after a
    // successful append so a transient write failure can be retried by a later
    // update instead of silently losing the record.
    const outcome = await usageLogger.append(record);
    if (outcome.ok) {
      loggedMessages.add(seenKey);
      if (!failed) attempts.delete(info.id);
    }
  }

  function contextEstimatesFrom(outcome, messages) {
    if (outcome && outcome.contextUnits) {
      return {
        before_pruning: estimateFromUnits(outcome.contextUnits.before),
        after_pruning: estimateFromUnits(outcome.contextUnits.after),
      };
    }
    // Pruning was disabled or skipped: before == after, computed once.
    const estimate = estimateMessagesTokens(messages);
    return { before_pruning: estimate, after_pruning: estimate };
  }

  return {
    "experimental.chat.messages.transform": async (_hookInput, output) => {
      if (!output || !Array.isArray(output.messages)) return;
      const sessionID = measuring ? sessionIdOf(output.messages) : null;

      let outcome = null;
      try {
        outcome = await applyTransform(output);
      } finally {
        if (measuring && sessionID) {
          pendingPrune.set(sessionID, {
            context_estimates: contextEstimatesFrom(outcome, output.messages),
            pruning: outcome?.pruning ?? null,
          });
        }
      }
    },

    event: async ({ event } = {}) => {
      if (!usageLogger.enabled) return;
      try {
        if (event?.type === "session.retry.scheduled") {
          rememberAttempt(
            event.properties?.assistantMessageID,
            event.properties?.attempt,
          );
          return;
        }
        await recordUsageEvent(event);
      } catch {
        // Never propagate into the runtime event bus.
      }
    },
  };
};
