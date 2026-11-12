import type { VideoSource } from "@/utils/url";

/** Minimal structural type for Electron's <webview> element (renderer side). */
export interface WebviewLike extends HTMLElement {
    loadURL(url: string): Promise<void> | void;
    executeJavaScript(code: string, userGesture?: boolean): Promise<any>;
    getURL(): string;
    getTitle?(): string;
    canGoBack?(): boolean;
    canGoForward?(): boolean;
    goBack?(): void;
    goForward?(): void;
    reload?(): void;
    stop?(): void;
    getWebContentsId?(): number;
    getZoomFactor?(): number;
    setZoomFactor?(factor: number): void;
}

export interface VideoSnapshot {
    href: string;
    title: string;
    bvid: string | null;
    page: number;
    hasVideo: boolean;
    readyState: number;
    currentTime: number | null;
    duration: number | null;
    paused: boolean | null;
    muted: boolean | null;
    videoWidth: number;
    videoHeight: number;
}

export interface SeekResult {
    target: number;
    before: number;
    after: number;
    duration: number | null;
    errorSeconds: number;
}

export interface FrameCapture {
    dataUrl: string;
    width: number;
    height: number;
    currentTime: number;
    avgLuma: number;
}

export interface PlaybackState {
    paused: boolean;
    currentTime: number;
    duration: number | null;
    playbackRate: number;
}

export interface ClipCapture {
    base64: string;
    mime: string;
    byteLength: number;
    duration: number;
    width: number;
    height: number;
    mode: "video.captureStream" | "canvas.captureStream";
    hasAudio: boolean;
}

export const HOTKEY_LOG_PREFIX = "[SVN_KEY";

/**
 * All Bilibili-specific knowledge lives here (page-side scripts only).
 * Host-side code must treat every result as untrusted data and validate it.
 */
