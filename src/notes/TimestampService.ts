import { fetchSyncPost, type Protyle } from "siyuan";
import type { BrowserController } from "@/browser/BrowserController";
import type { EditorTargetTracker, EditorTarget } from "@/notes/EditorTargetTracker";
import { formatTimestamp } from "@/utils/time";
import { buildTimestampUrl } from "@/utils/url";
import { formatLinkText, type LinkTextSettings } from "@/settings/LinkTextSettings";

export interface InsertTimestampResult {
    ok: boolean;
    method: "protyle.insert" | "block.insertBlock";
    html: string;
    displayTime: string;
    bvid: string;
    page: number;
    timeSeconds: number;
    target: { rootID: string; blockID: string | null; title: string };
    error?: string;
}

/**
 * Snapshot the active video + the last explicit editor target, then insert an
 * inline timestamp link at that cached caret. Nothing is inserted if either
 * side is ambiguous/absent.
 */
export class TimestampService {
    constructor(
        private readonly browser: BrowserController,
        private readonly tracker: EditorTargetTracker,
        private readonly linkText: LinkTextSettings,
    ) {}

    async insertAtLastTarget(): Promise<InsertTimestampResult> {
        const target = this.tracker.validate(this.tracker.getLastTarget());
        if (!target) {
            throw new Error("未找到有效的思源编辑目标：请先在笔记中点击需要插入的位置，再回到视频按快捷键。");
        }
        if (!target.range) {
            throw new Error("编辑目标没有可用的光标位置：请在笔记中重新点击定位后再试。");
        }

        const source = await this.browser.getSource();
        if (!source) {
            throw new Error("当前页面没有可用视频，无法生成时间戳。");
        }
        const snapshot = await this.browser.getSnapshot();
        const timeSeconds = Math.floor(Number(snapshot.currentTime) || 0);
        const displayTime = formatTimestamp(timeSeconds);
        const sourceTitle = cleanTitle(source.title || snapshot.title || source.bvid || source.canonicalUrl);
        const url = buildTimestampUrl(source, timeSeconds);
        const text = formatLinkText(this.linkText.get(), {
            target: "timestamp",
            seconds: timeSeconds,
            title: sourceTitle,
            filename: sourceTitle,
            provider: "bilibili",
            bvid: source.bvid,
            page: source.page,
            durationSeconds: Number(snapshot.duration) || 0,
        });
        // SiYuan inline links are `<span data-type="a" data-href="…">text</span>`
        // (verified against a real editor DOM via /api/block/getBlockDOM).
        const html = `<span data-type="a" data-href="${escapeAttr(url)}">${escapeHtml(text)}</span>`;

        try {
            target.protyle.insert(html, false, true);
            return {
                ok: true,
                method: "protyle.insert",
                html,
                displayTime,
                bvid: source.bvid || "",
                page: source.page || 0,
                timeSeconds,
                target: { rootID: target.rootID, blockID: target.blockID, title: target.title },
            };
        } catch (error) {
            const fallback = await this.insertViaKernel(target, `[${text}](${url})`);
            if (!fallback) throw error;
            return {
                ok: true,
                method: "block.insertBlock",
                html,
                displayTime,
                bvid: source.bvid || "",
                page: source.page || 0,
                timeSeconds,
                target: { rootID: target.rootID, blockID: target.blockID, title: target.title },
            };
        }
    }

    private async insertViaKernel(target: EditorTarget, markdown: string): Promise<boolean> {
        if (!target.blockID) return false;
        const response = await fetchSyncPost("/api/block/insertBlock", {
            dataType: "markdown",
            data: markdown,
            previousID: target.blockID,
        });
        return Boolean(response && response.code === 0);
    }
}

export function cleanTitle(title: string): string {
    return String(title || "")
        .replace(/_哔哩哔哩_bilibili$/, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 1)) + "…";
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeAttr(text: string): string {
    return escapeHtml(text);
}

export type { Protyle };
