import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import {
  formatLocalTimestamp,
  loadDashboardData,
  type DashboardData,
  type DashboardSourceFilter,
} from "./dashboard-data";

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

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "projects", label: "Projects" },
  { id: "models", label: "Models" },
  { id: "daily", label: "Daily" },
];

const DASHBOARD_SOURCES: DashboardSourceId[] = ["claude-code", "codex-cli", "cursor"];

function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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

function spark(value: number, max: number, width = 18): string {
  if (max <= 0) return ".".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return `${"#".repeat(filled)}${".".repeat(width - filled)}`;
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

function DataRow(props: { left: string; bar?: string; right: string; color?: string }) {
  return (
    <Box>
      <Box width={28}>
        <Text wrap="truncate-end">{props.left}</Text>
      </Box>
      <Box width={2}>
        <Text> </Text>
      </Box>
      <Box width={22}>
        <Text color={props.color ?? "cyan"}>{props.bar ?? ""}</Text>
      </Box>
      <Box width={2}>
        <Text> </Text>
      </Box>
      <Text>{props.right}</Text>
    </Box>
  );
}

export function DashboardApp(props: DashboardAppProps) {
  const { exit } = useApp();
  const [tab, setTab] = useState<TabId>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string>("");

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (input === "r") {
      void refresh();
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

  async function refresh() {
    setError(null);
    setLoading(true);
    try {
      const nextData = await loadDashboardData({
        root: props.root,
        dbPath: props.dbPath,
        codexStatePath: props.codexStatePath,
        date: props.date,
        sync: props.sync,
        source: props.source,
      });
      setData(nextData);
      setRefreshedAt(formatLocalTimestamp());
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [props.root, props.dbPath, props.codexStatePath, props.date, props.sync, props.source]);

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

  const maxDaily = Math.max(...(data?.dailyRows.map((row) => row.estimatedCostUsd) ?? [0]), 0);
  const maxTodayProject = Math.max(...(data?.todayProjects.slice(0, 5).map((row) => row.estimatedCostUsd) ?? [0]), 0);
  const maxMonthProject = Math.max(...(data?.monthProjects.slice(0, 8).map((row) => row.estimatedCostUsd) ?? [0]), 0);
  const maxMonthModel = Math.max(...(data?.monthModels.slice(0, 8).map((row) => row.estimatedCostUsd) ?? [0]), 0);
  const sourceRows = DASHBOARD_SOURCES.map((source) => {
    const today = data?.today.bySource.find((row) => row.source === source);
    const month = data?.month.bySource.find((row) => row.source === source);

    return {
      source,
      todayCostUsd: today?.estimatedCostUsd ?? 0,
      todayEvents: today?.events ?? 0,
      monthCostUsd: month?.estimatedCostUsd ?? 0,
      monthEvents: month?.events ?? 0,
    };
  });

  return (
    <Box flexDirection="column" paddingX={1}>
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

      <Box marginTop={1}>
        {TABS.map((candidate, index) => (
          <Box key={candidate.id} marginRight={1}>
            <Text color={candidate.id === tab ? "black" : "gray"} backgroundColor={candidate.id === tab ? "cyan" : undefined}>
              {` ${index + 1}. ${candidate.label} `}
            </Text>
          </Box>
        ))}
      </Box>

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
          <Box marginTop={1}>
            <Text color="gray">Database: {props.dbPath}</Text>
            <Text color="gray">  Refreshed: {refreshedAt || "n/a"}</Text>
          </Box>

          {tab === "overview" ? (
            <>
              <Box marginTop={1} gap={1}>
                <MetricCard label="Today" value={formatUsd(data.today.estimatedCostUsd)} detail={`${formatNumber(data.today.events)} events`} color="cyan" />
                <MetricCard label="Week" value={formatUsd(data.week.estimatedCostUsd)} detail={`${formatNumber(data.week.events)} events`} color="green" />
                <MetricCard label="Month" value={formatUsd(data.month.estimatedCostUsd)} detail={`${formatNumber(data.month.events)} events`} color="magenta" />
              </Box>
              <Box marginTop={1} gap={1}>
                <MetricCard label="Input Today" value={formatNumber(data.today.totalInputTokens)} detail="input tokens" color="blue" />
                <MetricCard label="Output Today" value={formatNumber(data.today.totalOutputTokens)} detail="output tokens" color="yellow" />
                <MetricCard label="Cache Read Today" value={formatNumber(data.today.totalCacheReadTokens)} detail="cache read tokens" color="green" />
              </Box>
              <Box marginTop={1} gap={1}>
                {data.today.bySource.map((source) => (
                  <MetricCard
                    key={source.source}
                    label={source.source}
                    value={formatUsd(source.estimatedCostUsd)}
                    detail={
                      source.tokenBreakdownKnown
                        ? `${formatNumber(source.totalTokens)} tokens`
                        : `${formatNumber(source.totalTokens)} tokens, aggregate estimate`
                    }
                    color={source.source === "codex-cli" ? "yellow" : "cyan"}
                  />
                ))}
              </Box>

              {props.source === "all" ? (
                <Section title="Sources" color="yellow">
                  {sourceRows.map((row) => (
                    <DataRow
                      key={row.source}
                      left={formatSourceLabel(row.source)}
                      right={`Today ${formatUsd(row.todayCostUsd)} / ${formatNumber(row.todayEvents)}   Month ${formatUsd(row.monthCostUsd)} / ${formatNumber(row.monthEvents)}`}
                      color={sourceColor(row.source)}
                    />
                  ))}
                </Section>
              ) : null}

              <Section title="7-Day Trend" color="cyan">
                {data.dailyRows.map((row) => (
                  <DataRow
                    key={row.date}
                    left={row.date}
                    bar={spark(row.estimatedCostUsd, maxDaily)}
                    right={`${formatUsd(row.estimatedCostUsd)}   ${formatNumber(row.events)} events`}
                    color="cyan"
                  />
                ))}
              </Section>
            </>
          ) : null}

          {tab === "projects" ? (
            <>
              <Section title="Top Projects Today" color="green">
                {data.todayProjects.slice(0, 5).map((project) => (
                  <DataRow
                    key={`today-${project.project}`}
                    left={project.displayProject}
                    bar={spark(project.estimatedCostUsd, maxTodayProject)}
                    right={`${formatUsd(project.estimatedCostUsd)}   ${formatNumber(project.events)} events`}
                    color="green"
                  />
                ))}
                {data.todayProjects.length === 0 ? <Text dimColor>No project usage today.</Text> : null}
              </Section>

              <Section title="Top Projects This Month" color="green">
                {data.monthProjects.slice(0, 8).map((project) => (
                  <DataRow
                    key={`month-${project.project}`}
                    left={project.displayProject}
                    bar={spark(project.estimatedCostUsd, maxMonthProject)}
                    right={`${formatUsd(project.estimatedCostUsd)}   ${formatNumber(project.events)} events`}
                    color="green"
                  />
                ))}
              </Section>
            </>
          ) : null}

          {tab === "models" ? (
            <>
              <Section title="Top Models Today" color="magenta">
                {data.todayModels.slice(0, 5).map((model) => (
                  <DataRow
                    key={`today-${model.model}`}
                    left={`${model.model}${model.model.startsWith("gpt-5") ? " *" : ""}`}
                    bar={spark(model.estimatedCostUsd, data.today.estimatedCostUsd)}
                    right={`${formatUsd(model.estimatedCostUsd)}   ${formatNumber(model.events)} events`}
                    color="magenta"
                  />
                ))}
                <Box marginTop={1}>
                  <Text dimColor>* aggregate-token estimate when local source has no prompt/output split</Text>
                </Box>
              </Section>

              <Section title="Top Models This Month" color="magenta">
                {data.monthModels.slice(0, 8).map((model) => (
                  <DataRow
                    key={`month-${model.model}`}
                    left={`${model.model}${model.model.startsWith("gpt-5") ? " *" : ""}`}
                    bar={spark(model.estimatedCostUsd, maxMonthModel)}
                    right={`${formatUsd(model.estimatedCostUsd)}   ${formatNumber(model.events)} events`}
                    color="magenta"
                  />
                ))}
              </Section>
            </>
          ) : null}

          {tab === "daily" ? (
            <Section title="Daily Model Leaders" color="blue">
              {data.modelRows.map((row) => (
                <Box key={row.date} flexDirection="column" marginBottom={1}>
                  <Text bold color="blue">{row.date}</Text>
                  {row.models.slice(0, 3).map((model) => (
                    <Text key={`${row.date}-${model.model}`}>
                      {`  ${model.model}  ${formatUsd(model.estimatedCostUsd)}  ${formatNumber(model.events)} events`}
                    </Text>
                  ))}
                  {row.models.length === 0 ? <Text dimColor>  no usage</Text> : null}
                </Box>
              ))}
            </Section>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
