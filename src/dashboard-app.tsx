import React, { memo, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import {
  toClaudeUsageSamples,
  readClaudeUsageSnapshot,
  refreshPersistedClaudeUsageSnapshot,
  type ClaudeUsageSnapshot,
  type ClaudeUsageWindow,
} from "./claude-usage";
import { ensureDatabase, insertClaudeUsageSamples } from "./db";
import {
  formatLocalTimestamp,
  loadClaudeFiveHourEstimate,
  loadClaudeFiveHourHistory,
  loadDashboardData,
  type DashboardData,
  type DashboardSourceFilter,
} from "./dashboard-data";
import type { ClaudeFiveHourEstimate, ClaudeFiveHourEstimateHistory } from "./types";

type DashboardAppProps = {
  root: string;
  dbPath: string;
  codexStatePath: string;
  date: string;
  sync: boolean;
  watch: boolean;
  intervalSeconds: number;
  source: DashboardSourceFilter;
};

type TabId = "overview" | "projects" | "models" | "daily";

type DashboardSourceId = Exclude<DashboardSourceFilter, "all">;
type DashboardToday = DashboardData["today"];
type DashboardWeek = DashboardData["week"];
type DashboardMonth = DashboardData["month"];
type DashboardTodayProjects = DashboardData["todayProjects"];
type DashboardMonthProjects = DashboardData["monthProjects"];
type DashboardTodayModels = DashboardData["todayModels"];
type DashboardMonthModels = DashboardData["monthModels"];
type DashboardDailyRows = DashboardData["dailyRows"];
type DashboardModelRows = DashboardData["modelRows"];

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "projects", label: "Projects" },
  { id: "models", label: "Models" },
  { id: "daily", label: "Daily" },
];

const DASHBOARD_SOURCES: DashboardSourceId[] = ["claude-code", "codex-cli", "cursor"];
const CLAUDE_USAGE_REFRESH_INTERVAL_MS = 300_000;

function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return formatNumber(value);
}

function formatSourceLabel(source: DashboardSourceId): string {
  switch (source) {
    case "claude-code":
      return "Claude Code";
    case "codex-cli":
      return "Codex";
    case "cursor":
      return "Cursor";
  }
}

function sourceColor(source: DashboardSourceId): string {
  switch (source) {
    case "claude-code":
      return "cyan";
    case "codex-cli":
      return "yellow";
    case "cursor":
      return "magenta";
  }
}

function formatSourceFilterLabel(source: DashboardSourceFilter): string {
  if (source === "all") {
    return "All tools";
  }

  return formatSourceLabel(source);
}

function fillWidth(value: number, total: number, width: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(width, Math.round((value / total) * width)));
}

function isClaudeUsageStale(lastCheckedMs: number): boolean {
  return Date.now() - lastCheckedMs >= CLAUDE_USAGE_REFRESH_INTERVAL_MS;
}

function MetricCard(props: { label: string; value: string; detail: string; color?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={props.color ?? "cyan"} paddingX={1} width={26}>
      <Text color="gray">{props.label}</Text>
      <Text bold color={props.color ?? "cyan"}>{props.value}</Text>
      <Text dimColor>{props.detail}</Text>
    </Box>
  );
}

function Section(props: { title: string; children: React.ReactNode; color?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={props.color ?? "blue"} paddingX={1} marginTop={1}>
      <Text bold color={props.color ?? "blue"}>{props.title}</Text>
      <Box marginTop={1} flexDirection="column">{props.children}</Box>
    </Box>
  );
}

function DataRow(props: { left: string; bar?: React.ReactNode; right: React.ReactNode; color?: string }) {
  return (
    <Box>
      <Box width={28}>
        <Text wrap="truncate-end">{props.left}</Text>
      </Box>
      <Box width={2}>
        <Text> </Text>
      </Box>
      <Box width={22}>
        {props.bar ?? null}
      </Box>
      <Box width={2}>
        <Text> </Text>
      </Box>
      <Box width={28}>
        {props.right}
      </Box>
    </Box>
  );
}

