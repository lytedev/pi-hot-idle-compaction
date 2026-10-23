import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, parseSettings, resolveSettingsForModel } from "../src/settings.ts";

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

  test("a_per_model_override_beats_a_per_provider_override_which_beats_the_global_value", () => {
    const parsed = parseSettings({
      compactAtTokens: 300_000,
      perProvider: { p: { compactAtTokens: 250_000, minContextTokens: 50_000 } },
      perModel: { "p/m": { compactAtTokens: 200_000 } },
    });
    const forModel = resolveSettingsForModel(parsed, "p", "m", undefined).settings;
    const forOtherModelOfProvider = resolveSettingsForModel(
      parsed,
      "p",
      "other",
      undefined,
    ).settings;
    const forOtherProvider = resolveSettingsForModel(parsed, "q", "m", undefined).settings;
    assert.equal(forModel.compactAtTokens, 200_000, "the model override must win");
    assert.equal(
      forModel.minContextTokens,
      50_000,
      "fields the model does not override fall to the provider override",
    );
    assert.equal(
      forOtherModelOfProvider.compactAtTokens,
      250_000,
      "the provider override applies to its other models",
    );
    assert.equal(
      forOtherProvider.compactAtTokens,
      300_000,
      "unrelated providers keep the global value",
    );
  });

  test("every_threshold_can_be_overridden_per_model", () => {
    const parsed = parseSettings({
      perModel: {
        "p/m": {
          minContextTokens: 1,
          compactAtTokens: 2,
          summaryMinTokens: 3,
          keepMostRecentToolUses: 4,
          minimumTokensCleared: 5,
          minimumFractionOfContextCleared: 0.6,
          keepaliveMaximumPings: 7,
        },
      },
    });
    const resolved = resolveSettingsForModel(parsed, "p", "m", undefined).settings;
    assert.deepEqual(
      [
        resolved.minContextTokens,
        resolved.compactAtTokens,
        resolved.idleSummary.minContextTokens,
        resolved.stubbing.keepMostRecentToolUses,
        resolved.stubbing.minimumTokensCleared,
        resolved.stubbing.minimumFractionOfContextCleared,
        resolved.keepalive.maximumPings,
      ],
      [1, 2, 3, 4, 5, 0.6, 7],
      "each documented override must reach the setting it names",
    );
  });

  test("an_unknown_override_key_is_rejected_so_typos_do_not_silently_do_nothing", () => {
    assert.throws(
      () => parseSettings({ perModel: { "p/m": { compactAt: 1 } } }),
      /compactAt is not a known override/,
      "typos must be loud",
    );
  });

  test("ttl_comes_from_a_setting_first_then_the_model_declaration_then_a_five_minute_guess", () => {
    const withSetting = parseSettings({ ttlSeconds: 600, perModel: { "a/b": { ttlSeconds: 90 } } });
    assert.deepEqual(
      [
        resolveSettingsForModel(withSetting, "a", "b", 3600).ttlSeconds,
        resolveSettingsForModel(withSetting, "c", "d", 3600).ttlSeconds,
      ],
      [90, 600],
      "per-model setting wins, then the global setting, both beating the declaration",
    );
    const declared = resolveSettingsForModel(parseSettings({}), "c", "d", 3600);
    assert.deepEqual(
      [declared.ttlSeconds, declared.ttlSource],
      [3600, "model-declaration"],
      "the declaration is used when no setting exists",
    );
    const guessed = resolveSettingsForModel(parseSettings({}), "c", "d", undefined);
    assert.deepEqual(
      [guessed.ttlSeconds, guessed.ttlSource],
      [300, "fallback-guess"],
      "with no information the lifetime is a flagged 5 minute guess",
    );
  });
});
