/**
 * Reproducible local benchmark for the context-dedup plugin.
 *
 * Deterministic fixtures, no network, no filesystem writes except the
 * optional logging section (which uses a temporary directory).
 *
 * Usage:
 *   node --expose-gc scripts/bench/context-dedup-bench.mjs
 *   node --expose-gc scripts/bench/context-dedup-bench.mjs --iters 40
 *   node --expose-gc scripts/bench/context-dedup-bench.mjs --json
 *
 * Measures transform latency (median / p95), throughput, plugin init, token
 * estimation, JSONL append overhead, and retained heap per fixture.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../../.opencode/context-dedup/config.js";
import { transformMessages } from "../../.opencode/context-dedup/opencode.js";
import { estimateMessagesTokens } from "../../.opencode/context-dedup/token-usage.js";
import { appendStats } from "../../.opencode/context-dedup/log.js";
import { createUsageLogger } from "../../.opencode/context-dedup/token-usage-log.js";
import { buildUsageRecord } from "../../.opencode/context-dedup/token-usage.js";
import { VibeContextDedupPlugin } from "../../.opencode/plugins/vibe-context-dedup.js";

const args = process.argv.slice(2);
const ITERS = Number(
  args.includes("--iters") ? args[args.indexOf("--iters") + 1] : 25,
);
const WARMUP = 5;
const AS_JSON = args.includes("--json");
const SESSION_ID = "ses_bench";

const canGc = typeof global.gc === "function";

// ---------------------------------------------------------------- fixtures

let counter = 0;
function nextId(prefix) {
  counter += 1;
  return `${prefix}_${counter}`;
}

function textPart(text) {
  return {
    id: nextId("prt"),
    sessionID: SESSION_ID,
    messageID: "msg",
    type: "text",
    text,
    time: { start: 1, end: 2 },
  };
}

function toolPart({ tool = "read", input, output, status = "completed", error = "" }) {
  const base = { id: nextId("prt"), sessionID: SESSION_ID, messageID: "msg" };
  const state =
    status === "completed"
      ? {
          status,
          input,
          output,
          title: `${tool} call`,
          metadata: { truncated: false, bytes: output.length },
          time: { start: 1, end: 2 },
        }
      : { status, input, error, metadata: {}, time: { start: 1, end: 2 } };
  return {
    ...base,
    type: "tool",
    callID: nextId("call"),
    tool,
    state,
  };
}

function assistantMessage(parts) {
  return {
    info: {
      id: nextId("msg"),
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "msg_parent",
      providerID: "CPMAC-API",
      modelID: "deepseek-flash",
      mode: "default",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts,
  };
}

function userMessage(index) {
  return {
    info: {
      id: nextId("umsg"),
      sessionID: SESSION_ID,
      role: "user",
      time: { created: index },
      agent: "build",
      model: { providerID: "CPMAC-API", modelID: "deepseek-flash" },
    },
    parts: [textPart(`user turn ${index}: please continue the task`)],
  };
}

function bigOutput(size, seed) {
  const unit = `line ${seed} 中文内容 abcdefghijklmnopqrstuvwxyz 0123456789\n`;
  let text = "";
  while (text.length < size) text += unit;
  return text.slice(0, size);
}

/**
 * Long conversation: 40 user turns, 2 tool parts per assistant message,
 * ~15 duplicate result pairs, ~12 errors of which 6 are superseded, plus
 * repeat failures. Outputs are 4 KB.
 */
function longMixed({ outputSize = 4096, turns = 40, duplicatePairs = 15, errors = 12 } = {}) {
  const messages = [];
  let outputSeed = 0;
  const dups = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(userMessage(turn));
    const parts = [textPart(`assistant turn ${turn} analysis text `.repeat(20))];
    for (let slot = 0; slot < 2; slot += 1) {
      outputSeed += 1;
      const filePath = `src/file-${outputSeed % 30}.txt`;
      const output = bigOutput(outputSize, outputSeed);
      if (dups.length < duplicatePairs && outputSeed % 7 === 0) {
        dups.push({ filePath, output });
      }
      parts.push(toolPart({ input: { filePath }, output }));
    }
    if (errors > 0 && outputSeed % 11 === 0) {
      const filePath = `src/flaky-${outputSeed % 5}.txt`;
      parts.push(toolPart({ input: { filePath }, status: "error", error: bigOutput(600, outputSeed) }));
      errors -= 1;
      // Same operation succeeds later in the same turn (superseder).
      parts.push(toolPart({ input: { filePath }, output: bigOutput(300, outputSeed) }));
    }
    // Replant duplicate outputs so dedup has real candidates.
    const dup = dups[turn % Math.max(1, dups.length)];
    if (dup && turn > 2) {
      parts.push(toolPart({ input: { filePath: dup.filePath }, output: dup.output }));
    }
    messages.push(assistantMessage(parts));
  }
  return messages;
}