function RowStats(props: { amount: string; events?: string }) {
  return (
    <Box>
      <Box width={10}>
        <Text>{props.amount}</Text>
      </Box>
      <Box width={2}>
        <Text> </Text>
      </Box>
      <Box width={16}>
        <Text>{props.events ?? ""}</Text>
      </Box>
    </Box>
  );
}

function UsageIndicator(props: {
  label: string;
  used: number;
  total: number;
  totalTokensLabel: string;
  todayCostUsd: number;
  todayEvents: number;
  monthCostUsd: number;
  monthEvents: number;
  color?: string;
}) {
  const percent = props.total > 0 ? Math.round((props.used / props.total) * 100) : 0;
  const filled = fillWidth(props.used, props.total, 22);
  const empty = 22 - filled;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.color ?? "gray"}
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color={props.color ?? "white"}>{props.label}</Text>
      <Text color="gray">{`${percent}% of today (${formatCompactNumber(props.used)} / ${formatCompactNumber(props.total)} total)`}</Text>
      <Box marginTop={1}>
        <Text>
          <Text backgroundColor="white">{`${" ".repeat(filled)}`}</Text>
          <Text backgroundColor="gray">{`${" ".repeat(empty)}`}</Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{props.totalTokensLabel}</Text>
        <Text dimColor>{`Today  ${formatUsd(props.todayCostUsd)} / ${formatNumber(props.todayEvents)} events`}</Text>
        <Text dimColor>{`Month  ${formatUsd(props.monthCostUsd)} / ${formatNumber(props.monthEvents)} events`}</Text>
      </Box>
    </Box>
  );
}

function EstimateCard(props: { estimate: ClaudeFiveHourEstimate }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text bold color="green">5-hour Window Estimate</Text>
      <Text dimColor>{`Observed ${props.estimate.percentUsed}% used since ${formatLocalTimestamp(new Date(props.estimate.windowStartAt))}`}</Text>
      <Text>{`Observed  ${formatUsd(props.estimate.observedCostUsd)} / ${formatNumber(props.estimate.observedTokens)} tokens / ${formatNumber(props.estimate.observedEvents)} events`}</Text>
      <Text>{`Full est. ${formatUsd(props.estimate.estimatedFullWindowCostUsd)} / ${formatNumber(props.estimate.estimatedFullWindowTokens)} tokens`}</Text>
      <Text>{`Left est. ${formatUsd(props.estimate.estimatedRemainingCostUsd)} / ${formatNumber(props.estimate.estimatedRemainingTokens)} tokens`}</Text>
      <Text dimColor>{`Resets ${formatLocalTimestamp(new Date(props.estimate.resetAt))}`}</Text>
    </Box>
  );
}

