export type TranscriptTurnState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TranscriptTextFrame {
  kind: "text";
  frameId: string;
  role: "assistant" | "user";
  text: string;
  attachmentIds?: string[];
}

export interface TranscriptThinkingFrame {
  kind: "thinking";
  frameId: string;
  text: string;
}

export interface TranscriptToolFrame {
  kind: "tool";
  frameId: string;
  toolCallId: string;
  name: string;
  state: "running" | "done" | "error";
  input?: unknown;
  inputText?: string;
  output?: unknown;
  display?: unknown;
  error?: string;
  progress?: { kind?: string; text?: string; percent?: number };
  agentRefs?: Array<{ agentId: string; role?: "child" | "member" }>;
}

export interface TranscriptNoticeFrame {
  kind: "notice";
  frameId: string;
  level: "error" | "warning" | "info";
  message: string;
  detail?: unknown;
}

export type TranscriptFrame =
  | TranscriptTextFrame
  | TranscriptThinkingFrame
  | TranscriptToolFrame
  | TranscriptNoticeFrame;

export interface TranscriptStep {
  kind: "step";
  stepId: string;
  turnId: string;
  ordinal: number;
  state: "running" | "completed" | "interrupted" | "failed";
  frames: TranscriptFrame[];
  startedAt?: string;
  endedAt?: string;
  finishReason?: string;
  retry?: {
    failedAttempt: number;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    errorName: string;
    errorMessage: string;
    statusCode?: number;
  };
}

