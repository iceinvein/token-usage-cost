import { describe, expect, test } from "bun:test";

import { parseClaudeUsageOutput } from "./claude-usage";

describe("parseClaudeUsageOutput", () => {
  test("keeps reset lines when Claude splits the session reset label", () => {
    const snapshot = parseClaudeUsageOutput(`
Current session
███████████████████ 38%used
Rese s 11:20am (Australia/Perth)

Current week (all models)
█████████████████████ 43% used
Resets May 27 at 7am (Australia/Perth)
`, "2026-05-26T03:00:00.000Z");

    expect(snapshot.status).toBe("available");
    expect(snapshot.windows.find((window) => window.id === "fiveHour")?.resetAt).toBe("2026-05-26T11:20:00");
    expect(snapshot.windows.find((window) => window.id === "weeklyAllModels")?.resetAt).toBe("2026-05-27T07:00:00");
  });

  test("parses usage from Claude cursor-positioned terminal output", () => {
    const snapshot = parseClaudeUsageOutput(
      "\x1b[2C\x1b[3ACurre\x1b[9Gt\x1b[11Gsession\x1b[K\r"
        + "\x1b[2C\x1b[1B███████████████████▌\x1b[54G39%\x1b[58Gused\r"
        + "\x1b[2C\x1b[1BRese\x1b[8Gs\x1b[10G11:20am\x1b[18G(Australia/Perth)\r\n"
        + "\x1b[3GCurrent\x1b[11Gweek\x1b[16G(all\x1b[21Gmodels)\r\n"
        + "\x1b[3G██████████████████████\x1b[54G44%\x1b[58Gused\r\n"
        + "\x1b[3GResets\x1b[10GMay\x1b[14G27\x1b[17Gat\x1b[20G7am\x1b[24G(Australia/Perth)\r\n",
      "2026-05-26T03:00:00.000Z",
    );

    expect(snapshot.status).toBe("available");
    expect(snapshot.windows.find((window) => window.id === "fiveHour")?.resetAt).toBe("2026-05-26T11:20:00");
    expect(snapshot.windows.find((window) => window.id === "fiveHour")?.detailText).toBe("39% used");
    expect(snapshot.windows.find((window) => window.id === "weeklyAllModels")?.resetAt).toBe("2026-05-27T07:00:00");
    expect(snapshot.windows.find((window) => window.id === "weeklyAllModels")?.detailText).toBe("44% used");
  });
});
