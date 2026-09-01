import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { RelayChannel } from "./relay.js";

interface TerminalPanelProps {
  hostId: string;
  channel: RelayChannel | null;
  demo: boolean;
  theme: "light" | "dark";
  platform: "windows" | "linux";
  elevationAvailable: boolean;
  elevated: boolean;
  output: { id: number; data: string } | null;
  connectionState?: TerminalConnectionState;
  onElevatedChange(value: boolean): void;
}

interface TerminalResumeState {
  terminalId: string;
  resumeToken: string;
}

type TerminalShell = "powershell" | "cmd" | "shell";
type TerminalConnectionState =
  | "loading"
  | "ready"
  | "reconnecting"
  | "offline"
  | "error";

export function defaultShellForPlatform(
  platform: "windows" | "linux",
): TerminalShell {
  return platform === "windows" ? "powershell" : "shell";
}

export function effectiveShellForPlatform(
  platform: "windows" | "linux",
  selected: TerminalShell,
): TerminalShell {
  return platform === "windows"
    ? selected === "cmd"
      ? "cmd"
      : "powershell"
    : "shell";
}

function terminalTheme(theme: "light" | "dark") {
  return theme === "light"
    ? {
        background: "#f7f7f7",
        foreground: "#171717",
        cursor: "#171717",
        selectionBackground: "#cfcfcf",
      }
    : {
        background: "#0d0d0d",
        foreground: "#ededed",
        cursor: "#f2f2f2",
        selectionBackground: "#414141",
      };
}

