import { describe, expect, it } from "vitest";
import {
  appendAssistantDelta,
  decodeKimiEvent,
  finishAssistantTurn,
  shouldApplySequence,
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
});
