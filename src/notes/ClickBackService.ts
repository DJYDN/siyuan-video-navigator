import { showMessage } from "siyuan";
import type { BrowserController } from "@/browser/BrowserController";
import type { ScreenshotIndex } from "@/notes/ScreenshotIndex";
import { buildVideoUrl, parseBilibiliUrl, parseGenericTimestampUrl, type VideoSource } from "@/utils/url";

/**
 * Intercepts clicks on timestamp links and screenshot images inside SiYuan
 * editors and seeks the embedded browser instead of opening the system browser
 * or the default image preview. Supports Bilibili BV links and any HTML5 video
 * page via the generic `#svn-t=seconds` marker.
 */
export class ClickBackService {
    private bound = false;
    private readonly handler = (event: MouseEvent) => this.onClick(event);

    constructor(
        private readonly getBrowser: () => BrowserController,
        private readonly ensureBrowserOpen: () => Promise<BrowserController>,
        private readonly screenshotIndex: ScreenshotIndex,
        private readonly onNativeLink?: (
            provider: string,
            fileId: string,
            name: string,
            seconds: number,
            dirId?: string,
            stack?: Array<{ id: string; name: string }>,
        ) => void,
    ) {}

    bind(): void {
        if (this.bound) return;
        this.bound = true;
        document.addEventListener("click", this.handler, true);
    }

    unbind(): void {
        if (!this.bound) return;
        this.bound = false;
        document.removeEventListener("click", this.handler, true);
    }

    private onClick(event: MouseEvent): void {
        const target = event.target as HTMLElement | null;
        if (!target) return;

        // 1) Screenshot: click the image itself -> seek to its saved source.
        const image = target.closest?.('img, [data-type="img"]') as HTMLElement | null;
        if (image?.closest?.(".protyle-wysiwyg")) {
            const block = image.closest("[data-node-id]") as HTMLElement | null;
            const record = this.screenshotIndex.get(block?.getAttribute("data-node-id"));
            if (record) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                if (record.url.startsWith("svn-native://") && this.onNativeLink) {
                    try {
                        const url = new URL(record.url);
                        const file = url.searchParams.get("file") || "";
                        if (!file) {
                            showMessage("该截图没有可用的网盘文件信息，请重新截取", 4000, "error");
                            return;
                        }
                        let stack: Array<{ id: string; name: string }> | undefined;
                        try {
                            const rawDirs = url.searchParams.get("dirs");
                            if (rawDirs) stack = JSON.parse(rawDirs);
                        } catch {
                            stack = undefined;
                        }
                        this.onNativeLink(
                            url.searchParams.get("provider") || "baidu",
                            file,
                            url.searchParams.get("name") || "网盘视频",
                            Number(url.searchParams.get("t") || 0),
                            url.searchParams.get("dir") || undefined,
                            stack,
                        );
                        return;
                    } catch {
                        /* fall through */
                    }
                }
                const source: VideoSource =
                    record.provider === "bilibili" && record.bvid
                        ? {
                              provider: "bilibili",
                              bvid: record.bvid,
                              page: record.page,
                              canonicalUrl: `https://www.bilibili.com/video/${record.bvid}/?p=${record.page}`,
                          }
                        : { provider: "url", canonicalUrl: record.url };
                void this.seekBack(source, record.timeSeconds);
                return;
            }
        }

        // 2) Timestamp link: SiYuan inline links are <span data-type="a" data-href="…">.
        const anchor = target.closest?.('[data-type="a"], a[href]') as HTMLElement | null;
        if (!anchor) return;
        const inEditor = Boolean(anchor.closest?.(".protyle-wysiwyg"));
        if (!inEditor) return;
        const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
        if (href.startsWith("svn-native://") && this.onNativeLink) {
            try {
                const url = new URL(href);
                const provider = url.searchParams.get("provider") || "baidu";
                const file = url.searchParams.get("file") || "";
                const name = url.searchParams.get("name") || "网盘视频";
                const seconds = Number(url.searchParams.get("t") || 0);
                const dirId = url.searchParams.get("dir") || undefined;
                let stack: Array<{ id: string; name: string }> | undefined;
                try {
                    const rawDirs = url.searchParams.get("dirs");
                    if (rawDirs) stack = JSON.parse(rawDirs);
                } catch {
                    stack = undefined;
                }
                if (file) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    this.onNativeLink(provider, file, name, seconds, dirId, stack);
                    return;
                }
            } catch {
                /* fall through */
            }
        }
        let source: VideoSource | null = null;
        let seconds = 0;
        const bilibili = parseBilibiliUrl(href);
        if (bilibili) {
            source = bilibili;
            seconds = bilibili.timeSeconds ?? 0;
        } else {
            const generic = parseGenericTimestampUrl(href);
            if (generic) {
                source = { provider: "url", canonicalUrl: generic.url };
                seconds = generic.timeSeconds;
            }
        }
        if (!source) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void this.seekBack(source, seconds);
    }

    private async seekBack(source: VideoSource, seconds: number): Promise<void> {
        try {
            let browser = this.getBrowser();
            if (!browser.isAttached()) {
                // Open directly on the target video; do not flash Bilibili home first.
                browser.setPendingInitialUrl(buildVideoUrl(source));
                browser = await this.ensureBrowserOpen();
            }
            const result = await browser.openAndSeek(source, seconds);
            const label = source.provider === "bilibili" ? `${source.bvid} P${source.page}` : "目标网页";
            showMessage(`已回到 ${label} · ${seconds}s（误差 ${result.seekErrorSeconds.toFixed(2)}s）`, 2500);
        } catch (error) {
            showMessage(`回溯失败：${String((error as Error)?.message || error)}`, 5000, "error");
        }
    }
}
