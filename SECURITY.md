# 安全策略 / Security Policy

## 1 私密报告

请使用仓库的 [GitHub 私密漏洞报告](https://github.com/AIALRA-0/AIALRA-KIMI/security/advisories/new)

不要在公开 Issue、讨论、截图或日志中提交令牌、密码、私钥、真实会话内容、终端输出、内部地址或绝对路径

报告应只包含复现所需的最小信息：受影响版本、入口、预期行为、实际行为、影响范围和已经采取的临时缓解措施

## 2 支持范围

安全修复面向当前维护的预发布分支和最新发布版本

上游 Kimi Server 协议被标记为实验性，只有 `upstream.lock.json` 固定的版本属于当前兼容范围

部署方负责 Authentik、Cloudflare 或其他边缘、TLS、操作系统、Kimi 账户和私有运维仓库的安全配置

## 3 重点关注问题

- OIDC 绕过、会话固定、CSRF 或 WebSocket 劫持
- 主机身份伪造、授权重放、跨主机数据混淆或撤销失效
- Kimi 内容、OAuth Token、密码、命令、路径或文件正文进入控制平面日志与存储
- 终端越权、提权会话未按时或断线销毁、Windows Broker 访问控制失效
- XSS、恶意前端资源、SRI 或发布签名绕过
- 路径穿越、SSRF、任意 localhost 代理或归档解压逃逸

## 4 English summary

Use [GitHub private vulnerability reporting](https://github.com/AIALRA-0/AIALRA-KIMI/security/advisories/new) and include only the minimum reproducible details

Never post tokens, passwords, private keys, real session content, terminal output, internal addresses, or absolute paths in public issues or screenshots

The current compatibility boundary is the Kimi Code release and protocol hashes pinned in `upstream.lock.json`; operators retain responsibility for identity, edge, TLS, operating-system, account, and private deployment configuration
