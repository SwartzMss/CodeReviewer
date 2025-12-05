import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
const log = (...args: unknown[]) => console.log('[CodeReview]', ...args);
const MAX_CHECKLIST_CHARS = 20_000;
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

const DEFAULT_CHECKLIST = `# 默认检查清单

- [ ] 关键业务路径是否包含充分的单元或集成测试？
- [ ] 是否存在潜在的空指针 / 异常未处理？
- [ ] 重要配置或边界条件是否有防御性校验？
- [ ] 异常或日志信息是否足够诊断问题？
- [ ] 是否有潜在的性能或并发隐患需要进一步评估？
`;

const limitText = (input: string, limit: number): { text: string; truncated: boolean } => {
    if (input.length <= limit) {
        return { text: input, truncated: false };
    }
    return { text: input.slice(0, limit), truncated: true };
};

const normalizeRelativePath = (workspacePath: string, inputPath: string): string | undefined => {
    const trimmed = inputPath?.trim();
    if (!trimmed) {
        return undefined;
    }

    const relative = path.isAbsolute(trimmed)
        ? path.relative(workspacePath, trimmed)
        : trimmed.replace(/^\.\/+/, '');

    const normalized = relative
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

    return normalized || undefined;
};

const buildExclusionList = (workspacePath: string, paths: string[]): string[] => {
    return Array.from(
        new Set(
            paths
                .map(item => normalizeRelativePath(workspacePath, item))
                .filter((item): item is string => Boolean(item))
        )
    );
};

const resolveWorkspaceFolder = (): vscode.WorkspaceFolder | undefined => {
    const [workspace] = vscode.workspace.workspaceFolders ?? [];
    return workspace;
};

const loadChecklistFiles = async (workspacePath: string, files: string[]) => {
    const checklists: { label: string; content: { text: string; truncated: boolean } }[] = [];

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
        const excludePaths = configuration.get<string[]>('excludePaths') ?? [];
        const exclusionPatterns = buildExclusionList(workspace.uri.fsPath, excludePaths);
        if (exclusionPatterns.length) {
            log('已加载 diff 排除规则', exclusionPatterns);
        }

        let checklistChunks: { label: string; content: { text: string; truncated: boolean } }[] = [];
        if (checklistFiles.length) {
            const checklistSummary = [
                '将加载以下检查清单：',
                ...checklistFiles.map(file => `- ${file}`)
            ].join('\n');
            stream.markdown(checklistSummary);
            checklistChunks = await loadChecklistFiles(workspace.uri.fsPath, checklistFiles);
        } else {
            stream.markdown('未配置检查清单，已加载默认检查清单。');
            checklistChunks = [
                {
                    label: '默认检查清单',
                    content: limitText(DEFAULT_CHECKLIST, MAX_CHECKLIST_CHARS)
                }
            ];
        }

        const preparationSections: string[] = [
            '你是一名资深的仓库助手，负责准备最新一次提交的 diff 上下文。',
            '请严格按照以下步骤操作，不要提前给出审查意见：',
            '1. 在仓库根目录运行：',
            '```sh',
            'git diff HEAD~1',
            'git diff --name-only HEAD~1',
            '```',
            '2. 若任一命令无输出或仅返回空白，直接回复 `<p>No changes detected</p>` 并停止。',
            '3. 若命令成功返回，请根据排除规则过滤文件，只保留允许的 diff 内容，然后总结输出。'
        ];

        if (exclusionPatterns.length) {
            preparationSections.push(
                '当前排除模式（相对工作区根目录）：',
                '```json',
                JSON.stringify(exclusionPatterns, null, 2),
                '```',
                '命中这些模式的文件必须完全忽略。'
            );
        } else {
            preparationSections.push('当前无额外排除模式，可覆盖所有文件。');
        }

        preparationSections.push(
            '### 输出要求',
            '- 首先列出总文件数、被排除文件数以及最终保留的文件列表；',
            '- 接着给出一个 ` ```diff ` 代码块，包含过滤后的完整 diff；',
            '- 如有必要，可附上额外说明或统计信息，但禁止进入正式代码审查。'
        );

        const preparationMessages = [
            vscode.LanguageModelChatMessage.User(preparationSections.join('\n\n'))
        ];

        const options: vscode.LanguageModelChatRequestOptions = {
            justification: '需要访问仓库上下文以提取 diff' // first phase
        };

        let preparedDiff = '';
        try {
            const response = await request.model.sendRequest(preparationMessages, options, token);
            log('已请求模型准备 diff');
            for await (const fragment of response.text) {
                preparedDiff += fragment;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stream.markdown(`无法准备 diff：${message}`);
            log('模型准备 diff 失败', message);
            return;
        }

        const trimmedPrepared = preparedDiff.trim();
        if (!trimmedPrepared) {
            stream.markdown('模型未返回任何 diff 内容，终止审查。');
            log('模型 diff 输出为空');
            return;
        }

        stream.markdown('Diff 上下文已由模型整理，输出如下：');
        stream.markdown(trimmedPrepared);
        log('模型准备的 diff 内容：', trimmedPrepared);

        if (trimmedPrepared.includes('<p>No changes detected</p>')) {
            log('模型判定无更改，审查结束');
            return;
        }

        stream.markdown('将上述 diff 交给模型进行正式审查。');

        const reviewSections: string[] = [
            '你是一名资深且严谨的代码审查专家，需要针对最新一次提交给出结构化 JSON 反馈。',
            '请基于下面已经整理好的 diff 内容进行审查，无需再次运行命令。'
        ];

        reviewSections.push('以下为准备好的 diff：', trimmedPrepared);

        if (checklistChunks.length) {
            reviewSections.push('以下是需要优先关注的审查检查清单：');
            for (const item of checklistChunks) {
                reviewSections.push(
                    `文件 ${item.label}：`,
                    '```markdown',
                    item.content.text,
                    '```'
                );
                if (item.content.truncated) {
                    reviewSections.push('（检查清单内容已截断，超出部分未包含）');
                }
            }
        }

        reviewSections.push(
            '若 diff 中包含 C++ 文件（扩展名 .cc/.cpp/.cxx/.h/.hh/.hpp/.hxx），请遵循以下额外审查准则：',
            CPP_REVIEW_GUIDELINES
        );

        reviewSections.push(
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

        const reviewMessages = [
            vscode.LanguageModelChatMessage.User(reviewSections.join('\n\n'))
        ];

        const reviewOptions: vscode.LanguageModelChatRequestOptions = {
            justification: '需要访问整理后的 diff 以完成审查'
        };

        try {
            const response = await request.model.sendRequest(reviewMessages, reviewOptions, token);
            log('已发送审查请求至模型');
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
