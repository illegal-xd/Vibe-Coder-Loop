/**
 * Unified viewer · memory payload: SQLite decoding (value JSON string, comma
 * tags, metadata JSON), fragment relations, read-only loading and HTTP route.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildMemoryPayload,
  loadMemoryPayload,
  startViewerServer,
} from "../../tools/viewer/server.mjs";

const NOW = new Date("2026-11-23T12:00:00.000Z");

function row(overrides = {}) {
  return {
    key: "lesson:example",
    value: JSON.stringify("正文内容"),
    tags: ",lesson,p_high,",
    metadata: JSON.stringify({ status: "active", layer: "L1" }),
    created_at: 1000,
    updated_at: 2000,
    ttl_expires_at: null,
    ...overrides,
  };
}

test("buildMemoryPayload decodes rows, tags, metadata and fragment relations", () => {
  const payload = buildMemoryPayload(
    [
      row(),
      row({
        key: "lesson:example#1",
        value: JSON.stringify("分片正文"),
        tags: ",fragment,,",
        metadata: JSON.stringify({ status: "active", fragments: ["lesson:example#1"] }),
        updated_at: 3000,
      }),
    ],
    { source: "/tmp/db.sqlite", now: NOW }
  );

  assert.equal(payload.available, true);
  assert.equal(payload.source, "/tmp/db.sqlite");
  assert.equal(payload.total, 2);
  assert.equal(payload.total_chars, Array.from("正文内容").length + Array.from("分片正文").length);
  assert.deepEqual(payload.types, { lesson: 2 });
  assert.equal(payload.generated_at, NOW.getTime());

  // sorted by updated_at desc: the fragment is newest.
  assert.equal(payload.entries[0].key, "lesson:example#1");
  const fragment = payload.entries[0];
  assert.equal(fragment.type, "lesson");
  assert.equal(fragment.fragment, true);
  assert.equal(fragment.parent, "lesson:example");
  assert.equal(fragment.value, "分片正文");
  assert.deepEqual(fragment.tags, ["fragment"]);
  assert.equal(fragment.status, "active");

  const parent = payload.entries[1];
  assert.equal(parent.fragment, false);
  assert.equal(parent.parent, null);
  assert.equal(parent.value, "正文内容");
  assert.deepEqual(parent.tags, ["lesson", "p_high"]);
  assert.equal(parent.weight, "p_high");
  assert.equal(parent.layer, "L1");
  assert.equal(parent.size, Array.from("正文内容").length);
});

test("buildMemoryPayload tolerates malformed value/metadata and empty input", () => {
  const payload = buildMemoryPayload(
    [
      row({ key: "note:raw", value: "plain text", metadata: "{not json" }),
      row({ key: "", value: "ignored" }),
    ],
    { now: NOW }
  );
  assert.equal(payload.total, 1);
  const entry = payload.entries[0];
  assert.equal(entry.key, "note:raw");
  assert.equal(entry.value, "plain text");
  assert.deepEqual(entry.metadata, {});
  assert.equal(entry.status, null);

  const empty = buildMemoryPayload([], { now: NOW });
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.types, {});
  assert.equal(empty.total, 0);
});

test("loadMemoryPayload reads a real SQLite database read-only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "viewer-memory-"));
  try {
    const dbPath = path.join(dir, "db.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "create table memory (key text primary key, value text, tags text, metadata text, " +
        "created_at integer, updated_at integer, ttl_expires_at integer)"
    );
    const insert = db.prepare(
      "insert into memory (key,value,tags,metadata,created_at,updated_at,ttl_expires_at) " +
        "values (?,?,?,?,?,?,?)"
    );
    insert.run(
      "rule:alpha",
      JSON.stringify("规则正文"),
      ",rule,L0,",
      JSON.stringify({ status: "active", layer: "L0" }),
      1000,
      2000,
      null
    );
    insert.run(
      "rule:alpha#1",
      JSON.stringify("分片"),
      ",fragment,",
      JSON.stringify({ fragments: ["rule:alpha#1"] }),
      1000,
      3000,
      null
    );
    db.close();

    const payload = await loadMemoryPayload({ dbPath, now: NOW });
    assert.equal(payload.available, true);
    assert.equal(payload.error, null);
    assert.equal(payload.source, dbPath);
    assert.equal(payload.total, 2);
    assert.equal(payload.entries[0].key, "rule:alpha#1");
    assert.equal(payload.entries[1].value, "规则正文");

    const started = await startViewerServer({
      port: 0,
      host: "127.0.0.1",
      memoryDb: dbPath,
    });
    try {
      const response = await fetch(new URL("api/memory", started.url));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.total, 2);
      assert.equal(body.entries[1].key, "rule:alpha");
    } finally {
      await new Promise((resolve) => started.server.close(resolve));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing database degrades to an empty payload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "viewer-memory-missing-"));
  try {
    const payload = await loadMemoryPayload({
      dbPath: path.join(dir, "does-not-exist.sqlite"),
      now: NOW,
    });
    assert.equal(payload.available, false);
    assert.equal(payload.error, "database_missing");
    assert.deepEqual(payload.entries, []);
    assert.equal(payload.total, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
