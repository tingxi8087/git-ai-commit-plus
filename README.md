# Git AI Commit Plus

根据 Git 变更，一键生成提交说明。默认中文界面，支持 DeepSeek、自选模型和缓存 Token 用量统计。

## 功能

- **一键生成**：点击源代码管理顶部的闪光图标，结果直接填入提交输入框。
- **暂存优先**：存在暂存变更时只分析暂存版本，否则分析全部变更，包含新文件。
- **生成偏好**：中文 / English，简洁 / 标准 / 详细三挡，默认中文简洁。
- **DeepSeek 模型**：支持 DeepSeek Flash 和 DeepSeek V4 Pro，使用自己的 API Key。
- **完整变更概览**：先覆盖全部文件摘要，再分配详细 diff 预算；附带最近 5 条提交标题参考风格。
- **Token 用量**：按模型累计输入、缓存命中、缓存未命中、未分类输入、输出和合计。
- **输入保护**：支持取消；生成期间新增的手写内容会保留，AI 结果另开预览。

插件只生成提交说明，提交仍由你检查并执行。

## 开始使用

要求 VS Code 1.95+、已安装 Git，并启用内置 Git 扩展。请先保存代码并信任工作区。

1. 在扩展市场搜索 **Git AI Commit Plus**，确认发布者为 **tingxi8087**。
2. 打开 Git 仓库，点击底部状态栏的 **AI Commit**；也可运行命令 **Git AI Commit: 打开配置**。
3. 在「配置」中选择模型，填写 DeepSeek API Key，点击「保存」。可点击「测试」检查连接。
4. 打开「源代码管理」，点击顶部闪光图标生成说明。
5. 检查生成结果，再使用 VS Code 原有提交按钮提交。

生成成功后会替换输入框原有说明；失败时保留原文。生成中可点击停止图标取消。

## 界面

### 配置

![紧凑的中文配置界面](https://raw.githubusercontent.com/tingxi8087/git-ai-commit-plus/main/docs/images/config.png)

### 用量

![按模型显示输入、缓存命中、未命中、输出和合计](https://raw.githubusercontent.com/tingxi8087/git-ai-commit-plus/main/docs/images/usage.png)

截图为界面示例，用量数据为演示数据。

## 密钥与代码数据

- API Key 使用 VS Code `SecretStorage` 保存，不写入 `settings.json`。
- 生成会将选定变更、文件路径状态摘要和最近提交标题发送至 **DeepSeek 官方 API**。DeepSeek API 用量可能产生费用，由你的 DeepSeek 账户承担。
- 默认排除常见密钥文件、二进制、锁文件和构建目录的正文，并做基础脱敏。过滤无法识别所有秘密，请确认代码适合发送。
- Token 记录仅保存在本机扩展存储中，包含生成和连接测试，依据 API 实报用量累计。缺失缓存明细的输入归为「未分类」，未返回用量的请求不估算 Token。它不是账户账单，升级前的调用无法补记。

大变更的摘要与详细 diff 合计约 60,000 字符，详细 diff 会按预算缩减。过滤和缩减信息可在 **输出 → Git AI Commit** 查看。

## 命令

| 命令 | 用途 |
| --- | --- |
| Git AI Commit: 生成提交说明 | 分析当前仓库变更并填入说明 |
| Git AI Commit: 打开配置 | 配置来源、模型、密钥、语言和详细程度，查看用量 |
| Git AI Commit: 停止生成提交说明 | 取消正在进行的生成 |

## 支持与开发

[问题反馈](https://github.com/tingxi8087/git-ai-commit-plus/issues) · [源代码](https://github.com/tingxi8087/git-ai-commit-plus) · [开发与实现](https://github.com/tingxi8087/git-ai-commit-plus/blob/main/docs/DEVELOPMENT.md)

本插件免费开源，使用 MIT 许可证。DeepSeek API 费用另计。
