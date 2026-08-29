# 贡献说明 / Contributing

## 1 开始前

本仓库处理远程代码执行、文件访问、身份和提权终端，修改必须先说明信任边界和失败行为

不要提交真实会话、账户、主机名、域名、路径、终端截图、访问令牌、密钥或生产配置

## 2 本地检查

使用 Node.js 24.15.x、pnpm 10.33.x 和 Rust 1.95.x

```bash
corepack enable # 使用仓库固定的 pnpm 版本
pnpm install --frozen-lockfile # 安装锁定依赖
pnpm check # 检查格式、类型和 TypeScript 测试
pnpm build # 构建控制平面和 Web
pnpm check:rust # 检查格式、Clippy 和 Rust 测试
pnpm test:e2e # 运行桌面与移动 Chromium 流程
```

修改上游适配时还需要执行 `pnpm check:upstream`

修改 README 或界面截图时执行 `pnpm docs:screenshots`，并人工检查亮色、暗色和窄屏像素

## 3 修改边界

- 协议变更先更新 `packages/protocol`，再更新控制平面、代理和 Web
- 新代理操作必须是预定义操作，不得引入任意 localhost HTTP 代理
- 新持久化字段必须说明是否包含内容、是否加密以及离线显示方式
- 权限模式以目标主机返回值为真相源，失败时界面必须回滚
- 提权功能必须保留短时授权、限速、超时和断线销毁
- 合成演示只能使用 `example.invalid`、合成主机和合成工作区

## 4 提交前

确认中英文 README 的版本、命令、状态、图片和限制一致

依赖、Actions 和上游版本必须固定到可核对版本或 commit，不能在生产路径使用浮动最新版

安全问题不要通过普通拉取请求披露，改用 [SECURITY.md](SECURITY.md) 的私密入口

## 5 English summary

Use Node.js 24.15.x, pnpm 10.33.x, and Rust 1.95.x, then run the checks in section 2

Describe trust boundaries and failure behavior for every change, keep agent operations allowlisted, use synthetic fixtures only, and report vulnerabilities privately through [SECURITY.md](SECURITY.md)
