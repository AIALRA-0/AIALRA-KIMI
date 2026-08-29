import { describe, expect, it } from "vitest";
import {
  appendAssistantDelta,
  cleanToolText,
  coalesceToolMessages,
  decodeKimiEvent,
  finishAssistantTurn,
  shouldApplySequence,
  turnFailureMessage,
  withInFlightMessage,
} from "../src/session-model.js";

describe("Kimi session event model", () => {
  it("decodes the official session event envelope", () => {
    expect(
      decodeKimiEvent({
        type: "assistant.delta",
        seq: 19,
        session_id: "session_one",
        timestamp: "2026-08-29T01:00:00.000Z",
        payload: { type: "assistant.delta", turnId: 7, delta: "hello" },
      }),
    ).toMatchObject({
      type: "assistant.delta",
      sessionId: "session_one",
      sequence: 19,
      payload: { turnId: 7, delta: "hello" },
    });
  });

  it("rebuilds and completes streaming assistant text without duplication", () => {
    const recovered = withInFlightMessage([], {
      turn_id: 7,
      assistant_text: "hello",
      running_tools: [],
    });
    const streamed = appendAssistantDelta(recovered, 7, " world", "now");
    expect(finishAssistantTurn(streamed, 7)).toEqual([
      expect.objectContaining({
        id: "live:7",
        text: "hello world",
        streaming: false,
      }),
    ]);
  });

  it("rejects durable replay duplicates but accepts volatile frames", () => {
    expect(shouldApplySequence(20, 20)).toBe(false);
    expect(shouldApplySequence(20, 19)).toBe(false);
    expect(shouldApplySequence(20, 21)).toBe(true);
    expect(shouldApplySequence(20, null)).toBe(true);
  });

  it("merges a tool call and result into one collapsible message", () => {
    expect(
      coalesceToolMessages([
        {
          id: "call",
          role: "tool",
          toolCallId: "one",
          toolName: "Shell",
          text: '{"command":"echo ok"}',
          time: "now",
        },
        {
          id: "result",
          role: "tool",
          toolCallId: "one",
          toolName: "result",
          text: "<system>Command executed successfully.</system>ok",
          time: "now",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        toolName: "Shell",
        toolInput: '{\n  "command": "echo ok"\n}',
        toolOutput: "Command executed successfully.\nok",
      }),
    ]);
  });

  it("removes transport wrappers without changing ordinary content", () => {
    expect(cleanToolText("before <system>done</system> after")).toBe(
      "before done\n after",
    );
  });
});

describe("turnFailureMessage", () => {
  it("explains a missing session model without exposing upstream details", () => {
    expect(
      turnFailureMessage({ error: { code: "model.not_configured" } }),
    ).toBe("Kimi 会话没有绑定模型，请重新创建会话");
  });

  it("returns a bounded fallback for other upstream codes", () => {
    expect(turnFailureMessage({ error: { code: "provider.failed" } })).toBe(
      "Kimi 会话执行失败（provider.failed）",
    );
  });
});
