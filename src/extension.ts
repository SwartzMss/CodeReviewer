import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const log = (...args: unknown[]) => console.log('[CodeReview]', ...args);
const MAX_DIFF_CHARS = 60_000;
const MAX_CHECKLIST_CHARS = 20_000;

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
            '请审查最新一次 Git 提交（`git diff HEAD~1`）并以 JSON 返回审查结果。',
            'Diff 如下：',
            '```diff',
            diffChunk.text,
            '```'
        ];

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
