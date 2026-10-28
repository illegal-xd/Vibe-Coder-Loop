import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VibeContextDedupPlugin } from "../../.opencode/plugins/vibe-context-dedup.js";
import { TOKEN_USAGE_SCHEMA_VERSION } from "../../.opencode/context-dedup/token-usage.js";
import { usageLogDateKey } from "../../.opencode/context-dedup/token-usage-log.js";
import { SESSION_ID, assistantMessage, textPart, toolPart, userMessage } from "./helpers.mjs";

function usageTokens({ input = 9500, output = 600, reasoning = 0, cached = 3000, cacheWrite = 0, total } = {}) {
  const tokens = { input, output, reasoning, cache: { read: cached, write: cacheWrite } };
  if (total !== undefined) {
    if (total !== null) tokens.total = total;
  } else {
    // Current runtime schema: total = uncached input + cache + visible output
    // + reasoning.
    tokens.total = input + output + reasoning + cached + cacheWrite;
  }
  return tokens;
}

function assistantInfo({ id = "msg_a1", time = { created: 1, completed: 2 }, tokens, error = undefined, retry = undefined } = {}) {
  return {
    id,
    sessionID: SESSION_ID,
    role: "assistant",
    time,
    parentID: "msg_user",
    providerID: "aspire-coding-shenzhen",
    modelID: "deepseek-flash",
    mode: "default",
    cost: 0,
    tokens: tokens ?? usageTokens(),
    finish: "stop",
    ...(error ? { error } : {}),
    ...(retry ? { retry } : {}),
  };
}

function messageUpdatedEvent(info) {
  return { type: "message.updated", properties: { info } };
}

function duplicateToolMessages({ removedText, keptText }) {
  return [
    userMessage({ text: "continue" }),
    {
      info: assistantMessage().info,
      parts: [
        toolPart({ id: "p_old", callID: "call_old", tool: "read", input: { filePath: "a.txt" }, output: removedText }),
        toolPart({ id: "p_new", callID: "call_new", tool: "read", input: { filePath: "a.txt" }, output: keptText }),
      ],
    },
  ];
}

async function tmpProjectDirectory(prefix = "vibe-token-plugin-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(directory, ".opencode"), { recursive: true });
  return directory;
}

async function loadPlugin(directory) {
  const plugin = await VibeContextDedupPlugin({ directory });
  return plugin;
}