function EstimateHistoryTable(props: { history: ClaudeFiveHourEstimateHistory }) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Box width={19}><Text dimColor>Reset</Text></Box>
        <Box width={9}><Text dimColor>% used</Text></Box>
        <Box width={12}><Text dimColor>Observed</Text></Box>
        <Box width={14}><Text dimColor>Full est.</Text></Box>
        <Box width={14}><Text dimColor>Left est.</Text></Box>
      </Box>
      {props.history.map((estimate) => (
        <Box key={estimate.resetAt}>
          <Box width={19}>
            <Text>{formatLocalTimestamp(new Date(estimate.resetAt)).slice(5, 16)}</Text>
          </Box>
          <Box width={9}>
            <Text>{`${estimate.percentUsed}%`}</Text>
          </Box>
          <Box width={12}>
            <Text>{formatUsd(estimate.observedCostUsd)}</Text>
          </Box>
          <Box width={14}>
            <Text>{`${formatUsd(estimate.estimatedFullWindowCostUsd)} ${formatCompactNumber(estimate.estimatedFullWindowTokens)}`}</Text>
          </Box>
          <Box width={14}>
            <Text>{`${formatUsd(estimate.estimatedRemainingCostUsd)} ${formatCompactNumber(estimate.estimatedRemainingTokens)}`}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function ClaudeUsageCard(props: { window: ClaudeUsageWindow; color?: string }) {
  const filled = fillWidth(props.window.percentLeft, 100, 22);
  const empty = 22 - filled;
  const usageText = props.window.usedText && props.window.totalText
    ? `${props.window.usedText} used / ${props.window.totalText}`
    : props.window.detailText;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.color ?? "cyan"}
      paddingX={1}
      width={36}
      marginRight={1}
    >
      <Text bold color={props.color ?? "white"}>{props.window.label}</Text>
      <Text color="gray">{`${props.window.percentLeft}% left`}</Text>
      <Box marginTop={1}>
        <Text>
          <Text backgroundColor="white">{`${" ".repeat(filled)}`}</Text>
          <Text backgroundColor="gray">{`${" ".repeat(empty)}`}</Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{usageText}</Text>
        <Text dimColor>{props.window.resetText ? `${props.window.resetText}` : "Reset not provided by Claude"}</Text>
      </Box>
    </Box>
  );
}

function InvertedBar(props: { value: number; total: number; width?: number }) {
  const width = props.width ?? 22;
  const filled = fillWidth(props.value, props.total, width);
  const empty = width - filled;

  return (
    <Text>
      <Text backgroundColor="white">{`${" ".repeat(filled)}`}</Text>
      <Text backgroundColor="gray">{`${" ".repeat(empty)}`}</Text>
    </Text>
  );
}

function buildDashboardDataSignature(data: DashboardData): string {
  return JSON.stringify(data);
}

const DashboardHeader = memo(function DashboardHeader(props: {
  date: string;
  source: DashboardSourceFilter;
  watch: boolean;
  intervalSeconds: number;
}) {
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text bold color="white">Claude Cost TUI</Text>
        <Text color="gray">  {props.date}</Text>
        <Text color="gray">  {formatSourceFilterLabel(props.source)}</Text>
      </Box>
      <Text color="gray">
        {props.watch ? `watch ${props.intervalSeconds}s` : "manual"} | r refresh | tab switch | q quit
      </Text>
    </Box>
  );
});

const DashboardTabs = memo(function DashboardTabs(props: { tab: TabId }) {
  return (
    <Box marginTop={1}>
      {TABS.map((candidate, index) => (
        <Box key={candidate.id} marginRight={1}>
          <Text color={candidate.id === props.tab ? "black" : "gray"} backgroundColor={candidate.id === props.tab ? "cyan" : undefined}>
            {` ${index + 1}. ${candidate.label} `}
          </Text>
        </Box>
      ))}
    </Box>
  );
});

const DashboardMeta = memo(function DashboardMeta(props: { dbPath: string; refreshedAt: string }) {
  return (
    <Box marginTop={1}>
      <Text color="gray">Database: {props.dbPath}</Text>
      <Text color="gray">  Refreshed: {props.refreshedAt || "n/a"}</Text>
    </Box>
  );
});

