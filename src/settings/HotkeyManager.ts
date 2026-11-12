import { showMessage, type Plugin } from "siyuan";

export type HotkeyAction =
    | "timestamp"
    | "screenshot"
    | "clip"
    | "playPause"
    | "rewind"
    | "forward"
    | "openBrowser"
    | "openNetdisk"
    | "mediaKb";

export interface HotkeyConfig {
    timestamp: string;
    screenshot: string;
    clip: string;
    playPause: string;
    rewind: string;
    forward: string;
    openBrowser: string;
    openNetdisk: string;
    mediaKb: string;
    clipSeconds: number;
    hideToolbar: boolean;
}

export const CLIP_DURATION_OPTIONS = [3, 5, 10, 15, 30];

export const ACTION_LABELS: Record<HotkeyAction, { title: string; description: string }> = {
    timestamp: { title: "插入当前视频时间戳", description: "光标定位后按下，插入当前播放时间。" },
    screenshot: { title: "插入当前视频截图", description: "截取当前真实视频帧并插入笔记。" },
    clip: { title: "截取当前视频片段", description: "按设置中的片段时长录制并插入可播放片段。" },
    playPause: { title: "播放 / 暂停", description: "控制当前视频播放或暂停。" },
    rewind: { title: "快退 3 秒", description: "短按退 3 秒；长按（系统按键重复）持续后退。" },
    forward: { title: "快进 3 秒", description: "短按进 3 秒；长按（系统按键重复）持续前进。" },
    openBrowser: { title: "打开视频浏览器", description: "打开 B 站/网页视频浏览页签。" },
    openNetdisk: { title: "打开网盘", description: "打开设置中的 OpenList/AList 地址。" },
    mediaKb: { title: "MediaKB 归档", description: "打开链接输入框，自动转写并导入 MediaKB 笔记本。" },
};

interface ModifierEvent {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "CapsLock"]);
const IGNORE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function normalizeKey(key: string): string {
    if (key === " ") return "Space";
    return key.length === 1 ? key.toUpperCase() : key;
}

/** Canonical binding string, e.g. `Ctrl+Alt+T` / `Meta+Alt+S`. */
export function bindingFromEvent(event: ModifierEvent): string | null {
    if (!event.key || MODIFIER_KEYS.has(event.key)) return null;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return null;
    const mods: string[] = [];
    if (event.ctrlKey) mods.push("Ctrl");
    if (event.metaKey) mods.push("Meta");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    return [...mods, normalizeKey(event.key)].join("+");
}

export function defaultHotkeys(): HotkeyConfig {
    const mac = typeof process !== "undefined" && process.platform === "darwin";
    const mod = mac ? "Meta+Alt" : "Ctrl+Alt";
    return {
        timestamp: `${mod}+T`,
        screenshot: `${mod}+S`,
        clip: `${mod}+C`,
        playPause: `${mod}+P`,
        rewind: `${mod}+ArrowLeft`,
        forward: `${mod}+ArrowRight`,
        openBrowser: `${mod}+B`,
        openNetdisk: `${mod}+N`,
        mediaKb: `${mod}+M`,
        clipSeconds: 10,
        hideToolbar: true,
    };
}

/**
 * Plugin-level user-configurable hotkeys and UI settings. Host editor focus is
 * handled with a document keydown listener; webview focus is handled by the
 * guest keydown bridge in BrowserController.
 */
export class HotkeyManager {
    private config: HotkeyConfig = defaultHotkeys();
    private bound = false;
    private readonly onHostKeydown = (event: KeyboardEvent) => this.handleHostEvent(event);
    private recording = false;

    constructor(
        private readonly plugin: Plugin,
        private readonly actions: Record<HotkeyAction, () => void>,
    ) {}

    getConfig(): HotkeyConfig {
        return { ...this.config };
    }

    async load(): Promise<void> {
        try {
            const saved = await this.plugin.loadData("svn-settings");
            if (saved && typeof saved === "object") {
                for (const key of Object.keys(defaultHotkeys()) as Array<keyof HotkeyConfig>) {
                    const value = (saved as any)[key];
                    if (typeof value === "string" && value) (this.config as any)[key] = value;
                }
                if (typeof saved.clipSeconds === "number" && CLIP_DURATION_OPTIONS.includes(saved.clipSeconds)) {
                    this.config.clipSeconds = saved.clipSeconds;
                }
                if (typeof saved.hideToolbar === "boolean") this.config.hideToolbar = saved.hideToolbar;
            }
        } catch (error) {
            console.warn("[siyuan-video-navigator] load settings failed", error);
        }
    }

    async save(): Promise<void> {
        try {
            await this.plugin.saveData("svn-settings", { ...this.config });
        } catch (error) {
            console.warn("[siyuan-video-navigator] save settings failed", error);
        }
    }

    bindHost(): void {
        if (this.bound) return;
        this.bound = true;
        document.addEventListener("keydown", this.onHostKeydown, true);
    }

    unbind(): void {
        if (!this.bound) return;
        this.bound = false;
        document.removeEventListener("keydown", this.onHostKeydown, true);
    }

    setRecording(recording: boolean): void {
        this.recording = recording;
    }

    async setBinding(action: HotkeyAction, binding: string): Promise<void> {
        this.config[action] = binding;
        await this.save();
        showMessage(`快捷键已更新：${ACTION_LABELS[action].title} = ${binding}`, 2500);
    }

    async resetBinding(action: HotkeyAction): Promise<void> {
        await this.setBinding(action, defaultHotkeys()[action]);
    }

    async setClipSeconds(seconds: number): Promise<void> {
        if (!CLIP_DURATION_OPTIONS.includes(seconds)) return;
        this.config.clipSeconds = seconds;
        await this.save();
        showMessage(`片段时长已设为 ${seconds} 秒`, 2500);
    }

    async setHideToolbar(hidden: boolean): Promise<void> {
        this.config.hideToolbar = hidden;
        await this.save();
    }

    /** Called from BrowserController console-message bridge. */
    handleGuestBinding(binding: string | null): void {
        this.dispatch(binding);
    }

    private handleHostEvent(event: KeyboardEvent): void {
        if (this.recording) return;
        const target = event.target as HTMLElement | null;
        if (target && IGNORE_TAGS.has(target.tagName)) return;
        const binding = bindingFromEvent(event);
        if (!binding) return;
        if (this.dispatch(binding)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    }

    private dispatch(binding: string | null): boolean {
        if (!binding) return false;
        for (const [action, value] of Object.entries(this.config) as Array<[HotkeyAction, string]>) {
            if (typeof value !== "string" || value !== binding) continue;
            const callback = this.actions[action];
            if (callback) {
                callback();
                return true;
            }
        }
        return false;
    }
}
