import test from "node:test";
import assert from "node:assert/strict";

import {
  ConfigError,
  DEFAULT_CONFIG,
  isTruthy,
  resolveConfig,
} from "../../.opencode/context-dedup/config.js";

test("defaults are safe and explicit", () => {
  const config = resolveConfig({}, {});
  assert.equal(config.enabled, true);
  assert.equal(config.preview, false);
  assert.deepEqual(config.tools, ["read", "grep", "glob"]);
  assert.equal(config.protectCallIdReferences, true);
  assert.deepEqual(config.deduplication, {
    enabled: true,
    tools: ["read", "grep", "glob", "bash"],
    collapseReadWindows: true,
  });
  assert.equal(config.errorPurge.enabled, true);
  assert.equal(config.errorPurge.preview, false);
  assert.equal(config.errorPurge.preserveAcrossUserTurns, false);
  assert.equal(config.errorPurge.preserveRepeatedFailuresAcrossUserTurns, false);
  assert.equal(config.errorPurge.preserveOnStateChanges, true);
  assert.equal(config.errorPurge.pruneRepeatedFailures, true);
  assert.equal(config.errorPurge.protectReferences, true);
  assert.equal(config.errorPurge.minSuccesses, 1);
  // The runtime reports a real exit status, so completed shell calls are
  // success/failure evidence instead of being ignored.
  assert.equal(config.errorPurge.shellExitReliable, true);
  assert.equal(config.errorPurge.shellFailureDetection, "ambiguous");
  // Supersede Writes: non-mutating tools and inspection-only shell chains are
  // not barriers by default; both can be turned off explicitly.
  assert.deepEqual(config.supersedeWrites.barrierExemptTools, [
    "todowrite",
    "question",
    "webfetch",
    "websearch",
    "list",
  ]);
  assert.equal(config.supersedeWrites.barrierExemptShellCommands, true);
  assert.deepEqual(config.log, DEFAULT_CONFIG.log);
});

test("environment can disable or preview without editing the file", () => {
  const disabled = resolveConfig({}, { VIBE_CONTEXT_DEDUP_DISABLED: "1" });
  assert.equal(disabled.enabled, false);

  const preview = resolveConfig({}, { VIBE_CONTEXT_DEDUP_PREVIEW: "true" });
  assert.equal(preview.preview, true);

  const logDisabled = resolveConfig({}, { VIBE_CONTEXT_DEDUP_LOG_DISABLED: "yes" });
  assert.equal(logDisabled.log.enabled, false);
});

test("the global preview environment switch reaches every strategy", () => {
  // A dry-run must not leave sibling strategies rewriting the request.
  const config = resolveConfig({}, { VIBE_CONTEXT_DEDUP_PREVIEW: "1" });
  assert.equal(config.preview, true);
  assert.equal(config.errorPurge.preview, true);
  assert.equal(config.supersedeWrites.preview, true);
  assert.equal(config.slimEdit.preview, true);
});

test("the global preview environment switch wins over explicit false", () => {
  // The same precedence VIBE_CONTEXT_DEDUP_DISABLED has over `enabled`.
  const config = resolveConfig(
    { preview: false, errorPurge: { preview: false }, supersedeWrites: { preview: false } },
    { VIBE_CONTEXT_DEDUP_PREVIEW: "1" },
  );
  assert.equal(config.preview, true);
  assert.equal(config.errorPurge.preview, true);
  assert.equal(config.supersedeWrites.preview, true);
});

test("strategies are independently configurable", () => {
  const config = resolveConfig(
    {
      deduplication: { enabled: false },
      errorPurge: { enabled: false, preview: true, minSuccesses: 2 },
    },
    {},
  );
  assert.equal(config.deduplication.enabled, false);
  assert.equal(config.errorPurge.enabled, false);
  assert.equal(config.errorPurge.preview, true);
  assert.equal(config.errorPurge.minSuccesses, 2);
  assert.deepEqual(config.tools, ["read", "grep", "glob"]);
});

test("top-level preview is inherited unless Error Purge overrides it", () => {
  const inherited = resolveConfig({ preview: true }, {});
  assert.equal(inherited.preview, true);
  assert.equal(inherited.errorPurge.preview, true);

  const overridden = resolveConfig({ preview: true, errorPurge: { preview: false } }, {});
  assert.equal(overridden.errorPurge.preview, false);
});

test("Error Purge environment switches are independent", () => {
  const disabled = resolveConfig({}, { VIBE_CONTEXT_ERROR_PURGE_DISABLED: "1" });
  assert.equal(disabled.errorPurge.enabled, false);
  assert.equal(disabled.enabled, true);

  const preview = resolveConfig({}, { VIBE_CONTEXT_ERROR_PURGE_PREVIEW: "yes" });
  assert.equal(preview.errorPurge.preview, true);
  assert.equal(preview.preview, false);
});