/** Same size but nothing is prunable: no duplicates, no errors. */
function longNoCandidates({ outputSize = 4096, turns = 40 } = {}) {
  const messages = [];
  let seed = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(userMessage(turn));
    const parts = [textPart(`assistant turn ${turn} analysis text `.repeat(20))];
    for (let slot = 0; slot < 2; slot += 1) {
      seed += 1;
      parts.push(
        toolPart({
          input: { filePath: `src/unique-${seed}.txt` },
          output: bigOutput(outputSize, seed),
        }),
      );
    }
    messages.push(assistantMessage(parts));
  }
  return messages;
}

/** Many failures and successes: stresses supersession evaluation. */
function manyErrors({ turns = 60 } = {}) {
  const messages = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(userMessage(turn));
    const parts = [];
    const filePath = `src/case-${turn % 10}.txt`;
    parts.push(toolPart({ input: { filePath }, status: "error", error: bigOutput(800, turn) }));
    parts.push(toolPart({ input: { filePath }, output: bigOutput(400, turn) }));
    parts.push(toolPart({ input: { filePath }, status: "error", error: bigOutput(800, turn) }));
    parts.push(toolPart({ input: { filePath }, output: bigOutput(400, turn) }));
    messages.push(assistantMessage(parts));
  }
  return messages;
}

function short() {
  return [
    userMessage(0),
    assistantMessage([
      textPart("short answer"),
      toolPart({ input: { filePath: "a.txt" }, output: "same content here" }),
      toolPart({ input: { filePath: "a.txt" }, output: "same content here" }),
    ]),
  ];
}

// -------------------------------------------------------------- utilities

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function timeIt(fn, iterations) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / 1e6);
  }
  const sorted = samples.slice().sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    medianMs: Number(percentile(sorted, 50).toFixed(3)),
    p95Ms: Number(percentile(sorted, 95).toFixed(3)),
    meanMs: Number((total / sorted.length).toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    iterations,
  };
}

function measureRetained(fn, iterations) {
  if (!canGc) return null;
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let index = 0; index < iterations; index += 1) fn();
  global.gc();
  const after = process.memoryUsage().heapUsed;
  return {
    retainedPerIterationBytes: Math.round((after - before) / iterations),
  };
}

function bytesOf(messages) {
  let bytes = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text") bytes += part.text.length;
      else if (part.type === "tool") bytes += (part.state.output ?? part.state.error ?? "").length;
    }
  }
  return bytes;
}

// -------------------------------------------------------------------- runs

const fixtures = [
  ["short", () => short()],
  ["long-mixed", () => longMixed()],
  ["long-no-candidates", () => longNoCandidates()],
  ["many-errors", () => manyErrors()],
];

const config = resolveConfig({}, {});
const results = { runtime: process.version, platform: `${process.platform}/${process.arch}`, iterations: ITERS, fixtures: {} };

