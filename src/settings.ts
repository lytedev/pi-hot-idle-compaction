export const SETTINGS_KEY = "hotIdleCompaction";

export const FALLBACK_TTL_SECONDS = 300;

export type SettingsOverrides = {
  ttlSeconds?: number;
  minContextTokens?: number;
  compactAtTokens?: number;
  summaryMinTokens?: number;
  keepMostRecentToolUses?: number;
  minimumTokensCleared?: number;
  minimumFractionOfContextCleared?: number;
  keepaliveMaximumPings?: number;
};

const OVERRIDE_KEYS: (keyof SettingsOverrides)[] = [
  "ttlSeconds",
  "minContextTokens",
  "compactAtTokens",
  "summaryMinTokens",
  "keepMostRecentToolUses",
  "minimumTokensCleared",
  "minimumFractionOfContextCleared",
  "keepaliveMaximumPings",
];

export type HotIdleSettings = {
  enabled: boolean;
  minContextTokens: number;
  compactAtTokens: number;
  ttlSeconds: number | undefined;
  perProvider: Record<string, SettingsOverrides>;
  perModel: Record<string, SettingsOverrides>;
  summary: {
    maxOutputTokens: number;
    minimumCacheReadFraction: number;
  };
  stubbing: {
    enabled: boolean;
    graceSeconds: number;
    keepMostRecentToolUses: number;
    minimumTokensCleared: number;
    minimumFractionOfContextCleared: number;
  };
  idleSummary: {
    enabled: boolean;
    minContextTokens: number;
    maximumTtlSeconds: number;
    lateToleranceSeconds: number;
  };
  keepalive: {
    enabled: boolean;
    maximumPings: number | undefined;
  };
};

export const DEFAULT_SETTINGS: HotIdleSettings = {
  enabled: true,
  minContextTokens: 100_000,
  compactAtTokens: 300_000,
  ttlSeconds: undefined,
  perProvider: {},
  perModel: {},
  summary: { maxOutputTokens: 8_000, minimumCacheReadFraction: 0.8 },
  stubbing: {
    enabled: true,
    graceSeconds: 60,
    keepMostRecentToolUses: 12,
    minimumTokensCleared: 20_000,
    minimumFractionOfContextCleared: 0.3,
  },
  idleSummary: {
    enabled: true,
    minContextTokens: 250_000,
    maximumTtlSeconds: 7_200,
    lateToleranceSeconds: 60,
  },
  keepalive: { enabled: false, maximumPings: undefined },
};

type PlainObject = Record<string, unknown>;