export class BilibiliAdapter {
    static async waitForLoad(webview: WebviewLike, timeoutMs = 45000): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve();
            };
            const onFinish = () => finish();
            const onFail = (event: any) => {
                if (event.isMainFrame === false) return;
                finish(new Error(`did-fail-load ${event.errorCode} ${event.errorDescription} ${event.validatedURL}`));
            };
            const timer = window.setTimeout(() => finish(new Error("webview load timeout: " + (webview.getURL?.() || ""))), timeoutMs);
            const cleanup = () => {
                window.clearTimeout(timer);
                webview.removeEventListener("did-finish-load", onFinish);
                webview.removeEventListener("did-fail-load", onFail);
            };
            webview.addEventListener("did-finish-load", onFinish);
            webview.addEventListener("did-fail-load", onFail);
        });
    }

    static async navigate(webview: WebviewLike, url: string, extraWaitMs = 1500): Promise<void> {
        const loaded = this.waitForLoad(webview);
        await Promise.resolve(webview.loadURL(url));
        await loaded;
        await sleep(extraWaitMs);
    }

    static async snapshot(webview: WebviewLike): Promise<VideoSnapshot> {
        const code = `(() => {
            const v = document.querySelector("video");
            let bvid = null;
            const m = location.href.match(/\\/video\\/(BV[0-9A-Za-z]+)/);
            if (m) bvid = m[1];
            let page = 1;
            try { const p = new URL(location.href).searchParams.get("p"); if (p && /^\\d+$/.test(p)) page = parseInt(p, 10); } catch (e) {}
            return {
                href: location.href,
                title: document.title,
                bvid,
                page,
                hasVideo: !!v,
                readyState: v ? v.readyState : -1,
                currentTime: v ? v.currentTime : null,
                duration: v ? (Number.isFinite(v.duration) ? v.duration : null) : null,
                paused: v ? v.paused : null,
                muted: v ? v.muted : null,
                videoWidth: v ? v.videoWidth : 0,
                videoHeight: v ? v.videoHeight : 0,
            };
        })()`;
        return webview.executeJavaScript(code, true);
    }

    static async waitForVideo(webview: WebviewLike, timeoutMs = 45000): Promise<VideoSnapshot> {
        const started = Date.now();
        let last: VideoSnapshot | null = null;
        while (Date.now() - started < timeoutMs) {
            last = await this.snapshot(webview);
            if (last.hasVideo && last.readyState >= 1 && Number(last.duration) > 0) {
                await sleep(1000);
                return this.snapshot(webview);
            }
            await sleep(800);
        }
        throw new Error("当前页面没有可用视频：" + JSON.stringify(last));
    }

    /** Read bvid/page from the active page and return a VideoSource if it is a video page. */
    static async getVideoSource(webview: WebviewLike): Promise<VideoSource | null> {
        const snap = await this.snapshot(webview);
        if (!snap.bvid) return null;
        return {
            provider: "bilibili",
            bvid: snap.bvid,
            page: snap.page,
            canonicalUrl: `https://www.bilibili.com/video/${snap.bvid}/?p=${snap.page}`,
            title: snap.title.replace(/_哔哩哔哩_bilibili$/, "").trim(),
        };
    }

    /** Seek the current page's <video> element and return the measured result. */
    static async seek(webview: WebviewLike, seconds: number): Promise<SeekResult> {
        const target = Math.max(0, Math.floor(seconds));
        const code = `(async () => {
            const v = document.querySelector("video");
            if (!v) return { error: "no video element" };
            // Do NOT force-mute the player: click-back should keep the user's
            // audio state. seek() works without play(); play() is best effort.
            try { await v.play(); } catch (e) {}
            const before = v.currentTime;
            v.currentTime = ${target};
            await new Promise((resolve) => {
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                v.addEventListener("seeked", finish, { once: true });
                setTimeout(finish, 8000);
            });
            return { before, after: v.currentTime, duration: v.duration, readyState: v.readyState };
        })()`;
        const result = await webview.executeJavaScript(code, true);
        if (result?.error) throw new Error(result.error);
        return {
            target,
            before: result.before,
            after: result.after,
            duration: result.duration,
            errorSeconds: Math.abs(Number(result.after) - target),
        };
    }

    /** Best-effort autoplay after a timestamp/link jump. */
    static async play(webview: WebviewLike): Promise<void> {
        const code = `(async () => {
            const v = document.querySelector("video");
            if (!v) return { ok: false };
            const wasMuted = v.muted;
            try {
                // Autoplay policies can block unmuted playback; temporarily
                // mute to start, then restore normal audible playback.
                if (v.paused) v.muted = true;
                await v.play();
            } catch (e) {
            } finally {
                v.muted = false;
                if (v.volume === 0) v.volume = 1;
            }
            return { ok: !v.paused, paused: v.paused, currentTime: v.currentTime, muted: v.muted, wasMuted };
        })()`;
        await webview.executeJavaScript(code, true).catch(() => undefined);
    }

    /** Bilibili remembers "web fullscreen" across pages; leave it after a jump. */
    static async exitWebFullscreen(webview: WebviewLike): Promise<boolean> {
        const code = `(() => {
            const container = document.querySelector(".bpx-player-container");
            const active = Boolean(container && (container.classList.contains("bpx-state-web-fullscreen") || container.classList.contains("bpx-state-fullscreen")));
            if (!active) return false;
            const buttons = Array.from(document.querySelectorAll(".bpx-player-ctrl-web, .bpx-player-ctrl-full"));
            for (const button of buttons) {
                const title = String(button.getAttribute("title") || button.getAttribute("aria-label") || "");
                if (title.includes("网页全屏") || title.includes("全屏")) {
                    button.click();
                    return true;
                }
            }
            // Fallback: click the web-fullscreen control directly.
            const web = document.querySelector(".bpx-player-ctrl-web");
            if (web) { web.click(); return true; }
            return false;
        })()`;
        const result = await webview.executeJavaScript(code, true).catch(() => false);
        return Boolean(result);
    }

    /** Toggle play/pause of the active HTML5 video. */
    static async togglePlay(webview: WebviewLike): Promise<PlaybackState> {
        const code = `(async () => {
            const v = document.querySelector("video");
            if (!v) return { error: "no video element" };
            if (v.paused) { try { await v.play(); } catch (e) {} } else { v.pause(); }
            return { paused: v.paused, currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null, playbackRate: v.playbackRate };
        })()`;
        const result = await webview.executeJavaScript(code, true);
        if (result?.error) throw new Error(result.error);
        return result as PlaybackState;
    }

    /** Seek relative to the current playback position (negative = rewind). */
    static async seekRelative(webview: WebviewLike, deltaSeconds: number): Promise<PlaybackState & { targetTime: number }> {
        const delta = Number(deltaSeconds) || 0;
        const code = `(async () => {
            const v = document.querySelector("video");
            if (!v) return { error: "no video element" };
            const target = Math.max(0, Math.min(Number.isFinite(v.duration) ? v.duration : Number.MAX_SAFE_INTEGER, v.currentTime + (${delta})));
            v.currentTime = target;
            await new Promise((resolve) => {
                let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                v.addEventListener("seeked", finish, { once: true });
                setTimeout(finish, 5000);
            });
            return { paused: v.paused, currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null, playbackRate: v.playbackRate, targetTime: target };
        })()`;
        const result = await webview.executeJavaScript(code, true);
        if (result?.error) throw new Error(result.error);
        return result;
    }

    static async setPlaybackRate(webview: WebviewLike, rate: number): Promise<PlaybackState> {
        const safeRate = Math.max(0.25, Math.min(4, Number(rate) || 1));
        const code = `(() => {
            const v = document.querySelector("video");
            if (!v) return { error: "no video element" };
            v.playbackRate = ${safeRate};
            return { paused: v.paused, currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null, playbackRate: v.playbackRate };
        })()`;
        const result = await webview.executeJavaScript(code, true);
        if (result?.error) throw new Error(result.error);
        return result as PlaybackState;
    }

    /**
     * Record a real clip of `seconds` from the current video position using
     * MediaRecorder. Prefers video.captureStream() (video+audio); falls back to
     * canvas.captureStream() (video only) when captureStream is unavailable.
     */
    static async captureClip(webview: WebviewLike, seconds: number): Promise<ClipCapture> {
        const duration = Math.max(1, Math.min(30, Math.floor(Number(seconds) || 10)));
        const code = `(async () => {
            const seconds = ${duration};
            const v = document.querySelector("video");
            if (!v) return { error: "no video element" };
            if (!v.videoWidth || !v.videoHeight) return { error: "video has no decoded frame" };
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            let stream = null;
            let mode = "video.captureStream";
            let canvas = null;
            let timer = null;
            try {
                if (typeof v.captureStream === "function") stream = v.captureStream();
                if (!stream || stream.getVideoTracks().length === 0) {
                    if (stream) stream.getTracks().forEach((t) => t.stop());
                    canvas = document.createElement("canvas");
                    canvas.width = v.videoWidth;
                    canvas.height = v.videoHeight;
                    const ctx = canvas.getContext("2d");
                    const draw = () => {
                        try { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); } catch (e) {}
                        timer = requestAnimationFrame(draw);
                    };
                    draw();
                    stream = canvas.captureStream(25);
                    mode = "canvas.captureStream";
                }
            } catch (e) {
                if (timer) cancelAnimationFrame(timer);
                return { error: "captureStream failed: " + String(e && e.message ? e.message : e) };
            }
            const hasAudio = stream.getAudioTracks().length > 0;
            if (typeof MediaRecorder === "undefined") {
                if (timer) cancelAnimationFrame(timer);
                stream.getTracks().forEach((t) => t.stop());
                return { error: "MediaRecorder is not available" };
            }
            const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
            const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
            const chunks = [];
            let recorder;
            try {
                recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
            } catch (e) {
                if (timer) cancelAnimationFrame(timer);
                stream.getTracks().forEach((t) => t.stop());
                return { error: "MediaRecorder init failed: " + String(e && e.message ? e.message : e) };
            }
            const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(); });
            recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunks.push(event.data); };
            try {
                recorder.start(250);
            } catch (e) {
                if (timer) cancelAnimationFrame(timer);
                stream.getTracks().forEach((t) => t.stop());
                return { error: "MediaRecorder start failed: " + String(e && e.message ? e.message : e) };
            }
            try { v.muted = false; } catch (e) {}
            try { await v.play(); } catch (e) {}
            await sleep(seconds * 1000);
            try { recorder.stop(); } catch (e) {}
            await stopped;
            if (timer) cancelAnimationFrame(timer);
            stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: mime });
            const buffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            return {
                base64: btoa(binary),
                mime,
                byteLength: bytes.length,
                duration: seconds,
                width: canvas ? canvas.width : v.videoWidth,
                height: canvas ? canvas.height : v.videoHeight,
                mode,
                hasAudio,
            };
        })()`;
        const result = await webview.executeJavaScript(code, true);
        if (result?.error) throw new Error(result.error);
        if (!result?.base64 || !result.byteLength) throw new Error("clip capture returned empty data");
        return result as ClipCapture;
    }

    /** Capture the current video frame from inside the guest page (canvas, no taint). */
    static async captureFrame(webview: WebviewLike, maxWidth = 1280): Promise<FrameCapture> {
        const code = `(() => {
            const v = document.querySelector("video");
            if (!v) return { error: "no video element" };
            if (!v.videoWidth || !v.videoHeight) return { error: "video has no decoded frame" };
            const scale = Math.min(1, ${maxWidth} / v.videoWidth);
            const c = document.createElement("canvas");
            c.width = Math.round(v.videoWidth * scale);
            c.height = Math.round(v.videoHeight * scale);
            const ctx = c.getContext("2d");
            ctx.drawImage(v, 0, 0, c.width, c.height);
            let dataUrl, error = null;
            try { dataUrl = c.toDataURL("image/png"); } catch (e) { error = String(e && e.message ? e.message : e); }
            let avgLuma = 0;
            try {
                const probe = document.createElement("canvas");
                probe.width = Math.min(64, c.width);
                probe.height = Math.min(64, c.height);
                const probeCtx = probe.getContext("2d");
                probeCtx.drawImage(c, 0, 0, probe.width, probe.height);
                const d = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
                let sum = 0;
                for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
                avgLuma = +(sum / (d.length / 4)).toFixed(2);
            } catch (e) {}
            return { error, dataUrl, width: c.width, height: c.height, currentTime: v.currentTime, avgLuma };
        })()`;
        const result = await webview.executeJavaScript(code, true);
        if (result?.error) throw new Error(result.error);
        // A dark/letterboxed frame is still a valid screenshot; only reject a
        // completely empty capture where even the canvas has no data.
        if (!result?.dataUrl) throw new Error("截图失败：画布没有返回图像数据");
        return result as FrameCapture;
    }

    /**
     * Inject the guest hotkey bridge + link target fix. Idempotent per document;
     * re-run after every main-frame load because Bilibili navigation replaces the page.
     *
     * The guest reports the raw key + modifiers. The host matches them against
     * the user-configurable HotkeyManager config, so custom hotkeys work while
     * the webview has focus.
     */
    static async installGuestBridge(webview: WebviewLike): Promise<{ installed: boolean; already?: boolean }> {
        const code = `(() => {
            if (window.__svnBridgeInstalled) return { installed: true, already: true };
            window.__svnBridgeInstalled = true;

            window.addEventListener("keydown", (e) => {
                const tag = e.target && e.target.tagName;
                if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
                if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
                const key = String(e.key || "");
                if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") return;
                console.log("[SVN_KEY] ctrl=" + (e.ctrlKey ? 1 : 0) + " meta=" + (e.metaKey ? 1 : 0) + " alt=" + (e.altKey ? 1 : 0) + " shift=" + (e.shiftKey ? 1 : 0) + " key=" + encodeURIComponent(key));
            }, true);

            // Ctrl/Command + wheel zooms the embedded page (browser-like).
            window.addEventListener("wheel", (e) => {
                if (!(e.ctrlKey || e.metaKey)) return;
                e.preventDefault();
                console.log("[SVN_ZOOM] delta=" + (e.deltaY < 0 ? 1 : -1));
            }, { capture: true, passive: false });

            const fixLinks = () => {
                document.querySelectorAll('a[target="_blank"]').forEach((a) => {
                    try {
                        if (/bilibili\\.com\\/video\\//.test(a.href)) a.setAttribute("target", "_self");
                    } catch (e) {}
                });
            };
            fixLinks();
            try {
                const observer = new MutationObserver(fixLinks);
                observer.observe(document.documentElement, { childList: true, subtree: true });
                window.__svnBridgeObserver = observer;
            } catch (e) {}
            return { installed: true };
        })()`;
        return webview.executeJavaScript(code, true);
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