// Plugin initialization (config read + store creation).
{
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-bench-init-"));
  try {
    const samples = [];
    for (let index = 0; index < ITERS; index += 1) {
      const start = process.hrtime.bigint();
      await VibeContextDedupPlugin({ directory });
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    samples.sort((left, right) => left - right);
    results.pluginInitMs = {
      medianMs: Number(percentile(samples, 50).toFixed(3)),
      p95Ms: Number(percentile(samples, 95).toFixed(3)),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [name, build] of fixtures) {
  const messages = build();
  const entry = { messages: messages.length, contentBytes: bytesOf(messages), parts: messages.reduce((sum, message) => sum + message.parts.length, 0) };

  const stats = [];
  const original = transformMessages(messages, config).stats;
  entry.candidates = original.candidateCount;
  entry.prunedDedup = original.prunedCount;
  entry.errorCandidates = original.errorPurge.candidateCount;
  entry.prunedErrors = original.errorPurge.prunedCount;

  // Warm up.
  for (let index = 0; index < WARMUP; index += 1) transformMessages(messages, config);

  entry.transformMs = timeIt(() => {
    const result = transformMessages(messages, config);
    stats.push(result.stats.changed);
  }, ITERS);

  // Token estimation over the same content (single pass).
  entry.estimateMs = timeIt(() => estimateMessagesTokens(messages), ITERS);

  // Full plugin hook (pruning + aggregate logging to a temp file).
  {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-bench-hook-"));
    try {
      const plugin = await VibeContextDedupPlugin({ directory });
      const hookMessages = messages.map((message) => ({ info: message.info, parts: message.parts.slice() }));
      for (let index = 0; index < WARMUP; index += 1) {
        await plugin["experimental.chat.messages.transform"]({}, { messages: hookMessages });
      }
      const samples = [];
      for (let index = 0; index < ITERS; index += 1) {
        hookMessages.length = messages.length;
        hookMessages.splice(0, hookMessages.length, ...messages.map((message) => ({ info: message.info, parts: message.parts.slice() })));
        const start = process.hrtime.bigint();
        await plugin["experimental.chat.messages.transform"]({}, { messages: hookMessages });
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      samples.sort((left, right) => left - right);
      entry.pluginHookWithLoggingMs = {
        medianMs: Number(percentile(samples, 50).toFixed(3)),
        p95Ms: Number(percentile(samples, 95).toFixed(3)),
        iterations: ITERS,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  // Retained heap after repeated transforms (GC-assisted).
  entry.retained = measureRetained(() => transformMessages(messages, config), Math.max(10, Math.floor(ITERS / 2)));

  results.fixtures[name] = entry;

  // Keep the fixture alive only while measuring it.
  messages.length = 0;
}

// JSONL append overhead (async, one record per append).
{
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-bench-log-"));
  try {
    const logger = createUsageLogger({ directory, config });
    const record = buildUsageRecord({
      session_id: SESSION_ID,
      request_id: "msg_bench",
      usage: {
        provider: "CPMAC-API",
        model: "deepseek-flash",
        transport: "opencode_provider",
        usage_status: "actual",
        input_tokens: { value: 9500, source: "provider_usage" },
        output_tokens: { value: 600, source: "provider_usage" },
      },
    });
    const start = process.hrtime.bigint();
    for (let index = 0; index < ITERS * 4; index += 1) await logger.append(record);
    await logger.idle();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    results.usageAppendMsPerRecord = Number((elapsed / (ITERS * 4)).toFixed(4));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Aggregate dedup log append overhead (stat + mkdir + append per call).
{
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-bench-agg-"));
  try {
    const logConfig = resolveConfig({ log: { path: path.join(directory, "events.jsonl") } }, {});
    const stats = transformMessages(short(), logConfig).stats;
    const start = process.hrtime.bigint();
    for (let index = 0; index < ITERS * 4; index += 1) {
      await appendStats({ directory, config: logConfig }, stats);
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    results.aggregateAppendMsPerRecord = Number((elapsed / (ITERS * 4)).toFixed(4));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

results.gcAvailable = canGc;

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  console.log(`runtime ${results.runtime} ${results.platform}, iterations ${ITERS}, warmup ${WARMUP}, gc ${canGc}`);
  console.log(`plugin init (median/p95): ${results.pluginInitMs.medianMs} / ${results.pluginInitMs.p95Ms} ms`);
  for (const [name, entry] of Object.entries(results.fixtures)) {
    console.log(`\n[${name}] messages=${entry.messages} parts=${entry.parts} content=${(entry.contentBytes / 1024).toFixed(0)}KB`);
    console.log(`  candidates dedup=${entry.candidates} pruned=${entry.prunedDedup} | errorCandidates=${entry.errorCandidates} pruned=${entry.prunedErrors}`);
    console.log(`  transform median/p95: ${entry.transformMs.medianMs} / ${entry.transformMs.p95Ms} ms (mean ${entry.transformMs.meanMs})`);
    console.log(`  estimate median/p95:  ${entry.estimateMs.medianMs} / ${entry.estimateMs.p95Ms} ms`);
    console.log(`  plugin hook (with aggregate log) median/p95: ${entry.pluginHookWithLoggingMs.medianMs} / ${entry.pluginHookWithLoggingMs.p95Ms} ms`);
    if (entry.retained) console.log(`  retained heap per transform: ${entry.retained.retainedPerIterationBytes} bytes`);
  }
  console.log(`\nusage JSONL append: ${results.usageAppendMsPerRecord} ms/record`);
  console.log(`aggregate log append: ${results.aggregateAppendMsPerRecord} ms/record`);
}
