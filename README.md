# Code Reviewer

一个支持个性化指令的 VS Code 插件，可按需调整检查清单、过滤路径并自动使用 AI 审查你的最新 Git 提交，输出 JSON/HTML 双格式的审查结果。

## 功能特点

- **一键审查**：自动审查最新的 Git 提交
- **Diff 可见性**：先列出所有变更文件及排除项，并在系统临时目录写入文件概览 JSON
- **默认检查清单**：未配置 `checklistFiles` 时自动使用内置检查清单
- **JSON 输出**：结构化的审查结果，易于解析
- **AI 驱动**：使用 GitHub Copilot 进行智能代码分析

## 使用方法

在 Copilot Chat 中输入：
```
@CodeReview
```

## 可选配置

- `codeReviewer.checklistFiles`：附加到提示中的检查清单文件列表，支持相对或绝对路径；若留空则会自动应用内置默认清单。
- `codeReviewer.excludePaths`：需要从 `git diff` 中排除的文件或目录路径，支持多个条目；目录会匹配其下的所有文件。

## 输出示例

```json
{
  "comments": {
    "src/index.ts": [
      {
        "line": "+function processData(data) {",
        "message": "[Major] 缺少参数类型注解"
      },
      {
        "line": "+  return data.value;",
        "message": "[Critical] 可能的空指针：data 未检查是否为 undefined"
      }
    ],
    "src/utils.ts": [
      {
        "line": "+const result = await fetch(url);",
        "message": "[Major] 缺少错误处理机制"
      }
    ]
  }
}
```

## 基本实现流程

1. 在 Copilot Chat 输入 `@CodeReview`（可附带额外说明）。
2. 扩展执行 `git diff HEAD~1`，列举 diff 中涉及的所有文件，显示被过滤的路径，同时将 `included/excluded/all` 信息写入临时 JSON（`/tmp/code-review-files-*.json`）。
3. 根据配置决定使用自定义或默认检查清单，并在聊天窗口提示当前使用的清单。
4. 构建提示词（包含 diff、检查清单与输出格式），调用 Copilot 让模型返回 JSON 审查意见。
5. 将模型的流式响应直接输出到聊天窗口，并把最终 HTML 报告写入工作区。

### 实现要点

- 缺少 workspace 或 diff 为空时会友好提示并提前返回。
- 通过 `options.justification` 允许模型访问仓库上下文。
- 捕获 git/模型调用异常并提示用户。

### 项目结构

```
code-reviewer/
├── src/extension.ts       # 核心逻辑，读取 diff 并发送请求
├── dist/extension.js      # 编译产物
├── scripts/               # 打包脚本
├── package.json
├── tsconfig.json
└── README.md
```

## 快速开始

```bash
# 1. 克隆或创建项目
mkdir code-reviewer && cd code-reviewer

# 2. 安装依赖
npm install

# 3. 编译
npm run compile

# 4. 打包
npm run package

# 5. 安装到 VS Code
code --install-extension code-reviewer-0.0.1.vsix

# 6. 测试
# 在任意 git 仓库中提交代码后，打开 Copilot Chat 输入：
# @CodeReview
```

## 调试日志

安装 VSIX 后如果在 Copilot Chat 无法使用 `@CodeReview` 或命令无响应，可通过以下方式查看日志：

- 在 VS Code 中打开 `查看 → 输出`，右上角选择 `Log (Extension Host)`，可以看到扩展激活和注册参与者相关的错误。
- 按 `Ctrl+Shift+P`，输入 `Developer: Toggle Developer Tools` 打开开发者工具，在 Console 面板查看详细报错。

把这些日志分享出来有助于快速定位扩展加载或 MCP 调用问题。

## FAQ

**Q: 为什么输出的是 JSON 格式？**  
A: JSON 易于解析，可以集成到 CI/CD 流程或其他工具中。

**Q: 可以审查未提交的修改吗？**  
A: 当前版本只支持已提交的代码。未提交的修改需要先 commit。

**Q: MCP 是什么？**  
A: Model Context Protocol（模型上下文协议），允许模型在需要时访问仓库相关上下文。

**Q: 为什么要启用 MCP？**  
A: 启用 MCP 可以让模型在需要时访问仓库上下文，并确保处理较大 diff 时具备足够的权限。

**Q: 支持哪些编程语言？**  
A: 支持所有 Git 能 diff 的语言（TypeScript、JavaScript、Python、C++、Java、Go 等）。

## 许可证

MIT License
