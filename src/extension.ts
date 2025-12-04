import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const MAX_DIFF_CHARS = 60_000;
const MAX_RULE_CHARS = 12_000;

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

const readRulesContent = async (workspacePath: string, configuredPath: string): Promise<TextChunk> => {
    const normalizedPath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(workspacePath, configuredPath);

    try {
        const data = await fs.readFile(normalizedPath, 'utf8');
        return limitText(data.trim(), MAX_RULE_CHARS);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法读取审查规则文件（${configuredPath}）：${message}`);
    }
};

export function activate(context: vscode.ExtensionContext) {
    const reviewer = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        if (request.command && request.command !== 'review') {
            stream.markdown('请使用 `/review` 命令来触发自动代码审查。');
            return;
        }

        if (!request.command) {
            stream.markdown('请发送 `@CodeReview /review` 来触发自动代码审查。');
            return;
        }

        const workspace = resolveWorkspaceFolder();
        if (!workspace) {
            stream.markdown('请先在 VS Code 中打开一个 Git 仓库再运行审查。');
            return;
        }

        const config = vscode.workspace.getConfiguration('codeReviewer');
        const rulesFile = (config.get<string>('rulesFile') || '').trim();

        let diffChunk: TextChunk;
        try {
            diffChunk = await loadGitDiff(workspace.uri.fsPath);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stream.markdown(message);
            return;
        }

        if (!diffChunk.text) {
            stream.markdown('未检测到最近一次提交的差异，请确认有新的更改后再试。');
            return;
        }

        let rulesChunk: TextChunk | undefined;
        if (rulesFile) {
            try {
                rulesChunk = await readRulesContent(workspace.uri.fsPath, rulesFile);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                stream.markdown(message);
                return;
            }
        }

        const sections: string[] = [
            '你是一名资深且严谨的代码审查专家，需要针对最新一次提交给出结构化 JSON 反馈。',
            '请审查最新一次 Git 提交（`git diff HEAD~1`）并以 JSON 返回审查结果。',
            'Diff 如下：',
            '```diff',
            diffChunk.text,
            '```'
        ];

        if (diffChunk.truncated) {
            sections.push(`（Diff 仅包含前 ${MAX_DIFF_CHARS} 个字符）`);
        }

        if (rulesChunk) {
            sections.push(`审查规则（来自 ${rulesFile}）：`, '```', rulesChunk.text, '```');
            if (rulesChunk.truncated) {
                sections.push(`（规则内容仅截取前 ${MAX_RULE_CHARS} 个字符）`);
            }
        }

        sections.push(
            '输出格式：',
            '```json',
            '{',
            '  "comments": {',
            '    "<file path>": [',
            '      { "line": "<line context>", "message": "[<Severity>] <description>" }',
            '    ]',
            '  }',
            '}',
            '```',
            '没有问题时请返回 `{"comments": {}}`，重点关注潜在缺陷、风险及遗漏的测试。'
        );

        const messages = [vscode.LanguageModelChatMessage.User(sections.join('\n\n'))];

        const options: vscode.LanguageModelChatRequestOptions = {
            justification: '需要访问仓库上下文以进行全面的代码审查'
        };

        try {
            const response = await request.model.sendRequest(messages, options, token);
            for await (const fragment of response.text) {
                stream.markdown(fragment);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stream.markdown(`无法完成审查：${message}`);
        }
    };

    const participant = vscode.chat.createChatParticipant('CodeReview', reviewer);
    context.subscriptions.push(participant);
}

export function deactivate() {}