const OverviewTab = memo(function OverviewTab(props: {
  source: DashboardSourceFilter;
  today: DashboardToday;
  week: DashboardWeek;
  month: DashboardMonth;
  dailyRows: DashboardDailyRows;
  claudeUsage: ClaudeUsageSnapshot | null;
  claudeUsageRefreshing: boolean;
  claudeFiveHourEstimate: ClaudeFiveHourEstimate | null;
  claudeFiveHourHistory: ClaudeFiveHourEstimateHistory;
}) {
  const maxDaily = Math.max(...props.dailyRows.map((row) => row.estimatedCostUsd), 0);
  const sourceRows = DASHBOARD_SOURCES.map((source) => {
    const today = props.today.bySource.find((row) => row.source === source);
    const month = props.month.bySource.find((row) => row.source === source);

    return {
      source,
      todayTokens: today?.totalTokens ?? 0,
      totalTokensLabel: today?.tokenBreakdownKnown
        ? `${formatNumber(today?.totalTokens ?? 0)} total tokens including input, output, cache read, and cache write`
        : `${formatNumber(today?.totalTokens ?? 0)} total tokens from aggregate estimate`,
      todayCostUsd: today?.estimatedCostUsd ?? 0,
      todayEvents: today?.events ?? 0,
      monthCostUsd: month?.estimatedCostUsd ?? 0,
      monthEvents: month?.events ?? 0,
    };
  });

  return (
    <>
      <Box marginTop={1} gap={1}>
        <MetricCard label="Today" value={formatUsd(props.today.estimatedCostUsd)} detail={`${formatNumber(props.today.events)} events`} color="cyan" />
        <MetricCard label="Week" value={formatUsd(props.week.estimatedCostUsd)} detail={`${formatNumber(props.week.events)} events`} color="green" />
        <MetricCard label="Month" value={formatUsd(props.month.estimatedCostUsd)} detail={`${formatNumber(props.month.events)} events`} color="magenta" />
      </Box>
      <Box marginTop={1} gap={1}>
        <MetricCard label="Input Today" value={formatNumber(props.today.totalInputTokens)} detail="input tokens" color="blue" />
        <MetricCard label="Output Today" value={formatNumber(props.today.totalOutputTokens)} detail="output tokens" color="yellow" />
        <MetricCard label="Cache Read Today" value={formatNumber(props.today.totalCacheReadTokens)} detail="cache read tokens" color="green" />
        <MetricCard label="Cache Write Today" value={formatNumber(props.today.totalCacheWriteTokens)} detail="cache write tokens" color="magenta" />
      </Box>
      <Box marginTop={1} gap={1}>
        {props.today.bySource.map((source) => (
          <MetricCard
            key={source.source}
            label={source.source}
            value={formatUsd(source.estimatedCostUsd)}
            detail={
              source.tokenBreakdownKnown
                ? `${formatNumber(source.totalTokens)} total tokens`
                : `${formatNumber(source.totalTokens)} total tokens, aggregate estimate`
            }
            color={source.source === "codex-cli" ? "yellow" : "cyan"}
          />
        ))}
      </Box>
      {props.source === "all" ? (
        <Section title="Sources" color="yellow">
          {sourceRows.map((row) => (
            <UsageIndicator
              key={row.source}
              label={formatSourceLabel(row.source)}
              used={row.todayTokens}
              total={props.today.totalTokens}
              totalTokensLabel={row.totalTokensLabel}
              todayCostUsd={row.todayCostUsd}
              todayEvents={row.todayEvents}
              monthCostUsd={row.monthCostUsd}
              monthEvents={row.monthEvents}
              color={sourceColor(row.source)}
            />
          ))}
        </Section>
      ) : null}

      {(props.source === "all" || props.source === "claude-code") ? (
        <Section title="Claude Usage" color="cyan">
          {props.claudeUsage?.status === "available" ? (
            <>
              <Box>
                {props.claudeUsage.windows.map((window) => (
                  <ClaudeUsageCard
                    key={window.id}
                    window={window}
                    color={window.id === "fiveHour" ? "cyan" : window.id === "weeklyAllModels" ? "green" : "magenta"}
                  />
                ))}
              </Box>
              <Box marginTop={1}>
                <Text dimColor>{`Fetched from Claude /usage at ${formatLocalTimestamp(new Date(props.claudeUsage.fetchedAt))}`}</Text>
              </Box>
              {props.claudeUsageRefreshing ? (
                <Box marginTop={1}>
                  <Text color="yellow">Refreshing Claude usage in background...</Text>
                </Box>
              ) : null}
            </>
          ) : props.claudeUsage ? (
            <>
              <Text dimColor>{props.claudeUsage.message ?? "Claude usage data is currently unavailable."}</Text>
              <Box marginTop={1}>
                <Text dimColor>{`Last checked at ${formatLocalTimestamp(new Date(props.claudeUsage.fetchedAt))}`}</Text>
              </Box>
              {props.claudeUsageRefreshing ? (
                <Box marginTop={1}>
                  <Text color="yellow">Refreshing Claude usage in background...</Text>
                </Box>
              ) : null}
            </>
          ) : (
            <Text dimColor>{props.claudeUsageRefreshing ? "Refreshing Claude usage in background..." : "Loading Claude usage..."}</Text>
          )}
        </Section>
      ) : null}

      {(props.source === "all" || props.source === "claude-code") && props.claudeFiveHourEstimate ? (
        <Section title="Claude 5-hour Estimate" color="green">
          <EstimateCard estimate={props.claudeFiveHourEstimate} />
          {props.claudeFiveHourHistory.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Recent windows</Text>
              <Box marginTop={1}>
                <EstimateHistoryTable history={props.claudeFiveHourHistory} />
              </Box>
            </Box>
          ) : null}
        </Section>
      ) : null}

      <Section title="7-Day Trend" color="cyan">
        {props.dailyRows.map((row) => (
          <DataRow
            key={row.date}
            left={row.date}
            bar={<InvertedBar value={row.estimatedCostUsd} total={maxDaily} />}
            right={<RowStats amount={formatUsd(row.estimatedCostUsd)} events={`${formatNumber(row.events)} events`} />}
            color="cyan"
          />
        ))}
      </Section>
    </>
  );
});

