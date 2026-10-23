export const ACTION_ENTRY_TYPE = "hot-idle-action";
export const STUB_ENTRY_TYPE = "hot-idle-stubs";

export type ActionKind =
  | "threshold-compaction"
  | "idle-summary"
  | "pi-compaction-with-cached-summary"
  | "stubbing"
  | "keepalive-ping";

export type ActionRecord = {
  kind: ActionKind;
  atEpochMilliseconds: number;
  contextTokens: number;
  actualCostDollars: number;
  estimatedSavedDollars: number;
  cacheReadTokens?: number;
  detail: string;
};

export type StubRecord = {
  atEpochMilliseconds: number;
  toolCallIds: string[];
};

type BranchEntry = { type: string; customType?: string; data?: unknown };

export function readActionRecords(branchEntries: readonly BranchEntry[]): ActionRecord[] {
  return branchEntries
    .filter((entry) => entry.type === "custom" && entry.customType === ACTION_ENTRY_TYPE)
    .map((entry) => entry.data as ActionRecord);
}

export function readStubbedToolCallIds(branchEntries: readonly BranchEntry[]): Set<string> {
  const stubbed = new Set<string>();
  for (const entry of branchEntries) {
    if (entry.type !== "custom" || entry.customType !== STUB_ENTRY_TYPE) continue;
    for (const toolCallId of (entry.data as StubRecord).toolCallIds) stubbed.add(toolCallId);
  }
  return stubbed;
}

export function totalsOf(records: readonly ActionRecord[]): {
  actionCount: number;
  actualCostDollars: number;
  estimatedSavedDollars: number;
} {
  return {
    actionCount: records.length,
    actualCostDollars: records.reduce((sum, record) => sum + record.actualCostDollars, 0),
    estimatedSavedDollars: records.reduce((sum, record) => sum + record.estimatedSavedDollars, 0),
  };
}
