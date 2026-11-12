/**
 * OpenAI-compatible bridge from MediaKB's Python LLM client to SiYuan's
 * built-in AI endpoint (`/api/ai/editor/chat`).
 *
 * MediaKB only understands OpenAI-compatible base URLs. This local server
 * accepts /v1/chat/completions, converts messages to a prompt, streams the
 * SiYuan AI response, and returns an OpenAI-shaped completion. The user then
 * only configures the model in SiYuan; no separate API key is needed.
 */
export class SiYuanAIProxy {
    private server: any = null;
    private baseUrl = "";

    static async start(): Promise<SiYuanAIProxy> {
        const proxy = new SiYuanAIProxy();
        await proxy.listen();
        return proxy;
    }

    getBaseUrl(): string {
        return this.baseUrl;
    }

    async close(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve());
        });
        this.server = null;
    }

    private async listen(): Promise<void> {
        const requireFn = (globalThis as any).require || (window as any).require;
        const http = requireFn("http");
        this.server = http.createServer((request: any, response: any) => {
            void this.handle(request, response);
        });
        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = this.server.address();
        this.baseUrl = `http://127.0.0.1:${address.port}`;
    }

    private async handle(request: any, response: any): Promise<void> {
        try {
            if (request.method !== "POST" || !String(request.url || "").startsWith("/v1/chat/completions")) {
                this.send(response, 404, { error: { message: "not found" } });
                return;
            }
            const body = await this.readBody(request);
            const payload = JSON.parse(body || "{}");
            const messages = Array.isArray(payload.messages) ? payload.messages : [];
            const prompt = messages
                .map((message: any) => `${message.role === "system" ? "系统" : message.role === "assistant" ? "助手" : "用户"}：${String(message.content || "")}`)
                .join("\n\n");
            if (!prompt.trim()) throw new Error("空提示词");
            const content = await this.complete(prompt);
            this.send(response, 200, {
                id: `chatcmpl-svn-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: payload.model || "siyuan-ai",
                choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
        } catch (error) {
            this.send(response, 500, { error: { message: String((error as any)?.message || error), type: "siyuan_ai_error" } });
        }
    }

    private async complete(prompt: string): Promise<string> {
        const token = (window as any)?.siyuan?.config?.api?.token || "";
        const kernel = (window as any)?.siyuan?.config?.system?.kernelUrl || "http://127.0.0.1:6806";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Token ${token}`;
        const requestBody = {
            taskID: `svn-mediakb-${Date.now()}`,
            ids: [],
            input: prompt,
            action: "",
            history: [],
        };
        const result = await fetch(`${kernel}/api/ai/editor/chat`, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
        });
        const contentType = result.headers.get("Content-Type") || "";
        if (!result.ok || !contentType.includes("text/event-stream")) {
            let message = `SiYuan AI HTTP ${result.status}`;
            try {
                const json = await result.json();
                message = json?.msg || json?.message || message;
            } catch {
                /* ignore */
            }
            throw new Error(message);
        }
        const text = await result.text();
        let content = "";
        let event = "";
        for (const line of text.split(/\r?\n/)) {
            if (line.startsWith("event:")) {
                event = line.slice(6).trim();
                continue;
            }
            if (event === "content" && line.startsWith("data:")) {
                try {
                    const data = JSON.parse(line.slice(5).trim());
                    content += String(data.token || "");
                } catch {
                    /* ignore malformed event */
                }
            }
            if (event === "error" && line.startsWith("data:")) {
                try {
                    const data = JSON.parse(line.slice(5).trim());
                    throw new Error(String(data.message || "SiYuan AI error"));
                } catch (error) {
                    if (error instanceof Error) throw error;
                }
            }
        }
        if (!content.trim()) throw new Error("思源 AI 没有返回内容，请检查思源 AI 模型是否已配置");
        return content;
    }

    private readBody(request: any): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = "";
            request.on("data", (chunk: any) => {
                body += String(chunk);
                if (body.length > 8 * 1024 * 1024) {
                    reject(new Error("请求体过大"));
                    request.destroy();
                }
            });
            request.on("end", () => resolve(body));
            request.on("error", reject);
        });
    }

    private send(response: any, status: number, data: any): void {
        const text = JSON.stringify(data);
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
        response.end(text);
    }
}
