import { Setting, fetchSyncPost, showMessage } from "siyuan";
import type { MediaKBSettings } from "@/mediaKB/MediaKBSettings";

function closeOpenDialogs(): void {
    for (const close of Array.from(document.querySelectorAll(".b3-dialog__close"))) {
        try {
            (close as HTMLElement).click();
        } catch {
            /* ignore */
        }
    }
    for (const dialog of Array.from(document.querySelectorAll(".b3-dialog"))) {
        try {
            (dialog as HTMLElement).remove();
        } catch {
            /* ignore */
        }
    }
}

/**
 * Dedicated MediaKB settings dialog. Kept separate from the main hotkey dialog
 * so the large path/notebook form cannot push the hotkey list out of view.
 */
export class MediaKBSettingsDialog {
    private readonly settings: MediaKBSettings;
    private readonly openInput: () => void;
    private readonly importRecent: () => void;

    constructor(settings: MediaKBSettings, openInput: () => void, importRecent: () => void) {
        this.settings = settings;
        this.openInput = openInput;
        this.importRecent = importRecent;
    }

    open(): void {
        closeOpenDialogs();
        const setting = new Setting({ width: "980px", height: "680px" });
        const config = this.settings.get();

        const pathWrap = document.createElement("div");
        pathWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;width:520px;max-width:100%;";
        const pathRows: Array<{ key: keyof ReturnType<MediaKBSettings["get"]>; label: string; placeholder: string }> = [
            { key: "rootDir", label: "根目录", placeholder: "D:\\...\\OmniVault\\MediaKB" },
            { key: "pythonPath", label: "Python", placeholder: "自动探测 .venv312\\Scripts\\python.exe" },
            { key: "envPath", label: ".env", placeholder: "默认 MediaKB\\.env" },
            { key: "outputDir", label: "转写输出", placeholder: "默认 data\\output\\md" },
            { key: "vaultDir", label: "Vault", placeholder: "默认从 .env 的 KB_VAULT_DIR 读取" },
        ];
        const inputs: Partial<Record<string, HTMLInputElement>> = {};
        for (const rowDef of pathRows) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;";
            const label = document.createElement("span");
            label.textContent = rowDef.label;
            label.style.cssText = "width:64px;flex:none;font-size:12px;opacity:.8;";
            const input = document.createElement("input");
            input.className = "b3-text-field";
            input.style.cssText = "flex:1;min-width:260px;";
            input.placeholder = rowDef.placeholder;
            input.value = String(config[rowDef.key] || "");
            input.addEventListener("change", async () => {
                await this.settings.save({ [rowDef.key]: input.value } as any);
                await this.settings.load();
                const fresh = this.settings.get();
                for (const item of pathRows) {
                    const target = inputs[item.key as string];
                    if (target) target.value = String(fresh[item.key] || "");
                }
            });
            inputs[rowDef.key as string] = input;
            row.append(label, input);
            pathWrap.appendChild(row);
        }

        const detectWrap = document.createElement("div");
        detectWrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
        const detectButton = document.createElement("button");
        detectButton.className = "b3-button b3-button--outline";
        detectButton.textContent = "检测环境";
        const detectStatus = document.createElement("span");
        detectStatus.style.cssText = "font-size:11px;opacity:.8;white-space:pre-line;";
        const inputButton = document.createElement("button");
        inputButton.className = "b3-button b3-button--text";
        inputButton.textContent = "打开链接输入框";
        const importButton = document.createElement("button");
        importButton.className = "b3-button b3-button--text";
        importButton.textContent = "导入最近30分钟结果";
        importButton.title = "不重新转写，直接把最近生成的 MediaKB 文件导入思源";
        detectButton.addEventListener("click", () => {
            const detected = this.settings.detect();
            detectStatus.textContent = detected.lines.join("\n");
            showMessage(detected.ok ? "MediaKB 环境检测通过" : "MediaKB 环境检测发现问题", 4000);
        });
        inputButton.addEventListener("click", () => {
            closeOpenDialogs();
            window.setTimeout(() => this.openInput(), 80);
        });
        importButton.addEventListener("click", () => this.importRecent());
        detectWrap.append(detectButton, inputButton, importButton, detectStatus);

