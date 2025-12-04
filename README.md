# 简易代码审查插件

一个极简的 VS Code 插件，自动使用 AI 审查你的最新 Git 提交，输出 JSON 格式的审查结果。

## 功能特点

- 🚀 **一键审查**：自动审查最新的 Git 提交
- 📝 **JSON 输出**：结构化的审查结果，易于解析
- 🤖 **AI 驱动**：使用 GitHub Copilot 进行智能代码分析
- ⚡ **灵活配置**：可选配置自定义审查规则文件

## 配置（可选）

在 `.vscode/settings.json` 中添加：

```json
{
  "codeReviewer.rulesFile": ".vscode/my-review-rules.md"
}
```

如果不配置，AI 会使用默认规则进行审查。

## 使用方法

在 Copilot Chat 中输入：
```
@CodeReview /review
```

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

### 1. 架构概览

```
用户触发命令
    ↓
Chat Participant 处理请求
    ↓
构建审查 Prompt (告诉 AI 要审查最新提交)
    ↓
调用 Copilot API (启用 MCP)
    ↓
AI 自动调用 MCP 工具：
  - 执行 git diff
  - 读取审查规则文件
  - 查看相关代码文件
    ↓
解析 JSON 响应
    ↓
显示审查结果
```

**核心思想**：只需告诉 AI "请审查最新提交"，AI 会自己调用 MCP 工具去获取 diff、读取规则文件、查看相关代码。你的代码只需要 ~50 行。

### 2. 核心实现步骤

#### 步骤 1：注册 Chat Participant

```typescript
// extension.ts - 入口文件
export function activate(context: vscode.ExtensionContext) {
    const handler = async (request, chatContext, stream, token) => {
        if (request.command === 'review') {
            // 读取用户配置的规则文件路径
            const config = vscode.workspace.getConfiguration('codeReviewer');
            const rulesFile = config.get<string>('rulesFile', '');
            
            // 构建 prompt（如果配置了规则文件，告诉 AI 去读取）
            let prompt = `请审查最新的 Git 提交，返回 JSON 格式的审查结果。`;
            if (rulesFile) {
                prompt += `\n审查规则在 ${rulesFile} 文件中。`;
            }
            
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            
            // 关键：启用 MCP
            const options = {
                justification: '需要访问仓库上下文以进行全面的代码审查'
            };
            
            // 发送请求（AI 会自动调用 MCP 工具）
            const response = await request.model.sendRequest(messages, options, token);
            
            // 显示结果
            for await (const fragment of response.text) {
                stream.markdown(fragment);
            }
        }
    };
    
    const participant = vscode.chat.createChatParticipant('CodeReview', handler);
    context.subscriptions.push(participant);
}
```

**就这么简单！** 完整的核心代码只有 ~25 行。

**关键点：**
- ✅ `options` 中的 `justification` 参数启用了 MCP
- ✅ AI 会自动调用 `git diff HEAD~1`
- ✅ **如果配置了 `rulesFile`，代码只是把路径传递给 AI，AI 会自己去读取文件**
- ✅ AI 会自动返回 JSON 格式的结果

**重要**：你的代码不需要 `fs.readFileSync` 去读取规则文件，只需要把路径告诉 AI，AI 会自己调用 MCP 工具去读。

### 3. 关键：MCP 的作用

MCP（Model Context Protocol）允许 AI 主动调用工具获取信息。

**启用 MCP 后会发生什么：**

```typescript
// 你的代码只需要这样写：
const prompt = `请审查最新的 Git 提交`;
const options = {
    justification: '需要访问仓库上下文以进行全面的代码审查'
};
await request.model.sendRequest(messages, options, token);

// AI 会自动执行：
// 1. 调用 git diff 工具获取 diff
// 2. 调用文件读取工具读取审查规则
// 3. 调用文件搜索工具查看相关代码
// 4. 综合分析所有信息
```

**优势：**
- ✅ **极简代码**：你只需要 ~50 行代码
- ✅ **更智能**：AI 可以根据需要获取额外信息
- ✅ **更灵活**：AI 可以自主决定查看哪些文件
- ✅ **不需要手动执行**：不需要 `execSync`、`fs.readFileSync` 等

**注意事项：**
- ⚠️ 首次使用需要用户授权
- ⚠️ 速度比手动传入慢一些（因为 AI 要调用多个工具）
- ⚠️ Token 消耗会多一些

