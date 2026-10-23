import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  compactAtTokensForModel,
  DEFAULT_SETTINGS,
  parseSettings,
  ttlSecondsForModel,
} from "../src/settings.ts";

describe("settings", () => {
  test("missing_settings_parse_to_the_documented_defaults", () => {
    assert.deepEqual(
      parseSettings(undefined),
      DEFAULT_SETTINGS,
      "an absent settings object must produce exactly the defaults",
    );
  });

  test("a_partial_nested_object_overrides_only_the_fields_it_names", () => {
    const parsed = parseSettings({ stubbing: { keepMostRecentToolUses: 3 } });
    assert.equal(
      parsed.stubbing.keepMostRecentToolUses,
      3,
      "the named field must take the configured value",
    );
    assert.equal(
      parsed.stubbing.minimumTokensCleared,
      DEFAULT_SETTINGS.stubbing.minimumTokensCleared,
      "sibling fields must keep their defaults",
    );
  });

  test("a_negative_threshold_is_rejected_with_the_offending_path_in_the_message", () => {
    assert.throws(
      () => parseSettings({ compactAtTokens: -1 }),
      /hotIdleCompaction\.compactAtTokens must be a non-negative number/,
      "a negative number must name the setting path so the operator can find it",
    );
  });

  test("a_non_boolean_enabled_flag_is_rejected", () => {
    assert.throws(
      () => parseSettings({ keepalive: { enabled: "yes" } }),
      /keepalive\.enabled must be a boolean/,
      "string flags must be rejected instead of being treated as truthy",
    );
  });

  test("a_per_model_threshold_beats_the_global_threshold_for_that_model_only", () => {
    const parsed = parseSettings({
      compactAtTokens: 300_000,
      perModel: {
        "openrouter-gateway/deepseek/deepseek-v4-pro-0813": { compactAtTokens: 200_000 },
      },
    });
    assert.equal(
      compactAtTokensForModel(parsed, "openrouter-gateway/deepseek/deepseek-v4-pro-0813"),
      200_000,
      "the configured model must use its own threshold",
    );
    assert.equal(
      compactAtTokensForModel(parsed, "anthropic/claude-sonnet-5"),
      300_000,
      "other models must use the global threshold",
    );
  });

  test("ttl_resolution_prefers_per_model_then_global_setting_then_the_models_own_declaration", () => {
    const parsed = parseSettings({ ttlSeconds: 600, perModel: { "a/b": { ttlSeconds: 90 } } });
    assert.equal(ttlSecondsForModel(parsed, "a/b", 3600), 90, "per-model setting must win");
    assert.equal(
      ttlSecondsForModel(parsed, "c/d", 3600),
      600,
      "global setting must beat the declaration",
    );
    assert.equal(
      ttlSecondsForModel(parseSettings({}), "c/d", 3600),
      3600,
      "declaration is the fallback",
    );
    assert.equal(
      ttlSecondsForModel(parseSettings({}), "c/d", undefined),
      undefined,
      "no source means unknown",
    );
  });
});
