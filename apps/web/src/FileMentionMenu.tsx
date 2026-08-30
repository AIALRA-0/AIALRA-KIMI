import { File, Folder, Search } from "lucide-react";
import type { UiFileEntry } from "./session-model.js";

export function mentionQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)@([^\s]*)$/u);
  return match ? (match[1] ?? "") : null;
}

export function matchingFiles(
  files: UiFileEntry[],
  value: string,
): UiFileEntry[] {
  const query = mentionQuery(value)?.toLowerCase();
  if (query === null) return [];
  return files
    .filter((file) =>
      `${file.name} ${file.path}`.toLowerCase().includes(query ?? ""),
    )
    .slice(0, 12);
}

export function insertFileMention(value: string, path: string): string {
  return value.replace(/(?:^|\s)@[^\s]*$/u, (token) => {
    const prefix = token.startsWith(" ") ? " " : "";
    return `${prefix}@${path} `;
  });
}

export function FileMentionMenu({
  value,
  files,
  selected,
  onSelectedChange,
  onChoose,
}: {
  value: string;
  files: UiFileEntry[];
  selected: number;
  onSelectedChange: (index: number) => void;
  onChoose: (file: UiFileEntry) => void;
}) {
  const query = mentionQuery(value);
  if (query === null) return null;
  const matches = matchingFiles(files, value);
  return (
    <div
      className="command-menu file-mention-menu"
      role="listbox"
      aria-label="工作区文件"
    >
      <div className="command-menu-head">
        <Search size={14} />
        <span>{query ? `查找 “${query}”` : "引用工作区文件"}</span>
        <kbd>↑↓</kbd>
        <kbd>Tab</kbd>
      </div>
      <div className="command-menu-list">
        {matches.length === 0 ? (
          <p>没有匹配的工作区文件</p>
        ) : (
          matches.map((file, index) => {
            const Icon = file.kind === "directory" ? Folder : File;
            return (
              <button
                key={file.path}
                role="option"
                aria-selected={index === selected}
                className={index === selected ? "selected" : ""}
                onMouseEnter={() => onSelectedChange(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChoose(file)}
              >
                <Icon size={14} />
                <strong>{file.name}</strong>
                <span>{file.path}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