const ProjectsTab = memo(function ProjectsTab(props: {
  todayProjects: DashboardTodayProjects;
  monthProjects: DashboardMonthProjects;
}) {
  const maxTodayProject = Math.max(...props.todayProjects.slice(0, 5).map((row) => row.estimatedCostUsd), 0);
  const maxMonthProject = Math.max(...props.monthProjects.slice(0, 8).map((row) => row.estimatedCostUsd), 0);

  return (
    <>
      <Section title="Top Projects Today" color="green">
        {props.todayProjects.slice(0, 5).map((project) => (
          <DataRow
            key={`today-${project.project}`}
            left={project.displayProject}
            bar={<InvertedBar value={project.estimatedCostUsd} total={maxTodayProject} />}
            right={<RowStats amount={formatUsd(project.estimatedCostUsd)} events={`${formatNumber(project.events)} events`} />}
            color="green"
          />
        ))}
        {props.todayProjects.length === 0 ? <Text dimColor>No project usage today.</Text> : null}
      </Section>

      <Section title="Top Projects This Month" color="green">
        {props.monthProjects.slice(0, 8).map((project) => (
          <DataRow
            key={`month-${project.project}`}
            left={project.displayProject}
            bar={<InvertedBar value={project.estimatedCostUsd} total={maxMonthProject} />}
            right={<RowStats amount={formatUsd(project.estimatedCostUsd)} events={`${formatNumber(project.events)} events`} />}
            color="green"
          />
        ))}
      </Section>
    </>
  );
});

const ModelsTab = memo(function ModelsTab(props: {
  todayCostUsd: number;
  todayModels: DashboardTodayModels;
  monthModels: DashboardMonthModels;
}) {
  const maxMonthModel = Math.max(...props.monthModels.slice(0, 8).map((row) => row.estimatedCostUsd), 0);

  return (
    <>
      <Section title="Top Models Today" color="magenta">
        {props.todayModels.slice(0, 5).map((model) => (
          <DataRow
            key={`today-${model.model}`}
            left={`${model.model}${model.model.startsWith("gpt-5") ? " *" : ""}`}
            bar={<InvertedBar value={model.estimatedCostUsd} total={props.todayCostUsd} />}
            right={<RowStats amount={formatUsd(model.estimatedCostUsd)} events={`${formatNumber(model.events)} events`} />}
            color="magenta"
          />
        ))}
        <Box marginTop={1}>
          <Text dimColor>* aggregate-token estimate when local source has no prompt/output split</Text>
        </Box>
      </Section>

      <Section title="Top Models This Month" color="magenta">
        {props.monthModels.slice(0, 8).map((model) => (
          <DataRow
            key={`month-${model.model}`}
            left={`${model.model}${model.model.startsWith("gpt-5") ? " *" : ""}`}
            bar={<InvertedBar value={model.estimatedCostUsd} total={maxMonthModel} />}
            right={<RowStats amount={formatUsd(model.estimatedCostUsd)} events={`${formatNumber(model.events)} events`} />}
            color="magenta"
          />
        ))}
      </Section>
    </>
  );
});

