import { fetchSyncPost } from "siyuan";
import type { BrowserController } from "@/browser/BrowserController";
import type { EditorTargetTracker } from "@/notes/EditorTargetTracker";
import type { ScreenshotIndex } from "@/notes/ScreenshotIndex";
import { buildTimestampUrl } from "@/utils/url";
import { cleanTitle } from "@/notes/TimestampService";
import { formatLinkText, type LinkTextSettings } from "@/settings/LinkTextSettings";

export interface InsertScreenshotResult {
    ok: boolean;
    method: "block.insertBlock";
    assetPath: string;
    blockId: string | null;
    bvid: string;
    page: number;
    timeSeconds: number;
    width: number;
    height: number;
    targetTitle: string;
    error?: string;
}

/**
 * Capture the current video frame, upload it to SiYuan assets, insert an image
 * block after the cached caret block and persist the video source as custom
 * block attributes so clicking the image itself can seek back after restart.
 */
export class ScreenshotService {
    constructor(
        private readonly browser: BrowserController,
        private readonly tracker: EditorTargetTracker,
        private readonly screenshotIndex: ScreenshotIndex,
        private readonly linkText: LinkTextSettings,
    ) {}

    async insertAtLastTarget(): Promise<InsertScreenshotResult> {
        const target = this.tracker.validate(this.tracker.getLastTarget());
        if (!target) throw new Error("未找到有效的思源编辑目标：请先在笔记中点击需要截图插入的位置。");
        if (!target.blockID) throw new Error("当前编辑目标没有可用的块定位点。");

        const source = await this.browser.getSource();
        if (!source) throw new Error("当前页面没有可用视频，无法截图。");
        const snapshot = await this.browser.getSnapshot();
        const timeSeconds = Math.floor(Number(snapshot.currentTime) || 0);
        const frame = await this.browser.captureFrame();
        if (!frame?.dataUrl) throw new Error("截图失败：未拿到视频帧数据。");

        const title = cleanTitle(source.title || snapshot.title || source.bvid || source.canonicalUrl);
        const sourceKey = source.bvid ? `${source.bvid}-p${source.page}` : `url-${Date.now()}`;
        const fileName = `svn-${sourceKey}-${timeSeconds}-${Date.now()}.png`;
        const assetPath = await this.uploadAsset(frame.dataUrl, fileName);
        const url = buildTimestampUrl(source, timeSeconds);
        const alt = formatLinkText(this.linkText.get(), {
            target: "screenshot",
            seconds: timeSeconds,
            title,
            filename: title,
            provider: "bilibili",
            bvid: source.bvid,
            page: source.page,
            durationSeconds: Number(snapshot.duration) || 0,
        });
        const markdown = `![${alt}](${assetPath})`;

        const inserted = await fetchSyncPost("/api/block/insertBlock", {
            dataType: "markdown",
            data: markdown,
            previousID: target.blockID,
        });
        if (!inserted || inserted.code !== 0) {
            await this.cleanupAsset(assetPath);
            throw new Error("插入截图块失败：" + (inserted?.msg || "unknown"));
        }
        const blockId = extractInsertedBlockId(inserted);
        if (!blockId) {
            throw new Error("截图块已插入，但无法取得块 ID，未写入来源属性（图片：" + assetPath + "）");
        }

        const attrs = {
            "custom-svn-type": "screenshot",
            "custom-svn-provider": source.provider,
            "custom-svn-bvid": source.bvid || "",
            "custom-svn-page": String(source.page || 0),
            "custom-svn-time": String(timeSeconds),
            "custom-svn-url": url,
            "custom-svn-asset": assetPath,
        };
        const attrResponse = await fetchSyncPost("/api/attr/setBlockAttrs", { id: blockId, attrs });
        if (!attrResponse || attrResponse.code !== 0) {
            throw new Error("截图已插入但来源属性写入失败：" + (attrResponse?.msg || "unknown"));
        }
        this.screenshotIndex.add({
            blockId,
            provider: source.provider,
            bvid: source.bvid || "",
            page: source.page || 0,
            timeSeconds,
            assetPath,
            url,
        });
        return {
            ok: true,
            method: "block.insertBlock",
            assetPath,
            blockId,
            bvid: source.bvid || "",
            page: source.page || 0,
            timeSeconds,
            width: frame.width,
            height: frame.height,
            targetTitle: target.title,
        };
    }

    private async uploadAsset(dataUrl: string, fileName: string): Promise<string> {
        const token = (window as any).siyuan?.config?.api?.token;
        if (!token) throw new Error("无法取得思源 API Token，资产上传不可用。");
        const base64 = String(dataUrl).split(",")[1] || "";
        const buffer = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
        const blob = new Blob([buffer], { type: "image/png" });
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
            throw new Error("资产上传失败：" + (json?.msg || text.slice(0, 200)));
        }
        const succMap = json.data?.succMap || {};
        const path = Object.values(succMap)[0] as string | undefined;
        if (!path) throw new Error("资产上传返回中没有 succMap 路径。");
        return path;
    }

    private async cleanupAsset(assetPath: string): Promise<void> {
        try {
            await fetchSyncPost("/api/file/removeFile", { path: assetPath });
        } catch {
            /* best effort; caller still reports the failure */
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
