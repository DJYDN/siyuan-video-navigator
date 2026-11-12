import { MediaKBImporter, type MediaKBImportResult } from "@/mediaKB/MediaKBImporter";
import type { MediaKBSettings } from "@/mediaKB/MediaKBSettings";
import { SiYuanAIProxy } from "@/mediaKB/SiYuanAIProxy";

export interface MediaKBRunOptions {
    input: string;
    localFile: boolean;
    expandMultipart: boolean;
    expandCollection: boolean;
    force: boolean;
    onLog: (line: string) => void;
}

export interface MediaKBRunResult {
    importResult: MediaKBImportResult;
    log: string[];
}

function nodeRequire(name: string): any {
    const requireFn = (globalThis as any).require || (window as any).require;
    return requireFn(name);
}

export class MediaKBRunner {
    private child: any = null;
    private cancelled = false;
    private running = false;
    private readonly importer: MediaKBImporter;

    constructor(plugin: any) {
        this.importer = new MediaKBImporter(plugin);
    }

    isRunning(): boolean {
        return this.running;
    }

    cancel(): void {
        this.cancelled = true;
        if (!this.child) return;
        try {
            if (process.platform === "win32" && this.child.pid) {
                // MediaKB uses a ProcessPoolExecutor. Killing only the parent
                // leaves ASR workers alive and they continue eating CPU.
                const { spawn } = nodeRequire("child_process");
                spawn("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true });
            } else {
                this.child.kill();
            }
        } catch {
            try {
                this.child.kill();
            } catch {
                /* ignore */
            }
        }
    }

    async run(options: MediaKBRunOptions, settings: MediaKBSettings): Promise<MediaKBRunResult> {
        if (this.running) throw new Error("已有 MediaKB 任务正在运行");
        const config = settings.get();
        if (!settings.isConfigured()) throw new Error("请先在插件设置中完成 MediaKB 路径和笔记本配置");
        const fs = nodeRequire("fs");
        if (!config.rootDir || !fs.existsSync(config.rootDir)) throw new Error("MediaKB 根目录不存在");
        if (!config.pythonPath || !fs.existsSync(config.pythonPath)) throw new Error("Python 路径不存在");
        if (!options.input.trim()) throw new Error("链接或文件路径为空");

        this.running = true;
        this.cancelled = false;
        const log: string[] = [];
        const pushLog = (line: string): void => {
            const text = String(line || "").replace(/\r$/, "");
            if (!text.trim()) return;
            log.push(text);
            if (log.length > 400) log.shift();
            options.onLog(text);
        };
        const startedAt = Date.now();
        const jobVault = settings.getJobVaultDir();
        let aiProxy: SiYuanAIProxy | null = null;
        try {
            const extraEnv: Record<string, string> = {
                KB_VAULT_DIR: jobVault,
                // Use the local faster-whisper model instead of the ONNX
                // Paraformer path, which was hanging on long CPU chunks.
                SVN_ASR_ENGINE: "whisper",
                SVN_WHISPER_MODEL: "tiny",
                SVN_ASR_WORKERS: "8",
            };
            if (config.useSiyuanAI) {
                aiProxy = await SiYuanAIProxy.start();
                extraEnv.KB_LLM_PROVIDER = "openai";
                extraEnv.KB_LLM_API_KEY = "siyuan-ai";
                extraEnv.KB_LLM_BASE_URL = `${aiProxy.getBaseUrl()}/v1`;
                extraEnv.KB_LLM_MODEL = "siyuan-ai";
                pushLog(`LLM：使用思源内置 AI（${aiProxy.getBaseUrl()}）`);
            } else {
                pushLog("LLM：使用 MediaKB .env 配置");
            }
            pushLog(`启动 MediaKB：${options.input}`);
            pushLog(`工作 Vault：${jobVault}`);
            const args = ["-m", "app.main", options.localFile ? "--file" : "--url", options.input];
            if (options.expandMultipart && !options.localFile) args.push("--expand-bili-multipart");
            if (options.force) args.push("--force");
            const code = await this.spawnProcess(config.pythonPath, args, config.rootDir, pushLog, extraEnv);
            if (this.cancelled) throw new Error("任务已取消");
            if (code !== 0) pushLog(`MediaKB 退出码 ${code}，尝试导入已生成内容`);
            // MediaKB already compiles the current source in its own pipeline.
            // Do NOT run --kb-recover here: it scans the whole output directory
            // and will process unrelated historical/Obsidian backlog, which can
            // make a short video appear to run for many minutes.
            pushLog("当前任务处理结束，等待本次卡片落盘…");
            await new Promise((resolve) => window.setTimeout(resolve, 1200));
            pushLog("开始导入思源笔记本…");
            try {
                const importResult = await this.importer.importRecent(startedAt, options.input, settings);
                pushLog(`导入完成：转写 ${importResult.transcripts.length} 篇，LLM ${importResult.cards.length} 篇，概念 ${importResult.concepts.length} 篇`);
                return { importResult, log };
            } catch (error) {
                if (code !== 0) throw new Error(`MediaKB 退出码 ${code}，且没有可导入结果：${String((error as Error)?.message || error)}`);
                throw error;
            }
        } finally {
            this.running = false;
            this.child = null;
            await aiProxy?.close();
        }
    }

    private spawnProcess(
        python: string,
        args: string[],
        cwd: string,
        onLog: (line: string) => void,
        extraEnv: Record<string, string> = {},
    ): Promise<number> {
        return new Promise((resolve, reject) => {
            let child: any;
            try {
                const { spawn } = nodeRequire("child_process");
                child = spawn(python, args, {
                    cwd,
                    windowsHide: true,
                    env: { ...process.env, ...extraEnv, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
                });
            } catch (error) {
                reject(error);
                return;
            }
            this.child = child;
            let stderr = "";
            child.stdout?.setEncoding?.("utf8");
            child.stderr?.setEncoding?.("utf8");
            child.stdout?.on?.("data", (chunk: any) => {
                String(chunk).split(/\r?\n/).forEach(onLog);
            });
            child.stderr?.on?.("data", (chunk: any) => {
                const text = String(chunk);
                stderr += text;
                text.split(/\r?\n/).forEach(onLog);
            });
            child.on?.("error", (error: any) => reject(error));
            child.on?.("close", (code: number | null) => {
                if (this.cancelled) resolve(130);
                else if (code === 0) resolve(0);
                else reject(new Error(`MediaKB 进程失败（${code}）：${stderr.slice(-800)}`));
            });
        });
    }
}
