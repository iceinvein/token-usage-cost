import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import type { UsageEvent } from "./types";

type CursorChatBubble = {
  type?: string;
  id?: string;
  modelType?: string;
  text?: string;
};

type CursorChatTab = {
  tabId?: string;
  bubbles?: CursorChatBubble[];
  lastSendTime?: number;
};

type CursorChatData = {
  tabs?: CursorChatTab[];
};

type CursorComposerHead = {
  composerId?: string;
  name?: string;
  subtitle?: string;
  unifiedMode?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
};

type CursorComposerData = {
  allComposers?: CursorComposerHead[];
};

function toIsoMs(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function parseWorkspaceFolderUri(raw: string): string {
  try {
    if (raw.startsWith("file://")) {
      return decodeURIComponent(new URL(raw).pathname);
    }
  } catch {
    // Fall through to raw value.
  }

  return raw;
}

async function readWorkspaceProject(statePath: string): Promise<string> {
  const workspacePath = join(dirname(statePath), "workspace.json");

  try {
    const text = await readFile(workspacePath, "utf8");
    const json = JSON.parse(text) as { folder?: string };
    const folder = json.folder ? parseWorkspaceFolderUri(json.folder) : "";
    return folder || basename(dirname(statePath));
  } catch {
    return basename(dirname(statePath));
  }
}

function readItemValue(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM ItemTable WHERE key = ?").get(key);
  return row?.value ?? null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseChatEvents(statePath: string, project: string, chatData: CursorChatData | null): UsageEvent[] {
  if (!chatData?.tabs) {
    return [];
  }

  return chatData.tabs.flatMap((tab) => {
    const lastSendTime = tab.lastSendTime ?? 0;
    const aiBubbles = (tab.bubbles ?? []).filter((bubble) => bubble.type === "ai");
    const lastAiBubble = [...aiBubbles].reverse().find((bubble) => bubble.modelType || bubble.text);

    if (!tab.tabId || !lastAiBubble || lastSendTime <= 0) {
      return [];
    }

    const model = lastAiBubble.modelType ?? "cursor-chat";

    return [{
      source: "cursor" as const,
      project,
      sessionId: tab.tabId,
      filePath: statePath,
      eventKey: `cursor:chat:${tab.tabId}:${lastSendTime}`,
      timestamp: toIsoMs(lastSendTime),
      messageId: lastAiBubble.id ?? tab.tabId,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      totalTokens: 0,
      tokenBreakdownKnown: false,
      speed: "standard" as const,
      estimatedCostUsd: 0,
    }];
  });
}

function parseComposerEvents(
  statePath: string,
  project: string,
  composerData: CursorComposerData | null,
): UsageEvent[] {
  if (!composerData?.allComposers) {
    return [];
  }

  return composerData.allComposers.flatMap((composer) => {
    const composerId = composer.composerId;
    const timestamp = composer.lastUpdatedAt ?? composer.createdAt ?? 0;

    if (!composerId || timestamp <= 0) {
      return [];
    }

    const mode = composer.unifiedMode ?? "composer";

    return [{
      source: "cursor" as const,
      project,
      sessionId: composerId,
      filePath: statePath,
      eventKey: `cursor:composer:${composerId}:${timestamp}`,
      timestamp: toIsoMs(timestamp),
      messageId: composerId,
      model: `cursor-${mode}`,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      totalTokens: 0,
      tokenBreakdownKnown: false,
      speed: "standard" as const,
      estimatedCostUsd: 0,
    }];
  });
}

export function defaultCursorWorkspaceRoot(): string {
  return join(homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage");
}

export async function statCursorWorkspaceRoot(root: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(root);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

export async function parseCursorUsageFile(statePath: string): Promise<UsageEvent[]> {
  const db = new Database(statePath, { readonly: true });

  try {
    const project = await readWorkspaceProject(statePath);
    const chatValue = readItemValue(db, "workbench.panel.aichat.view.aichat.chatdata");
    const composerValue = readItemValue(db, "composer.composerData");

    const chatData = parseJson<CursorChatData>(chatValue);
    const composerData = parseJson<CursorComposerData>(composerValue);
    const events = [
      ...parseChatEvents(statePath, project, chatData),
      ...parseComposerEvents(statePath, project, composerData),
    ];

    return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } finally {
    db.close();
  }
}

export async function cursorWorkspaceExists(root = defaultCursorWorkspaceRoot()): Promise<boolean> {
  try {
    await access(root);
    return true;
  } catch {
    return false;
  }
}
