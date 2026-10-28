import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReferenceIndex,
  indexHasReference,
  referencesCallId,
  referencesCallIdAfter,
} from "../../.opencode/context-dedup/opencode.js";
import { SESSION_ID } from "./helpers.mjs";

function textPart(order, text) {
  return { order, part: { type: "text", text } };
}
function toolPart(order, callID, { output = "", error = "", input = { filePath: "a.txt" }, metadata = {}, status = "completed" } = {}) {
  return {
    order,
    part: {
      type: "tool",
      callID,
      tool: "read",
      state: { status, input, output, error, metadata, title: "read", time: { start: 1, end: 2 } },
    },
  };
}
function subtaskPart(order, prompt) {
  return { order, part: { type: "subtask", prompt } };
}

// Legacy direct-scan implementation, kept here only to prove the index matches.
function legacyReferencesCallId(orderedParts, callId, fromOrderExclusive, toOrderExclusive) {
  if (!Array.isArray(orderedParts) || typeof callId !== "string" || callId.length === 0) return false;
  for (const item of orderedParts) {
    if (!item || item.order <= fromOrderExclusive || item.order >= toOrderExclusive) continue;
    const part = item.part;
    if (!part || typeof part !== "object") continue;
    const candidates = [];
    if (typeof part.text === "string") candidates.push(part.text);
    if (part.type === "subtask" && typeof part.prompt === "string") candidates.push(part.prompt);
    if (part.type === "tool") {
      if (part.metadata !== undefined) candidates.push(JSON.stringify(part.metadata));
      const state = part.state;
      if (state && typeof state === "object") {
        if (typeof state.output === "string") candidates.push(state.output);
        if (typeof state.error === "string") candidates.push(state.error);
        if (state.input !== undefined) candidates.push(JSON.stringify(state.input));
        if (state.metadata !== undefined) candidates.push(JSON.stringify(state.metadata));
      }
    }
    for (const text of candidates) {
      if (text.includes(callId)) return true;
    }
  }
  return false;
}

const ids = ["call_a", "call_b", "call_with_dots.in.it", "call_special*chars?"];

const fixture = [
  textPart(0, "intro, no references"),
  toolPart(1, "call_a", { output: "result for a" }),
  textPart(2, "later text mentions call_a"),            // references call_a after order 1
  toolPart(3, "call_b", { output: "output b" }),
  textPart(4, "see call_b and call_with_dots.in.it"),    // references call_b, call_with_dots.in.it
  subtaskPart(5, "delegate with call_special*chars?"),
  toolPart(6, "call_a", { status: "error", error: "boom also mentions call_b" }),
  textPart(7, "call_a again after keeper"),
];

test("the reference index matches the per-decision scan exactly", () => {
  const index = buildReferenceIndex(fixture, ids, -Infinity);

  for (const id of ids) {
    for (const from of [-1, 0, 1, 2, 3, 4, 5, 6]) {
      for (const to of [from + 1, from + 2, 7, Number.POSITIVE_INFINITY]) {
        const actual = indexHasReference(index, id, from, to);
        const expected = legacyReferencesCallId(fixture, id, from, to);
        assert.equal(
          actual,
          expected,
          `index mismatch id=${id} from=${from} to=${to}: ${actual} vs ${expected}`,
        );
      }
    }
  }
});

test("the exported wrappers behave identically to the legacy signature", () => {
  // Both bounds are exclusive, matching the original scan semantics.
  assert.equal(referencesCallId(fixture, "call_a", 1, 7), true);   // order 2 ref inside (1,7)
  assert.equal(referencesCallId(fixture, "call_a", 2, 7), false);  // order 2 excluded; order 7 excluded by upper bound
  assert.equal(referencesCallId(fixture, "call_a", 1, 8), true);   // order 7 ref inside (1,8)
  assert.equal(referencesCallId(fixture, "call_a", 3, 7), false);  // no ref inside (3,7)
  assert.equal(referencesCallIdAfter(fixture, "call_b", 3), true); // order 4 ref after 3
  assert.equal(referencesCallIdAfter(fixture, "call_b", 6), false);// only refs at 4 and 6, both <=6
  assert.equal(referencesCallId(fixture, "call_with_dots.in.it", 0, 8), true);
  assert.equal(referencesCallId(fixture, "call_special*chars?", 0, 8), true);
  assert.equal(referencesCallId(fixture, "missing_id", 0, 8), false);
  assert.equal(referencesCallId([], "x", 0, 1), false);
  assert.equal(referencesCallId(fixture, "", 0, 1), false);
});

test("an empty id set builds an empty index without scanning", () => {
  const index = buildReferenceIndex(fixture, [], -Infinity);
  assert.equal(index.refsById.size, 0);
  assert.equal(indexHasReference(index, "anything", 0, 8), false);
});

test("startOrderExclusive prunes parts before the earliest relevant one", () => {
  // call_b is first referenced at order 4; scanning from 4 must still find it.
  const index = buildReferenceIndex(fixture, ["call_b"], 3);
  assert.equal(indexHasReference(index, "call_b", 3, 8), true);
  // Scanning from after the only reference finds nothing.
  const late = buildReferenceIndex(fixture, ["call_b"], 6);
  assert.equal(indexHasReference(late, "call_b", 6, 8), false);
});

test("a part that mentions the same id twice records one order", () => {
  const parts = [textPart(1, "call_x and call_x again")];
  const index = buildReferenceIndex(parts, ["call_x"], -Infinity);
  assert.deepEqual(index.refsById.get("call_x"), [1]);
});
