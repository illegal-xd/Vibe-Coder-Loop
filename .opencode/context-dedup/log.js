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
    eligibleCount: Number(stats.eligibleCount) || 0,
    potentialSupersedeCount: Number(stats.potentialSupersedeCount) || 0,
    markedCount: Number(stats.markedCount) || 0,
    changedCount: Number(stats.changedCount) || 0,
    plannedPruneCount: Number(stats.plannedPruneCount) || 0,
    wouldPruneCount: Number(stats.wouldPruneCount) || 0,
    prunedCount: Number(stats.prunedCount) || 0,
    preservedCount: Number(stats.preservedCount) || 0,
    highConfidencePruneCount: Number(stats.highConfidencePruneCount) || 0,
    mediumConfidencePruneCount: Number(stats.mediumConfidencePruneCount) || 0,
    inputRedactedCount: Number(stats.inputRedactedCount) || 0,
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
    ambiguousResultCount: Number(stats.ambiguousResultCount) || 0,
    observedReadCount: Number(stats.observedReadCount) || 0,
    confirmedReadCount: Number(stats.confirmedReadCount) || 0,
    fullReadCount: Number(stats.fullReadCount) || 0,
    ambiguousWriteCount: Number(stats.ambiguousWriteCount) || 0,
    candidateCount: Number(stats.candidateCount) || 0,
    eligibleCount: Number(stats.eligibleCount) || 0,
    fileMatchCount: Number(stats.fileMatchCount) || 0,
    versionVerifiedCount: Number(stats.versionVerifiedCount) || 0,
    markedCount: Number(stats.markedCount) || 0,
    changedCount: Number(stats.changedCount) || 0,
    plannedPruneCount: Number(stats.plannedPruneCount) || 0,
    wouldPruneCount: Number(stats.wouldPruneCount) || 0,
    prunedCount: Number(stats.prunedCount) || 0,
    preservedCount: Number(stats.preservedCount) || 0,
    highConfidencePruneCount: Number(stats.highConfidencePruneCount) || 0,
    decisionKinds: compactReasons(stats.decisionKinds),
    skippedReasons: compactReasons(stats.skippedReasons),
    readRejectedReasons: compactReasons(stats.readRejectedReasons),
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
    eligibleCount: Number(stats.eligibleCount) || 0,
    duplicateGroupCount: Number(stats.duplicateGroupCount) || 0,
    duplicateCandidateCount: Number(stats.duplicateCandidateCount) || 0,
    uniqueSignatureCount: Number(stats.uniqueSignatureCount) || 0,
    sameSignatureDifferentOutputCount:
      Number(stats.sameSignatureDifferentOutputCount) || 0,
    sameSignatureDifferentOutputGroups:
      Number(stats.sameSignatureDifferentOutputGroups) || 0,
    markedCount: Number(stats.markedCount) || 0,
    changedCount: Number(stats.changedCount) || 0,
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

async function rotateIfNeeded(file, maxBytes, incomingBytes) {
  const size = await currentSize(file);
  if (size + incomingBytes <= maxBytes) return true;
  // All archive slots were already found occupied; do not stat them again on
  // every append. Logging continues in the active file (never overwrite).
  if (rotationExhausted.has(file)) return true;

  for (let index = 1; index <= MAX_ARCHIVES; index += 1) {
    const archive = `${file}.${index}`;
    try {
      await stat(archive);
      // Slot taken by a file the user may own; try the next one.
      continue;
    } catch {
      // Free slot.
    }
    try {
      await rename(file, archive);
      fileSizes.set(file, 0);
    } catch {
      // Rename failed (permissions, cross-device, or the file vanished).
      // Keep appending instead of dropping diagnostics.
    }
    return true;
  }
  // Every archive slot exists: keep appending to the active file rather than
  // silently disabling logging for the rest of the session. Existing files are
  // never overwritten or deleted.
  rotationExhausted.add(file);
  return true;
}

// Process-local caches. `directoryReady` avoids one mkdir syscall per request;
// `fileSizes` avoids one stat per request by tracking appended bytes.
const directoryReady = new Set();
const fileSizes = new Map();
const rotationExhausted = new Set();
const MAX_ARCHIVES = 3;

async function currentSize(file) {
  const known = fileSizes.get(file);
  if (Number.isFinite(known)) return known;
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    size = 0;
  }
  fileSizes.set(file, size);
  return size;
}

async function ensureDirectory(dir) {
  if (directoryReady.has(dir)) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  directoryReady.add(dir);
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

    const record = {
      ts: new Date().toISOString(),
      plugin: "vibe-context-dedup",
      ...sanitizeStats(stats ?? {}),
    };
    if (configError) record.configError = sanitizeError(configError);
    // Serialize once: the same string is measured for rotation and appended.
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");

    await ensureDirectory(path.dirname(file));
    if (!(await rotateIfNeeded(file, maxBytes, lineBytes))) return;

    await appendFile(file, line, {
      encoding: "utf8",
      mode: 0o600,
    });
    fileSizes.set(file, (fileSizes.get(file) ?? 0) + lineBytes);
  } catch {
    // Fail-open for observability: a broken log path must not affect chat.
  }
}
