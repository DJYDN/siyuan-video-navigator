/**
 * Aliyun signed CDN URLs require a Referer header that cannot be set by a
 * plain <video> element. Inject it at the Electron session layer so Chromium's
 * native network stack handles Range/redirects/HTTP2; also add CORS headers so
 * screenshots can read the decoded frame.
 *
 * Only Aliyun CDN hosts are touched; Bilibili/Quark are unaffected.
 */
export class AliyunSessionInjector {
    private session: any = null;
    private installed = false;
    private referer = "https://www.aliyundrive.com/";

    isInstalled(): boolean {
        return this.installed;
    }

    setReferer(referer: string): void {
        this.referer = referer;
    }

    async install(): Promise<void> {
        if (this.installed) return;
        const requireFn = (globalThis as any).require || (window as any).require;
        const remote = requireFn("@electron/remote");
        const webContents =
            remote?.getCurrentWebContents?.() ||
            remote?.webContents?.getFocusedWebContents?.() ||
            remote?.webContents?.getAllWebContents?.().find((item: any) => item.getType?.() === "window");
        if (!webContents?.session?.webRequest) throw new Error("无法访问 Electron 网络会话，阿里云盘播放不可用");
        this.session = webContents.session;
        const filter = {
            urls: [
                "*://*.aliyundrive.cloud/*",
                "*://*.aliyundrive.net/*",
                "*://*.aliyundrive.com/*",
                "*://*.alipan.com/*",
            ],
        };
        this.session.webRequest.onBeforeSendHeaders(filter, (details: any, callback: any) => {
            const headers = details.requestHeaders || {};
            headers.Referer = this.referer;
            headers["User-Agent"] =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
            callback({ requestHeaders: headers });
        });
        this.session.webRequest.onHeadersReceived(filter, (details: any, callback: any) => {
            const headers = details.responseHeaders || {};
            headers["Access-Control-Allow-Origin"] = ["*"];
            headers["Access-Control-Allow-Headers"] = ["*"];
            callback({ responseHeaders: headers });
        });
        this.installed = true;
    }

    dispose(): void {
        if (!this.session) return;
        try {
            this.session.webRequest.onBeforeSendHeaders(null);
            this.session.webRequest.onHeadersReceived(null);
        } catch {
            /* ignore */
        }
        this.session = null;
        this.installed = false;
    }
}
