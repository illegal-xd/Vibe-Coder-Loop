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
  assert.equal(config.barrierOnNonWhitelistedTools, true);
  assert.equal(config.protectCallIdReferences, true);
  assert.deepEqual(config.deduplication, { enabled: true });
  assert.equal(config.errorPurge.enabled, true);
  assert.equal(config.errorPurge.preview, false);
  assert.equal(config.errorPurge.preserveAcrossUserTurns, true);
  assert.equal(config.errorPurge.preserveOnStateChanges, true);
  assert.equal(config.errorPurge.pruneRepeatedFailures, true);
  assert.equal(config.errorPurge.protectReferences, true);
  assert.equal(config.errorPurge.minSuccesses, 1);
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

test("error purge input options validate and default conservatively", () => {
  const defaults = resolveConfig({}, {});
  assert.equal(defaults.errorPurge.redactInputPayload, true);
  assert.equal(defaults.errorPurge.staleInputAfterUserTurns, null);
  assert.ok(defaults.errorPurge.inputPlaceholder.startsWith("[vibe-context-dedup]"));

  const disabled = resolveConfig(
    { errorPurge: { redactInputPayload: false, staleInputAfterUserTurns: 3 } },
    {},
  );
  assert.equal(disabled.errorPurge.redactInputPayload, false);
  assert.equal(disabled.errorPurge.staleInputAfterUserTurns, 3);

  assert.throws(
    () => resolveConfig({ errorPurge: { redactInputPayload: "yes" } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ errorPurge: { staleInputAfterUserTurns: 0 } }, {}),
    ConfigError,
  );
  assert.throws(
    () => resolveConfig({ errorPurge: { inputPlaceholder: "plain" } }, {}),
    ConfigError,
  );
});
