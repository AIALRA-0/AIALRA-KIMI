export const KIMI_OPERATIONS = [
  "meta.read",
  "sessions.list",
  "sessions.create",
  "sessions.read",
  "sessions.archive",
  "sessions.fork",
  "sessions.prompt",
  "sessions.interrupt",
  "sessions.snapshot",
  "sessions.events",
  "sessions.transcript.read",
  "sessions.transcript.resume",
  "sessions.messages.page",
  "sessions.prompts.list",
  "sessions.prompts.steer",
  "sessions.prompts.abort",
  "sessions.skills.list",
  "sessions.skills.activate",
  "sessions.commands.list",
  "sessions.commands.execute",
  "sessions.attachments.upload",
  "sessions.media.read",
  "sessions.models.list",
  "sessions.compact",
  "sessions.undo",
  "sessions.btw",
  "sessions.title.write",
  "sessions.tasks.cancel",
  "sessions.tasks.detach",
  "sessions.export",
  "sessions.approvals.respond",
  "sessions.questions.respond",
  "sessions.questions.dismiss",
  "sessions.tasks.list",
  "sessions.files.search",
  "sessions.files.read",
  "sessions.files.status",
  "sessions.permission.read",
  "sessions.permission.write",
  "oauth.userinfo",
  "oauth.usage",
  "oauth.device.start",
  "oauth.device.poll",
] as const;

export const TERMINAL_OPERATIONS = [
  "terminal.open",
  "terminal.resume",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
  "terminal.elevate.open",
  "terminal.elevate.input",
] as const;

export const AGENT_OPERATIONS = [
  ...KIMI_OPERATIONS,
  ...TERMINAL_OPERATIONS,
] as const;

export type KimiOperation = (typeof KIMI_OPERATIONS)[number];
export type TerminalOperation = (typeof TERMINAL_OPERATIONS)[number];
export type AgentOperation = (typeof AGENT_OPERATIONS)[number];

const OPERATION_SET = new Set<string>(AGENT_OPERATIONS);

export function isAgentOperation(value: string): value is AgentOperation {
  return OPERATION_SET.has(value);
}
