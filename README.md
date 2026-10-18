# Git AI Commit Plus

VS Code 扩展。在源代码管理顶部点击 ✦，使用 DeepSeek 根据当前仓库的 Git 变更生成提交说明，填入原有提交输入框。

## 安装与使用

要求 VS Code 1.95+，本机已安装 Git，启用内置 Git 扩展，并信任工作区。

1. 在扩展面板的「… → 从 VSIX 安装」选择 `releases/v0.3.1/git-ai-commit-plus-0.3.1.vsix`。
2. 打开 Git 仓库，点击 VS Code 底部状态栏的 **AI Commit** 打开配置；也可在命令面板运行 **Git AI Commit: 打开配置**。
3. 在「配置」Tab 选择来源和模型，输入 API Key，选择生成偏好后点击「保存」。点击「测试」可验证当前选中模型，连接测试也计入用量。
4. 在源代码管理顶部点击闪光图标，或运行 **Git AI Commit: 生成提交说明**。
5. 检查输入框中的结果，再使用 VS Code 原有按钮提交。

仅生成说明，不会自动暂存、提交或推送。点击生成图标后直接分析并填入结果，无首次发送、内容过滤、截断或覆盖确认弹窗。已有提交文字在生成成功后替换；如果你在等待期间编辑了输入框，则保留你的文字，并自动把 AI 结果打开为独立预览。失败时保留已有文字。生成中可点击顶部停止图标取消；完成与取消使用状态栏轻提示，错误才显示通知。

## 默认行为

- 配置界面：中文，紧凑的「配置 / 用量」Tab，跟随 VS Code 主题。
- 模型：DeepSeek Flash（默认）或 DeepSeek V4 Pro，使用非思考模式生成提交说明。
- 提交语言：简体中文；也可选择 English。
- 详细程度：**简洁**。仅 Conventional Commit 标题；标准包含关键变更列表，详细按需分组说明变更与可确认的影响。
- 范围：**优先暂存，否则全部变更**。存在暂存变更时只发送暂存版本，不会混入同一文件的未暂存修改。无暂存时读取工作区全部变更，包括未跟踪文件。
- 支持首次提交、多仓库选择、重命名、删除和取消生成。存在未解决冲突时停止生成。
- 最近提交：附带当前仓库最近 5 条提交标题，最多每条 200 字符，仅参考格式和风格；生成语言仍以设置为准。首次提交无历史时正常工作，不读取历史提交正文或作者信息。
- 全部变更模式读取 Git 看到的磁盘内容；请先保存编辑器中的修改。

生成偏好保存在当前工作区的 `.vscode/settings.json`；没有工作区时保存在用户设置。也可在 VS Code 设置中修改 `gitAiCommit.provider`、`gitAiCommit.model`、`gitAiCommit.language`、`gitAiCommit.detail` 和 `gitAiCommit.scope`。

## 密钥与代码数据

密钥保存在 VS Code `SecretStorage`，不写入配置文件，不回传到配置页面。留空保存保留已有密钥，也可清除或替换。首版仅连接 DeepSeek 官方 API `https://api.deepseek.com/chat/completions`，可选择 `deepseek-flash` 或 `deepseek-v4-pro`。

生成需要将选定的代码变更、全部文件的路径状态摘要和最近提交标题发送至 DeepSeek。配置页保留此说明，点击生成不再二次确认。连接测试只发送固定测试文本。默认排除 `.env*`、常见凭据文件、私钥、证书、二进制、锁文件和常见构建目录；对常见密钥格式和凭据赋值做基础脱敏。**过滤不能识别所有秘密，请确认发送内容符合自己的代码保密要求。**

大变更采用两阶段上下文分配：

1. 先为所选范围的**全部文件**保留路径、Git 状态及可获得的增删行数摘要。默认排除的文件只列路径、状态和排除标记，不发送正文。
2. 再在剩余额度中为可分析文件分配详细 diff，单文件最多约 20,000 字符；前面的巨大文件不会耗尽后续文件的份额。没有用完的份额留给后面的文件。

摘要与详细 diff 合计不超过约 60,000 字符，不再限制为前 100 个文件。普通新文件大于 256 KB 时只保留新增状态与大小摘要；超大 tracked diff 按分配额度流式读取后停止，不会先加载完整 diff。只有摘要的文件不推断具体代码行为。若全部文件摘要本身已超过上下文上限，会明确报错要求缩小提交范围，避免静默遗漏文件。

过滤、缩减情况记录在「输出 → Git AI Commit」，正常生成不弹确认框。若暂存内容全部被排除，不会改用未暂存内容。Git 状态与统计命令输出上限为 4 MB，单次命令超时为 15 秒。

API 请求超时为 60 秒，连接测试为 20 秒。错误提示不显示服务端响应原文或 API Key。

## Token 用量

「用量」Tab 按来源和所选模型累计本插件的调用：输入、缓存命中、缓存未命中、未分类输入、输出和合计。统计保存在 VS Code 的扩展全局存储目录 `usage-v1.json`，跨工作区保留；多窗口写入会合并。配置页打开时随本窗口请求更新，也可手动刷新其他窗口产生的记录。

用量来自 API 返回的 `usage`，包括生成与连接测试。缓存命中与未命中是输入的组成部分，不额外加入合计；输出字段已经包含推理 Token（若服务返回），不重复相加。缺少缓存明细的输入计入「未分类」；缺少完整 usage 的响应只累计调用和「未上报」次数，不估算 Token。未收到 usage 的失败、取消或超时请求无法计入 Token，这不是账户账单。升级前的历史调用无法补记。

当前模型与字段参考：[DeepSeek 官方 API 文档](https://api-docs.deepseek.com/api/create-chat-completion/)。

## 本地开发

```sh
npm ci
npm test
npm run package
```

安装包统一输出到 `releases/v<版本号>/<插件名>-<版本号>.vsix`，版本号自动读取 `package.json`。例如当前版本为 `releases/v0.3.1/git-ai-commit-plus-0.3.1.vsix`。更新版本后运行 `npm run package`，会创建对应版本目录并保留其他版本的安装包；重复打包同一版本会更新该版本的安装包。

在 VS Code 打开项目后按 F5 启动扩展开发宿主。`npm test` 使用临时 Git 仓库和本地模拟 HTTP 服务，不消耗真实 DeepSeek API 用量。`test/host.ts` 是额外的隔离扩展宿主冒烟测试入口。

实现采用 TypeScript 与 VS Code 原生 Webview，不依赖运行时 UI 框架。尚未发布到扩展市场；当前 publisher 为本地打包标识，正式发布前需绑定自己的 Marketplace publisher。

接口参考：[VS Code 源代码管理](https://code.visualstudio.com/api/extension-guides/scm-provider)、[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。
