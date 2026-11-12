import { fetchSyncPost } from "siyuan";
import { BilibiliAdapter, type VideoSnapshot, type WebviewLike } from "@/browser/BilibiliAdapter";
import { buildVideoUrl, type VideoSource } from "@/utils/url";

export type BrowserHotkeyAction = "timestamp" | "screenshot";

export interface BrowserState {
    attached: boolean;
    url: string;
    title: string;
    bvid: string | null;
    page: number;
    currentTime: number | null;
    duration: number | null;
    hasVideo: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
    error: string | null;
    zoom: number;
    paused: boolean | null;
    playbackRate: number;
}

type StateListener = (state: BrowserState) => void;

const EMPTY_STATE: BrowserState = {
    attached: false,
    url: "",
    title: "",
    bvid: null,
    page: 1,
    currentTime: null,
    duration: null,
    hasVideo: false,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    error: null,
    zoom: 1,
    paused: null,
    playbackRate: 1,
};

/**
 * Owns the real <webview> instance and the active-page state.
 * Only one browser workspace is supported in Phase 2 (single tab).
 */
export class BrowserController {
    private webview: WebviewLike | null = null;
    private host: HTMLElement | null = null;
    private listeners = new Set<StateListener>();
    private pollTimer: number | null = null;
    private state: BrowserState = { ...EMPTY_STATE };
    private boundHandlers: Array<{ type: string; handler: (event: any) => void }> = [];
    private attachSeq = 0;
    private pendingInitialUrl: string | null = null;
    private zoomFactor = loadStoredZoom();
    private static readonly MIN_ZOOM = 0.5;
    private static readonly MAX_ZOOM = 2.5;
    private static readonly ZOOM_STEP = 0.1;

    /** Set the URL to open right after the browser tab mounts (avoids a home-page flash). */
    setPendingInitialUrl(url: string): void {
        this.pendingInitialUrl = url;
    }

    /** Called when the guest page reports a plugin hotkey via console bridge. */
    onHotkey: ((action: BrowserHotkeyAction) => void) | null = null;
    /** Called with a canonical binding (e.g. `Ctrl+Alt+T`) from the guest. */
    onKeyBinding: ((binding: string) => void) | null = null;
    /** Called once the webview is attached and ready to navigate. */
    onAttached: (() => void) | null = null;

    /** Dev diagnostics: last guest bridge events / install errors. */
    readonly hotkeyEvents: Array<{ at: string; action: BrowserHotkeyAction; raw: string }> = [];
    readonly keyBindings: Array<{ at: string; binding: string; raw: string }> = [];
    readonly keyEvents: string[] = [];
    readonly navigationLog: string[] = [];
    lastBridgeError: string | null = null;

    getState(): BrowserState {
        return this.state;
    }

    isAttached(): boolean {
        return Boolean(this.webview);
    }

    getWebview(): WebviewLike | null {
        return this.webview;
    }

    getWebContentsId(): number | null {
        try {
            return this.webview?.getWebContentsId?.() ?? null;
        } catch {
            return null;
        }
    }

    clearNavigationLog(): void {
        this.navigationLog.length = 0;
    }

    getZoom(): number {
        return this.zoomFactor;
    }

    setZoom(factor: number): void {
        const clamped = Math.min(BrowserController.MAX_ZOOM, Math.max(BrowserController.MIN_ZOOM, Math.round(factor * 10) / 10));
        if (clamped === this.zoomFactor) return;
        this.zoomFactor = clamped;
        this.applyZoom();
        this.setState({ zoom: clamped });
        try {
            window.localStorage.setItem("svn-zoom-factor", String(clamped));
        } catch {
            /* ignore */
        }
    }

    zoomIn(): void {
        this.setZoom(this.zoomFactor + BrowserController.ZOOM_STEP);
    }

    zoomOut(): void {
        this.setZoom(this.zoomFactor - BrowserController.ZOOM_STEP);
    }

    resetZoom(): void {
        this.setZoom(1);
    }

    private adjustZoom(direction: number): void {
        if (!direction) return;
        this.setZoom(this.zoomFactor + (direction > 0 ? BrowserController.ZOOM_STEP : -BrowserController.ZOOM_STEP));
    }

