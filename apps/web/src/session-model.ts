import type { PermissionMode } from "@aialra-kimi/protocol";

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  time: string;
  streaming?: boolean;
  toolCallId?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  isError?: boolean;
}

export function cleanToolText(value: string): string {
  const withoutSystemEnvelope = value.replace(
    /<system>([\s\S]*?)<\/system>/gu,
    "$1\n",
  );
  const trimmed = withoutSystemEnvelope.trim();
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

export function coalesceToolMessages(messages: UiMessage[]): UiMessage[] {
  const result: UiMessage[] = [];
  const calls = new Map<string, number>();

  for (const message of messages) {
    if (message.role !== "tool") {
      result.push(message);
      continue;
    }

    const callId = message.toolCallId;
    const isResult = message.toolName?.toLowerCase() === "result";
    if (isResult && callId && calls.has(callId)) {
      const index = calls.get(callId)!;
      const existing = result[index];
      if (existing) {
        const merged: UiMessage = {
          ...existing,
          toolOutput: cleanToolText(message.toolOutput ?? message.text),
          streaming: false,
        };
        if (message.isError !== undefined) merged.isError = message.isError;
        result[index] = merged;
      }
      continue;
    }

    const normalized: UiMessage = { ...message };
    if (isResult) {
      normalized.toolOutput = cleanToolText(message.toolOutput ?? message.text);
    } else {
      normalized.toolInput = cleanToolText(message.toolInput ?? message.text);
      if (message.toolOutput)
        normalized.toolOutput = cleanToolText(message.toolOutput);
    }
    if (callId && !isResult) calls.set(callId, result.length);
    result.push(normalized);
  }

  return result;
}

export interface UiApproval {
  approval_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display: unknown;
  created_at: string;
  expires_at: string;
}

export interface UiQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface UiQuestionItem {
  id: string;
  question: string;
  header?: string;
  body?: string;
  options: UiQuestionOption[];
  multi_select?: boolean;
  allow_other?: boolean;
  other_label?: string;
}

export interface UiQuestion {
  question_id: string;
  session_id: string;
  questions: UiQuestionItem[];
  created_at: string;
}

export interface UiTask {
  id: string;
  session_id: string;
  kind: "subagent" | "bash" | "tool";
  description: string;
  status: "running" | "completed" | "failed" | "cancelled";
  created_at: string;
  completed_at?: string;
  model?: string;
}

export interface UiFileEntry {
  path: string;
  name: string;
  kind: "file" | "directory" | "symlink";
}

export interface UiFileRead {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  size: number;
  truncated: boolean;
  is_binary: boolean;
}

export interface UiSessionStatus {
  busy: boolean;
  contextTokens: number;
  maxContextTokens?: number | null;
  contextUsage?: number | null;
  model?: string | null;
  thinkingLevel: string;
}

export interface UiInFlightTurn {
  turn_id: number;
  assistant_text: string;
  running_tools: Array<{
    tool_call_id: string;
    name: string;
    description?: string;
    last_progress?: { text?: string; percent?: number };
  }>;
}

export interface UiSessionSnapshot {
  messages: UiMessage[];
  permissionMode: PermissionMode;
  asOfSeq: number;
  epoch: string;
  pendingApprovals: UiApproval[];
  pendingQuestions: UiQuestion[];
  inFlightTurn: UiInFlightTurn | null;
  tasks: UiTask[];
  status: UiSessionStatus;
}

export interface KimiEventEnvelope {
  type: string;
  sessionId: string | null;
  sequence: number | null;
  timestamp: string | null;
  payload: Record<string, unknown>;
}

export function decodeKimiEvent(value: unknown): KimiEventEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.type !== "string") return null;
  const payload =
    envelope.payload && typeof envelope.payload === "object"
      ? (envelope.payload as Record<string, unknown>)
      : envelope;
  const sessionId =
    typeof envelope.session_id === "string"
      ? envelope.session_id
      : typeof payload.sessionId === "string"
        ? payload.sessionId
        : typeof payload.session_id === "string"
          ? payload.session_id
          : null;
  return {
    type: envelope.type,
    sessionId,
    sequence: typeof envelope.seq === "number" ? envelope.seq : null,
    timestamp:
      typeof envelope.timestamp === "string" ? envelope.timestamp : null,
    payload,
  };
}

export function withInFlightMessage(
  messages: UiMessage[],
  turn: UiInFlightTurn | null,
): UiMessage[] {
  if (!turn?.assistant_text) return messages;
  return appendAssistantDelta(
    messages,
    turn.turn_id,
    turn.assistant_text,
    "",
    true,
  );
}

export function appendAssistantDelta(
  messages: UiMessage[],
  turnId: number,
  delta: string,
  time: string,
  replace = false,
): UiMessage[] {
  const id = `live:${turnId}`;
  const existing = messages.find((message) => message.id === id);
  if (!existing) {
    return [
      ...messages,
      { id, role: "assistant", text: delta, time, streaming: true },
    ];
  }
  return messages.map((message) =>
    message.id === id
      ? {
          ...message,
          text: replace ? delta : `${message.text}${delta}`,
          streaming: true,
        }
      : message,
  );
}

export function finishAssistantTurn(
  messages: UiMessage[],
  turnId: number,
): UiMessage[] {
  const id = `live:${turnId}`;
  return messages.map((message) =>
    message.id === id ? { ...message, streaming: false } : message,
  );
}

export function shouldApplySequence(
  lastSequence: number,
  nextSequence: number | null,
): boolean {
  return nextSequence === null || nextSequence > lastSequence;
}