### 4. package.json 配置

需要在 `package.json` 中声明配置项：

```json
{
  "contributes": {
    "configuration": {
      "title": "Code Reviewer",
      "properties": {
        "codeReviewer.rulesFile": {
          "type": "string",
          "default": "",
          "description": "自定义审查规则文件路径（相对于工作区根目录），留空则使用默认规则"
        }
      }
    }
  }
}
```

### 5. 项目结构

```
code-reviewer/
├── src/
│   ├── extension.ts           # 入口文件，注册命令和 participant
│   └── chatParticipant.ts     # Chat participant 逻辑，核心实现
├── package.json               # 插件配置和依赖（包含 configuration）
├── tsconfig.json              # TypeScript 配置
└── README.md                  # 本文档
```

### 6. 关键 API

| API | 用途 |
|-----|------|
| `vscode.chat.createChatParticipant()` | 创建聊天参与者 |
| `vscode.LanguageModelChatMessage.User()` | 创建用户消息 |
| `request.model.sendRequest()` | 发送请求到 AI 模型（带 justification 启用 MCP） |
| `vscode.workspace.getConfiguration()` | 读取用户配置 |

### 7. 完整工作流程

```
┌────────────────────────┐
│  用户执行 /review      │
└───────────┬────────────┘
            ↓
┌────────────────────────┐
│  读取配置              │
│  rulesFile = config    │  ← 获取用户配置的规则文件路径
└───────────┬────────────┘
            ↓
┌────────────────────────┐
│  构建 prompt           │
│  "请审查最新提交"      │
│  + "规则在 xxx 中"     │  ← 如果配置了，把路径告诉 AI
└───────────┬────────────┘
            ↓
┌────────────────────────┐
│  sendRequest()         │
│  options: {            │
│    justification: ...  │  ← 启用 MCP
│  }                     │
└───────────┬────────────┘
            ↓
┌────────────────────────┐
│  AI 自动调用 MCP 工具  │
│  - git diff HEAD~1     │  ← AI 自己执行
│  - 读取规则文件        │  ← AI 看到路径，自己去读
│  - 查看相关代码        │  ← AI 自己决定
└───────────┬────────────┘
            ↓
┌────────────────────────┐
│  AI 返回 JSON 结果     │
└───────────┬────────────┘
            ↓
┌────────────────────────┐
│  解析并显示结果        │
└────────────────────────┘
```

**核心思想**：
- 你的代码只负责**把配置的路径传递给 AI**
- AI 看到路径后，**自己调用 MCP 工具去读取文件**
- 不需要 `fs.readFileSync`，不需要手动插入文件内容

## 设计理念

- **极简主义**：核心代码只需 ~30 行（包含配置读取）
- **AI 驱动**：让 AI 自己决定如何获取和分析信息
- **灵活配置**：可选配置规则文件，但代码不需要手动读取
- **专注核心**：只做代码审查，不集成 Gerrit 等复杂系统

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
# @CodeReview /review
```

## FAQ

**Q: 为什么输出的是 JSON 格式？**  
A: JSON 易于解析，可以集成到 CI/CD 流程或其他工具中。

**Q: 可以审查未提交的修改吗？**  
A: 当前版本只支持已提交的代码。未提交的修改需要先 commit。

**Q: MCP 是什么？**  
A: Model Context Protocol（模型上下文协议），允许 AI 主动获取额外信息（如搜索文件、查看 Git 历史）。

**Q: 为什么要启用 MCP？**  
A: 启用 MCP 后，AI 可以自己获取 diff、读取规则文件、查看相关代码，你的代码只需要 ~50 行。不启用的话，你需要手动执行这些操作，代码量会增加到 ~150 行。

**Q: 支持哪些编程语言？**  
A: 支持所有 Git 能 diff 的语言（TypeScript、JavaScript、Python、C++、Java、Go 等）。

**Q: 审查规则如何定制？**  
A: 在 `.vscode/settings.json` 中配置 `codeReviewer.rulesFile` 指向你的规则文件，例如：
```json
{
  "codeReviewer.rulesFile": ".vscode/my-rules.md"
}
```
你的代码只需要把这个路径传递给 AI，AI 会自己去读取文件内容。

## 许可证

MIT License
