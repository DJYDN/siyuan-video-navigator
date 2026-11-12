<script lang="ts">
    import { onMount, tick } from "svelte";
    import Hls from "hls.js";
    import { showMessage } from "siyuan";
    import { NativeCloudService } from "@/cloud/native/NativeCloudService";
    import { formatSize, isVideoFile } from "@/cloud/CloudDriveService";
    import type { NativeCloudEntry } from "@/cloud/native/types";
    import type { NativePlayRequest, NativePlayerContext } from "@/cloud/native/NativeCloudService";
    import { formatTimestamp } from "@/utils/time";

    export let service: NativeCloudService;
    export let onInsertTimestamp:
        | ((provider: string, fileId: string, name: string, seconds: number, dirId: string, stack: Array<{ id: string; name: string }>) => void)
        | undefined = undefined;

    let cookie = "";
    let driveId = "";
    let aliyunAccessToken = "";
    let connected = false;
    let showLogin = false;
    let loginHost: HTMLDivElement;
    let loginWebview: any = null;
    let providerId = service.getActiveProviderId();
    let providers = service.getMounts();
    let loading = false;
    let error: string | null = null;
    let entries: NativeCloudEntry[] = [];
    let stack: Array<{ id: string; name: string }> = [{ id: "0", name: "根目录" }];
    let playing: { url: string; title: string; kind?: "video" | "hls" } | null = null;
    let hls: Hls | null = null;
    let playerError: string | null = null;
    let videoEl: HTMLVideoElement | null = null;
    let currentEntry: NativeCloudEntry | null = null;
    let currentTime = 0;
    let duration = 0;
    let paused = true;
    let userPaused = false;
    let rate = 1;
    let volume = 1;
    let userMuted = false;
    let showList = false;
    let pendingSeek = 0;
    let controlsVisible = true;
    let hideTimer: number | null = null;
    let playerHeight = Number(window.localStorage.getItem("svn-native-player-height")) || 360;
    let showMenu = false;
    let corsFallbackUsed = false;
    let loadSeq = 0;
    let playSeq = 0;
    let requestSeq = 0;
    let lastPlayRequestKey = "";
    let lastPlayRequestAt = 0;

    $: videoEntries = entries.filter((entry) => !entry.isDir && isVideoFile(entry.name));
    $: breadcrumbItems = buildBreadcrumbs(stack);

    function buildBreadcrumbs(items: Array<{ id: string; name: string }>): Array<{ name: string; index: number; ellipsis?: boolean }> {
        if (items.length <= 4) return items.map((item, index) => ({ name: item.name, index }));
        return [
            { name: items[0].name, index: 0 },
            { name: items[1].name, index: 1 },
            { name: "…", index: -1, ellipsis: true },
            { name: items[items.length - 2].name, index: items.length - 2 },
            { name: items[items.length - 1].name, index: items.length - 1 },
        ];
    }

    onMount(() => {
        providers = service.getMounts();
        connected = providers.some((mount) => mount.connected);
        showLogin = !connected;
        if (connected) {
            providerId = service.getActiveProviderId();
            stack = [{ id: rootId(), name: `${providerName()}根目录` }];
            void load(rootId());
        }
        const pending = service.consumePendingPlay();
        if (pending) void playRequest(pending);
        const handler = (event: Event) => {
            const detail = (event as CustomEvent<NativePlayRequest>).detail;
            const request = service.consumePendingPlay() || detail;
            if (request) void playRequest(request);
        };
        window.addEventListener("svn-native-play", handler);
        const autoplayOnFocus = () => void ensurePlaying();
        const autoplayOnVisible = () => {
            if (document.visibilityState === "visible") void ensurePlaying();
        };
        window.addEventListener("focus", autoplayOnFocus);
        document.addEventListener("visibilitychange", autoplayOnVisible);
        const closeMenu = (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (showMenu && !target?.closest?.(".svn-native__bar")) showMenu = false;
        };
        document.addEventListener("pointerdown", closeMenu, true);
        service.setPlayerApi({
            isActive: () => Boolean(videoEl && currentEntry && isNativeTabVisible()),
            togglePlay: () => togglePlay(),
            seekRelative: (delta: number) => {
                if (videoEl) {
                    videoEl.currentTime = Math.max(0, Math.min(videoEl.duration || 0, videoEl.currentTime + delta));
                }
            },
            getContext: () => playerContext(),
            captureFrame: () => captureFrame(),
            captureClip: (seconds: number) => captureClip(seconds),
        });
        return () => {
            service.setPlayerApi(null);
            window.removeEventListener("svn-native-play", handler);
            window.removeEventListener("focus", autoplayOnFocus);
            document.removeEventListener("visibilitychange", autoplayOnVisible);
            document.removeEventListener("pointerdown", closeMenu, true);
        };
    });

    /**
     * The native player API lives as long as the tab component exists. When
     * the user switches to the Bilibili tab, that API must report inactive so
     * timestamps/screenshots/links go to the currently visible video.
     */
    function isNativeTabVisible(): boolean {
        const root = videoEl?.closest(".svn-native") as HTMLElement | null;
        if (!root?.isConnected) return false;
        const tab = root.closest(".layout__tab") as HTMLElement | null;
        if (tab && !tab.classList.contains("layout__tab--active") && !tab.classList.contains("layout__tab--current")) {
            return false;
        }
        if (root.offsetParent === null) return false;
        const rect = root.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function rootId(): string {        if (providerId === "baidu") return "/";
        if (providerId === "aliyun") return "root";
        return "0";
    }

    function providerName(): string {
        return providers.find((item) => item.provider === providerId)?.label || "网盘";
    }

    async function connect(): Promise<void> {
        invalidateRequests();
        loading = true;
        error = null;
        try {
            await service.connect(
                providerId,
                providerId === "aliyun"
                    ? { refresh_token: cookie.trim(), drive_id: driveId.trim(), access_token: aliyunAccessToken.trim() }
                    : { cookie: cookie.trim() },
            );
            connected = true;
            showLogin = false;
            providers = service.getMounts();
            stack = [{ id: rootId(), name: `${providerName()}根目录` }];
            await load(stack[0].id);
            showMessage(`${providerName()}连接成功`, 3000);
        } catch (e) {
            error = String((e as Error)?.message || e);
        } finally {
            loading = false;
        }
    }

    function requestKey(request: NativePlayRequest): string {
        return `${request.provider}|${request.fileId}|${request.seconds}|${request.dirId || ""}|${request.name}`;
    }

    function invalidateRequests(): void {
        loadSeq++;
        playSeq++;
        requestSeq++;
    }

    async function load(dirId: string, force = false): Promise<void> {
        const seq = ++loadSeq;
        const provider = providerId;
        service.setActiveProvider(provider);
        loading = true;
        error = null;
        try {
            const result = await service.list(dirId, provider, force);
            if (seq !== loadSeq || provider !== providerId) return;
            entries = result;
            error = null;
        } catch (e) {
            if (seq === loadSeq && provider === providerId) error = String((e as Error)?.message || e);
        } finally {
            if (seq === loadSeq) loading = false;
        }
    }

    function enter(entry: NativeCloudEntry): void {
        if (entry.isDir) {
            stack = [...stack, { id: entry.id, name: entry.name }];
            void load(entry.id);
            return;
        }
        if (!isVideoFile(entry.name)) {
            showMessage("原生网盘当前只支持播放视频文件", 3000);
            return;
        }
        void playEntry(entry, 0);
    }

    async function playEntry(entry: NativeCloudEntry, seconds: number): Promise<void> {
        if (!entry.id || !String(entry.id).trim()) {
            error = "文件 ID 为空，无法播放，请刷新目录后重试";
            return;
        }
        const seq = ++playSeq;
        const provider = providerId;
        service.setActiveProvider(provider);
        loading = true;
        error = null;
        corsFallbackUsed = false;
        try {
            const playable = await service.makePlayableUrl(entry.id, provider);
            if (seq !== playSeq || provider !== providerId) return;
            currentEntry = entry;
            playing = { url: playable.url, title: entry.name, kind: playable.kind };
            pendingSeek = seconds;
            playerError = null;
            error = null;
            userPaused = false;
            if (volume > 0) userMuted = false;
            await tick();
            startPlayback();
            scheduleAutoplay();
            scheduleSoundChecks();
        } catch (e) {
            if (seq === playSeq && provider === providerId && (!playing || currentEntry?.id === entry.id)) {
                error = String((e as Error)?.message || e);
            }
        } finally {
            if (seq === playSeq) loading = false;
        }
    }

    async function playRequest(request: NativePlayRequest): Promise<void> {
        const key = requestKey(request);
        const now = Date.now();
        if (key === lastPlayRequestKey && now - lastPlayRequestAt < 1500) return;
        lastPlayRequestKey = key;
        lastPlayRequestAt = now;
        invalidateRequests();
        const reqSeq = requestSeq;
        service.setActiveProvider(request.provider);
        providerId = request.provider;
        connected = true;
        error = null;
        playerError = null;
        if (request.stack?.length) {
            stack = request.stack;
        } else if (request.dirId) {
            stack = [{ id: request.dirId, name: "文件所在目录" }];
        }
        const entry: NativeCloudEntry = { name: request.name, id: request.fileId, isDir: false, size: 0, modified: "" };
        // Start URL resolution immediately; folder restore runs in parallel so
        // clicking a link does not wait for a full directory listing.
        const listTask = (async () => {
            let dirId = request.dirId || "";
            if (!dirId) {
                const located = await service.locate(request.fileId, request.provider);
                if (reqSeq !== requestSeq || providerId !== request.provider) return;
                if (located) {
                    stack = located.stack;
                    dirId = located.dirId;
                }
            }
            if (reqSeq !== requestSeq || providerId !== request.provider) return;
            if (dirId) await load(dirId);
        })().catch((loadError) => {
            if (reqSeq === requestSeq && providerId === request.provider && !playing) {
                error = String((loadError as Error)?.message || loadError);
            }
        });
        try {
            await playEntry(entry, request.seconds || 0);
        } finally {
            void listTask;
        }
    }

    function onLoadedMetadata(): void {
        if (!videoEl) return;
        duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
        if (pendingSeek > 0) {
            try {
                videoEl.currentTime = pendingSeek;
            } catch {
                /* ignore */
            }
            pendingSeek = 0;
        }
        paused = videoEl.paused;
        showControls();
        scheduleAutoplay();
    }

    function scheduleAutoplay(): void {
        for (const delay of [80, 350, 900, 1800, 3000]) {
            window.setTimeout(() => void ensurePlaying(), delay);
        }
    }

    async function ensurePlaying(): Promise<void> {
        const video = videoEl;
        if (!video || !video.paused || userPaused) return;
        const wasMuted = video.muted;
        try {
            if (!wasMuted) video.muted = true;
            await video.play();
        } catch {
            /* keep the manual play button available */
        } finally {
            window.setTimeout(() => {
                if (videoEl === video) {
                    video.muted = wasMuted;
                    paused = video.paused;
                }
            }, 180);
        }
    }

    function ensureSound(): void {
        if (!videoEl || userMuted) return;
        if (videoEl.volume === 0) videoEl.volume = volume > 0 ? volume : 1;
        videoEl.muted = false;
    }

    function scheduleSoundChecks(): void {
        for (const delay of [400, 1200, 2500, 5000]) {
            window.setTimeout(() => ensureSound(), delay);
        }
    }

    function scheduleHide(): void {
        if (hideTimer !== null) window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => {
            if (!paused) controlsVisible = false;
        }, 2600);
    }

    function showControls(): void {
        controlsVisible = true;
        if (!paused) scheduleHide();
    }

    function onPlayerLeave(): void {
        if (!paused) controlsVisible = false;
    }

    function startResize(event: PointerEvent): void {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = playerHeight;
        const move = (moveEvent: PointerEvent) => {
            const max = Math.max(220, Math.round(window.innerHeight * 0.82));
            playerHeight = Math.max(160, Math.min(max, startHeight + moveEvent.clientY - startY));
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            try {
                window.localStorage.setItem("svn-native-player-height", String(playerHeight));
            } catch {
                /* ignore */
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up, { once: true });
    }

    function onTimeUpdate(): void {
        if (!videoEl) return;
        currentTime = videoEl.currentTime;
        duration = Number.isFinite(videoEl.duration) ? videoEl.duration : duration;
        paused = videoEl.paused;
    }

    function togglePlay(): void {
        if (!videoEl) return;
        if (videoEl.paused) {
            userPaused = false;
            if (!userMuted) videoEl.muted = false;
            void videoEl.play().catch(() => undefined);
        } else {
            userPaused = true;
            videoEl.pause();
        }
        showControls();
    }

    function closeList(): void {
        showList = false;
        showControls();
    }

    function seekTo(value: number): void {
        if (!videoEl) return;
        videoEl.currentTime = Math.max(0, Math.min(duration || videoEl.duration || 0, value));
    }

    function changeRate(value: number): void {
        rate = value;
        if (videoEl) videoEl.playbackRate = value;
    }

    function changeVolume(value: number): void {
        volume = value;
        userMuted = value === 0;
        if (videoEl) {
            videoEl.volume = value;
            videoEl.muted = userMuted;
        }
    }

    function toggleFullscreen(): void {
        if (!videoEl) return;
        const target = videoEl.parentElement || videoEl;
        if (document.fullscreenElement) void document.exitFullscreen();
        else void target.requestFullscreen?.();
    }

    function currentVideoIndex(): number {
        if (!currentEntry) return -1;
        return videoEntries.findIndex((entry) => entry.id === currentEntry?.id);
    }

    function playRelative(delta: number): void {
        const index = currentVideoIndex();
        const next = videoEntries[index + delta];
        if (next) void playEntry(next, 0);
        else showMessage("已经是列表末尾", 2000);
    }

    function insertCurrentTimestamp(): void {
        if (!currentEntry) return;
        if (!onInsertTimestamp) return;
        const dirId = stack[stack.length - 1]?.id || rootId();
        onInsertTimestamp(providerId, currentEntry.id, currentEntry.name, Math.floor(currentTime), dirId, [...stack]);
    }

    function startPlayback(): void {
        destroyHls();
        if (!videoEl || !playing) return;
        if (playing.kind !== "hls") return;
        if (Hls.isSupported()) {
            hls = new Hls({ enableWorker: true });
            hls.loadSource(playing.url);
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            videoEl.muted = true;
            hls.attachMedia(videoEl);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                scheduleAutoplay();
                scheduleSoundChecks();
                window.setTimeout(() => {
                    if (!videoEl) return;
                    videoEl.muted = userMuted;
                    videoEl.volume = volume > 0 ? volume : 1;
                    void ensurePlaying();
                    window.setTimeout(() => {
                        if (videoEl && !userMuted) videoEl.muted = false;
                    }, 400);
                }, 500);
            });
            hls.on(Hls.Events.FRAG_LOADED, () => void ensurePlaying());
            hls.on(Hls.Events.LEVEL_LOADED, () => void ensurePlaying());
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (data.fatal) playerError = `HLS 播放失败：${data.details || data.type}`;
            });
        } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
            videoEl.src = playing.url;
        } else {
            playerError = "当前环境不支持 HLS 播放";
        }
    }

    function destroyHls(): void {
        if (hls) {
            hls.destroy();
            hls = null;
        }
    }

    function closePlayer(): void {
        destroyHls();
        playing = null;
        currentEntry = null;
        currentTime = 0;
        duration = 0;
    }

    function playerContext(): NativePlayerContext | null {
        if (!currentEntry) return null;
        const dirId = stack[stack.length - 1]?.id || rootId();
        return {
            provider: providerId,
            fileId: currentEntry.id,
            name: currentEntry.name,
            seconds: Math.floor(videoEl?.currentTime ?? currentTime),
            dirId,
            stack: [...stack],
        };
    }

    async function captureFrame(): Promise<{ dataUrl: string; width: number; height: number }> {
        if (!videoEl || !videoEl.videoWidth) throw new Error("当前没有可截图的视频画面");
        const canvas = document.createElement("canvas");
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建截图画布");
        context.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
    }

    async function captureClip(seconds: number): Promise<{
        base64: string;
        mime: string;
        byteLength: number;
        duration: number;
        width: number;
        height: number;
        hasAudio: boolean;
        mode: string;
    }> {
        if (!videoEl || !videoEl.videoWidth) throw new Error("当前没有可录制的视频画面");
        const video = videoEl;
        if (video.paused) await video.play().catch(() => undefined);
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        const mimeCandidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
        const mime = mimeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "video/webm";

        const recordStream = async (stream: MediaStream, duration: number): Promise<Blob> => {
            const chunks: Blob[] = [];
            const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
            const stopped = new Promise<void>((resolve) => {
                recorder.onstop = () => resolve();
            });
            recorder.ondataavailable = (event) => {
                if (event.data?.size) chunks.push(event.data);
            };
            recorder.start(200);
            await new Promise((resolve) => window.setTimeout(resolve, Math.max(1, duration) * 1000));
            try {
                recorder.requestData();
            } catch {
                /* ignore */
            }
            recorder.stop();
            await stopped;
            return new Blob(chunks, { type: mime });
        };

        let blob: Blob;
        let mode = "video.captureStream";
        let hasAudio = false;
        if (typeof (video as any).captureStream === "function") {
            const stream: MediaStream = (video as any).captureStream();
            hasAudio = stream.getAudioTracks().length > 0;
            blob = await recordStream(stream, seconds);
            stream.getTracks().forEach((track) => track.stop());
            if (blob.size === 0) {
                // Some paused/cross-origin media produces no frames; record the
                // decoded canvas instead so clips still work (video only).
                mode = "canvas.captureStream";
                hasAudio = false;
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const context = canvas.getContext("2d");
                if (!context) throw new Error("无法创建录制画布");
                let raf = 0;
                const draw = () => {
                    try {
                        context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    } catch {
                        /* ignore */
                    }
                    raf = requestAnimationFrame(draw);
                };
                draw();
                const canvasStream = canvas.captureStream(25);
                blob = await recordStream(canvasStream, seconds);
                cancelAnimationFrame(raf);
                canvasStream.getTracks().forEach((track) => track.stop());
            }
        } else {
            throw new Error("当前视频不支持 captureStream，无法录制片段");
        }
        if (blob.size === 0) throw new Error("片段录制结果为空，请播放视频后重试");
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return {
            base64: btoa(binary),
            mime,
            byteLength: bytes.length,
            duration: seconds,
            width: video.videoWidth,
            height: video.videoHeight,
            hasAudio,
            mode,
        };
    }

    function up(): void {
        if (stack.length <= 1) return;
        stack = stack.slice(0, -1);
        void load(stack[stack.length - 1].id);
    }

    async function disconnect(): Promise<void> {
        invalidateRequests();
        destroyHls();
        await service.disconnect(providerId);
        providers = service.getMounts();
        connected = providers.some((mount) => mount.connected);
        showLogin = !connected;
        entries = [];
        playing = null;
        currentEntry = null;
        error = null;
        playerError = null;
        if (connected) {
            const next = providers.find((mount) => mount.connected);
            if (next) {
                providerId = next.provider;
                service.setActiveProvider(providerId);
                stack = [{ id: rootId(), name: `${providerName()}根目录` }];
                await load(rootId());
            }
        }
    }

    function selectProvider(id: string): void {
        destroyLoginWebview();
        invalidateRequests();
        destroyHls();
        providerId = id;
        playing = null;
        currentEntry = null;
        entries = [];
        error = null;
        playerError = null;
        corsFallbackUsed = false;
        if (service.vault.has(id)) {
            service.setActiveProvider(id);
            connected = true;
            showLogin = false;
            stack = [{ id: rootId(), name: `${providerName()}根目录` }];
            void load(rootId());
        } else {
            showLogin = true;
        }
    }

    function destroyLoginWebview(): void {
        if (loginWebview) {
            try {
                loginWebview.remove();
            } catch {
                /* ignore */
            }
            loginWebview = null;
        }
    }

    function focusLoginQr(webview: any): void {
        const script = `(() => {
            const candidates = [];
            const selectors = ['canvas', 'img[src*="qr" i]', '[class*="qrcode" i]', '[class*="qr-code" i]', '[class*="qrCode" i]', 'iframe'];
            for (const selector of selectors) {
                for (const element of document.querySelectorAll(selector)) {
                    const rect = element.getBoundingClientRect();
                    if (rect.width < 70 || rect.height < 70) continue;
                    candidates.push({ element, area: rect.width * rect.height });
                }
            }
            candidates.sort((a, b) => b.area - a.area);
            const best = candidates.find((item) => item.area < 700 * 700) || candidates[0];
            if (!best) return null;
            best.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
            return {
                tag: best.element.tagName,
                width: Math.round(best.element.getBoundingClientRect().width),
                height: Math.round(best.element.getBoundingClientRect().height),
            };
        })()`;
        webview.executeJavaScript(script, true).catch(() => undefined);
    }

    function openLoginPage(): void {
        if (!loginHost) return;
        destroyLoginWebview();
        const webview = document.createElement("webview");
        webview.setAttribute("partition", `persist:svn-native-login-${providerId}`);
        const loginUrl =
            providerId === "baidu"
                ? "https://pan.baidu.com/"
                : providerId === "quark"
                  ? "https://pan.quark.cn/"
                  : "https://www.alipan.com/";
        webview.setAttribute("src", loginUrl);
        webview.setAttribute("allowpopups", "false");
        webview.style.width = "100%";
        webview.style.height = "min(52vh, 520px)";
        webview.style.background = "#fff";
        loginHost.appendChild(webview);
        loginWebview = webview;
        const scheduleFocus = () => {
            for (const delay of [600, 1600, 3200]) {
                window.setTimeout(() => {
                    if (loginWebview === webview) focusLoginQr(webview);
                }, delay);
            }
        };
        webview.addEventListener("dom-ready", scheduleFocus);
        webview.addEventListener("did-finish-load", scheduleFocus);
        webview.addEventListener("did-navigate-in-page", scheduleFocus);
    }

    function parseAliyunTokens(data: any): { refreshToken: string; accessToken: string; driveId: string } {
        const found = { refreshToken: "", accessToken: "", driveId: "" };
        const visit = (value: any, depth: number) => {
            if (!value || depth > 6) return;
            if (typeof value === "string") {
                try {
                    visit(JSON.parse(value), depth + 1);
                } catch {
                    /* not JSON */
                }
                return;
            }
            if (typeof value !== "object") return;
            if (typeof value.refresh_token === "string" && !found.refreshToken) found.refreshToken = value.refresh_token;
            if (typeof value.access_token === "string" && !found.accessToken) found.accessToken = value.access_token;
            if (typeof value.default_drive_id === "string" && !found.driveId) found.driveId = value.default_drive_id;
            for (const child of Object.values(value)) visit(child, depth + 1);
        };
        visit(data, 0);
        return found;
    }

    async function captureEmbeddedLogin(): Promise<void> {
        if (!loginWebview) {
            showMessage("请先打开登录页并完成扫码/登录", 3000);
            return;
        }
        try {
            if (providerId === "aliyun") {
                const script = `(() => {
                    const out = {};
                    try {
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            if (/token|drive|user/i.test(key)) out[key] = localStorage.getItem(key);
                        }
                    } catch (e) {}
                    return out;
                })()`;
                const raw = await loginWebview.executeJavaScript(script, true);
                const tokens = parseAliyunTokens(raw);
                aliyunAccessToken = tokens.accessToken;
                driveId = tokens.driveId;
                cookie = tokens.refreshToken;
                if (!cookie && !aliyunAccessToken) {
                    throw new Error("未从阿里云盘登录页读取到 token，请确认已完成扫码登录，或手动填写 refresh_token");
                }
                await connect();
                return;
            }
            const requireFn = (globalThis as any).require || (window as any).require;
            const remote = requireFn("@electron/remote");
            const webContents = remote?.webContents?.fromId?.(loginWebview.getWebContentsId?.());
            if (!webContents) throw new Error("无法访问登录页 Cookie，请使用手动 Cookie 方式");
            const url = providerId === "baidu" ? "https://pan.baidu.com/" : "https://pan.quark.cn/";
            const cookies = await webContents.session.cookies.get({ url });
            const header = cookies.map((item: any) => `${item.name}=${item.value}`).join("; ");
            if (!header) throw new Error("未读取到登录 Cookie，请确认已在登录页完成登录");
            cookie = header;
            await connect();
        } catch (e) {
            error = String((e as Error)?.message || e);
        }
    }
