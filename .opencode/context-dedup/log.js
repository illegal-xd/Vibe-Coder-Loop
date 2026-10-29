/**
 * Aggregate-only JSONL logging.
 *
 * The log deliberately excludes tool inputs, tool outputs, file paths, session
 * ids, and credentials. It records only counters, reasons, durations, and
 * clearly-labelled token estimates.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isTruthy } from "./config.js";

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveLogPath(config, directory) {
  const configured = config?.log?.path;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(directory, expandHome(configured.trim()));
  }
  return path.join(os.homedir(), ".vibe-loop", "context-dedup", "events.jsonl");
}

function compactReasons(reasons) {
  if (!reasons || typeof reasons !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(reasons)) {
    if (Number.isFinite(value) && value > 0) result[key] = value;
  }
  return result;
}

function sanitizeError(value) {
  if (typeof value !== "string") return "unknown_error";
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function sanitizeErrorPurgeStats(stats) {
  if (!stats || typeof stats !== "object") return null;
  return {
    enabled: stats.enabled === true,
    preview: stats.preview === true,
    changed: stats.changed === true,
    recordsTotal: Number(stats.recordsTotal) || 0,
    confirmedErrorCount: Number(stats.confirmedErrorCount) || 0,
    ambiguousResultCount: Number(stats.ambiguousResultCount) || 0,
    candidateCount: Number(stats.candidateCount) || 0,
    plannedPruneCount: Number(stats.plannedPruneCount) || 0,
    wouldPruneCount: Number(stats.wouldPruneCount) || 0,
    prunedCount: Number(stats.prunedCount) || 0,
    preservedCount: Number(stats.preservedCount) || 0,
    highConfidencePruneCount: Number(stats.highConfidencePruneCount) || 0,
    mediumConfidencePruneCount: Number(stats.mediumConfidencePruneCount) || 0,
    decisionKinds: compactReasons(stats.decisionKinds),
    skippedReasons: compactReasons(stats.skippedReasons),
    durationMs: Number.isFinite(stats.durationMs) ? stats.durationMs : null,
    tokenSavingsEstimated: Number(stats.tokenSavingsEstimated) || 0,
    tokenSavingsEstimatedIfApplied: Number(stats.tokenSavingsEstimatedIfApplied) || 0,
    tokenCounting: typeof stats.tokenCounting === "string" ? stats.tokenCounting : "unknown",
    actualTokenSavings: null,
    outputBytesRemovedActual: Number(stats.outputBytesRemovedActual) || 0,
    error: typeof stats.error === "string" ? sanitizeError(stats.error) : undefined,
  };
}

function sanitizeSupersedeWritesStats(stats) {
  if (!stats || typeof stats !== "object") return null;
  return {
    enabled: stats.enabled === true,
    preview: stats.preview === true,
    changed: stats.changed === true,
    recordsTotal: Number(stats.recordsTotal) || 0,
    confirmedWriteCount: Number(stats.confirmedWriteCount) || 0,
    fullReadCount: Number(stats.fullReadCount) || 0,
    ambiguousResultCount: Number(stats.ambiguousResultCount) || 0,
    candidateCount: Number(stats.candidateCount) || 0,
    plannedPruneCount: Number(stats.plannedPruneCount) || 0,
    wouldPruneCount: Number(stats.wouldPruneCount) || 0,
    prunedCount: Number(stats.prunedCount) || 0,
    preservedCount: Number(stats.preservedCount) || 0,
    highConfidencePruneCount: Number(stats.highConfidencePruneCount) || 0,
    decisionKinds: compactReasons(stats.decisionKinds),
    skippedReasons: compactReasons(stats.skippedReasons),
    durationMs: Number.isFinite(stats.durationMs) ? stats.durationMs : null,
    tokenSavingsEstimated: Number(stats.tokenSavingsEstimated) || 0,
    tokenSavingsEstimatedIfApplied: Number(stats.tokenSavingsEstimatedIfApplied) || 0,
    tokenCounting: typeof stats.tokenCounting === "string" ? stats.tokenCounting : "unknown",
    actualTokenSavings: null,
    outputBytesRemovedActual: Number(stats.outputBytesRemovedActual) || 0,
    error: typeof stats.error === "string" ? sanitizeError(stats.error) : undefined,
  };
}

function sanitizeStats(stats) {
  return {
    event: "transform",
    enabled: stats.enabled === true,
    deduplicationEnabled: stats.deduplicationEnabled === true,
    preview: stats.preview === true,
    changed: stats.changed === true,
    recordsTotal: Number(stats.recordsTotal) || 0,
    candidateCount: Number(stats.candidateCount) || 0,
    duplicateGroupCount: Number(stats.duplicateGroupCount) || 0,
    sameSignatureDifferentOutputGroups:
      Number(stats.sameSignatureDifferentOutputGroups) || 0,
    plannedPruneCount: Number(stats.plannedPruneCount) || 0,
    wouldPruneCount: Number(stats.wouldPruneCount) || 0,
    prunedCount: Number(stats.prunedCount) || 0,
    skippedReasons: compactReasons(stats.skippedReasons),
    durationMs: Number.isFinite(stats.durationMs) ? stats.durationMs : null,
    tokenSavingsEstimated: Number(stats.tokenSavingsEstimated) || 0,
    tokenSavingsEstimatedIfApplied: Number(stats.tokenSavingsEstimatedIfApplied) || 0,
    tokenCounting: typeof stats.tokenCounting === "string" ? stats.tokenCounting : "unknown",
    actualTokenSavings: null,
    outputBytesRemovedActual: Number(stats.outputBytesRemovedActual) || 0,
    error: typeof stats.error === "string" ? sanitizeError(stats.error) : undefined,
    errorPurge: sanitizeErrorPurgeStats(stats.errorPurge),
    supersedeWrites: sanitizeSupersedeWritesStats(stats.supersedeWrites),
  };
}

async function rotateIfNeeded(file, maxBytes) {
  try {
    const info = await stat(file);
    if (info.size <= maxBytes) return true;
  } catch {
    return true;
  }

  const archive = `${file}.1`;
  try {
    await stat(archive);
    // Never overwrite an existing archive. Pause logging instead of
    // destroying a file that the user may have placed at this path.
    return false;
  } catch {
    // Archive does not exist; safe to rename.
  }
  try {
    await rename(file, archive);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one aggregate record. Never throws; logging must not break a model
 * request.
 */
export async function appendStats({ directory, config, configError }, stats) {
  try {
    if (isTruthy(process.env.VIBE_CONTEXT_DEDUP_LOG_DISABLED)) return;
    if (!config?.log?.enabled) return;
    if (
      config.log.onlyWhenActive &&
      !stats?.changed &&
      !stats?.candidateCount &&
      !stats?.error &&
      !stats?.errorPurge?.candidateCount &&
      !stats?.errorPurge?.error &&
      !stats?.supersedeWrites?.candidateCount &&
      !stats?.supersedeWrites?.error
    ) {
      return;
    }

    const file = resolveLogPath(config, directory);
    const maxBytes = Number.isInteger(config.log.maxBytes)
      ? config.log.maxBytes
      : 512 * 1024;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!(await rotateIfNeeded(file, maxBytes))) return;

    const record = {
      ts: new Date().toISOString(),
      plugin: "vibe-context-dedup",
      ...sanitizeStats(stats ?? {}),
    };
    if (configError) record.configError = sanitizeError(configError);
    await appendFile(file, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Fail-open for observability: a broken log path must not affect chat.
  }
}
