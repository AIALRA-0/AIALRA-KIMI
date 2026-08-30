import { Command, Search } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

export interface CommandDescriptor {
  name: string;
  aliases?: string[];
  description: string;
  kind: "browser" | "agent" | "skill" | "unavailable";
  busy?: boolean;
  argumentHint?: string;
  skillName?: string;
}

export const BUILTIN_COMMANDS: CommandDescriptor[] = [
  { name: "help", kind: "browser", description: "显示命令帮助", busy: true },
  {
    name: "sessions",
    kind: "browser",
    description: "打开会话列表",
    busy: true,
  },
  { name: "tasks", kind: "browser", description: "打开任务面板", busy: true },
  { name: "usage", kind: "browser", description: "打开用量页面", busy: true },
  {
    name: "status",
    kind: "browser",
    description: "显示主机和会话状态",
    busy: true,
  },
  {
    name: "copy",
    kind: "browser",
    description: "复制最后一条回复",
    busy: true,
  },
  { name: "theme", kind: "browser", description: "切换黑白主题", busy: true },
  { name: "new", kind: "browser", description: "新建会话", busy: true },
  { name: "fork", kind: "browser", description: "分叉当前会话", busy: false },
  {
    name: "title",
    kind: "agent",
    description: "修改会话标题",
    busy: true,
    argumentHint: "标题",
  },
  {
    name: "compact",
    kind: "agent",
    description: "压缩当前上下文",
    busy: false,
  },
  { name: "undo", kind: "agent", description: "撤销上一轮", busy: false },
  {
    name: "permission",
    kind: "browser",
    description: "切换权限模式",
    busy: true,
    argumentHint: "manual | auto | yolo",
  },
  { name: "btw", kind: "agent", description: "启动旁路问题", busy: true },
  { name: "login", kind: "browser", description: "打开 Kimi 登录", busy: true },
  { name: "mcp", kind: "browser", description: "查看 MCP 状态", busy: true },
  { name: "plugins", kind: "browser", description: "查看插件状态", busy: true },
  {
    name: "web",
    kind: "browser",
    description: "当前已经位于 Web 控制台",
    busy: true,
  },
  {
    name: "exit",
    kind: "unavailable",
    description: "远程 Web 会话不支持退出宿主终端",
    busy: true,
  },
  {
    name: "editor",
    kind: "unavailable",
    description: "远程 Web 不启动目标主机图形应用",
    busy: true,
  },
];

export function mergeCommands(
  builtins: CommandDescriptor[],
  dynamic: CommandDescriptor[],
): CommandDescriptor[] {
  const merged = new Map(
    BUILTIN_COMMANDS.map((command) => [command.name, command]),
  );
  for (const command of [...builtins, ...dynamic])
    merged.set(command.name, command);
  return [...merged.values()];
}

export function CommandMenu({
  value,
  commands,
  selected,
  busy,
  onSelectedChange,
  onChoose,
}: {
  value: string;
  commands: CommandDescriptor[];
  selected: number;
  busy: boolean;
  onSelectedChange: (index: number) => void;
  onChoose: (command: CommandDescriptor) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const query = value.slice(1).split(/\s/u, 1)[0]?.toLowerCase() ?? "";
  const filtered = useMemo(
    () =>
      commands.filter((command) =>
        [command.name, ...(command.aliases ?? []), command.description]
          .join(" ")
          .toLowerCase()
          .includes(query),
      ),
    [commands, query],
  );

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!value.startsWith("/") || value.includes("\n")) return null;

  return (
    <div className="command-menu" role="listbox" aria-label="Kimi 命令">
      <div className="command-menu-head">
        <Search size={14} />
        <span>{query ? `筛选 “${query}”` : "输入命令名称"}</span>
        <kbd>↑↓</kbd>
        <kbd>Enter</kbd>
      </div>
      <div className="command-menu-list">
        {filtered.length === 0 ? (
          <p>没有匹配的命令，发送后会作为普通提示词处理</p>
        ) : (
          filtered.map((command, index) => {
            const disabled = busy && command.busy === false;
            return (
              <button
                key={`${command.kind}:${command.name}`}
                ref={index === selected ? selectedRef : undefined}
                role="option"
                aria-selected={index === selected}
                className={index === selected ? "selected" : ""}
                disabled={disabled}
                onMouseEnter={() => onSelectedChange(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChoose(command)}
              >
                <Command size={14} />
                <strong>/{command.name}</strong>
                {command.argumentHint && <code>{command.argumentHint}</code>}
                <span>
                  {disabled ? "当前任务结束后可用" : command.description}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export function filterCommands(
  commands: CommandDescriptor[],
  value: string,
): CommandDescriptor[] {
  if (!value.startsWith("/")) return [];
  const query = value.slice(1).split(/\s/u, 1)[0]?.toLowerCase() ?? "";
  return commands.filter((command) =>
    [command.name, ...(command.aliases ?? []), command.description]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
}
