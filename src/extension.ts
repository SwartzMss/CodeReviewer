import * as vscode from 'vscode';

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

        const config = vscode.workspace.getConfiguration('codeReviewer');
        const rulesFile = (config.get<string>('rulesFile') || '').trim();

        let prompt = '请审查最新的 Git 提交，返回 JSON 格式的审查结果。';
        if (rulesFile) {
            prompt += `\n审查规则在 ${rulesFile} 文件中。`;
        }

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
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