        const notebookWrap = document.createElement("div");
        notebookWrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:520px;max-width:100%;";
        const notebookDefs: Array<{ key: keyof ReturnType<MediaKBSettings["get"]>; label: string }> = [
            { key: "transcriptNotebook", label: "转写稿" },
            { key: "llmNotebook", label: "LLM" },
            { key: "conceptNotebook", label: "概念" },
            { key: "topicNotebook", label: "主题" },
            { key: "indexNotebook", label: "索引（留空=LLM）" },
        ];
        const selects: Partial<Record<string, HTMLSelectElement>> = {};
        for (const item of notebookDefs) {
            const select = document.createElement("select");
            select.className = "b3-select";
            select.style.maxWidth = "180px";
            select.addEventListener("change", async () => {
                await this.settings.save({ [item.key]: select.value } as any);
            });
            selects[item.key as string] = select;
            notebookWrap.appendChild(select);
        }

        const optionsWrap = document.createElement("div");
        optionsWrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:10px;width:100%;font-size:12px;";
        const optionDefs: Array<{ key: keyof ReturnType<MediaKBSettings["get"]>; label: string }> = [
            { key: "expandMultipart", label: "展开分P" },
            { key: "expandCollection", label: "展开合集" },
            { key: "force", label: "强制重跑" },
            { key: "skipDuplicates", label: "跳过重复" },
            { key: "importFrontmatter", label: "导入元信息" },
            { key: "timestampLinks", label: "时间戳链接" },
            { key: "indexEnabled", label: "生成索引" },
            { key: "useSiyuanAI", label: "使用思源内置 AI（推荐）" },
        ];
        for (const optionDef of optionDefs) {
            const label = document.createElement("label");
            label.style.cssText = "display:flex;align-items:center;gap:4px;";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = Boolean(config[optionDef.key]);
            checkbox.addEventListener("change", async () => {
                await this.settings.save({ [optionDef.key]: checkbox.checked } as any);
            });
            label.append(checkbox, document.createTextNode(optionDef.label));
            optionsWrap.appendChild(label);
        }

        setting.addItem({
            title: "MediaKB 配置",
            description: "路径、目标笔记本和归档选项。快捷键默认 Ctrl+Alt+M；检测通过后可直接打开链接输入框。",
            actionElement: (() => {
                const container = document.createElement("div");
                container.style.cssText = "display:flex;flex-direction:column;gap:12px;width:620px;max-width:100%;";
                const heading = (text: string): HTMLElement => {
                    const item = document.createElement("div");
                    item.textContent = text;
                    item.style.cssText = "font-size:12px;font-weight:600;opacity:.8;margin-top:2px;";
                    return item;
                };
                container.append(
                    heading("路径"),
                    pathWrap,
                    detectWrap,
                    heading("目标笔记本"),
                    notebookWrap,
                    heading("归档选项"),
                    optionsWrap,
                );
                return container;
            })(),
        });

        void this.loadNotebooks(notebookDefs, selects, config).catch(() => {
            detectStatus.textContent = "无法读取思源笔记本列表";
        });
        setting.open("siyuan-video-navigator MediaKB");
    }

    private async loadNotebooks(
        defs: Array<{ key: keyof ReturnType<MediaKBSettings["get"]>; label: string }>,
        selects: Partial<Record<string, HTMLSelectElement>>,
        config: ReturnType<MediaKBSettings["get"]>,
    ): Promise<void> {
        const result = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const notebooks = result?.data?.notebooks || [];
        for (const item of defs) {
            const select = selects[item.key as string];
            if (!select) continue;
            const empty = document.createElement("option");
            empty.value = "";
            empty.textContent = item.key === "indexNotebook" ? "索引：留空=LLM" : `${item.label}：未选择`;
            select.appendChild(empty);
            for (const notebook of notebooks) {
                const option = document.createElement("option");
                option.value = notebook.id;
                option.textContent = `${item.label}：${notebook.name}`;
                select.appendChild(option);
            }
            select.value = String(config[item.key] || "");
        }
    }
}
