import { describe, expect, it } from "vitest";
import {
  applyTranscriptReset,
  applyTranscriptOps,
  mergeTranscriptPage,
  shouldRenderTranscript,
  transcriptFromPage,
  turnTraceDefaultOpen,
  type TranscriptPage,
} from "../src/transcript-model.js";

function page(): TranscriptPage {
  return {
    agent_id: "main",
    items: [
      {
        kind: "turn",
        turnId: "turn-1",
        ordinal: 1,
        state: "running",
        origin: { kind: "user" },
        prompt: "测试",
        steps: [
          {
            kind: "step",
            stepId: "step-1",
            turnId: "turn-1",
            ordinal: 1,
            state: "running",
            frames: [
              {
                kind: "thinking",
                frameId: "think-1",
                text: "先分析",
              },
              {
                kind: "text",
                frameId: "answer-1",
                role: "assistant",
                text: "答",
              },
            ],
          },
        ],
      },
    ],
    has_more: false,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    agents: [],
    pending_interactions: [],
    seq: 10,
  };
}

describe("transcript v2 reducer", () => {
  it("keeps running traces open and folds completed traces when a new prompt starts", () => {
    expect(turnTraceDefaultOpen("running", true, true)).toBe(true);
    expect(turnTraceDefaultOpen("completed", true, false)).toBe(true);
    expect(turnTraceDefaultOpen("completed", true, true)).toBe(false);
    expect(turnTraceDefaultOpen("completed", false, false)).toBe(false);
  });

  it("applies exact-offset deltas and rejects duplicates", () => {
    const state = transcriptFromPage(page());
    const operation = {
      op: "append",
      target: {
        type: "frame",
        turnId: "turn-1",
        stepId: "step-1",
        frameId: "answer-1",
      },
      offset: 1,
      text: "案",
    };
    const first = applyTranscriptOps(state, [operation], 11);
    const duplicate = applyTranscriptOps(first.state, [operation], 11);
    expect(first.gap).toBe(false);
    expect(duplicate.state).toBe(first.state);
    expect(
      (
        first.state.items[0] as {
          steps: Array<{ frames: Array<{ text?: string }> }>;
        }
      ).steps[0]!.frames[1]!.text,
    ).toBe("答案");
  });

  it("signals an offset gap without corrupting visible content", () => {
    const state = transcriptFromPage(page());
    const result = applyTranscriptOps(
      state,
      [
        {
          op: "append",
          target: {
            type: "frame",
            turnId: "turn-1",
            stepId: "step-1",
            frameId: "answer-1",
          },
          offset: 9,
          text: "错误拼接",
        },
      ],
      11,
    );
    expect(result.gap).toBe(true);
    expect(result.state).toBe(state);
  });

  it("signals a sequence gap for REST catch-up", () => {
    const state = transcriptFromPage(page());
    expect(applyTranscriptOps(state, [], 13).gap).toBe(true);
  });

  it("does not erase a recovered transcript with an empty stale reset", () => {
    const current = transcriptFromPage({ ...page(), seq: 12 });
    const staleReset = { ...page(), items: [], seq: 12 };
    expect(applyTranscriptReset(current, staleReset)).toBe(current);
    expect(applyTranscriptReset(current, { ...staleReset, seq: 13 })).toBe(
      current,
    );
  });

  it("keeps an empty recovery page scoped to its session", () => {
    const current = transcriptFromPage(page());
    const emptyPage = { ...page(), items: [] };
    expect(
      mergeTranscriptPage(current, "session-1", "session-1", emptyPage),
    ).toBe(current);
    expect(
      mergeTranscriptPage(current, "session-1", "session-2", emptyPage).items,
    ).toEqual([]);
  });

  it("falls back to legacy messages while transcript recovery is empty", () => {
    const empty = transcriptFromPage({ ...page(), items: [] });
    expect(shouldRenderTranscript(empty, "session-1", "session-1", 2)).toBe(
      false,
    );
    expect(shouldRenderTranscript(empty, "session-1", "session-1", 0)).toBe(
      true,
    );
    expect(
      shouldRenderTranscript(
        transcriptFromPage(page()),
        "session-1",
        "session-1",
        2,
      ),
    ).toBe(true);
  });
});
