import type { Plugin } from "siyuan";

export interface MediaKBSettingsData {
    rootDir: string;
    pythonPath: string;
    envPath: string;
    outputDir: string;
    vaultDir: string;
    transcriptNotebook: string;
    llmNotebook: string;
    conceptNotebook: string;
    topicNotebook: string;
    indexNotebook: string;
    expandMultipart: boolean;
    expandCollection: boolean;
    force: boolean;
    skipDuplicates: boolean;
    importFrontmatter: boolean;
    timestampLinks: boolean;
    indexEnabled: boolean;
    useSiyuanAI: boolean;
}

export const MEDIAKB_STORAGE_KEY = "svn-mediakb-config";

export function defaultMediaKBSettings(): MediaKBSettingsData {
    return {
        rootDir: "",
        pythonPath: "",
        envPath: "",
        outputDir: "",
        vaultDir: "",
        transcriptNotebook: "",
        llmNotebook: "",
        conceptNotebook: "",
        topicNotebook: "",
        indexNotebook: "",
        expandMultipart: true,
        expandCollection: true,
        force: false,
        skipDuplicates: true,
        importFrontmatter: true,
        timestampLinks: true,
        indexEnabled: true,
        useSiyuanAI: true,
    };
}

function nodeRequire(name: string): any {
    const requireFn = (globalThis as any).require || (window as any).require;
    return requireFn(name);
}

export class MediaKBSettings {
    private data = defaultMediaKBSettings();
    private readonly plugin: Plugin;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    async load(): Promise<void> {
        try {
            const saved = await this.plugin.loadData(MEDIAKB_STORAGE_KEY);
            if (saved && typeof saved === "object") this.data = { ...this.data, ...saved };
        } catch {
            /* defaults */
        }
        this.derivePaths();
    }

    get(): MediaKBSettingsData {
        return { ...this.data };
    }

    async save(patch: Partial<MediaKBSettingsData>): Promise<void> {
        this.data = { ...this.data, ...patch };
        this.derivePaths();
        await this.plugin.saveData(MEDIAKB_STORAGE_KEY, this.data);
    }

    isConfigured(): boolean {
        return Boolean(
            this.data.rootDir &&
                this.data.pythonPath &&
                this.data.transcriptNotebook &&
                this.data.llmNotebook &&
                this.data.conceptNotebook,
        );
    }

    getVaultDir(): string {
        if (this.data.vaultDir) return this.data.vaultDir;
        try {
            const fs = nodeRequire("fs");
            if (!this.data.envPath || !fs.existsSync(this.data.envPath)) return "";
            const text = fs.readFileSync(this.data.envPath, "utf8") as string;
            const match = text.match(/^\s*KB_VAULT_DIR\s*=\s*(.+?)\s*$/m);
            return match ? match[1].replace(/^["']|["']$/g, "").trim() : "";
        } catch {
            return "";
        }
    }

    /**
     * Plugin jobs write KB output into a staging vault inside the MediaKB
     * project. The final notes still go to SiYuan notebooks; this avoids
     * failures when the user's Obsidian vault is read-only/locked.
     */
    getJobVaultDir(): string {
        try {
            const path = nodeRequire("path");
            const fs = nodeRequire("fs");
            const dir = path.join(this.data.rootDir || ".", "data", "mediakb-vault");
            const structure = [
                "00_Inbox",
                "01_RawTranscripts",
                "02_Cards",
                "03_Concepts",
                "04_Topics",
                "05_Index",
                "06_Questions",
                "07_Outputs",
                "08_LintReports",
                "99_System",
                "attachments",
            ];
            for (const name of structure) fs.mkdirSync(path.join(dir, name), { recursive: true });
            return dir;
        } catch {
            return this.getVaultDir();
        }
    }

    detect(): { ok: boolean; lines: string[] } {
        const fs = nodeRequire("fs");
        const path = nodeRequire("path");
        const lines: string[] = [];
        const check = (label: string, target: string, wantDir = false): void => {
            if (!target) {
                lines.push(`✗ ${label}：未填写`);
                return;
            }
            try {
                const exists = wantDir ? fs.existsSync(target) && fs.statSync(target).isDirectory() : fs.existsSync(target);
                lines.push(`${exists ? "✓" : "✗"} ${label}：${target}`);
            } catch {
                lines.push(`✗ ${label}：${target}`);
            }
        };
        check("MediaKB 根目录", this.data.rootDir, true);
        check("Python", this.data.pythonPath);
        check(".env", this.data.envPath);
        check("转写输出目录", this.data.outputDir, true);
        const vault = this.getVaultDir();
        check("Vault 目录（外部）", vault, true);
        check("Vault 目录（插件工作）", this.getJobVaultDir(), true);
        if (vault) {
            check("Vault 来源卡片", path.join(vault, "02_Cards"), true);
            check("Vault 概念页面", path.join(vault, "03_Concepts"), true);
        }
        const required = [this.data.transcriptNotebook, this.data.llmNotebook, this.data.conceptNotebook];
        lines.push(`${required.every(Boolean) ? "✓" : "✗"} 目标笔记本：${required.every(Boolean) ? "已选择" : "未选全"}`);
        return { ok: !lines.some((line) => line.startsWith("✗")), lines };
    }

    private derivePaths(): void {
        const path = nodeRequire("path");
        if (this.data.rootDir) {
            if (!this.data.pythonPath) {
                const win = path.join(this.data.rootDir, ".venv312", "Scripts", "python.exe");
                const unix = path.join(this.data.rootDir, ".venv312", "bin", "python");
                const fs = nodeRequire("fs");
                this.data.pythonPath = fs.existsSync(win) ? win : unix;
            }
            if (!this.data.envPath) this.data.envPath = path.join(this.data.rootDir, ".env");
            if (!this.data.outputDir) this.data.outputDir = path.join(this.data.rootDir, "data", "output", "md");
        }
        if (!this.data.vaultDir) this.data.vaultDir = this.getVaultDir();
    }
}
