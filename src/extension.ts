import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const log = (...args: unknown[]) => console.log('[CodeReview]', ...args);
const MAX_DIFF_CHARS = 60_000;
const MAX_CHECKLIST_CHARS = 20_000;
const CPP_FILE_EXTENSIONS = ['.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'];
const CPP_REVIEW_GUIDELINES = `# Role: C++ Code Reviewer

## Profile
- Author: C++ Expert
- Version: 1.0
- Language: English
- Description: A meticulous C++ code reviewer specialized in identifying potential risks, design considerations, and promoting modern C++ best practices for high-performance computing environments.

## Skills
- Deep understanding of C++ memory management mechanisms including manual allocation, RAII, and smart pointers
- Expert knowledge in multithreaded programming and concurrent data structures
- Proficiency in modern C++ standards (C++17/20/23) and their safety features
- Strong analytical abilities to identify potential runtime issues in complex codebases
- Clear communication skills to explain technical issues and recommend improvements
- Experience with performance optimization techniques for C++ applications

## Goals:
- Thoroughly analyze provided C++ code for memory safety vulnerabilities
- Identify potential thread safety issues in multithreaded environments
- Detect design flaws related to context management, especially in single-threaded callback scenarios
- Detect incorrect or ineffective control logic
- Evaluate code against modern C++ best practices and design patterns
- Provide detailed, structured feedback on identified issues with clear explanations
- Suggest specific improvements to enhance code safety, performance, and maintainability

## Issue Severity Levels
- **Critical**: Code that may cause crashes, memory corruption, security vulnerabilities, or undefined behavior. Must be fixed immediately.
- **Major**: Code that may lead to performance degradation, thread-safety issues, or maintainability concerns. Should be addressed before merging.
- **Minor**: Style issues, non-critical optimizations, or improvements that can be deferred.

## Rules:
- Focus analysis specifically on memory safety, thread safety, control logic, design flaw and modern C++ best practices
- The **Solution** for each issue MUST align with the defined **Remediation Strategy**.
- Provide **concrete examples** and explanations rather than vague criticisms. Ensure all comments are precise and well-supported.
- Maintain a professional, technical tone throughout the review.
- Below **Memory Safety** issues MUST be flagged as **Critical** severity:
  - Any cases that could lead to memory corruption, crashes or exceptions (e.g., buffer overflows, invalid memory access, use-after-free, double free, memory leaks, dangling pointers or references, etc.)
  - Any implicit assumptions that could lead to undefined behavior or unsafe access patterns
- **Do NOT** flag ordering dependencies in constructors or setup functions like \`setUp\`, even if calls must happen in sequence. Assume correctness unless there is evidence of race conditions or external non-determinism.
- **DO NOT** recommend synchronization (e.g., mutex or atomic) for variable access in clearly single-threaded contexts where race conditions are impossible.
- Avoid speculative assumptions about the multithreading or concurrency execution context **unless** there is concrete evidence in the code or documentation (e.g. [multithreaded] tagged).
- Base all **Thread Safety** analysis on concrete, observable evidence — speculative or hypothetical concerns are **NOT Allowed**.
- All **Queue** objects (e.g., \`SyncTaskQueue\`, \`MessageQueue\` etc.) are **thread-safe** by design, and their internal state is **always consistent** when accessed through their public APIs.
- If a member variable is initialized during construction (e.g., via constructor body or initializer list), **Do NOT** comment on potential null pointer dereference or validity checks when that variable is used later, unless there is evidence of reassignment or lifetime mismatch. Assume the constructor guarantees its validity.

## Review Workflow:
1. Carefully analyze the given C++ code. Break it into logical segments (or by provided functions), and for each part:
2. Document your thought process in a detailed, stream-of-consciousness style.
3. Examine the code for **Memory Safety** issues. Specifically, identify:
4. Analyze the code for **Thread Safety** concerns. In particular, identify and explain:
5. Merge all valid review comments into a consolidated output.
6. Organize findings into a structured review following the specified format, clearly separating the thinking process from the formal review.
7. Provide specific, actionable recommendations for each identified issue, explaining both the problem and potential solutions.
8. For each comments, please mark it as [Critical],[Major],[Minor] at the begining of the comment message.

## Remediation Strategy
- Propose hierarchical fixes: immediate mitigation → proper resolution → ideal implementation
- Include complete Before/After code examples using standard C++ idioms
- Explain solution rationale with references to language features or design patterns
- Ensure that all potential side effects of the proposed changes are thoroughly considered and explicitly addressed
- For complex issues (e.g., related to Design of Context Management), provide a clear, complete, working solution
- Prioritize issues by severity within their category and focus on concrete, actionable recommendations`;

interface TextChunk {
    text: string;
    truncated: boolean;
}

const limitText = (input: string, limit: number): TextChunk => {
    if (input.length <= limit) {
        return { text: input, truncated: false };
    }
    return { text: input.slice(0, limit), truncated: true };
};

const resolveWorkspaceFolder = (): vscode.WorkspaceFolder | undefined => {
    const [workspace] = vscode.workspace.workspaceFolders ?? [];
    return workspace;
};

