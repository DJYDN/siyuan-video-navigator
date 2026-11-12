import { Dialog, showMessage } from "siyuan";
import type { MediaKBSettings } from "@/mediaKB/MediaKBSettings";

export interface MediaKBStartOptions {
    input: string;
    localFile: boolean;
    expandMultipart: boolean;
    force: boolean;
}

function nodeRequire(name: string): any {
    const requireFn = (globalThis as any).require || (window as any).require;
    return requireFn(name);
}

function closeOpenDialogs(): void {
    for (const close of Array.from(document.querySelectorAll(".b3-dialog__close"))) {
        try {
            (close as HTMLElement).click();
        } catch {
            /* ignore */
        }
    }
    // Some SiYuan dialogs keep their scrim after a programmatic close; remove
    // any remaining plugin dialog roots so the new dialog is never covered.
    for (const dialog of Array.from(document.querySelectorAll(".b3-dialog"))) {
        try {
            (dialog as HTMLElement).remove();
        } catch {
            /* ignore */
        }
    }
}

/** URL/local-file dialog for running a MediaKB archive job. */
export class MediaKBDialog {
    private dialog: Dialog | null = null;
    private readonly settings: MediaKBSettings;
    private readonly onStart: (options: MediaKBStartOptions) => void;

    constructor(settings: MediaKBSettings, onStart: (options: MediaKBStartOptions) => void) {
        this.settings = settings;
        this.onStart = onStart;
    }

    open(): void {
        closeOpenDialogs();
        if (!this.settings.isConfigured()) {
            showMessage("请先在插件设置中配置 MediaKB 路径和三个目标笔记本", 5000, "error");
            return;
        }
        if (!this.settings.isConfigured()) {
            showMessage("请先在插件设置中配置 MediaKB 路径和三个目标笔记本", 5000, "error");
            return;
        }
        const config = this.settings.get();
        const content = `
            <div style="display:flex;flex-direction:column;gap:10px;padding:16px 22px;box-sizing:border-box;width:100%;min-height:0;flex:1;">
                <label style="font-size:12px;opacity:.8;">视频链接 / 本地文件路径</label>
                <textarea class="b3-text-field" data-role="input" rows="3"
                    placeholder="https://www.bilibili.com/video/BV...  或  D:\\\\video\\\\demo.mp4"
                    style="box-sizing:border-box;width:100%;min-height:86px;max-height:150px;resize:vertical;"></textarea>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                    <button class="b3-button b3-button--outline" data-role="pick">选择本地文件</button>
                    <label style="display:flex;align-items:center;gap:4px;font-size:12px;">
                        <input type="checkbox" data-role="multipart" ${config.expandMultipart ? "checked" : ""}> 展开 B 站分 P
                    </label>
                    <label style="display:flex;align-items:center;gap:4px;font-size:12px;">
                        <input type="checkbox" data-role="force" ${config.force ? "checked" : ""}> 强制重新转写
                    </label>
                </div>
                <div data-role="status" style="font-size:12px;opacity:.85;">开始后自动转入后台，可通过状态按钮查看日志。</div>
                <div style="display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:auto;">
                    <button class="b3-button b3-button--text" data-role="close">关闭</button>
                    <button class="b3-button b3-button--outline" data-role="start">开始归档</button>
                </div>
            </div>`;
        this.dialog = new Dialog({
            title: "MediaKB 归档",
            content,
            width: "720px",
            height: "330px",
            destroyCallback: () => {
                this.dialog = null;
            },
        });
        const root = this.dialog.element;
        const input = root.querySelector('[data-role="input"]') as HTMLTextAreaElement;
        const pick = root.querySelector('[data-role="pick"]') as HTMLButtonElement;
        const multipart = root.querySelector('[data-role="multipart"]') as HTMLInputElement;
        const force = root.querySelector('[data-role="force"]') as HTMLInputElement;
        const status = root.querySelector('[data-role="status"]') as HTMLElement;
        const start = root.querySelector('[data-role="start"]') as HTMLButtonElement;
        const close = root.querySelector('[data-role="close"]') as HTMLButtonElement;
        let localFile = false;

        pick.addEventListener("click", async () => {
            try {
                const remote = nodeRequire("@electron/remote");
                const result = await remote.dialog.showOpenDialog({
                    properties: ["openFile"],
                    filters: [{ name: "音视频", extensions: ["mp4", "mkv", "mov", "webm", "mp3", "wav", "m4a", "flac"] }],
                });
                const file = result?.canceled ? "" : result?.filePaths?.[0] || "";
                if (file) {
                    input.value = file;
                    localFile = true;
                    status.textContent = "已选择本地文件";
                }
            } catch (error) {
                showMessage(`文件选择失败：${String((error as any)?.message || error)}`, 4000, "error");
            }
        });
        input.addEventListener("input", () => {
            localFile = /^[A-Za-z]:[\\/]|^\//.test(input.value.trim());
        });
        start.addEventListener("click", () => {
            const value = input.value.trim();
            if (!value) {
                showMessage("请输入视频链接或选择本地文件", 3000);
                return;
            }
            this.onStart({
                input: value,
                localFile,
                expandMultipart: multipart.checked,
                force: force.checked,
            });
            this.dialog?.destroy();
            showMessage("MediaKB 已转入后台运行，可点击右下角任务状态查看日志", 4000);
        });
        close.addEventListener("click", () => this.dialog?.destroy());
        window.setTimeout(() => input.focus(), 80);
    }
}
