import { Archive, ArchiveRestore, Clock3, Search } from "lucide-react";
import type { UiSession } from "./demo.js";

export function ArchiveManager({
  sessions,
  loading,
  unavailable = false,
  busy = false,
  query,
  onQueryChange,
  onRestore,
}: {
  sessions: UiSession[];
  loading: boolean;
  unavailable?: boolean;
  busy?: boolean;
  query: string;
  onQueryChange(value: string): void;
  onRestore(session: UiSession): void;
}) {
  const visible = sessions.filter((session) =>
    `${session.title} ${session.workspaceAlias}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const groups = new Map<string, UiSession[]>();
  for (const session of visible) {
    const key = session.workspaceAlias || "未命名项目";
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return (
    <section className="archive-view" aria-labelledby="archive-heading">
      <div className="page-heading">
        <div>
          <p className="eyebrow">会话归档</p>
          <h1 id="archive-heading">归档对话</h1>
          <p>归档只会隐藏对话，恢复后仍可继续使用</p>
        </div>
        <div className="archive-count" aria-label="归档数量">
          <Archive size={18} /> {sessions.length}
        </div>
      </div>
      <label className="archive-search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索归档对话"
          aria-label="搜索归档对话"
        />
      </label>
      {loading ? (
        <div className="archive-empty" role="status">
          <Clock3 className="spin" size={22} /> 正在加载归档对话…
        </div>
      ) : unavailable ? (
        <div className="archive-empty" role="status">
          <Archive size={22} />
          <strong>代理暂时不可用</strong>
          <p>主机恢复在线后才能读取和恢复归档对话</p>
        </div>
      ) : visible.length ? (
        <div className="archive-list">
          {[...groups.entries()].map(([project, projectSessions]) => (
            <section className="archive-project-group" key={project}>
              <div className="archive-project-heading">
                <strong>{project}</strong>
                <span>{projectSessions.length}</span>
              </div>
              {projectSessions.map((session) => (
                <article
                  className="archive-row"
                  key={`${session.hostId}:${session.upstreamSessionId}`}
                >
                  <Archive size={18} aria-hidden="true" />
                  <div className="archive-row-main">
                    <strong>{session.title}</strong>
                    <span>
                      {session.workspaceAlias} ·{" "}
                      {session.updatedAt
                        ? new Date(session.updatedAt).toLocaleString("zh-CN")
                        : "时间未知"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onRestore(session)}
                    disabled={unavailable || busy}
                    aria-label={`恢复 ${session.title}`}
                  >
                    <ArchiveRestore size={15} /> {busy ? "处理中…" : "恢复"}
                  </button>
                </article>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="archive-empty">
          <Archive size={22} />{" "}
          {query.trim() ? "没有匹配的归档对话" : "还没有归档对话"}
        </div>
      )}
    </section>
  );
}
