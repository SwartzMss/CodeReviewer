# Code Reviewer

一个支持个性化指令的 VS Code 插件，可按需调整检查清单、过滤路径并自动使用 AI 审查你的最新 Git 提交，输出 JSON/HTML 双格式的审查结果。

## 功能特点

- **一键审查**：自动审查最新的 Git 提交
- **Diff 托管**：直接委托 Copilot 运行 `git diff` 与 `git diff --name-only`，扩展负责提供过滤规则与检查清单
- **双阶段对话**：第一轮让模型打印过滤后的 diff，第二轮再基于该输出进行正式审查
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
2. 扩展根据配置准备排除规则与检查清单，并先发起 **第一轮对话**，指示 Copilot 运行 `git diff`/`git diff --name-only`、过滤文件并打印结果。
3. 扩展把第一轮输出回传给模型，发起 **第二轮对话**，指导其依据整理好的 diff 完成代码审查。
4. 将模型的最终响应直接输出到聊天窗口，并把 HTML 报告写入工作区。

### 实现要点

- 缺少 workspace 时会友好提示并提前返回。
- 通过 `options.justification` 允许模型访问仓库上下文。
- 捕获 git/模型调用异常并提示用户。

### 项目结构

```
code-reviewer/
├── src/extension.ts       # 核心逻辑，组织 prompt 并交由模型自行运行 diff
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
