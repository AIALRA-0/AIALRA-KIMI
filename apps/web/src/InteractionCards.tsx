import { Check, HelpCircle, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import type { UiApproval, UiQuestion } from "./session-model.js";

interface InteractionCardsProps {
  approvals: UiApproval[];
  questions: UiQuestion[];
  disabled: boolean;
  onApproval(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<void>;
  onQuestion(
    questionId: string,
    answers: Record<string, unknown>,
  ): Promise<void>;
  onDismissQuestion(questionId: string): Promise<void>;
}

export function InteractionCards({
  approvals,
  questions,
  disabled,
  onApproval,
  onQuestion,
  onDismissQuestion,
}: InteractionCardsProps) {
  if (!approvals.length && !questions.length) return null;
  return (
    <div className="interaction-stack">
      {approvals.map((approval) => (
        <article
          className="interaction-card approval-card"
          key={approval.approval_id}
        >
          <div className="interaction-icon">
            <ShieldAlert size={18} />
          </div>
          <div className="interaction-copy">
            <strong>需要审批 · {approval.tool_name}</strong>
            <p>
              {approval.action || displayValue(approval.tool_input_display)}
            </p>
            <small>
              到期时间 {new Date(approval.expires_at).toLocaleString("zh-CN")}
            </small>
          </div>
          <div className="interaction-actions">
            <button
              disabled={disabled}
              onClick={() => void onApproval(approval.approval_id, "rejected")}
            >
              <X size={15} /> 拒绝
            </button>
            <button
              className="approve"
              disabled={disabled}
              onClick={() => void onApproval(approval.approval_id, "approved")}
            >
              <Check size={15} /> 批准
            </button>
          </div>
        </article>
      ))}
      {questions.map((question) => (
        <QuestionCard
          key={question.question_id}
          request={question}
          disabled={disabled}
          onSubmit={onQuestion}
          onDismiss={onDismissQuestion}
        />
      ))}
    </div>
  );
}

function QuestionCard({
  request,
  disabled,
  onSubmit,
  onDismiss,
}: {
  request: UiQuestion;
  disabled: boolean;
  onSubmit(questionId: string, answers: Record<string, unknown>): Promise<void>;
  onDismiss(questionId: string): Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  function choose(itemId: string, optionId: string, multiple: boolean) {
    setAnswers((current) => {
      const selected = current[itemId] ?? [];
      const next = multiple
        ? selected.includes(optionId)
          ? selected.filter((id) => id !== optionId)
          : [...selected, optionId]
        : [optionId];
      return { ...current, [itemId]: next };
    });
  }

  async function submit() {
    const payload: Record<string, unknown> = {};
    for (const item of request.questions) {
      const selected = answers[item.id] ?? [];
      const otherText = other[item.id]?.trim();
      if (otherText && selected.length)
        payload[item.id] = {
          kind: "multi_with_other",
          option_ids: selected,
          other_text: otherText,
        };
      else if (otherText) payload[item.id] = { kind: "other", text: otherText };
      else if (item.multi_select)
        payload[item.id] = { kind: "multi", option_ids: selected };
      else if (selected[0])
        payload[item.id] = { kind: "single", option_id: selected[0] };
      else payload[item.id] = { kind: "skipped" };
    }
    await onSubmit(request.question_id, payload);
  }

  return (
    <article className="interaction-card question-card">
      <div className="interaction-icon">
        <HelpCircle size={18} />
      </div>
      <div className="question-copy">
        {request.questions.map((item) => (
          <fieldset key={item.id}>
            <legend>{item.header ?? "Kimi 有一个问题"}</legend>
            <p>{item.question}</p>
            <div className="question-options">
              {item.options.map((option) => {
                const selected = (answers[item.id] ?? []).includes(option.id);
                return (
                  <button
                    type="button"
                    className={selected ? "selected" : ""}
                    onClick={() =>
                      choose(item.id, option.id, Boolean(item.multi_select))
                    }
                    key={option.id}
                  >
                    <strong>{option.label}</strong>
                    {option.description && <span>{option.description}</span>}
                  </button>
                );
              })}
            </div>
            {item.allow_other && (
              <input
                value={other[item.id] ?? ""}
                onChange={(event) =>
                  setOther((current) => ({
                    ...current,
                    [item.id]: event.target.value,
                  }))
                }
                placeholder={item.other_label ?? "其他回答"}
              />
            )}
          </fieldset>
        ))}
      </div>
      <div className="interaction-actions">
        <button
          disabled={disabled}
          onClick={() => void onDismiss(request.question_id)}
        >
          忽略
        </button>
        <button
          className="approve"
          disabled={disabled}
          onClick={() => void submit()}
        >
          回答
        </button>
      </div>
    </article>
  );
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "请检查请求的工具操作";
  }
}