export interface TranscriptTurn {
  kind: "turn";
  turnId: string;
  ordinal: number;
  state: TranscriptTurnState;
  origin: { kind: string; taskId?: string };
  prompt?: string;
  attachmentIds?: string[];
  steps: TranscriptStep[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface TranscriptMarker {
  kind: "marker";
  markerId: string;
  marker: string;
  payload?: unknown;
  at?: string;
}

export interface TranscriptTaskRef {
  kind: "taskref";
  refId: string;
  taskId: string;
  at?: string;
}

export type TranscriptItem =
  | TranscriptTurn
  | TranscriptMarker
  | TranscriptTaskRef;

export interface TranscriptTask {
  taskId: string;
  kind: "shell" | "subagent" | "tool" | "other";
  state: string;
  detached: boolean;
  description?: string;
  agentId?: string;
  outputTail: string;
  startedAt?: string;
  endedAt?: string;
  resultSummary?: string;
  error?: string;
}

export interface TranscriptPage {
  agent_id: string;
  items: TranscriptItem[];
  has_more: boolean;
  tasks: TranscriptTask[];
  interactions: unknown[];
  attachments: Array<Record<string, unknown>>;
  todos: Array<Record<string, unknown>>;
  prompts: Array<Record<string, unknown>>;
  meta: Record<string, unknown>;
  agents: Array<Record<string, unknown>>;
  pending_interactions: string[];
  seq?: number;
}

export interface TranscriptState {
  agentId: string;
  items: TranscriptItem[];
  tasks: Map<string, TranscriptTask>;
  interactions: Map<string, unknown>;
  attachments: Map<string, Record<string, unknown>>;
  todos: Map<string, Record<string, unknown>>;
  prompts: Map<string, Record<string, unknown>>;
  meta: Record<string, unknown>;
  pendingInteractions: Set<string>;
  hasMoreOlder: boolean;
  seq: number;
}

export type TranscriptOperation = Record<string, unknown> & { op: string };

export function emptyTranscript(agentId = "main"): TranscriptState {
  return {
    agentId,
    items: [],
    tasks: new Map(),
    interactions: new Map(),
    attachments: new Map(),
    todos: new Map(),
    prompts: new Map(),
    meta: {},
    pendingInteractions: new Set(),
    hasMoreOlder: false,
    seq: 0,
  };
}

function keyedMap<T extends Record<string, unknown>>(
  values: T[] | undefined,
  key: string,
): Map<string, T> {
  return new Map(
    (values ?? []).flatMap((value) =>
      typeof value[key] === "string" ? [[value[key] as string, value]] : [],
    ),
  );
}

export function transcriptFromPage(page: TranscriptPage): TranscriptState {
  return {
    agentId: page.agent_id,
    items: page.items ?? [],
    tasks: new Map((page.tasks ?? []).map((task) => [task.taskId, task])),
    interactions: keyedMap(
      page.interactions as Record<string, unknown>[],
      "interactionId",
    ),
    attachments: keyedMap(page.attachments, "attachmentId"),
    todos: keyedMap(page.todos, "todoId"),
    prompts: keyedMap(page.prompts, "promptId"),
    meta: page.meta ?? {},
    pendingInteractions: new Set(page.pending_interactions ?? []),
    hasMoreOlder: Boolean(page.has_more),
    seq: page.seq ?? 0,
  };
}

export function prependTranscriptPage(
  state: TranscriptState,
  page: TranscriptPage,
): TranscriptState {
  const ids = new Set(state.items.map(itemId));
  return {
    ...state,
    items: [
      ...(page.items ?? []).filter((item) => !ids.has(itemId(item))),
      ...state.items,
    ],
    hasMoreOlder: Boolean(page.has_more),
  };
}

export function applyTranscriptOps(
  current: TranscriptState,
  operations: TranscriptOperation[],
  sequence?: number,
): { state: TranscriptState; gap: boolean } {
  if (sequence !== undefined && sequence <= current.seq)
    return { state: current, gap: false };
  if (sequence !== undefined && current.seq > 0 && sequence > current.seq + 1)
    return { state: current, gap: true };
  let state = cloneState(current);
  let gap = false;
  for (const operation of operations) {
    const result = applyTranscriptOperation(state, operation);
    state = result.state;
    gap ||= result.gap;
    if (gap) break;
  }
  if (!gap && sequence !== undefined) state.seq = sequence;
  return { state: gap ? current : state, gap };
}

function applyTranscriptOperation(
  state: TranscriptState,
  operation: TranscriptOperation,
): { state: TranscriptState; gap: boolean } {
  if (operation.op === "reset") {
    const snapshot = operation.snapshot as Record<string, unknown> | undefined;
    if (!snapshot) return { state, gap: true };
    return {
      state: transcriptFromPage({
        agent_id: String(operation.agentId ?? state.agentId),
        items: (snapshot.items as TranscriptItem[]) ?? [],
        has_more: Boolean(snapshot.hasMoreOlder),
        tasks: (snapshot.tasks as TranscriptTask[]) ?? [],
        interactions: (snapshot.interactions as unknown[]) ?? [],
        attachments:
          (snapshot.attachments as Array<Record<string, unknown>>) ?? [],
        todos: (snapshot.todos as Array<Record<string, unknown>>) ?? [],
        prompts: (snapshot.prompts as Array<Record<string, unknown>>) ?? [],
        meta: (snapshot.meta as Record<string, unknown>) ?? {},
        agents: [],
        pending_interactions: [],
      }),
      gap: false,
    };
  }
  if (operation.op === "turn.upsert") {
    const turn = operation.turn as Omit<TranscriptTurn, "steps">;
    const index = state.items.findIndex(
      (item) => item.kind === "turn" && item.turnId === turn.turnId,
    );
    const existing =
      index >= 0 ? (state.items[index] as TranscriptTurn) : undefined;
    const next = {
      ...turn,
      kind: "turn" as const,
      steps: existing?.steps ?? [],
    };
    if (index >= 0) state.items[index] = next;
    else state.items.push(next);
    sortItems(state.items);
    return { state, gap: false };
  }
  if (operation.op === "step.upsert") {
    const turn = findTurn(state, String(operation.turnId));
    const step = operation.step as Omit<TranscriptStep, "frames">;
    if (!turn || !step) return { state, gap: true };
    const index = turn.steps.findIndex((item) => item.stepId === step.stepId);
    const next = {
      ...step,
      kind: "step" as const,
      frames: index >= 0 ? turn.steps[index]!.frames : [],
    };
    if (index >= 0) turn.steps[index] = next;
    else turn.steps.push(next);
    turn.steps.sort((a, b) => a.ordinal - b.ordinal);
    return { state, gap: false };
  }
  if (operation.op === "frame.upsert") {
    const step = findStep(
      state,
      String(operation.turnId),
      String(operation.stepId),
    );
    const frame = operation.frame as TranscriptFrame;
    if (!step || !frame) return { state, gap: true };
    const index = step.frames.findIndex(
      (item) => item.frameId === frame.frameId,
    );
    if (index >= 0) step.frames[index] = frame;
    else step.frames.push(frame);
    return { state, gap: false };
  }
  if (operation.op === "append") {
    const target = operation.target as Record<string, unknown>;
    const offset = Number(operation.offset);
    const text = String(operation.text ?? "");
    if (target?.type === "frame") {
      const step = findStep(
        state,
        String(target.turnId),
        String(target.stepId),
      );
      const frame = step?.frames.find(
        (item) => item.frameId === String(target.frameId),
      );
      if (!frame || !("text" in frame)) return { state, gap: true };
      if (offset < frame.text.length) return { state, gap: false };
      if (offset > frame.text.length) return { state, gap: true };
      frame.text += text;
      return { state, gap: false };
    }
    if (target?.type === "task") {
      const task = state.tasks.get(String(target.taskId));
      if (!task) return { state, gap: true };
      if (offset < task.outputTail.length) return { state, gap: false };
      if (offset > task.outputTail.length) return { state, gap: true };
      state.tasks.set(task.taskId, {
        ...task,
        outputTail: task.outputTail + text,
      });
      return { state, gap: false };
    }
  }
  if (operation.op === "marker.upsert" || operation.op === "taskref.upsert") {
    const item = operation.item as TranscriptItem;
    const id = itemId(item);
    const index = state.items.findIndex(
      (candidate) => itemId(candidate) === id,
    );
    if (index >= 0) state.items[index] = item;
    else state.items.push(item);
    return { state, gap: false };
  }
  if (operation.op === "items.remove") {
    const ids = new Set((operation.ids as string[]) ?? []);
    state.items = state.items.filter((item) => !ids.has(itemId(item)));
    return { state, gap: false };
  }
  const mapTargets: Record<string, [Map<string, unknown>, string, string]> = {
    "task.upsert": [state.tasks as Map<string, unknown>, "task", "taskId"],
    "interaction.upsert": [state.interactions, "interaction", "interactionId"],
    "attachment.upsert": [
      state.attachments as Map<string, unknown>,
      "attachment",
      "attachmentId",
    ],
    "todo.upsert": [state.todos as Map<string, unknown>, "todo", "todoId"],
    "prompt.upsert": [state.prompts, "prompt", "promptId"],
  };
  const mapping = mapTargets[operation.op];
  if (mapping) {
    const value = operation[mapping[1]] as Record<string, unknown>;
    const key = value?.[mapping[2]];
    if (typeof key === "string") mapping[0].set(key, value);
    return { state, gap: false };
  }
  if (operation.op === "meta.merge") {
    state.meta = deepMerge(
      state.meta,
      (operation.meta as Record<string, unknown>) ?? {},
    );
  }
  return { state, gap: false };
}

function cloneState(state: TranscriptState): TranscriptState {
  return {
    ...state,
    items: structuredClone(state.items),
    tasks: new Map(
      [...state.tasks].map(([key, value]) => [key, structuredClone(value)]),
    ),
    interactions: new Map(state.interactions),
    attachments: new Map(state.attachments),
    todos: new Map(state.todos),
    prompts: new Map(state.prompts),
    meta: structuredClone(state.meta),
    pendingInteractions: new Set(state.pendingInteractions),
  };
}

function findTurn(
  state: TranscriptState,
  turnId: string,
): TranscriptTurn | undefined {
  return state.items.find(
    (item): item is TranscriptTurn =>
      item.kind === "turn" && item.turnId === turnId,
  );
}

function findStep(
  state: TranscriptState,
  turnId: string,
  stepId: string,
): TranscriptStep | undefined {
  return findTurn(state, turnId)?.steps.find((step) => step.stepId === stepId);
}

function itemId(item: TranscriptItem): string {
  if (item.kind === "turn") return `turn:${item.turnId}`;
  if (item.kind === "marker") return `marker:${item.markerId}`;
  return `taskref:${item.refId}`;
}

function sortItems(items: TranscriptItem[]): void {
  items.sort((left, right) => {
    if (left.kind !== "turn" || right.kind !== "turn") return 0;
    return left.ordinal - right.ordinal;
  });
}

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    )
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    else result[key] = value;
  }
  return result;
}