const DAILY_FILE_PATTERN = /^token-usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Read every daily usage file; the file name and record date are checked by tests. */
async function usageEntries(directory) {
  const dataDirectory = path.join(directory, "data");
  let names;
  try {
    names = await readdir(dataDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = names.filter((name) => DAILY_FILE_PATTERN.test(name)).sort();
  const entries = [];
  for (const name of files) {
    const text = await readFile(path.join(dataDirectory, name), "utf8");
    for (const line of text.split("\n").filter((item) => item.length > 0)) {
      entries.push({ file: name, record: JSON.parse(line) });
    }
  }
  return entries;
}

test("records one usage entry pairing real usage with the measured pruning", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);

    const output = { messages: duplicateToolMessages({ removedText: "x".repeat(400), keptText: "x".repeat(400) }) };
    await plugin["experimental.chat.messages.transform"]({}, output);
    await plugin.event({ event: messageUpdatedEvent(assistantInfo({ id: "msg_a1" })) });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 1);
    const { file, record } = entries[0];
    assert.equal(file, `token-usage-${usageLogDateKey(record.timestamp)}.jsonl`);

    assert.equal(record.schema_version, TOKEN_USAGE_SCHEMA_VERSION);
    assert.equal(record.event_type, "model_request_usage");
    assert.equal(record.session_id, SESSION_ID);
    assert.equal(record.request_id, "msg_a1");
    assert.equal(record.provider, "aspire-coding-shenzhen");
    assert.equal(record.model, "deepseek-flash");
    assert.equal(record.usage_status, "actual");
    assert.deepEqual(record.input_tokens, { value: 12500, source: "provider_usage_derived" });
    assert.deepEqual(record.output_tokens, { value: 600, source: "provider_usage_derived" });
    assert.deepEqual(record.total_tokens, { value: 13100, source: "provider_usage" });
    assert.deepEqual(record.cache_write_tokens, { value: 0, source: "provider_usage" });
    assert.ok(record.context_estimates.before_pruning.value > record.context_estimates.after_pruning.value);
    assert.equal(record.pruning.deduplication.removed_items, 1);
    assert.ok(record.pruning.total_removed_tokens.value > 0);
    assert.equal(record.errors.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries and repeated callbacks log the message exactly once", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    const output = { messages: duplicateToolMessages({ removedText: "x".repeat(200), keptText: "x".repeat(200) }) };
    await plugin["experimental.chat.messages.transform"]({}, output);

    const event = messageUpdatedEvent(assistantInfo({ id: "msg_dup" }));
    await plugin.event({ event });
    await plugin.event({ event });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].record.request_id, "msg_dup");
    assert.equal(
      entries[0].file,
      `token-usage-${usageLogDateKey(entries[0].record.timestamp)}.jsonl`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streaming updates before completion write nothing", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });
    await plugin.event({
      event: messageUpdatedEvent(assistantInfo({ id: "msg_stream", time: { created: 1 } })),
    });

    assert.deepEqual(await usageEntries(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple streaming updates with usage write only the final aggregate", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({
          id: "msg_chunks",
          time: { created: 1 },
          tokens: usageTokens({ input: 100, output: 5, cached: 0 }),
        }),
      ),
    });
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({
          id: "msg_chunks",
          time: { created: 1 },
          tokens: usageTokens({ input: 5000, output: 200, cached: 0 }),
        }),
      ),
    });
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({
          id: "msg_chunks",
          time: { created: 1, completed: 2 },
          tokens: usageTokens({ input: 5000, output: 200, cached: 0 }),
        }),
      ),
    });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 1);
    const { record } = entries[0];
    assert.equal(record.usage_status, "actual");
    assert.deepEqual(record.input_tokens, { value: 5000, source: "provider_usage_derived" });
    assert.deepEqual(record.output_tokens, { value: 200, source: "provider_usage_derived" });
    assert.deepEqual(record.total_tokens, { value: 5200, source: "provider_usage" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an aborted stream is recorded once with missing usage", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });

    const aborted = messageUpdatedEvent(
      assistantInfo({ id: "msg_abort", time: { created: 1 }, error: { name: "MessageAbortedError", data: { message: "aborted" } } }),
    );
    await plugin.event({ event: aborted });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 1);
    const { record } = entries[0];
    assert.equal(
      entries[0].file,
      `token-usage-${usageLogDateKey(record.timestamp)}.jsonl`,
    );
    assert.equal(record.usage_status, "missing");
    assert.deepEqual(record.input_tokens, { value: null, source: "unavailable" });
    assert.ok(record.errors.includes("stream_ended_without_usage"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabled measurement keeps pruning behavior unchanged and writes no file", async () => {
  const directory = await tmpProjectDirectory();
  try {
    await writeFile(
      path.join(directory, ".opencode", "context-dedup.json"),
      JSON.stringify({ tokenUsage: { enabled: false } }),
    );
    const plugin = await loadPlugin(directory);

    const before = duplicateToolMessages({ removedText: "x".repeat(300), keptText: "x".repeat(300) });
    const output = { messages: before };
    await plugin["experimental.chat.messages.transform"]({}, output);

    assert.equal(output.messages.length, before.length);
    // Pruning still applied: the older output is replaced by the placeholder.
    const parts = output.messages[1].parts;
    assert.notEqual(parts[0].state.output, "x".repeat(300));
    assert.deepEqual(await usageEntries(directory), []);

    await plugin.event({ event: messageUpdatedEvent(assistantInfo({ id: "msg_off" })) });
    assert.deepEqual(await usageEntries(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a broken log path does not break pruning", async () => {
  const directory = await tmpProjectDirectory();
  try {
    await mkdir(path.join(directory, "blocked"), { recursive: true });
    await rm(path.join(directory, "blocked"), { recursive: true, force: true });
    await writeFile(path.join(directory, "blocked"), "not a directory");
    await writeFile(
      path.join(directory, ".opencode", "context-dedup.json"),
      JSON.stringify({ tokenUsage: { path: path.join(directory, "blocked", "token-usage.jsonl") } }),
    );

    const plugin = await loadPlugin(directory);
    const output = {
      messages: duplicateToolMessages({ removedText: "x".repeat(300), keptText: "x".repeat(300) }),
    };
    await plugin["experimental.chat.messages.transform"]({}, output);
    await plugin.event({ event: messageUpdatedEvent(assistantInfo({ id: "msg_break" })) });

    // Pruning happened even though logging failed.
    assert.notEqual(output.messages[1].parts[0].state.output, "x".repeat(300));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("large cache and reasoning counters stay subsets of the normalized totals", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });
    // cache.read >> uncached input: expected when most of the prompt is cached.
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({ id: "msg_anom", tokens: usageTokens({ input: 5000, output: 200, reasoning: 1500, cached: 8000 }) }),
      ),
    });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 1);
    const { record } = entries[0];
    assert.equal(
      entries[0].file,
      `token-usage-${usageLogDateKey(record.timestamp)}.jsonl`,
    );

    assert.equal(record.usage_status, "actual");
    assert.deepEqual(record.input_tokens, { value: 13000, source: "provider_usage_derived" });
    assert.deepEqual(record.cached_input_tokens, { value: 8000, source: "provider_usage" });
    assert.deepEqual(record.uncached_input_tokens, { value: 5000, source: "provider_usage" });
    assert.deepEqual(record.output_tokens, { value: 1700, source: "provider_usage_derived" });
    assert.deepEqual(record.reasoning_tokens, { value: 1500, source: "provider_usage" });
    assert.deepEqual(record.total_tokens, { value: 14700, source: "provider_usage" });
    assert.equal(record.errors.length, 0);
    assert.ok(record.reasoning_tokens.value <= record.output_tokens.value);
    assert.ok(record.cached_input_tokens.value <= record.input_tokens.value);
    // No credentials, prompts, or response bodies leak into the record.
    const text = JSON.stringify(record);
    assert.equal(text.includes("sk-"), false);
    assert.equal(text.includes("prompt"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("zero usage from an unpopulated terminal message is not recorded as actual", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({ id: "msg_zero", tokens: usageTokens({ input: 0, output: 0, cached: 0 }) }),
      ),
    });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 1);
    const { record } = entries[0];
    assert.equal(
      entries[0].file,
      `token-usage-${usageLogDateKey(record.timestamp)}.jsonl`,
    );
    assert.equal(record.usage_status, "unverified");
    assert.deepEqual(record.input_tokens, { value: 0, source: "provider_usage_derived" });
    assert.deepEqual(record.output_tokens, { value: 0, source: "provider_usage_derived" });
    assert.deepEqual(record.total_tokens, { value: 0, source: "provider_usage" });
    assert.ok(record.errors.includes("usage_zero_unverified"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("older runtime schema (reasoning included in output) does not double count", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({
          id: "msg_old_runtime",
          tokens: usageTokens({
            input: 5000,
            output: 200,
            reasoning: 1500,
            cached: 8000,
            total: 13200,
          }),
        }),
      ),
    });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 1);
    const { record } = entries[0];
    assert.equal(record.usage_status, "actual");
    assert.deepEqual(record.input_tokens, { value: 13000, source: "provider_usage_derived" });
    assert.deepEqual(record.output_tokens, { value: 200, source: "provider_usage_derived" });
    assert.deepEqual(record.reasoning_tokens, { value: 1500, source: "provider_usage" });
    assert.deepEqual(record.total_tokens, { value: 13200, source: "provider_usage" });
    assert.equal(record.errors.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cache reads are per request, not accumulated across requests", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });

    for (const [id, cached] of [
      ["msg_cache_1", 1152],
      ["msg_cache_2", 1920],
    ]) {
      await plugin["experimental.chat.messages.transform"]({}, {
        messages: [userMessage({ text: `continue ${id}` })],
      });
      await plugin.event({
        event: messageUpdatedEvent(
          assistantInfo({ id, tokens: usageTokens({ input: 784, output: 2, cached }) }),
        ),
      });
    }

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.record.cached_input_tokens.value),
      [1152, 1920],
    );
    // The second record is not 1152 + 1920.
    assert.deepEqual(
      entries.map((entry) => entry.record.input_tokens.value),
      [1936, 2704],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retry attempts are separate records and the successful attempt is not suppressed", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });

    // Attempt 1 fails without provider usage.
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({
          id: "msg_retry",
          tokens: usageTokens({ input: 0, output: 0, reasoning: 0, cached: 0 }),
          error: { name: "ProviderError", data: { message: "temporary" } },
        }),
      ),
    });

    // The runtime schedules attempt 2 and reuses the assistant message id.
    await plugin.event({
      event: {
        type: "session.retry.scheduled",
        properties: { assistantMessageID: "msg_retry", attempt: 2, at: Date.now() },
      },
    });

    // Attempt 2 succeeds with real usage.
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue again" })],
    });
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({
          id: "msg_retry",
          tokens: usageTokens({ input: 100, output: 50, reasoning: 10, cached: 900 }),
        }),
      ),
    });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 2);
    const failure = entries[0].record;
    const success = entries[1].record;
    assert.equal(failure.request_id, "msg_retry");
    assert.equal(failure.attempt, undefined); // attempt 1 is implicit
    assert.equal(failure.usage_status, "unverified");
    assert.equal(success.request_id, "msg_retry");
    assert.equal(success.attempt, 2);
    assert.equal(success.usage_status, "actual");
    assert.deepEqual(success.input_tokens, { value: 1000, source: "provider_usage_derived" });
    assert.deepEqual(success.output_tokens, { value: 60, source: "provider_usage_derived" });
    assert.deepEqual(success.total_tokens, { value: 1060, source: "provider_usage" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed attempt carrying retry separates the next success without the scheduled event", async () => {
  const directory = await tmpProjectDirectory();
  try {
    const plugin = await loadPlugin(directory);
    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue" })],
    });

    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({
          id: "msg_retry_field",
          tokens: usageTokens({ input: 0, output: 0, reasoning: 0, cached: 0 }),
          error: { name: "ProviderError", data: { message: "temporary" } },
          retry: { attempt: 2 },
        }),
      ),
    });

    await plugin["experimental.chat.messages.transform"]({}, {
      messages: [userMessage({ text: "continue again" })],
    });
    await plugin.event({
      event: messageUpdatedEvent(
        assistantInfo({
          id: "msg_retry_field",
          tokens: usageTokens({ input: 100, output: 50, reasoning: 10, cached: 900 }),
        }),
      ),
    });

    const entries = await usageEntries(directory);
    assert.equal(entries.length, 2);
    const [failure, success] = entries.map((entry) => entry.record);
    assert.equal(failure.attempt, undefined);
    assert.equal(failure.usage_status, "unverified");
    assert.equal(success.attempt, 2);
    assert.equal(success.usage_status, "actual");
    assert.deepEqual(success.total_tokens, { value: 1060, source: "provider_usage" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