function asPlainObject(value: unknown, path: string): PlainObject {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${SETTINGS_KEY}${path} must be an object`);
  }
  return value as PlainObject;
}

function readNumber(source: PlainObject, key: string, fallback: number, path: string): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `${SETTINGS_KEY}${path}.${key} must be a non-negative number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function readOptionalNumber(
  source: PlainObject,
  key: string,
  fallback: number | undefined,
  path: string,
): number | undefined {
  return source[key] === undefined ? fallback : readNumber(source, key, 0, path);
}

function readBoolean(source: PlainObject, key: string, fallback: boolean, path: string): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(
      `${SETTINGS_KEY}${path}.${key} must be a boolean, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function parseSettings(rawSettings: unknown): HotIdleSettings {
  const root = asPlainObject(rawSettings, "");
  const summary = asPlainObject(root.summary, ".summary");
  const stubbing = asPlainObject(root.stubbing, ".stubbing");
  const idleSummary = asPlainObject(root.idleSummary, ".idleSummary");
  const keepalive = asPlainObject(root.keepalive, ".keepalive");
  const perProvider = parseOverrideTable(root.perProvider, ".perProvider");
  const perModel = parseOverrideTable(root.perModel, ".perModel");

  const defaults = DEFAULT_SETTINGS;
  return {
    enabled: readBoolean(root, "enabled", defaults.enabled, ""),
    minContextTokens: readNumber(root, "minContextTokens", defaults.minContextTokens, ""),
    compactAtTokens: readNumber(root, "compactAtTokens", defaults.compactAtTokens, ""),
    ttlSeconds: readOptionalNumber(root, "ttlSeconds", defaults.ttlSeconds, ""),
    perProvider,
    perModel,
    summary: {
      maxOutputTokens: readNumber(
        summary,
        "maxOutputTokens",
        defaults.summary.maxOutputTokens,
        ".summary",
      ),
      minimumCacheReadFraction: readNumber(
        summary,
        "minimumCacheReadFraction",
        defaults.summary.minimumCacheReadFraction,
        ".summary",
      ),
    },
    stubbing: {
      enabled: readBoolean(stubbing, "enabled", defaults.stubbing.enabled, ".stubbing"),
      graceSeconds: readNumber(
        stubbing,
        "graceSeconds",
        defaults.stubbing.graceSeconds,
        ".stubbing",
      ),
      keepMostRecentToolUses: readNumber(
        stubbing,
        "keepMostRecentToolUses",
        defaults.stubbing.keepMostRecentToolUses,
        ".stubbing",
      ),
      minimumTokensCleared: readNumber(
        stubbing,
        "minimumTokensCleared",
        defaults.stubbing.minimumTokensCleared,
        ".stubbing",
      ),
      minimumFractionOfContextCleared: readNumber(
        stubbing,
        "minimumFractionOfContextCleared",
        defaults.stubbing.minimumFractionOfContextCleared,
        ".stubbing",
      ),
    },
    idleSummary: {
      enabled: readBoolean(idleSummary, "enabled", defaults.idleSummary.enabled, ".idleSummary"),
      minContextTokens: readNumber(
        idleSummary,
        "minContextTokens",
        defaults.idleSummary.minContextTokens,
        ".idleSummary",
      ),
      maximumTtlSeconds: readNumber(
        idleSummary,
        "maximumTtlSeconds",
        defaults.idleSummary.maximumTtlSeconds,
        ".idleSummary",
      ),
      lateToleranceSeconds: readNumber(
        idleSummary,
        "lateToleranceSeconds",
        defaults.idleSummary.lateToleranceSeconds,
        ".idleSummary",
      ),
    },
    keepalive: {
      enabled: readBoolean(keepalive, "enabled", defaults.keepalive.enabled, ".keepalive"),
      maximumPings: readOptionalNumber(
        keepalive,
        "maximumPings",
        defaults.keepalive.maximumPings,
        ".keepalive",
      ),
    },
  };
}

function parseOverrideTable(rawTable: unknown, path: string): Record<string, SettingsOverrides> {
  const table: Record<string, SettingsOverrides> = {};
  for (const [key, rawOverrides] of Object.entries(asPlainObject(rawTable, path))) {
    const overridePath = `${path}["${key}"]`;
    const overrides = asPlainObject(rawOverrides, overridePath);
    const parsed: SettingsOverrides = {};
    for (const overrideKey of OVERRIDE_KEYS) {
      const value = readOptionalNumber(overrides, overrideKey, undefined, overridePath);
      if (value !== undefined) parsed[overrideKey] = value;
    }
    for (const unknownKey of Object.keys(overrides)) {
      if (!(OVERRIDE_KEYS as string[]).includes(unknownKey)) {
        throw new Error(`${SETTINGS_KEY}${overridePath}.${unknownKey} is not a known override`);
      }
    }
    table[key] = parsed;
  }
  return table;
}

export type TtlSource = "setting" | "model-declaration" | "fallback-guess";

export type ResolvedForModel = {
  settings: HotIdleSettings;
  ttlSeconds: number;
  ttlSource: TtlSource;
};

export function resolveSettingsForModel(
  settings: HotIdleSettings,
  providerId: string,
  modelId: string,
  declaredByModelSeconds: number | undefined,
): ResolvedForModel {
  const layers: (SettingsOverrides | undefined)[] = [
    settings.perProvider[providerId],
    settings.perModel[`${providerId}/${modelId}`],
  ];
  const merged: SettingsOverrides = {};
  for (const layer of layers) Object.assign(merged, layer);

  const resolved: HotIdleSettings = {
    ...settings,
    minContextTokens: merged.minContextTokens ?? settings.minContextTokens,
    compactAtTokens: merged.compactAtTokens ?? settings.compactAtTokens,
    stubbing: {
      ...settings.stubbing,
      keepMostRecentToolUses:
        merged.keepMostRecentToolUses ?? settings.stubbing.keepMostRecentToolUses,
      minimumTokensCleared: merged.minimumTokensCleared ?? settings.stubbing.minimumTokensCleared,
      minimumFractionOfContextCleared:
        merged.minimumFractionOfContextCleared ?? settings.stubbing.minimumFractionOfContextCleared,
    },
    idleSummary: {
      ...settings.idleSummary,
      minContextTokens: merged.summaryMinTokens ?? settings.idleSummary.minContextTokens,
    },
    keepalive: {
      ...settings.keepalive,
      maximumPings: merged.keepaliveMaximumPings ?? settings.keepalive.maximumPings,
    },
  };

  const overriddenTtl = merged.ttlSeconds ?? settings.ttlSeconds;
  if (overriddenTtl !== undefined) {
    return { settings: resolved, ttlSeconds: overriddenTtl, ttlSource: "setting" };
  }
  if (declaredByModelSeconds !== undefined) {
    return {
      settings: resolved,
      ttlSeconds: declaredByModelSeconds,
      ttlSource: "model-declaration",
    };
  }
  return { settings: resolved, ttlSeconds: FALLBACK_TTL_SECONDS, ttlSource: "fallback-guess" };
}