test("Error Purge invalid fields fail closed", () => {
  assert.throws(() => resolveConfig({ errorPurge: { enabled: "yes" } }, {}), ConfigError);
  assert.throws(() => resolveConfig({ errorPurge: { preview: 1 } }, {}), ConfigError);
  assert.throws(() => resolveConfig({ errorPurge: { minSuccesses: 0 } }, {}), ConfigError);
  assert.throws(
    () => resolveConfig({ errorPurge: { placeholder: "plain" } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ errorPurge: { preserveOnStateChanges: "no" } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ errorPurge: { preserveRepeatedFailuresAcrossUserTurns: "no" } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ errorPurge: { shellExitReliable: "no" } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ errorPurge: { shellFailureDetection: "maybe" } }, {}),
    ConfigError,
  );
  assert.throws(() => resolveConfig({ deduplication: [] }, {}), ConfigError);
  assert.throws(() => resolveConfig({ deduplication: { enabled: 1 } }, {}), ConfigError);
});

test("whitelist is validated and de-duplicated", () => {
  const config = resolveConfig({ tools: ["read", "read", "list"] }, {});
  assert.deepEqual(config.tools, ["read", "list"]);

  assert.throws(() => resolveConfig({ tools: [] }, {}), ConfigError);
  assert.throws(() => resolveConfig({ tools: [""] }, {}), ConfigError);
  assert.throws(() => resolveConfig({ tools: "read" }, {}), ConfigError);
});

test("invalid known fields fail closed", () => {
  assert.throws(() => resolveConfig({ enabled: "yes" }, {}), ConfigError);
  assert.throws(() => resolveConfig({ preview: 1 }, {}), ConfigError);
  assert.throws(() => resolveConfig({ placeholder: "plain text" }, {}), ConfigError);
  assert.throws(() => resolveConfig({ log: { maxBytes: 0 } }, {}), ConfigError);
  assert.throws(() => resolveConfig({ log: { path: "" } }, {}), ConfigError);
});

test("unknown keys are ignored for forward compatibility", () => {
  const config = resolveConfig({ futureOption: true }, {});
  assert.equal(config.enabled, true);
  assert.equal(config.futureOption, undefined);
});

test("isTruthy only accepts explicit truthy tokens", () => {
  for (const value of ["1", "true", "YES", "on", true]) assert.equal(isTruthy(value), true);
  for (const value of ["0", "false", "off", "", undefined, null, 1]) {
    assert.equal(isTruthy(value), false);
  }
});

test("protection lists default to empty and accept empty overrides", () => {
  const defaults = resolveConfig({}, {});
  assert.deepEqual(defaults.protectedTools, []);
  assert.deepEqual(defaults.protectedFilePatterns, []);

  const empty = resolveConfig({ protectedTools: [], protectedFilePatterns: [] }, {});
  assert.deepEqual(empty.protectedTools, []);
  assert.deepEqual(empty.protectedFilePatterns, []);

  const custom = resolveConfig(
    { protectedTools: ["write", "write"], protectedFilePatterns: ["**/.env", "**/.env"] },
    {},
  );
  assert.deepEqual(custom.protectedTools, ["write"]);
  assert.deepEqual(custom.protectedFilePatterns, ["**/.env"]);
});

test("error purge input options validate with a turn-based default", () => {
  const defaults = resolveConfig({}, {});
  assert.equal(defaults.errorPurge.redactInputPayload, true);
  // Reference parity: confirmed failures older than 4 user turns keep their
  // error text but drop the bulky input payload.
  assert.equal(defaults.errorPurge.staleInputAfterTurns, 4);
  assert.ok(defaults.errorPurge.inputPlaceholder.startsWith("[vibe-context-dedup]"));

  const off = resolveConfig({ errorPurge: { staleInputAfterTurns: null } }, {});
  assert.equal(off.errorPurge.staleInputAfterTurns, 0);

  // Pre-v2 key name remains an alias so an existing config file keeps working.
  const legacy = resolveConfig({ errorPurge: { staleInputAfterUserTurns: 2 } }, {});
  assert.equal(legacy.errorPurge.staleInputAfterTurns, 2);

  const disabled = resolveConfig(
    { errorPurge: { redactInputPayload: false, staleInputAfterTurns: 3 } },
    {},
  );
  assert.equal(disabled.errorPurge.redactInputPayload, false);
  assert.equal(disabled.errorPurge.staleInputAfterTurns, 3);

  assert.throws(
    () => resolveConfig({ errorPurge: { redactInputPayload: "yes" } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ errorPurge: { staleInputAfterTurns: 0 } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ errorPurge: { inputPlaceholder: "plain" } }, {}),
    ConfigError,
  );
});

test("supersedeWrites exposes the order fallback switch (default off)", () => {
  assert.equal(resolveConfig({}, {}).supersedeWrites.allowOrderFallback, false);

  const enabled = resolveConfig(
    { supersedeWrites: { allowOrderFallback: true } },
    {},
  );
  assert.equal(enabled.supersedeWrites.allowOrderFallback, true);

  assert.throws(
    () => resolveConfig({ supersedeWrites: { allowOrderFallback: "yes" } }, {}),
    ConfigError,
  );
});

test("referenceProtection defaults to any and accepts strong", () => {
  assert.equal(resolveConfig({}, {}).referenceProtection, "any");
  assert.equal(
    resolveConfig({ referenceProtection: "strong" }, {}).referenceProtection,
    "strong",
  );
  assert.throws(
    () => resolveConfig({ referenceProtection: "weak" }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ referenceProtection: true }, {}),
    ConfigError,
  );
});