const loadChecklistFiles = async (workspacePath: string, files: string[]) => {
    const checklists: { label: string; content: TextChunk }[] = [];

    for (const rawPath of files) {
        const filePath = rawPath?.trim();
        if (!filePath) continue;

        const resolved = path.isAbsolute(filePath)
            ? filePath
            : path.join(workspacePath, filePath);

        try {
            const content = await fs.readFile(resolved, 'utf8');
            checklists.push({
                label: filePath,
                content: limitText(content, MAX_CHECKLIST_CHARS)
            });
        } catch (error) {
            log('检查清单文件读取失败', { filePath, error });
        }
    }

    return checklists;
};

const loadGitDiff = async (cwd: string): Promise<TextChunk> => {
    try {
        const { stdout } = await execAsync('git diff HEAD~1', {
            cwd,
            maxBuffer: 10 * 1024 * 1024
        });
        const diff = stdout.trim();
        if (!diff) {
            return { text: '', truncated: false };
        }
        return limitText(diff, MAX_DIFF_CHARS);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法获取 Git diff：${message}`);
    }
};

const diffContainsCppChanges = (diffText: string): boolean => {
    const matches = diffText.match(/^\+\+\+ b\/(.+)$/gm);
    if (!matches) {
        return false;
    }

    for (const line of matches) {
        const filePath = line.replace(/^\+\+\+ b\//, '').split('\t')[0];
        if (filePath === '/dev/null') {
            continue;
        }
        if (CPP_FILE_EXTENSIONS.some(ext => filePath.endsWith(ext))) {
            return true;
        }
    }
    return false;
};

export function activate(context: vscode.ExtensionContext) {
    const reviewer = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        const promptText = request.prompt ?? '';

        log('收到聊天请求', {
            command: request.command,
            prompt: promptText,
            hasHistory: chatContext.history.length > 0
        });

        const workspace = resolveWorkspaceFolder();
        if (!workspace) {
            stream.markdown('请先在 VS Code 中打开一个 Git 仓库再运行审查。');
            log('未找到 workspace folder');
            return;
        }

        const configuration = vscode.workspace.getConfiguration('codeReviewer');
        const checklistFiles = configuration.get<string[]>('checklistFiles') ?? [];

        let diffChunk: TextChunk;
        try {
            diffChunk = await loadGitDiff(workspace.uri.fsPath);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stream.markdown(message);
            log('git diff 获取失败', message);
            return;
        }

        if (!diffChunk.text) {
            stream.markdown('未检测到最近一次提交的差异，请确认有新的更改后再试。');
            log('git diff 为空');
            return;
        }

        const checklistChunks = checklistFiles.length
            ? await loadChecklistFiles(workspace.uri.fsPath, checklistFiles)
            : [];

        const sections: string[] = [
            '你是一名资深且严谨的代码审查专家，需要针对最新一次提交给出结构化 JSON 反馈。',
            '请审查最新一次 Git 提交（`git diff HEAD~1`）并以 JSON 返回审查结果。'
        ];

        if (diffContainsCppChanges(diffChunk.text)) {
            sections.push(
                '若 Diff 中包含 C++ 文件，请默认遵循以下审查标准：',
                CPP_REVIEW_GUIDELINES
            );
        }

        sections.push('Diff 如下：', '```diff', diffChunk.text, '```');

        if (checklistChunks.length) {
            sections.push('以下是需要优先关注的审查检查清单：');
            for (const item of checklistChunks) {
                sections.push(
                    `文件 ${item.label}：`,
                    '```markdown',
                    item.content.text,
                    '```'
                );
                if (item.content.truncated) {
                    sections.push('（检查清单内容已截断，超出部分未包含）');
                }
            }
        }

        if (diffChunk.truncated) {
            sections.push(`（Diff 仅包含前 ${MAX_DIFF_CHARS} 个字符）`);
        }

        sections.push(
            '输出格式：HTML（使用 <table> 列出 file/line/severity/message；line 为实际代码行号的整数；severity 独立字段，取值 ERROR/WARN/INFO，不要在 message 再带 [ERROR] 这类前缀）。',
            '示例：',
            '```html',
            '<table>',
            '  <tr><th>file</th><th>line</th><th>severity</th><th>message</th></tr>',
            '  <tr><td>src/foo.ts</td><td>42</td><td>ERROR</td><td>描述...</td></tr>',
            '</table>',
            '```',
            '没有问题时请返回一个简单的 HTML 段落，如 `<p>No issues found</p>`，并继续重点关注潜在缺陷、风险及遗漏的测试。'
        );

        const messages = [vscode.LanguageModelChatMessage.User(sections.join('\n\n'))];

        const options: vscode.LanguageModelChatRequestOptions = {
            justification: '需要访问仓库上下文以进行全面的代码审查'
        };

        try {
            const response = await request.model.sendRequest(messages, options, token);
            log('已发送请求至模型');
            let htmlContent = '';
            for await (const fragment of response.text) {
                htmlContent += fragment;
            }

            const fileName = `code-review-report-${Date.now()}.html`;
            const filePath = path.join(workspace.uri.fsPath, fileName);

            try {
                await fs.writeFile(filePath, htmlContent, 'utf8');
                stream.markdown(`审查完成，报告已保存：\`${filePath}\``);
                log('模型返回完成，已写入文件', filePath);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                stream.markdown(`审查生成成功，但保存文件失败：${message}`);
                log('写入报告失败', { filePath, message });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stream.markdown(`无法完成审查：${message}`);
            log('模型请求失败', message);
        }
    };

    const participant = vscode.chat.createChatParticipant('CodeReview', reviewer);
    context.subscriptions.push(participant);
}

export function deactivate() {}
