import { fetchSyncPost } from "siyuan";
import type { BrowserController } from "@/browser/BrowserController";
import type { EditorTargetTracker } from "@/notes/EditorTargetTracker";
import { buildTimestampUrl } from "@/utils/url";
import { formatLinkText, type LinkTextSettings } from "@/settings/LinkTextSettings";
import { cleanTitle } from "@/notes/TimestampService";

export interface InsertClipResult {
    ok: boolean;
    assetPath: string;
    blockId: string | null;
    bvid: string;
    page: number;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
    byteLength: number;
    mime: string;
    mode: string;
    hasAudio: boolean;
    width: number;
    height: number;
    targetTitle: string;
}

/**
 * Record a real clip of N seconds from the active video, upload it to local
 * SiYuan assets and insert a playable <video> block after the cached caret.
 */
export class ClipService {
    constructor(
        private readonly browser: BrowserController,
        private readonly tracker: EditorTargetTracker,
        private readonly linkText: LinkTextSettings,
    ) {}

    async insertAtLastTarget(seconds: number): Promise<InsertClipResult> {
        const target = this.tracker.validate(this.tracker.getLastTarget());
        if (!target) throw new Error("未找到有效的思源编辑目标：请先在笔记中点击需要插入片段的位置。");
        if (!target.blockID) throw new Error("当前编辑目标没有可用的块定位点。");
        const source = await this.browser.getSource();
        if (!source) throw new Error("当前页面没有可用视频，无法录制片段。");
        const snapshot = await this.browser.getSnapshot();
        const startSeconds = Math.floor(Number(snapshot.currentTime) || 0);

        const clip = await this.browser.captureClip(seconds);
        const sourceKey = source.bvid ? `${source.bvid}-p${source.page}` : "url";
        const fileName = `svn-clip-${sourceKey}-${startSeconds}-${clip.duration}s-${Date.now()}.webm`;
        const assetPath = await this.uploadClip(clip.base64, clip.mime, fileName);
        const sourceUrl = buildTimestampUrl(source, startSeconds);
        const title = cleanTitle(source.title || snapshot.title || source.bvid || source.canonicalUrl);
        const label = formatLinkText(this.linkText.get(), {
            target: "clip",
            seconds: startSeconds,
            title,
            filename: title,
            provider: "bilibili",
            bvid: source.bvid,
            page: source.page,
            durationSeconds: Number(snapshot.duration) || clip.duration,
        });
        const html = `<video controls src="${assetPath}"></video>\n\n[${label}](${sourceUrl})`;
        const inserted = await fetchSyncPost("/api/block/insertBlock", {
            dataType: "markdown",
            data: html,
            previousID: target.blockID,
        });
        if (!inserted || inserted.code !== 0) {
            await this.cleanupAsset(assetPath);
            throw new Error("插入片段块失败：" + (inserted?.msg || "unknown"));
        }
        const blockId = extractInsertedBlockId(inserted);
        if (!blockId) throw new Error("片段已插入，但无法取得块 ID（资产：" + assetPath + "）");
        const endSeconds = startSeconds + clip.duration;
        const attrResponse = await fetchSyncPost("/api/attr/setBlockAttrs", {
            id: blockId,
            attrs: {
                "custom-svn-type": "clip",
                "custom-svn-provider": source.provider,
                "custom-svn-bvid": source.bvid || "",
                "custom-svn-page": String(source.page || 0),
                "custom-svn-clip-start": String(startSeconds),
                "custom-svn-clip-end": String(endSeconds),
                "custom-svn-duration": String(clip.duration),
                "custom-svn-url": sourceUrl,
                "custom-svn-asset": assetPath,
            },
        });
        if (!attrResponse || attrResponse.code !== 0) {
            throw new Error("片段已插入但来源属性写入失败：" + (attrResponse?.msg || "unknown"));
        }
        return {
            ok: true,
            assetPath,
            blockId,
            bvid: source.bvid || "",
            page: source.page || 0,
            startSeconds,
            endSeconds,
            durationSeconds: clip.duration,
            byteLength: clip.byteLength,
            mime: clip.mime,
            mode: clip.mode,
            hasAudio: clip.hasAudio,
            width: clip.width,
            height: clip.height,
            targetTitle: target.title,
        };
    }

    private async uploadClip(base64: string, mime: string, fileName: string): Promise<string> {
        const token = (window as any).siyuan?.config?.api?.token;
        if (!token) throw new Error("无法取得思源 API Token，资产上传不可用。");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime || "video/webm" });
        const form = new FormData();
        form.append("assetsDirPath", "/assets/");
        form.append("file[]", blob, fileName);
        const response = await fetch("/api/asset/upload", {
            method: "POST",
            headers: { Authorization: "Token " + token },
            body: form,
        });
        const text = await response.text();
        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch {
            /* ignore */
        }
        if (!response.ok || !json || json.code !== 0) {
            throw new Error("片段资产上传失败：" + (json?.msg || text.slice(0, 200)));
        }
        const succMap = json.data?.succMap || {};
        const path = Object.values(succMap)[0] as string | undefined;
        if (!path) throw new Error("片段资产上传返回中没有 succMap 路径。");
        return path;
    }

    private async cleanupAsset(assetPath: string): Promise<void> {
        try {
            await fetchSyncPost("/api/file/removeFile", { path: assetPath });
        } catch {
            /* best effort */
        }
    }
}

function extractInsertedBlockId(response: any): string | null {
    const data = response?.data;
    if (Array.isArray(data)) {
        for (const item of data) {
            const ops = item?.doOperations;
            if (Array.isArray(ops) && ops.length && ops[0]?.id) return String(ops[0].id);
        }
    }
    return null;
}
