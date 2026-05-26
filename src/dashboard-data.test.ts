import { describe, expect, test } from "bun:test";

import {
  buildClaudeWeeklyEstimate,
  claudeFiveHourHistoryEventStart,
  resolveDashboardDate,
} from "./dashboard-data";
import type { ClaudeUsageSample } from "./types";

describe("resolveDashboardDate", () => {
  test("uses the current local date for live dashboards", () => {
    expect(resolveDashboardDate("2026-05-25", true, new Date(2026, 4, 26, 0, 1))).toBe("2026-05-26");
  });

  test("keeps an explicit dashboard date pinned", () => {
    expect(resolveDashboardDate("2026-05-25", false, new Date(2026, 4, 26, 0, 1))).toBe("2026-05-25");
  });
});

describe("buildClaudeWeeklyEstimate", () => {
  test("does not reuse an expired reset-bearing sample as the current estimate", () => {
    const samples: ClaudeUsageSample[] = [
      {
        sampleKey: "old",
        fetchedAt: "2026-05-19T01:06:23.383Z",
        windowKind: "weeklyAllModels",
        label: "Weekly",
        percentLeft: 32,
        percentUsed: 68,
        resetAt: "2026-05-20T07:00:00",
        resetText: "Resets May 20 at 7am (Australia/Perth)",
        detailText: "68% used",
      },
      {
        sampleKey: "new",
        fetchedAt: "2026-05-26T03:00:00.000Z",
        windowKind: "weeklyAllModels",
        label: "Weekly",
        percentLeft: 57,
        percentUsed: 43,
        detailText: "43% used",
      },
    ];

    expect(buildClaudeWeeklyEstimate(samples, [])).toBeNull();
  });
});

describe("claudeFiveHourHistoryEventStart", () => {
  test("starts at the earliest selected history window start", () => {
    const samples: ClaudeUsageSample[] = [
      {
        sampleKey: "current",
        fetchedAt: "2026-05-26T03:08:05.268Z",
        windowKind: "fiveHour",
        label: "5-hour",
        percentLeft: 55,
        percentUsed: 45,
        resetAt: "2026-05-26T11:20:00",
        resetText: "Resets 11:20am (Australia/Perth)",
        detailText: "45% used",
      },
      {
        sampleKey: "old",
        fetchedAt: "2026-05-18T06:00:00.000Z",
        windowKind: "fiveHour",
        label: "5-hour",
        percentLeft: 75,
        percentUsed: 25,
        resetAt: "2026-05-18T10:00:00",
        resetText: "Resets 10:00am (Australia/Perth)",
        detailText: "25% used",
      },
    ];

    expect(claudeFiveHourHistoryEventStart(samples, 6)).toBe("2026-05-18T05:00:00.000Z");
  });
});
