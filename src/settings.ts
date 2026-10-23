export const SETTINGS_KEY = "hotIdleCompaction";

export type PerModelSettings = {
  compactAtTokens?: number;
  ttlSeconds?: number;
};

export type HotIdleSettings = {
  enabled: boolean;
  minContextTokens: number;
  compactAtTokens: number;
  ttlSeconds: number | undefined;
  perModel: Record<string, PerModelSettings>;
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
  const rawPerModel = asPlainObject(root.perModel, ".perModel");

  const perModel: Record<string, PerModelSettings> = {};
  for (const [modelKey, rawModelSettings] of Object.entries(rawPerModel)) {
    const modelSettings = asPlainObject(rawModelSettings, `.perModel["${modelKey}"]`);
    perModel[modelKey] = {
      compactAtTokens: readOptionalNumber(
        modelSettings,
        "compactAtTokens",
        undefined,
        `.perModel["${modelKey}"]`,
      ),
      ttlSeconds: readOptionalNumber(
        modelSettings,
        "ttlSeconds",
        undefined,
        `.perModel["${modelKey}"]`,
      ),
    };
  }

  const defaults = DEFAULT_SETTINGS;
  return {
    enabled: readBoolean(root, "enabled", defaults.enabled, ""),
    minContextTokens: readNumber(root, "minContextTokens", defaults.minContextTokens, ""),
    compactAtTokens: readNumber(root, "compactAtTokens", defaults.compactAtTokens, ""),
    ttlSeconds: readOptionalNumber(root, "ttlSeconds", defaults.ttlSeconds, ""),
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

export function compactAtTokensForModel(settings: HotIdleSettings, modelKey: string): number {
  return settings.perModel[modelKey]?.compactAtTokens ?? settings.compactAtTokens;
}

export function ttlSecondsForModel(
  settings: HotIdleSettings,
  modelKey: string,
  declaredByModelSeconds: number | undefined,
): number | undefined {
  return settings.perModel[modelKey]?.ttlSeconds ?? settings.ttlSeconds ?? declaredByModelSeconds;
}
