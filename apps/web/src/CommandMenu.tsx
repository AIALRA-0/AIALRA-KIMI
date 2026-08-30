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