</script>

<div class="svn-native">
    <div class="svn-native__bar">
        <strong>原生网盘（实验）</strong>
        <span class="svn-native__warn">非官方接口，可能失效，账号风险自负</span>
        {#each providers as provider}
            <button
                class="svn-native__provider-tab"
                class:is-active={providerId === provider.provider}
                class:is-connected={provider.connected}
                onclick={() => selectProvider(provider.provider)}
            >{provider.label}{provider.connected ? " ✓" : ""}</button>
        {/each}
        {#if connected}
            <span class="svn-native__active">当前：{providerName()}</span>
            <button class="svn-native__menu-btn" title="网盘操作" onclick={() => (showMenu = !showMenu)}>⋯</button>
            {#if showMenu}
                <div class="svn-native__menu">
                    <button onclick={() => { showLogin = true; showMenu = false; destroyLoginWebview(); }}>登录其他网盘</button>
                    <button onclick={() => { showMenu = false; void disconnect(); }}>清除当前登录</button>
                </div>
            {/if}
        {/if}
    </div>

    {#if showLogin || !connected}
        <div class="svn-native__login">
            <h3>登录 {providerName()}</h3>
            <p>支持内嵌官方登录页扫码/登录后自动读取 Cookie，也可手动粘贴 Cookie。百度与夸克可同时保持登录。</p>
            <select
                class="b3-select"
                bind:value={providerId}
                onchange={() => {
                    destroyLoginWebview();
                    cookie = "";
                    error = null;
                }}
            >
                {#each providers as provider}
                    <option value={provider.provider}>{provider.label}{provider.connected ? " ✓" : ""}</option>
                {/each}
            </select>
            {#if providerId !== "aliyun"}
                <div class="svn-native__login-actions">
                    <button class="b3-button b3-button--outline" onclick={openLoginPage}>打开官方登录页（扫码/账号）</button>
                    <button class="b3-button b3-button--text" onclick={captureEmbeddedLogin} disabled={!loginWebview}>读取登录状态并连接</button>
                </div>
                <div bind:this={loginHost} class="svn-native__login-webview"></div>
            {:else}
                <div class="svn-native__login-actions">
                    <button class="b3-button b3-button--outline" onclick={openLoginPage}>打开阿里云盘扫码登录页</button>
                    <button class="b3-button b3-button--text" onclick={captureEmbeddedLogin} disabled={!loginWebview}>读取登录状态并连接</button>
                </div>
                <div bind:this={loginHost} class="svn-native__login-webview"></div>
            {/if}
            <textarea
                class="b3-text-field"
                rows="4"
                bind:value={cookie}
                placeholder={providerId === "baidu"
                    ? "也可手动粘贴 pan.baidu.com 的 Cookie（BDUSS、STOKEN 等）"
                    : providerId === "aliyun"
                      ? "粘贴阿里云盘 refresh_token"
                      : "也可手动粘贴 pan.quark.cn 的 Cookie"}
            ></textarea>
            {#if providerId === "aliyun"}
                <input class="b3-text-field" bind:value={driveId} placeholder="drive_id（可选，留空用默认网盘）" />
            {/if}
            <div class="svn-native__login-actions">
                <button class="b3-button b3-button--outline" onclick={connect} disabled={loading || !cookie.trim()}>
                    {loading ? "连接中…" : "使用 Cookie 连接 " + providerName()}
                </button>
                {#if connected}
                    <button class="b3-button b3-button--text" onclick={() => { showLogin = false; }}>返回文件浏览</button>
                {/if}
            </div>
            {#if error}<div class="svn-native__error">{error}</div>{/if}
        </div>
    {:else}
        {#if playing}
            <div class="svn-native__player" style={`height:${playerHeight}px`} onmousemove={showControls} onmouseleave={onPlayerLeave}>
                <div class="svn-native__stage">
                    <video
                        bind:this={videoEl}
                        class="svn-native__video"
                        src={playing.kind === "hls" ? undefined : playing.url}
                        autoplay
                        playsinline
                        crossorigin="anonymous"
                        onclick={togglePlay}
                        onloadedmetadata={onLoadedMetadata}
                        onloadeddata={() => {
                            ensureSound();
                            void ensurePlaying();
                        }}
                        oncanplay={() => {
                            ensureSound();
                            void ensurePlaying();
                        }}
                        ontimeupdate={onTimeUpdate}
                        onplay={() => {
                            paused = false;
                            userPaused = false;
                            if (!userMuted) {
                                window.setTimeout(() => {
                                    if (videoEl && !userMuted) videoEl.muted = false;
                                }, 250);
                            }
                            scheduleSoundChecks();
                            showControls();
                        }}
                        onpause={() => {
                            paused = true;
                            controlsVisible = true;
                            if (!userPaused && playing) {
                                window.setTimeout(() => {
                                    if (!userPaused) void ensurePlaying();
                                }, 250);
                            }
                        }}
                        onerror={() => {
                            if (!corsFallbackUsed && videoEl?.hasAttribute("crossorigin")) {
                                corsFallbackUsed = true;
                                const source = playing?.url;
                                if (source) {
                                    videoEl.removeAttribute("crossorigin");
                                    videoEl.src = `${source}${source.includes("?") ? "&" : "?"}retry=${Date.now()}`;
                                    videoEl.load();
                                    scheduleAutoplay();
                                    return;
                                }
                            }
                            playerError = `视频加载失败（代码 ${videoEl?.error?.code ?? "?"}）：${videoEl?.error?.message || "未知错误"}。可能是直链防盗链/Cookie 失效。`;
                        }}
                    ></video>
                    <div class="svn-native__overlay svn-native__overlay--top" class:is-hidden={!controlsVisible}>
                        <span class="svn-native__player-title">{playing.title}</span>
                        <span class="fn__flex-1"></span>
                        <button class="b3-button b3-button--text svn-native__close" onclick={closePlayer}>关闭</button>
                    </div>
                    <div class="svn-native__controls" class:is-hidden={!controlsVisible}>
                        <button class="svn-native__ctrl" title={paused ? "播放" : "暂停"} onclick={togglePlay}>{paused ? "▶" : "⏸"}</button>
                        <button class="svn-native__ctrl" title="上一个视频" onclick={() => playRelative(-1)}>⏮</button>
                        <button class="svn-native__ctrl" title="下一个视频" onclick={() => playRelative(1)}>⏭</button>
                        <span class="svn-native__time">{formatTimestamp(currentTime)}</span>
                        <input
                            class="svn-native__progress"
                            type="range"
                            min="0"
                            max={duration || 0}
                            step="0.1"
                            value={currentTime}
                            oninput={(event) => seekTo(Number((event.currentTarget as HTMLInputElement).value))}
                        />
                        <span class="svn-native__time">{formatTimestamp(duration)}</span>
                        <select class="b3-select svn-native__rate" value={rate} onchange={(event) => changeRate(Number((event.currentTarget as HTMLSelectElement).value))}>
                            <option value={0.5}>0.5x</option>
                            <option value={0.75}>0.75x</option>
                            <option value={1}>1x</option>
                            <option value={1.25}>1.25x</option>
                            <option value={1.5}>1.5x</option>
                            <option value={2}>2x</option>
                        </select>
                        <button class="svn-native__ctrl" title="插入当前时间戳到笔记" onclick={insertCurrentTimestamp}>⏱</button>
                        <button class="svn-native__ctrl" title={showList ? "隐藏右侧列表" : "显示右侧列表"} onclick={() => (showList = !showList)}>☰</button>
                        <button class="svn-native__ctrl" title="静音" onclick={() => changeVolume(volume > 0 ? 0 : 1)}>{volume > 0 ? "🔊" : "🔇"}</button>
                        <input
                            class="svn-native__volume"
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={volume}
                            oninput={(event) => changeVolume(Number((event.currentTarget as HTMLInputElement).value))}
                        />
                        <button class="svn-native__ctrl" title="全屏" onclick={toggleFullscreen}>⛶</button>
                    </div>
                    {#if playerError}<div class="svn-native__error svn-native__error--overlay">{playerError}</div>{/if}
                </div>
                {#if showList}
                    <aside class="svn-native__side-list" aria-label="视频列表">
                        <div class="svn-native__side-head">
                            <span>视频列表</span>
                            <button class="svn-native__ctrl" title="收起列表" onclick={closeList}>×</button>
                        </div>
                        <div class="svn-native__side-body">
                            {#each videoEntries as entry, index}
                                <button
                                    class="svn-native__playlist-row"
                                    class:is-active={entry.id === currentEntry?.id}
                                    onclick={() => playEntry(entry, 0)}
                                >
                                    <span>{index + 1}</span>
                                    <span class="svn-native__name">{entry.name}</span>
                                </button>
                            {/each}
                            {#if videoEntries.length === 0}
                                <div class="svn-native__empty">当前目录没有视频</div>
                            {/if}
                        </div>
                    </aside>
                {/if}
                <div class="svn-native__resizer" title="拖动调整播放窗格大小" onpointerdown={startResize}></div>
            </div>
        {/if}
        <div class="svn-native__path" title={stack.map((item) => item.name).join(" / ")}>
            <button class="b3-button b3-button--text" onclick={up} disabled={stack.length <= 1}>↑</button>
            <div class="svn-native__crumbs">
                {#each breadcrumbItems as crumb, index}
                    {#if crumb.ellipsis}
                        <span class="svn-native__crumb-ellipsis">{crumb.name}</span>
                    {:else}
                        <button
                            class="svn-native__crumb"
                            title={crumb.name}
                            onclick={() => {
                                stack = stack.slice(0, crumb.index + 1);
                                void load(stack[stack.length - 1].id);
                            }}
                        >{crumb.name}</button>
                    {/if}
                    {#if index < breadcrumbItems.length - 1}<span class="svn-native__sep">/</span>{/if}
                {/each}
            </div>
            <span class="fn__flex-1"></span>
            <button class="b3-button b3-button--text" onclick={() => load(stack[stack.length - 1].id, true)}>刷新</button>
        </div>
        {#if loading}
            <div class="svn-native__empty">加载中…</div>
        {:else if error}
            <div class="svn-native__error">{error}</div>
        {:else}
            <div class="svn-native__list">
                {#each entries as entry (entry.id)}
                    <button class="svn-native__row" onclick={() => enter(entry)}>
                        <span>{entry.isDir ? "📁" : isVideoFile(entry.name) ? "▶" : "📄"}</span>
                        <span class="svn-native__name">{entry.name}</span>
                        <span class="svn-native__size">{entry.isDir ? "" : formatSize(entry.size)}</span>
                    </button>
                {:else}
                    <div class="svn-native__empty">此目录为空</div>
                {/each}
            </div>
        {/if}
    {/if}
</div>

<style>
    .svn-native {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-background);
    }
    .svn-native__bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--b3-border-color);
        flex-wrap: wrap;
        position: relative;
    }
    .svn-native__menu-btn {
        border: 1px solid var(--b3-border-color);
        background: transparent;
        color: var(--b3-theme-on-surface);
        border-radius: 6px;
        width: 24px;
        height: 22px;
        line-height: 1;
        cursor: pointer;
        margin-left: auto;
    }
    .svn-native__menu {
        position: absolute;
        right: 8px;
        top: 32px;
        z-index: 20;
        min-width: 150px;
        display: flex;
        flex-direction: column;
        padding: 4px;
        border: 1px solid var(--b3-border-color);
        border-radius: 6px;
        background: var(--b3-theme-surface);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    }
    .svn-native__menu button {
        border: none;
        background: transparent;
        color: var(--b3-theme-on-background);
        text-align: left;
        padding: 6px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
    }
    .svn-native__menu button:hover {
        background: var(--b3-theme-background);
    }
    .svn-native__warn {
        color: var(--b3-theme-error);
        font-size: 12px;
    }
    .svn-native__provider-tab {
        border: 1px solid var(--b3-border-color);
        background: transparent;
        color: var(--b3-theme-on-surface);
        border-radius: 10px;
        padding: 1px 8px;
        font-size: 12px;
        cursor: pointer;
    }
    .svn-native__provider-tab.is-connected {
        color: var(--b3-theme-primary);
        border-color: var(--b3-theme-primary);
    }
    .svn-native__provider-tab.is-active {
        background: var(--b3-theme-primary);
        color: #fff;
    }
    .svn-native__login-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
    }
    .svn-native__login-webview {
        border: 1px solid var(--b3-border-color);
        border-radius: 6px;
        overflow: hidden;
        background: #fff;
        min-height: 0;
    }
    .svn-native__muted {
        color: var(--b3-theme-on-surface);
        font-size: 12px;
    }
    .svn-native__active {
        color: var(--b3-theme-primary);
        font-size: 12px;
        font-weight: 600;
    }
    .svn-native__login {
        max-width: 720px;
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .svn-native__login textarea {
        width: 100%;
        box-sizing: border-box;
    }
    .svn-native__path {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--b3-border-color);
        flex-wrap: nowrap;
        overflow: hidden;
        min-width: 0;
    }
    .svn-native__crumbs {
        display: flex;
        align-items: center;
        gap: 2px;
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
        white-space: nowrap;
    }
    .svn-native__crumb {
        background: none;
        border: none;
        color: var(--b3-theme-primary);
        cursor: pointer;
        padding: 2px 4px;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 0 1 auto;
    }
    .svn-native__crumb-ellipsis {
        color: var(--b3-theme-on-surface);
        padding: 0 2px;
        flex: none;
    }
    .svn-native__sep {
        color: var(--b3-theme-on-surface);
        opacity: 0.5;
        flex: none;
    }
    .svn-native__path > .b3-button {
        flex: none;
    }
    .svn-native__list {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 6px;
    }
    .svn-native__player {
        flex: none;
        display: flex;
        flex-direction: row;
        align-items: stretch;
        background: #000;
        position: relative;
        min-height: 160px;
    }
    .svn-native__stage {
        position: relative;
        flex: 1;
        min-width: 0;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #000;
    }
    .svn-native__video {
        display: block;
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        background: #000;
        cursor: pointer;
    }
    .svn-native__overlay {
        position: absolute;
        z-index: 3;
        transition: opacity 0.2s ease;
    }
    .svn-native__overlay--top {
        top: 0;
        left: 0;
        right: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        color: #eee;
        font-size: 12px;
        background: linear-gradient(rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0));
    }
    .svn-native__overlay.is-hidden,
    .svn-native__controls.is-hidden {
        opacity: 0;
        pointer-events: none;
    }
    .svn-native__player-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .svn-native__close {
        color: #8fc7ff;
        padding: 2px 4px;
    }
    .svn-native__controls {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 3;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        background: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.78));
        color: #eee;
        font-size: 12px;
        flex-wrap: wrap;
        transition: opacity 0.2s ease;
    }
    .svn-native__ctrl {
        border: none;
        background: transparent;
        color: #eee;
        cursor: pointer;
        font-size: 14px;
        padding: 2px 4px;
    }
    .svn-native__time {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        font-size: 11px;
    }
    .svn-native__progress {
        flex: 1;
        min-width: 100px;
    }
    .svn-native__volume {
        width: 58px;
    }
    .svn-native__rate {
        width: 62px;
        font-size: 11px;
        padding: 1px 2px;
    }
    .svn-native__side-list {
        flex: none;
        width: 280px;
        max-width: 42%;
        height: 100%;
        max-height: 100%;
        display: flex;
        flex-direction: column;
        background: #101114;
        border-left: 1px solid #2a2d33;
    }
    .svn-native__side-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
        color: #ddd;
        font-size: 12px;
        border-bottom: 1px solid #2a2d33;
    }
    .svn-native__side-body {
        flex: 1;
        min-height: 0;
        overflow: auto;
    }
    .svn-native__playlist-row {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 8px;
        border: none;
        background: transparent;
        color: #ccc;
        text-align: left;
        cursor: pointer;
        font-size: 12px;
    }
    .svn-native__playlist-row:hover {
        background: #1d2026;
    }
    .svn-native__playlist-row.is-active {
        color: var(--b3-theme-primary);
        background: #1d2026;
    }
    .svn-native__resizer {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 7px;
        z-index: 6;
        cursor: ns-resize;
        background: transparent;
    }
    .svn-native__resizer:hover,
    .svn-native__resizer:active {
        background: rgba(255, 255, 255, 0.18);
    }
    .svn-native__error--overlay {
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: 44px;
        z-index: 4;
        background: rgba(0, 0, 0, 0.78);
        border-radius: 4px;
        padding: 6px 8px;
    }
    .svn-native__row {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
    }
    .svn-native__row:hover {
        background: var(--b3-theme-surface);
    }
    .svn-native__name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .svn-native__size {
        opacity: 0.7;
        font-size: 12px;
    }
    .svn-native__empty,
    .svn-native__error {
        padding: 20px;
        color: var(--b3-theme-on-surface);
    }
    .svn-native__error {
        color: var(--b3-theme-error);
        word-break: break-word;
    }
</style>
