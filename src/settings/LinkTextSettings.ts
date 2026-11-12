import type { Plugin } from "siyuan";
import { formatTimestamp } from "../utils/time.ts";

export type LinkTextTarget = "timestamp" | "screenshot" | "clip";
export type LinkTextPreset =
    | "time"
    | "time_title"
    | "time_filename"
    | "source_time"
    | "time_bv"
    | "icon_time"
    | "full_title"
    | "custom";

export interface LinkTextConfig {
    preset: LinkTextPreset;
    templates: Record<LinkTextTarget, string>;
    maxChars: number;
    ellipsis: "end" | "middle";
    stripVideoExt: boolean;
    cleanBilibiliTitle: boolean;
    icon: string;
}

export interface LinkTextContext {
    target: LinkTextTarget;
    seconds: number;
    title?: string;
    filename?: string;
    provider?: string;
    bvid?: string;
    page?: number;
    folder?: string;
    durationSeconds?: number;
    date?: string;
}

export const LINK_TEXT_STORAGE_KEY = "svn-link-text-config";

export const LINK_TEXT_PRESETS: Array<{ id: LinkTextPreset; label: string; description: string }> = [
    { id: "time", label: "仅时间", description: "19:17" },
    { id: "time_title", label: "时间 + 截断标题（默认）", description: "19:17 · 让天下没有难写的…" },
    { id: "time_filename", label: "时间 + 文件名", description: "19:17 · 1-Earth Day…" },
    { id: "source_time", label: "来源 + 时间", description: "B站 19:17" },
    { id: "time_bv", label: "时间 + BV/P", description: "19:17 · BV1... P1" },
    { id: "icon_time", label: "图标 + 时间", description: "⏱19:17" },
    { id: "full_title", label: "完整标题", description: "19:17 · 完整标题" },
    { id: "custom", label: "自定义模板", description: "支持 {time}/{title:16}/{provider} 等 Token" },
];

const DEFAULT_TEMPLATES: Record<LinkTextTarget, string> = {
    timestamp: "{time} · {title:16}",
    screenshot: "▶ {time} · {title:16}",
    clip: "▶ {time} · {title:16}",
};

export function defaultLinkTextConfig(): LinkTextConfig {
    return {
        preset: "time_title",
        templates: { ...DEFAULT_TEMPLATES },
        maxChars: 16,
        ellipsis: "end",
        stripVideoExt: true,
        cleanBilibiliTitle: true,
        icon: "⏱",
    };
}

export function presetTemplates(preset: LinkTextPreset): Record<LinkTextTarget, string> {
    const withPrefix = (template: string): Record<LinkTextTarget, string> => ({
        timestamp: template,
        screenshot: `▶ ${template}`,
        clip: `▶ ${template}`,
    });
    switch (preset) {
        case "time":
            return withPrefix("{time}");
        case "time_filename":
            return withPrefix("{time} · {filename_noext:16}");
        case "source_time":
            return withPrefix("{provider} {time}");
        case "time_bv":
            return withPrefix("{time} · {bv} P{p}");
        case "icon_time":
            return withPrefix("{icon}{time}");
        case "full_title":
            return withPrefix("{time} · {title}");
        case "time_title":
        default:
            return { ...DEFAULT_TEMPLATES };
    }
}

/**
 * Pure, testable link-text formatter.
 *
 * Template tokens: {time}, {time_full}, {title}, {title:N}, {filename},
 * {filename_noext}, {filename:N}, {provider}, {bv}, {p}, {folder}, {duration},
 * {date}, {icon}, {type}.
 */
export function formatLinkText(config: LinkTextConfig, context: LinkTextContext): string {
    const template = config.templates[context.target] || DEFAULT_TEMPLATES[context.target];
    const provider = providerLabel(context.provider);
    const rawTitle = config.cleanBilibiliTitle ? cleanBilibiliTitle(context.title || "") : String(context.title || "");
    const rawFilename = String(context.filename || rawTitle || "视频");
    const filename = config.stripVideoExt ? stripVideoExtension(rawFilename) : rawFilename;
    const titleForDisplay = rawTitle || filename || "视频";
    const values: Record<string, string> = {
        time: formatTimestamp(Math.max(0, Math.floor(context.seconds || 0))),
        time_full: formatDuration(Math.max(0, Math.floor(context.seconds || 0))),
        title: titleForDisplay,
        filename: rawFilename,
        filename_noext: filename,
        provider,
        bv: context.bvid || "",
        p: String(context.page || ""),
        folder: context.folder || "",
        duration: context.durationSeconds ? formatDuration(context.durationSeconds) : "",
        date: context.date || new Date().toISOString().slice(0, 10),
        icon: config.icon || "",
        type: targetLabel(context.target),
    };

    let text = template.replace(/\{([a-z_]+)(?::(\d+))?\}/gi, (whole, rawName: string, rawLimit?: string) => {
        const name = rawName.toLowerCase();
        if (!(name in values)) return whole;
        let value = values[name];
        const explicitLimit = rawLimit ? Number(rawLimit) : 0;
        if (name === "title" || name === "filename" || name === "filename_noext" || name === "folder") {
            const limit = explicitLimit > 0 ? explicitLimit : config.maxChars;
            if (limit > 0) value = truncateText(value, limit, config.ellipsis);
        }
        return value;
    });

    text = sanitizeLinkText(text);
    if (!text.trim()) text = formatTimestamp(Math.max(0, Math.floor(context.seconds || 0)));
    return truncateText(text, 80, "end");
}

