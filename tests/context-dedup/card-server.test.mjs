/**
 * Token-usage card server: live payload normalization, HTTP contract, and
 * static allow-listing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCardPayload,
  loadCardPayload,
  startCardServer,
} from "../../tools/token-usage-card/server.mjs";

const DAY_28 = "2026-10-28";
const DAY_29 = "2026-10-29";

function pruning({ dedup = 1, error = 0, supersede = 1 } = {}) {
  const row = (changed, removedTokens) => ({
    scanned_records: 10,
    eligible_items: changed + 2,
    candidate_items: changed + 1,
    marked_items: changed,
    changed_items: changed,
    removed_items: changed,
    removed_tokens: { value: removedTokens, source: "estimated_tokens_from_chars" },
  });
  return {
    order: ["deduplication", "error_purge", "supersede_writes", "tool_descriptions", "compact_read", "line_range_edit"],
    deduplication: row(dedup, 300),
    error_purge: row(error, 0),
    supersede_writes: row(supersede, 200),
    total_removed_tokens: { value: 500, source: "estimated_tokens_from_chars" },
  };
}

function record({ timestamp, requestId = "r1", input = 1000, output = 100, cached = 0, summary = pruning() }) {
  return {
    schema_version: 3,
    event_type: "model_request_usage",
    timestamp,
    session_id: "s",
    request_id: requestId,
    input_tokens: { value: input, source: "provider_usage" },
    output_tokens: { value: output, source: "provider_usage" },
    cached_input_tokens: { value: cached, source: "provider_usage" },
    reasoning_tokens: { value: 0, source: "provider_usage" },
    pruning: summary,
    errors: [],
  };
}

async function writeArchive(directory, records) {
  const byDay = new Map();
  for (const entry of records) {
    const day = entry.timestamp.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(entry);
    byDay.set(day, list);
  }
  for (const [day, list] of byDay) {
    await writeFile(
      path.join(directory, `token-usage-${day}.jsonl`),
      `${list.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  }
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

// ------------------------------------------------------------------ payload

test("buildCardPayload normalizes v3 records and keeps the strategy order", () => {
  const payload = buildCardPayload(
    [record({ timestamp: `${DAY_28}T10:00:00.000Z` })],
    { files: ["/archive/token-usage-2026-10-28.jsonl"], invalid: [], archive: "/archive" },
  );

  assert.deepEqual(
    payload.strategies.map((item) => item.key),
    ["deduplication", "error_purge", "supersede_writes", "tool_descriptions", "compact_read", "line_range_edit"],
  );
  assert.equal(payload.records.length, 1);
  const [at, input, output, cached, removed, rows] = payload.records[0];
  assert.equal(at, Date.parse(`${DAY_28}T10:00:00.000Z`));
  assert.equal(input, 1000);
  assert.equal(output, 100);
  assert.equal(cached, 0);
  assert.equal(removed, 500);
  assert.deepEqual(rows[0], [300, 10, 2, 1, 3, 1]);
  assert.deepEqual(rows[1], [0, 10, 1, 0, 2, 0]);
  assert.deepEqual(rows[2], [200, 10, 2, 1, 3, 1]);
  assert.equal(payload.archive, "/archive");
  assert.equal(payload.diagnostics.records, 1);
  assert.deepEqual(payload.sourceFiles, ["token-usage-2026-10-28.jsonl"]);
});

test("buildCardPayload normalizes v2 totals and four-column old rows", () => {
  const legacy = {
    schema_version: 2,
    timestamp: `${DAY_28}T11:00:00.000Z`,
    input_tokens: { value: 100 },
    output_tokens: { value: 10 },
    cached_input_tokens: { value: 40 },
    cache_write_tokens: { value: 2 },
    reasoning_tokens: { value: 5 },
    pruning: {
      deduplication: {
        scanned_records: 4,
        candidate_items: 2,
        removed_items: 1,
        removed_tokens: { value: 50, source: "estimated_tokens_from_chars" },
      },
    },
  };
  const payload = buildCardPayload([legacy], {});
  const [, input, output, cached, removed, rows] = payload.records[0];
  assert.equal(input, 142); // 100 + 40 + 2
  assert.equal(output, 15); // 10 + 5
  assert.equal(cached, 40);
  assert.equal(removed, 50);
  // Old rows lack eligible/marked: fall back to candidate/removed.
  assert.deepEqual(rows[0], [50, 4, 2, 1, 2, 1]);
  assert.equal(rows[1], null);
});

test("buildCardPayload sorts by time and skips invalid timestamps", () => {
  const payload = buildCardPayload(
    [
      record({ timestamp: `${DAY_29}T10:00:00.000Z`, requestId: "later" }),
      { ...record({ timestamp: `${DAY_28}T10:00:00.000Z` }), timestamp: "not-a-date" },
      record({ timestamp: `${DAY_28}T09:00:00.000Z`, requestId: "earlier" }),
    ],
    {},
  );
  assert.equal(payload.records.length, 2);
  assert.deepEqual(
    payload.records.map((row) => row[0]),
    [Date.parse(`${DAY_28}T09:00:00.000Z`), Date.parse(`${DAY_29}T10:00:00.000Z`)],
  );
});

test("loadCardPayload reads the archive live and honours date ranges", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-card-server-"));
  try {
    await mkdir(directory, { recursive: true });
    await writeArchive(directory, [
      record({ timestamp: `${DAY_28}T10:00:00.000Z`, requestId: "r28" }),
      record({ timestamp: `${DAY_29}T10:00:00.000Z`, requestId: "r29" }),
    ]);

    const all = await loadCardPayload({ dataDir: directory, env: {} });
    assert.equal(all.records.length, 2);
    assert.deepEqual(all.sourceFiles.sort(), [
      "token-usage-2026-10-28.jsonl",
      "token-usage-2026-10-29.jsonl",
    ]);

    const one = await loadCardPayload({ dataDir: directory, from: DAY_29, to: DAY_29, env: {} });
    assert.equal(one.records.length, 1);
    assert.equal(one.records[0][0], Date.parse(`${DAY_29}T10:00:00.000Z`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- server

async function withServer(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-card-http-"));
  try {
    await writeArchive(directory, [
      record({ timestamp: `${DAY_28}T10:00:00.000Z`, requestId: "r28" }),
      record({ timestamp: `${DAY_29}T10:00:00.000Z`, requestId: "r29" }),
    ]);
    const { server, url } = await startCardServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: directory,
      env: {},
    });
    try {
      await fn({ url, directory });
    } finally {
      await close(server);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("GET /api/usage returns the live payload with no-store", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(new URL("api/usage", url));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    assert.equal(payload.records.length, 2);
    assert.deepEqual(
      payload.strategies.map((item) => item.key),
      ["deduplication", "error_purge", "supersede_writes", "tool_descriptions", "compact_read", "line_range_edit"],
    );
    assert.equal(payload.diagnostics.records, 2);
  });
});

test("GET /api/usage validates and applies from/to", async () => {
  await withServer(async ({ url }) => {
    const filtered = await fetch(new URL(`api/usage?from=${DAY_29}&to=${DAY_29}`, url));
    assert.equal(filtered.status, 200);
    const payload = await filtered.json();
    assert.equal(payload.records.length, 1);

    const invalid = await fetch(new URL("api/usage?from=2026-13-40", url));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_range" });

    const reversed = await fetch(new URL(`api/usage?from=${DAY_29}&to=${DAY_28}`, url));
    assert.equal(reversed.status, 400);
    assert.deepEqual(await reversed.json(), { error: "range_reversed" });
  });
});

test("static assets are served from the allow-list only", async () => {
  await withServer(async ({ url }) => {
    const home = await fetch(new URL("/", url));
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /text\/html/);
    assert.match(await home.text(), /Token Usage/);

    const app = await fetch(new URL("app.js", url));
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type"), /text\/javascript/);
    assert.match(await app.text(), /aggregate/);

    const css = await fetch(new URL("styles.css", url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const missing = await fetch(new URL("server.mjs", url));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });

    const traversal = await fetch(new URL("/..%2f..%2fpackage.json", url));
    assert.equal(traversal.status, 404);
  });
});

test("HEAD and unsupported methods follow the contract", async () => {
  await withServer(async ({ url }) => {
    const head = await fetch(new URL("api/usage", url), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const post = await fetch(new URL("api/usage", url), { method: "POST" });
    assert.equal(post.status, 405);
    assert.deepEqual(await post.json(), { error: "method_not_allowed" });
  });
});

test("health reports the resolved archive", async () => {
  await withServer(async ({ url, directory }) => {
    const response = await fetch(new URL("api/health", url));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.archive, directory);
  });
});

test("a missing archive renders an empty payload instead of failing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-card-empty-"));
  const missing = path.join(directory, "does-not-exist");
  const { server, url } = await startCardServer({
    port: 0,
    host: "127.0.0.1",
    dataDir: missing,
    env: {},
  });
  try {
    const response = await fetch(new URL("api/usage", url));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.records, []);
    assert.deepEqual(payload.sourceFiles, []);
    assert.equal(payload.diagnostics.records, 0);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