export function TerminalPanel({
  hostId,
  channel,
  demo,
  theme,
  platform,
  elevationAvailable,
  elevated,
  output,
  connectionState = demo ? "ready" : channel ? "ready" : "loading",
  onElevatedChange,
}: TerminalPanelProps) {
  const container = useRef<HTMLDivElement>(null);
  const activeTerminal = useRef<Terminal | null>(null);
  const credentialRef = useRef<{ username: string; password: string } | null>(
    null,
  );
  const [shell, setShell] = useState<TerminalShell>(() =>
    defaultShellForPlatform(platform),
  );
  const effectiveShell = effectiveShellForPlatform(platform, shell);
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [credentialAttempt, setCredentialAttempt] = useState(0);
  const [showCredentialForm, setShowCredentialForm] = useState(
    elevated && platform === "windows",
  );
  const [credentialError, setCredentialError] = useState<string | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Berkeley Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      theme: terminalTheme(theme),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    terminal.textarea?.setAttribute("aria-label", "终端输入");
    activeTerminal.current = terminal;
    fit.fit();
    let ready = demo;
    const resumeKey = `aialra-terminal:${hostId}:${effectiveShell}`;
    if (demo) {
      terminal.writeln("AIALRA Kimi 安全终端");
      terminal.writeln(
        `已连接合成 ${platform} 主机 · ${elevated ? "提权" : "普通"}`,
      );
      terminal.write(
        platform === "windows"
          ? "PS C:\\workspace> "
          : "operator@build-vps:/workspace$ ",
      );
    } else if (channel) {
      void (async () => {
        if (!elevated) {
          const saved = sessionStorage.getItem(resumeKey);
          if (saved) {
            try {
              const resume = JSON.parse(saved) as TerminalResumeState;
              const result = await channel.rpc<{
                terminalId: string;
                scrollback: string;
              }>("terminal.resume", resume);
              if (result.scrollback) terminal.write(result.scrollback);
              ready = true;
              return;
            } catch {
              sessionStorage.removeItem(resumeKey);
            }
          }
        }
        try {
          const credentials =
            elevated && platform === "windows" ? credentialRef.current : null;
          const result = await channel.rpc<{
            terminalId: string;
            resumeToken: string;
          }>(elevated ? "terminal.elevate.open" : "terminal.open", {
            shell: effectiveShell,
            columns: terminal.cols,
            rows: terminal.rows,
            ...(credentials ?? {}),
          });
          credentialRef.current = null;
          if (!elevated) {
            sessionStorage.setItem(
              resumeKey,
              JSON.stringify({
                terminalId: result.terminalId,
                resumeToken: result.resumeToken,
              } satisfies TerminalResumeState),
            );
          }
          ready = true;
        } catch (error) {
          credentialRef.current = null;
          if (elevated && platform === "windows") {
            setCredentialError(
              error instanceof Error ? error.message : "管理员身份验证失败",
            );
            setShowCredentialForm(true);
          }
          terminal.writeln(
            `\r\n终端不可用：${error instanceof Error ? error.message : "未知错误"}`,
          );
        }
      })();
    }
    const dataSubscription = terminal.onData((data) => {
      if (demo) {
        if (data === "\r")
          terminal.write(
            "\r\n" +
              (platform === "windows"
                ? "PS C:\\workspace> "
                : "operator@build-vps:/workspace$ "),
          );
        else terminal.write(data);
      } else if (channel && ready) {
        void channel.rpc(
          elevated ? "terminal.elevate.input" : "terminal.input",
          { data },
        );
      }
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (channel && !demo && ready)
        void channel.rpc("terminal.resize", { columns: cols, rows });
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      if (channel && !demo && elevated)
        void channel.rpc("terminal.close", {}).catch(() => undefined);
      activeTerminal.current = null;
      terminal.dispose();
    };
  }, [
    channel,
    credentialAttempt,
    demo,
    effectiveShell,
    elevated,
    hostId,
    platform,
  ]);

  useEffect(() => {
    if (activeTerminal.current)
      activeTerminal.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    const textarea = activeTerminal.current?.textarea;
    if (textarea) textarea.readOnly = !demo && connectionState !== "ready";
  }, [connectionState, demo]);

  useEffect(() => {
    if (output) activeTerminal.current?.write(output.data);
  }, [output]);

  function changeElevation(next: boolean) {
    credentialRef.current = null;
    setCredentialError(null);
    setCredentialAttempt(0);
    setShowCredentialForm(next && platform === "windows");
    setAdminPassword("");
    onElevatedChange(next);
  }

  function changeShell(next: TerminalShell) {
    if (channel && !demo) {
      void channel
        .rpc("terminal.close", {})
        .catch(() => undefined)
        .finally(() => setShell(next));
      return;
    }
    setShell(next);
  }

  function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    if (!adminUsername.trim() || !adminPassword) return;
    credentialRef.current = {
      username: adminUsername.trim(),
      password: adminPassword,
    };
    setAdminPassword("");
    setCredentialError(null);
    setShowCredentialForm(false);
    setCredentialAttempt((current) => current + 1);
  }

  return (
    <section
      className={`terminal-panel terminal-${theme}`}
      aria-label="主机终端"
    >
      <div className="terminal-toolbar">
        <div className="terminal-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <select
          value={effectiveShell}
          onChange={(event) => changeShell(event.target.value as TerminalShell)}
          aria-label="命令行环境"
        >
          {platform === "windows" ? (
            <>
              <option value="powershell">PowerShell</option>
              <option value="cmd">CMD</option>
            </>
          ) : (
            <option value="shell">Shell</option>
          )}
        </select>
        {elevationAvailable ? (
          <label className="elevated-toggle">
            <input
              type="checkbox"
              checked={elevated}
              onChange={(event) => changeElevation(event.target.checked)}
            />
            <span>管理员会话</span>
          </label>
        ) : (
          <span className="terminal-capability-note">
            {connectionState === "offline"
              ? "主机离线 · 等待恢复"
              : connectionState === "reconnecting"
                ? "正在重连普通终端"
                : connectionState === "error"
                  ? "普通终端连接失败"
                  : connectionState === "loading"
                    ? "正在连接普通终端"
                    : "普通终端已连接 · 管理员终端未启用"}
          </span>
        )}
        {elevated && <span className="danger-chip">断开即终止</span>}
      </div>
      {elevated && platform === "windows" && showCredentialForm ? (
        <form className="terminal-credentials" onSubmit={submitCredentials}>
          <div>
            <strong>验证 Windows 管理员</strong>
            <p>凭据直接加密传给目标主机，提交后立即从表单清除</p>
          </div>
          <label>
            <span>管理员账户</span>
            <input
              value={adminUsername}
              onChange={(event) => setAdminUsername(event.target.value)}
              placeholder="DOMAIN\\user"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              autoComplete="off"
            />
          </label>
          {credentialError && (
            <p className="credential-error">{credentialError}</p>
          )}
          <button
            type="submit"
            disabled={!adminUsername.trim() || !adminPassword}
          >
            打开一次性管理员终端
          </button>
        </form>
      ) : (
        <div ref={container} className="terminal-surface" />
      )}
    </section>
  );
}