const DailyTab = memo(function DailyTab(props: { modelRows: DashboardModelRows }) {
  return (
    <Section title="Daily Model Leaders" color="blue">
      {props.modelRows.map((row) => (
        <Box key={row.date} flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Text bold color="blue">{row.date}</Text>
          </Box>

          <Box marginBottom={1}>
            <Box width={5}>
              <Text dimColor>Rank</Text>
            </Box>
            <Box width={32}>
              <Text dimColor>Model</Text>
            </Box>
            <Box width={10}>
              <Text dimColor>Cost</Text>
            </Box>
            <Box width={16}>
              <Text dimColor>Events</Text>
            </Box>
          </Box>

          {row.models.slice(0, 3).map((model, index) => (
            <Box key={`${row.date}-${model.model}`}>
              <Box width={5}>
                <Text>{`#${index + 1}`}</Text>
              </Box>
              <Box width={32}>
                <Text wrap="truncate-end">{model.model}</Text>
              </Box>
              <Box width={10}>
                <Text>{formatUsd(model.estimatedCostUsd)}</Text>
              </Box>
              <Box width={16}>
                <Text>{`${formatNumber(model.events)} events`}</Text>
              </Box>
            </Box>
          ))}

          {row.models.length === 0 ? (
            <Box>
              <Text dimColor>no usage</Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Section>
  );
});

export function DashboardApp(props: DashboardAppProps) {
  const { exit } = useApp();
  const [tab, setTab] = useState<TabId>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string>("");
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsageSnapshot | null>(null);
  const [claudeUsageRefreshing, setClaudeUsageRefreshing] = useState(false);
  const [claudeFiveHourEstimate, setClaudeFiveHourEstimate] = useState<ClaudeFiveHourEstimate | null>(null);
  const [claudeFiveHourHistory, setClaudeFiveHourHistory] = useState<ClaudeFiveHourEstimateHistory>([]);
  const dataSignatureRef = useRef<string>("");
  const claudeUsageSignatureRef = useRef<string>("");
  const lastClaudeUsageRefreshMsRef = useRef<number>(0);
  const claudeUsageLoadingRef = useRef(false);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (input === "r") {
      void refresh(true);
      return;
    }

    if (key.leftArrow) {
      const index = TABS.findIndex((candidate) => candidate.id === tab);
      setTab(TABS[(index + TABS.length - 1) % TABS.length]!.id);
      return;
    }

    if (key.rightArrow || key.tab) {
      const index = TABS.findIndex((candidate) => candidate.id === tab);
      setTab(TABS[(index + 1) % TABS.length]!.id);
      return;
    }

    if (input === "1") setTab("overview");
    if (input === "2") setTab("projects");
    if (input === "3") setTab("models");
    if (input === "4") setTab("daily");
  });

  async function refresh(forceClaudeUsage = false) {
    setError(null);
    setLoading(true);
    try {
      const nextDataPromise = loadDashboardData({
        root: props.root,
        dbPath: props.dbPath,
        codexStatePath: props.codexStatePath,
        date: props.date,
        sync: props.sync,
        source: props.source,
      });
      const shouldRefreshClaudeUsage = (props.source === "all" || props.source === "claude-code")
        && (forceClaudeUsage || isClaudeUsageStale(lastClaudeUsageRefreshMsRef.current));

      if (shouldRefreshClaudeUsage && !claudeUsageLoadingRef.current) {
        void refreshClaudeUsage();
      }
      const nextData = await nextDataPromise;
      const nextSignature = buildDashboardDataSignature(nextData);
      if (nextSignature !== dataSignatureRef.current) {
        dataSignatureRef.current = nextSignature;
        setData(nextData);
        setClaudeFiveHourEstimate(nextData.claudeFiveHourEstimate);
        setClaudeFiveHourHistory(nextData.claudeFiveHourHistory);
      }
      setRefreshedAt(formatLocalTimestamp());
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshClaudeUsage() {
    if (claudeUsageLoadingRef.current) {
      return;
    }

    claudeUsageLoadingRef.current = true;
    setClaudeUsageRefreshing(true);
    try {
      const nextUsage = await refreshPersistedClaudeUsageSnapshot();
      const db = await ensureDatabase(props.dbPath);
      try {
        insertClaudeUsageSamples(db, toClaudeUsageSamples(nextUsage));
      } finally {
        db.close();
      }
      lastClaudeUsageRefreshMsRef.current = Date.now();
      setClaudeFiveHourEstimate(await loadClaudeFiveHourEstimate(props.dbPath));
      setClaudeFiveHourHistory(await loadClaudeFiveHourHistory(props.dbPath));
      const nextSignature = JSON.stringify(nextUsage);
      if (nextSignature !== claudeUsageSignatureRef.current) {
        claudeUsageSignatureRef.current = nextSignature;
        setClaudeUsage(nextUsage);
      }
    } finally {
      claudeUsageLoadingRef.current = false;
      setClaudeUsageRefreshing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const persistedUsage = await readClaudeUsageSnapshot();
      if (!persistedUsage || cancelled) {
        return;
      }

      claudeUsageSignatureRef.current = JSON.stringify(persistedUsage);
      setClaudeUsage(persistedUsage);
      lastClaudeUsageRefreshMsRef.current = Date.parse(persistedUsage.fetchedAt) || 0;
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [props.root, props.dbPath, props.codexStatePath, props.date, props.sync, props.source]);

  useEffect(() => {
    if (props.source !== "all" && props.source !== "claude-code") {
      return;
    }

    if (isClaudeUsageStale(lastClaudeUsageRefreshMsRef.current)) {
      void refreshClaudeUsage();
    }
    const timer = setInterval(() => {
      if (isClaudeUsageStale(lastClaudeUsageRefreshMsRef.current)) {
        void refreshClaudeUsage();
      }
    }, CLAUDE_USAGE_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [props.source]);

  useEffect(() => {
    if (!props.watch) {
      return;
    }

    const timer = setInterval(() => {
      void refresh();
    }, props.intervalSeconds * 1000);

    return () => {
      clearInterval(timer);
    };
  }, [props.watch, props.intervalSeconds, props.root, props.dbPath, props.codexStatePath, props.date, props.sync, props.source]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <DashboardHeader
        date={props.date}
        source={props.source}
        watch={props.watch}
        intervalSeconds={props.intervalSeconds}
      />
      <DashboardTabs tab={tab} />

      {loading && !data ? (
        <Box marginTop={2}><Text color="yellow">Loading dashboard...</Text></Box>
      ) : null}

      {error ? (
        <Box marginTop={2} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      ) : null}

      {data ? (
        <>
          <DashboardMeta dbPath={props.dbPath} refreshedAt={refreshedAt} />
          {tab === "overview" ? (
            <OverviewTab
              source={props.source}
              today={data.today}
              week={data.week}
              month={data.month}
              dailyRows={data.dailyRows}
              claudeUsage={claudeUsage}
              claudeUsageRefreshing={claudeUsageRefreshing}
              claudeFiveHourEstimate={claudeFiveHourEstimate}
              claudeFiveHourHistory={claudeFiveHourHistory}
            />
          ) : null}
          {tab === "projects" ? (
            <ProjectsTab
              todayProjects={data.todayProjects}
              monthProjects={data.monthProjects}
            />
          ) : null}
          {tab === "models" ? (
            <ModelsTab
              todayCostUsd={data.today.estimatedCostUsd}
              todayModels={data.todayModels}
              monthModels={data.monthModels}
            />
          ) : null}
          {tab === "daily" ? <DailyTab modelRows={data.modelRows} /> : null}
        </>
      ) : null}
    </Box>
  );
}