export function cleanBilibiliTitle(title: string): string {
    return String(title || "")
        .replace(/_哔哩哔哩_bilibili$/, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function stripVideoExtension(filename: string): string {
    return String(filename || "").replace(/\.(mp4|mkv|webm|mov|avi|flv|m4v|ts|m3u8)$/i, "");
}

export function sanitizeLinkText(text: string): string {
    return String(text || "")
        .replace(/\r?\n/g, " ")
        .replace(/\\/g, "＼")
        .replace(/\[/g, "［")
        .replace(/\]/g, "］")
        .replace(/\|/g, "｜")
        .replace(/\s+/g, " ")
        .trim();
}

export function truncateText(text: string, maxChars: number, ellipsis: "end" | "middle" = "end"): string {
    const value = String(text || "");
    if (!maxChars || maxChars <= 0) return value;
    const chars = graphemes(value);
    if (chars.length <= maxChars) return value;
    if (ellipsis === "middle") {
        const keep = Math.max(1, maxChars - 1);
        const head = Math.ceil(keep / 2);
        const tail = Math.floor(keep / 2);
        return chars.slice(0, head).join("") + "…" + chars.slice(chars.length - tail).join("");
    }
    return chars.slice(0, Math.max(0, maxChars - 1)).join("") + "…";
}

function graphemes(text: string): string[] {
    const SegmenterCtor = (Intl as any).Segmenter;
    if (typeof SegmenterCtor === "function") {
        try {
            return Array.from(new SegmenterCtor("zh", { granularity: "grapheme" }).segment(text), (item: any) => item.segment);
        } catch {
            /* fall through */
        }
    }
    return Array.from(text);
}

function formatDuration(seconds: number): string {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    const pad = (number: number) => String(number).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

function providerLabel(provider?: string): string {
    switch (provider) {
        case "bilibili":
            return "B站";
        case "baidu":
            return "百度";
        case "quark":
            return "夸克";
        case "aliyun":
            return "阿里";
        case "url":
            return "网页";
        case "native":
            return "网盘";
        default:
            return provider || "";
    }
}

function targetLabel(target: LinkTextTarget): string {
    if (target === "screenshot") return "截图";
    if (target === "clip") return "片段";
    return "时间戳";
}

/** Loads/saves the link-text configuration through SiYuan plugin data. */
export class LinkTextSettings {
    private config = defaultLinkTextConfig();
    private readonly plugin: Plugin;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    async load(): Promise<void> {
        try {
            const saved = await this.plugin.loadData(LINK_TEXT_STORAGE_KEY);
            if (saved && typeof saved === "object") this.config = normalizeConfig(saved);
        } catch {
            /* default */
        }
    }

    get(): LinkTextConfig {
        return {
            ...this.config,
            templates: { ...this.config.templates },
        };
    }

    async setPreset(preset: LinkTextPreset): Promise<void> {
        this.config.preset = preset;
        if (preset !== "custom") this.config.templates = presetTemplates(preset);
        await this.save();
    }

    async setTemplate(target: LinkTextTarget, template: string): Promise<void> {
        this.config.preset = "custom";
        this.config.templates[target] = template;
        await this.save();
    }

    async update(patch: Partial<Omit<LinkTextConfig, "templates">> & { templates?: Partial<Record<LinkTextTarget, string>> }): Promise<void> {
        if (patch.preset !== undefined) this.config.preset = patch.preset;
        if (patch.maxChars !== undefined) this.config.maxChars = Math.max(0, Math.min(80, Math.floor(patch.maxChars)));
        if (patch.ellipsis !== undefined) this.config.ellipsis = patch.ellipsis;
        if (patch.stripVideoExt !== undefined) this.config.stripVideoExt = patch.stripVideoExt;
        if (patch.cleanBilibiliTitle !== undefined) this.config.cleanBilibiliTitle = patch.cleanBilibiliTitle;
        if (patch.icon !== undefined) this.config.icon = patch.icon;
        if (patch.templates) this.config.templates = { ...this.config.templates, ...patch.templates };
        await this.save();
    }

    async reset(): Promise<void> {
        this.config = defaultLinkTextConfig();
        await this.save();
    }

    private async save(): Promise<void> {
        await this.plugin.saveData(LINK_TEXT_STORAGE_KEY, this.config);
    }
}

function normalizeConfig(raw: any): LinkTextConfig {
    const base = defaultLinkTextConfig();
    const templates = raw.templates && typeof raw.templates === "object" ? raw.templates : {};
    return {
        preset: raw.preset || base.preset,
        templates: {
            timestamp: typeof templates.timestamp === "string" ? templates.timestamp : base.templates.timestamp,
            screenshot: typeof templates.screenshot === "string" ? templates.screenshot : base.templates.screenshot,
            clip: typeof templates.clip === "string" ? templates.clip : base.templates.clip,
        },
        maxChars: Number.isFinite(Number(raw.maxChars)) ? Math.max(0, Math.min(80, Number(raw.maxChars))) : base.maxChars,
        ellipsis: raw.ellipsis === "middle" ? "middle" : "end",
        stripVideoExt: raw.stripVideoExt !== false,
        cleanBilibiliTitle: raw.cleanBilibiliTitle !== false,
        icon: typeof raw.icon === "string" ? raw.icon : base.icon,
    };
}