    private applyZoom(): void {
        try {
            (this.webview as any)?.setZoomFactor?.(this.zoomFactor);
        } catch (error) {
            console.warn("[siyuan-video-navigator] setZoomFactor failed", error);
        }
    }
    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }

    async attach(host: HTMLElement): Promise<void> {
        if (this.webview && this.host) return;
        this.host = host;
        const seq = ++this.attachSeq;
        const wv = document.createElement("webview") as WebviewLike;
        wv.className = "svn-browser__webview";
        wv.setAttribute("partition", "persist:siyuan-video-navigator");
        wv.setAttribute("src", "about:blank");
        wv.setAttribute("allowpopups", "false");
        wv.style.width = "100%";
        wv.style.height = "100%";
        wv.style.background = "#000";
        host.appendChild(wv);
        this.webview = wv;
        this.bindEvents(wv);
        await this.waitUntilReady(wv, 15000);
        if (seq !== this.attachSeq) return;
        this.setState({ attached: true, error: null, zoom: this.zoomFactor });
        this.applyZoom();
        // Restore the last page in this workspace when possible, otherwise home.
        // If a click-back requested a concrete URL, go there directly.
        const startUrl =
            this.pendingInitialUrl ||
            (this.state.url && this.state.url !== "about:blank" ? this.state.url : "https://www.bilibili.com/");
        this.pendingInitialUrl = null;
        await this.navigate(startUrl).catch((error) => this.setState({ error: String(error?.message || error) }));
        this.startPolling();
        this.onAttached?.();
    }

    detach(): void {
        this.attachSeq++;
        this.stopPolling();
        if (this.webview) {
            for (const { type, handler } of this.boundHandlers) {
                this.webview.removeEventListener(type, handler as EventListener);
            }
            this.boundHandlers = [];
            this.webview.remove();
        }
        this.webview = null;
        this.host = null;
        this.setState({ attached: false });
    }

    private async waitUntilReady(wv: WebviewLike, timeoutMs: number): Promise<void> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            try {
                await wv.executeJavaScript("1", false);
                return;
            } catch {
                await delay(150);
            }
        }
        throw new Error("webview 未能在超时时间内就绪");
    }

    private bindEvents(wv: WebviewLike): void {
        const on = (type: string, handler: (event: any) => void) => {
            wv.addEventListener(type, handler as EventListener);
            this.boundHandlers.push({ type, handler });
        };
        on("dom-ready", () => {
            void this.installGuestHelpers(wv);
        });
        on("did-finish-load", () => {
            const url = wv.getURL?.() || "";
            this.setState({ url, loading: false });
            void this.installGuestHelpers(wv);
        });
        on("did-fail-load", (event) => {
            if (event.isMainFrame === false) return;
            this.setState({ error: `${event.errorDescription} (${event.errorCode})` });
        });
        on("did-start-loading", () => this.setState({ loading: true }));
        on("did-stop-loading", () => this.setState({ loading: false }));
        on("did-navigate", (event) => {
            this.navigationLog.push(event.url);
            if (this.navigationLog.length > 50) this.navigationLog.shift();
            this.setState({ url: event.url, canGoBack: wv.canGoBack?.() ?? false, canGoForward: wv.canGoForward?.() ?? false });
        });
        on("did-navigate-in-page", (event) => {
            if (event.isMainFrame === false) return;
            this.navigationLog.push(event.url);
            if (this.navigationLog.length > 50) this.navigationLog.shift();
            this.setState({ url: event.url, canGoBack: wv.canGoBack?.() ?? false, canGoForward: wv.canGoForward?.() ?? false });
        });
        on("page-title-updated", (event) => this.setState({ title: event.title || this.state.title }));
        on("console-message", (event) => {
            const message = String(event.message || "");
            if (message.startsWith("[SVN_ZOOM]")) {
                const match = message.match(/delta=(-?\d+)/);
                if (match) this.adjustZoom(Number(match[1]));
                return;
            }
            if (message.startsWith("[SVN_KEY]")) {
                const binding = parseGuestKeyBinding(message);
                if (binding) {
                    this.keyBindings.push({ at: new Date().toISOString(), binding, raw: message });
                    if (this.keyBindings.length > 50) this.keyBindings.shift();
                    this.onKeyBinding?.(binding);
                }
                if ((window as any)?.siyuan?.storage?.["svn-key-debug"]) {
                    this.keyEvents.push(message);
                    if (this.keyEvents.length > 100) this.keyEvents.shift();
                    void fetchSyncPost("/api/storage/setLocalStorageVal", {
                        key: "svn-key-debug-log",
                        val: JSON.stringify({ at: new Date().toISOString(), message }),
                    }).catch(() => undefined);
                }
                return;
            }
            if (!message.includes("[SVN_HOTKEY")) return;
            if (message.includes("[SVN_HOTKEY:timestamp]")) {
                this.hotkeyEvents.push({ at: new Date().toISOString(), action: "timestamp", raw: message });
                this.onHotkey?.("timestamp");
            } else if (message.includes("[SVN_HOTKEY:screenshot]")) {
                this.hotkeyEvents.push({ at: new Date().toISOString(), action: "screenshot", raw: message });
                this.onHotkey?.("screenshot");
            }
        });
    }

    private async installGuestHelpers(wv: WebviewLike): Promise<void> {
        try {
            await BilibiliAdapter.installGuestBridge(wv);
            this.lastBridgeError = null;
            const storage = (window as any)?.siyuan?.storage || {};
            if (storage["svn-key-debug"]) {
                await wv.executeJavaScript(`(() => {
                    if (window.__svnKeyDebugInstalled) return { already: true };
                    window.__svnKeyDebugInstalled = true;
                    window.addEventListener("keydown", (e) => {
                        try {
                            console.log("[SVN_KEY] key=" + e.key + " code=" + e.code + " ctrl=" + e.ctrlKey + " alt=" + e.altKey + " meta=" + e.metaKey + " target=" + (e.target && e.target.tagName));
                        } catch (err) {}
                    }, true);
                    return { installed: true };
                })()`, true);
            }
        } catch (error) {
            this.lastBridgeError = String((error as any)?.message || error);
            console.warn("[siyuan-video-navigator] guest bridge install failed", error);
        }
    }

    private startPolling(): void {
        this.stopPolling();
        const tick = async () => {
            if (!this.webview) return;
            try {
                const snap = await BilibiliAdapter.snapshot(this.webview);
                this.applySnapshot(snap);
            } catch {
                /* page is navigating; ignore */
            }
        };
        void tick();
        this.pollTimer = window.setInterval(tick, 1200);
    }

    private stopPolling(): void {
        if (this.pollTimer !== null) {
            window.clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private applySnapshot(snap: VideoSnapshot): void {
        this.setState({
            url: snap.href || this.state.url,
            title: snap.title || this.state.title,
            bvid: snap.bvid,
            page: snap.page,
            currentTime: snap.currentTime,
            duration: snap.duration,
            hasVideo: snap.hasVideo,
            paused: snap.paused,
            canGoBack: this.webview?.canGoBack?.() ?? false,
            canGoForward: this.webview?.canGoForward?.() ?? false,
        });
    }

    private setState(patch: Partial<BrowserState>): void {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener(this.state);
    }

    async navigate(url: string): Promise<void> {
        if (!this.webview) throw new Error("browser 未打开");
        this.setState({ loading: true, error: null });
        await BilibiliAdapter.navigate(this.webview, url);
        const snap = await BilibiliAdapter.snapshot(this.webview);
        this.applySnapshot(snap);
    }

    goBack(): void {
        this.webview?.goBack?.();
    }

    goForward(): void {
        this.webview?.goForward?.();
    }

    reload(): void {
        this.webview?.reload?.();
    }

    focus(): void {
        this.webview?.focus?.();
    }

    async getSource(): Promise<VideoSource | null> {
        if (!this.webview) return null;
        const snapshot = await BilibiliAdapter.snapshot(this.webview);
        if (snapshot.bvid) {
            return {
                provider: "bilibili",
                bvid: snapshot.bvid,
                page: snapshot.page,
                canonicalUrl: `https://www.bilibili.com/video/${snapshot.bvid}/?p=${snapshot.page}`,
                title: snapshot.title.replace(/_哔哩哔哩_bilibili$/, "").trim(),
            };
        }
        if (snapshot.hasVideo) {
            return {
                provider: "url",
                canonicalUrl: snapshot.href,
                title: (snapshot.title || snapshot.href).trim(),
            };
        }
        return null;
    }

    async getSnapshot(): Promise<VideoSnapshot> {
        if (!this.webview) throw new Error("browser 未打开");
        return BilibiliAdapter.snapshot(this.webview);
    }

    async seek(seconds: number) {
        if (!this.webview) throw new Error("browser 未打开");
        return BilibiliAdapter.seek(this.webview, seconds);
    }

    async togglePlay(): Promise<void> {
        if (!this.webview) throw new Error("browser 未打开");
        const state = await BilibiliAdapter.togglePlay(this.webview);
        this.setState({ paused: state.paused, currentTime: state.currentTime, playbackRate: state.playbackRate });
    }

    async seekRelative(deltaSeconds: number): Promise<void> {
        if (!this.webview) throw new Error("browser 未打开");
        const state = await BilibiliAdapter.seekRelative(this.webview, deltaSeconds);
        this.setState({ paused: state.paused, currentTime: state.currentTime, playbackRate: state.playbackRate });
    }

    async setPlaybackRate(rate: number): Promise<void> {
        if (!this.webview) throw new Error("browser 未打开");
        const state = await BilibiliAdapter.setPlaybackRate(this.webview, rate);
        this.setState({ paused: state.paused, currentTime: state.currentTime, playbackRate: state.playbackRate });
    }

    async captureClip(seconds: number) {
        if (!this.webview) throw new Error("browser 未打开");
        return BilibiliAdapter.captureClip(this.webview, seconds);
    }

    async captureFrame() {
        if (!this.webview) throw new Error("browser 未打开");
        return BilibiliAdapter.captureFrame(this.webview);
    }

    /** Open a video source and (optionally) seek it; waits for the real player. */
    async openAndSeek(source: VideoSource, seconds: number): Promise<{ navigated: boolean; seekErrorSeconds: number }> {
        if (!this.webview) throw new Error("browser 未打开");
        const current = await BilibiliAdapter.snapshot(this.webview);
        let navigated: boolean;
        if (source.provider === "bilibili") {
            navigated = !(current.bvid === source.bvid && current.page === (source.page || 1));
        } else {
            navigated = current.href !== source.canonicalUrl;
        }
        if (navigated) {
            await this.navigate(buildVideoUrl(source));
            await BilibiliAdapter.waitForVideo(this.webview, 60000);
        }
        // Exiting web fullscreen before seeking avoids Bilibili restoring its
        // remembered "网页全屏" layout on timestamp jumps.
        await BilibiliAdapter.exitWebFullscreen(this.webview);
        const result = await BilibiliAdapter.seek(this.webview, seconds);
        await BilibiliAdapter.play(this.webview);
        await BilibiliAdapter.exitWebFullscreen(this.webview);
        this.applySnapshot(await BilibiliAdapter.snapshot(this.webview));
        return { navigated, seekErrorSeconds: result.errorSeconds };
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Parse `[SVN_KEY] ctrl=1 meta=0 alt=1 shift=0 key=T` into `Ctrl+Alt+T`. */
export function parseGuestKeyBinding(message: string): string | null {
    const match = message.match(/ctrl=(\d) meta=(\d) alt=(\d) shift=(\d) key=(.*)$/);
    if (!match) return null;
    const key = decodeURIComponent(match[5] || "");
    if (!key) return null;
    const mods: string[] = [];
    if (match[1] === "1") mods.push("Ctrl");
    if (match[2] === "1") mods.push("Meta");
    if (match[3] === "1") mods.push("Alt");
    if (match[4] === "1") mods.push("Shift");
    const normalized = key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;
    return [...mods, normalized].join("+");
}

function loadStoredZoom(): number {
    try {
        const raw = Number(window.localStorage.getItem("svn-zoom-factor"));
        if (Number.isFinite(raw) && raw >= 0.5 && raw <= 2.5) return raw;
    } catch {
        /* ignore */
    }
    return 1;
}
