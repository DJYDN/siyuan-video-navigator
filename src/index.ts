import { Plugin, openTab, showMessage, getFrontend, Setting, Dialog, fetchSyncPost } from "siyuan";
import "./index.scss";

import { mount, unmount } from "svelte";
import BrowserWorkspace from "@/ui/BrowserWorkspace.svelte";
import CloudBrowser from "@/ui/CloudBrowser.svelte";
import CloudMounts from "@/ui/CloudMounts.svelte";
import NativeCloud from "@/ui/NativeCloud.svelte";
import { NativeCloudService, type NativeClipCapture, type NativePlayerContext } from "@/cloud/native/NativeCloudService";
import { CloudDriveService, buildCloudPlayerUrl } from "@/cloud/CloudDriveService";
import { BrowserController } from "@/browser/BrowserController";
import { EditorTargetTracker } from "@/notes/EditorTargetTracker";
import { TimestampService } from "@/notes/TimestampService";
import { ScreenshotService } from "@/notes/ScreenshotService";
import { ClipService } from "@/notes/ClipService";
import { ScreenshotIndex } from "@/notes/ScreenshotIndex";
import { ClickBackService } from "@/notes/ClickBackService";
import { formatTimestamp } from "@/utils/time";
import { LinkTextSettings, LINK_TEXT_PRESETS, formatLinkText, type LinkTextTarget } from "@/settings/LinkTextSettings";
import { MediaKBSettings } from "@/mediaKB/MediaKBSettings";
import { MediaKBRunner } from "@/mediaKB/MediaKBRunner";
import { MediaKBImporter } from "@/mediaKB/MediaKBImporter";
import { MediaKBDialog } from "@/mediaKB/MediaKBDialog";
import type { MediaKBStartOptions } from "@/mediaKB/MediaKBDialog";
import { MediaKBSettingsDialog } from "@/mediaKB/MediaKBSettingsDialog";
import { HotkeyManager, bindingFromEvent, ACTION_LABELS, CLIP_DURATION_OPTIONS, type HotkeyAction } from "@/settings/HotkeyManager";
import { maybeRunPhase2E2E, maybeRunPersistTest, maybeRunMultiVideoE2E, maybeRunKeyTestSetup, maybeRunGenericE2E, maybeRunCloudE2E, maybeRunCloudMountsE2E, maybeRunNativeUIE2E, maybeRunNativePlaybackE2E, maybeRunVaultE2E } from "@/dev/e2e";

const TAB_TYPE = "svnBrowserTab";
const CLOUD_TAB_TYPE = "svnCloudTab";
const CLOUD_MOUNTS_TAB_TYPE = "svnCloudMountsTab";
const NATIVE_CLOUD_TAB_TYPE = "svnNativeCloudTab";

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
    return escapeHtml(value);
}

function extractBlockId(response: any): string | null {
    const data = response?.data;
    if (Array.isArray(data)) {
        for (const item of data) {
            const ops = item?.doOperations;
            if (Array.isArray(ops) && ops.length && ops[0]?.id) return String(ops[0].id);
        }
    }
    return null;
}

export default class SiYuanVideoNavigatorPlugin extends Plugin {
    readonly browser = new BrowserController();
    readonly tracker = new EditorTargetTracker(this as unknown as Plugin);
    private timestampService: TimestampService | null = null;
    private screenshotService: ScreenshotService | null = null;
    private clipService: ClipService | null = null;
    private readonly screenshotIndex = new ScreenshotIndex();
    private clickBack: ClickBackService | null = null;
    private hotkeys: HotkeyManager | null = null;
    private linkText: LinkTextSettings | null = null;
    private mediaKbSettings: MediaKBSettings | null = null;
    private mediaKbRunner: MediaKBRunner | null = null;
    private mediaKbDialog: MediaKBDialog | null = null;
    private mediaKbSettingsDialog: MediaKBSettingsDialog | null = null;
    private mediaKbJobButton: HTMLElement | null = null;
    private mediaKbJobHideTimer: number | null = null;
    private mediaKbJobDialog: Dialog | null = null;
    private mediaKbJobStatusElement: HTMLElement | null = null;
    private mediaKbJobLogElement: HTMLElement | null = null;
    private mediaKbJobRefreshTimer: number | null = null;
    private mediaKbJobLog: string[] = [];
    private mediaKbJobStatus = "idle";
    private mediaKbJobError = "";
    private readonly cloudDrive = new CloudDriveService();
    private cloudTabComponent: ReturnType<typeof mount> | null = null;
    private cloudMountsTabComponent: ReturnType<typeof mount> | null = null;
    private nativeCloudTabComponent: ReturnType<typeof mount> | null = null;
    private nativeCloud: NativeCloudService | null = null;

    private topBarElement: HTMLElement | null = null;
    private statusBarElement: HTMLElement | null = null;
    private browserTabComponent: ReturnType<typeof mount> | null = null;
    private browserReady: Promise<BrowserController> | null = null;
    private browserReadyResolve: ((controller: BrowserController) => void) | null = null;
    private unsubscribeStatus: (() => void) | null = null;
    private statusTimer: number | null = null;
    /** Dev diagnostics: result of the latest timestamp insertion attempt. */
    lastInsert: { at: string; source: string; ok: boolean; error?: string; result?: unknown } | null = null;
    /** Dev diagnostics: result of the latest screenshot insertion attempt. */
    lastScreenshot: { at: string; source: string; ok: boolean; error?: string; result?: unknown } | null = null;
    /** Dev diagnostics: result of the latest clip insertion attempt. */
    lastClip: { at: string; source: string; ok: boolean; error?: string; result?: unknown } | null = null;

    async onload() {
        console.log(`[siyuan-video-navigator] onload ${this.name}`);
        this.tracker.bind();
        this.linkText = new LinkTextSettings(this as unknown as Plugin);
        await this.linkText.load();
        this.mediaKbSettings = new MediaKBSettings(this as unknown as Plugin);
        await this.mediaKbSettings.load();
        this.mediaKbRunner = new MediaKBRunner(this);
        this.mediaKbDialog = new MediaKBDialog(this.mediaKbSettings, (options) => this.startMediaKBJob(options));
        this.mediaKbSettingsDialog = new MediaKBSettingsDialog(this.mediaKbSettings, () => this.openMediaKBDialog(), () => void this.importMediaKBRecent());
        this.timestampService = new TimestampService(this.browser, this.tracker, this.linkText);
        this.screenshotService = new ScreenshotService(this.browser, this.tracker, this.screenshotIndex, this.linkText);
        this.clipService = new ClipService(this.browser, this.tracker, this.linkText);
        this.nativeCloud = new NativeCloudService(this as unknown as Plugin);
        await this.nativeCloud.init();
        this.clickBack = new ClickBackService(
            () => this.browser,
            () => this.ensureBrowser(),
            this.screenshotIndex,
            (provider, fileId, name, seconds, dirId, stack) => this.openNativeRequest(provider, fileId, name, seconds, dirId, stack),
        );
        this.clickBack.bind();

        this.hotkeys = new HotkeyManager(this as unknown as Plugin, {
            timestamp: () => void this.insertTimestamp("hotkey"),
            screenshot: () => void this.insertScreenshot("hotkey"),
            clip: () => void this.insertClip(this.getClipSeconds(), "hotkey"),
            playPause: () => void this.togglePlay(),
            rewind: () => void this.seekRelative(-3),
            forward: () => void this.seekRelative(3),
            openBrowser: () => this.openBrowserTab(),
            openNetdisk: () => void this.openNetdisk(),
            mediaKb: () => this.openMediaKBDialog(),
        });
        await this.hotkeys.load();
        this.hotkeys.bindHost();
        try {
            const cloud = await this.loadData("svn-cloud");
            if (cloud && typeof cloud === "object") {
                this.cloudDrive.setConfig({
                    baseUrl: typeof cloud.baseUrl === "string" ? cloud.baseUrl : "",
                    username: typeof cloud.username === "string" ? cloud.username : "",
                    token: typeof cloud.token === "string" ? cloud.token : "",
                });
            }
        } catch {
            /* no saved cloud config */
        }

        this.browser.onKeyBinding = (binding) => this.hotkeys?.handleGuestBinding(binding);
        this.browser.onHotkey = (action) => {
            // Legacy bridge message (kept for old pages); the raw key bridge is primary.
            if (action === "timestamp") {
                void this.insertTimestamp("bridge");
            } else if (action === "screenshot") {
                void this.insertScreenshot("bridge");
            }
        };
        this.browser.onAttached = () => {
            this.browserReadyResolve?.(this.browser);
            this.browserReadyResolve = null;
        };

        this.addCommand({
            langKey: "openBrowser",
            hotkey: "",
            callback: () => this.openBrowserTab(),
        });
        this.addCommand({
            langKey: "insertTimestamp",
            hotkey: "",
            callback: () => {
                void this.insertTimestamp("command");
            },
        });
        this.addCommand({
            langKey: "insertScreenshot",
            hotkey: "",
            callback: () => {
                void this.insertScreenshot("command");
            },
        });
        this.addCommand({
            langKey: "insertClip",
            hotkey: "",
            callback: () => {
                void this.insertClip(this.getClipSeconds(), "command");
            },
        });
        this.addCommand({
            langKey: "togglePlay",
            hotkey: "",
            callback: () => {
                void this.togglePlay();
            },
        });
        this.addCommand({
            langKey: "seekBackward",
            hotkey: "",
            callback: () => {
                void this.seekRelative(-3);
            },
        });
        this.addCommand({
            langKey: "seekForward",
            hotkey: "",
            callback: () => {
                void this.seekRelative(3);
            },
        });
        this.addCommand({
            langKey: "openNetdisk",
            hotkey: "",
            callback: () => {
                void this.openNetdisk();
            },
        });
        this.addCommand({
            langKey: "openCloudMounts",
            hotkey: "",
            callback: () => this.openCloudMountsTab(),
        });
        this.addCommand({
            langKey: "openNativeCloud",
            hotkey: "",
            callback: () => this.openNativeCloudTab(),
        });
        this.addCommand({
            langKey: "openSettings",
            hotkey: "",
            callback: () => this.openSetting(),
        });

        const plugin = this;
        this.addTab({
            type: TAB_TYPE,
            init() {
                const host = document.createElement("div");
                host.className = "svn-browser-tab";
                plugin.browserTabComponent = mount(BrowserWorkspace, {
                    target: host,
                    props: {
                        controller: plugin.browser,
                        onOpenSettings: () => plugin.openSetting(),
                        onTogglePlay: () => void plugin.togglePlay(),
                        onSeekRelative: (delta: number) => void plugin.seekRelative(delta),
                        onCaptureClip: () => void plugin.insertClip(plugin.getClipSeconds(), "command"),
                        onOpenNetdisk: () => void plugin.openNetdisk(),
                        hideToolbar: plugin.hotkeys?.getConfig().hideToolbar ?? true,
                        onHideToolbarChange: (hidden: boolean) => void plugin.hotkeys?.setHideToolbar(hidden),
                    },
                });
                this.element.appendChild(host);
            },
            destroy: () => {
                if (this.browserTabComponent) {
                    unmount(this.browserTabComponent);
                    this.browserTabComponent = null;
                }
                console.log("[siyuan-video-navigator] browser tab destroyed");
            },
        });
        this.addTab({
            type: CLOUD_TAB_TYPE,
            init() {
                const host = document.createElement("div");
                host.className = "svn-cloud-tab";
                plugin.cloudTabComponent = mount(CloudBrowser, {
                    target: host,
                    props: {
                        service: plugin.cloudDrive,
                        onOpenVideo: (url: string, title: string) => void plugin.openCloudVideo(url, title),
                        onOpenSettings: () => plugin.openSetting(),
                        onOpenMounts: () => plugin.openCloudMountsTab(),
                        onOpenNative: () => plugin.openNativeCloudTab(),
                    },
                });
                this.element.appendChild(host);
            },
            destroy: () => {
                if (this.cloudTabComponent) {
                    unmount(this.cloudTabComponent);
                    this.cloudTabComponent = null;
                }
                console.log("[siyuan-video-navigator] cloud tab destroyed");
            },
        });
        this.addTab({
            type: CLOUD_MOUNTS_TAB_TYPE,
            init() {
                const host = document.createElement("div");
                host.className = "svn-cloud-tab";
                plugin.cloudMountsTabComponent = mount(CloudMounts, {
                    target: host,
                    props: {
                        service: plugin.cloudDrive,
                        onBack: () => plugin.openCloudTab(),
                        onOpenSettings: () => plugin.openSetting(),
                        onOpenNative: () => plugin.openNativeCloudTab(),
                    },
                });
                this.element.appendChild(host);
            },
            destroy: () => {
                if (this.cloudMountsTabComponent) {
                    unmount(this.cloudMountsTabComponent);
                    this.cloudMountsTabComponent = null;
                }
                console.log("[siyuan-video-navigator] cloud mounts tab destroyed");
            },
        });
        this.addTab({
            type: NATIVE_CLOUD_TAB_TYPE,
            init() {
                const host = document.createElement("div");
                host.className = "svn-cloud-tab";
                plugin.nativeCloudTabComponent = mount(NativeCloud, {
                    target: host,
                    props: {
                        service: plugin.nativeCloud,
                        onInsertTimestamp: (
                            provider: string,
                            fileId: string,
                            name: string,
                            seconds: number,
                            dirId: string,
                            stack: Array<{ id: string; name: string }>,
                        ) => plugin.insertNativeTimestamp(provider, fileId, name, seconds, dirId, stack),
                    },
                });
                this.element.appendChild(host);
            },
            destroy: () => {
                if (this.nativeCloudTabComponent) {
                    unmount(this.nativeCloudTabComponent);
                    this.nativeCloudTabComponent = null;
                }
                console.log("[siyuan-video-navigator] native cloud tab destroyed");
            },
        });
    }

    onLayoutReady() {
        this.topBarElement = this.addTopBar({
            icon: "iconVideo",
            title: "思源视频导航笔记：打开 B 站浏览器",
            position: "right",
            callback: () => this.openBrowserTab(),
        });
        this.addTopBar({
            icon: "iconFiles",
            title: "原生网盘（实验）：百度/夸克",
            position: "right",
            callback: () => this.openNativeCloudTab(),
        });

        this.statusBarElement = document.createElement("div");
        this.statusBarElement.className = "toolbar__item ariaLabel svn-statusbar";
        this.statusBarElement.setAttribute("aria-label", "思源视频导航笔记");
        this.statusBarElement.innerHTML = '<svg><use href="#iconVideo"></use></svg><span class="svn-statusbar__text">视频导航</span>';
        this.addStatusBar({ element: this.statusBarElement });
        this.subscribeStatusBar();
        this.startStatusTimer();
        void this.screenshotIndex.refresh().catch((error) => console.warn("[siyuan-video-navigator] screenshot index refresh failed", error));
        // A custom tab shell can survive a UI reload without its Svelte content
        // being mounted; close such stale tabs so the next open runs init().
        window.setTimeout(() => this.closeStaleBrowserTabs(), 300);

        if (getFrontend() === "desktop") {
            setTimeout(() => {
                void maybeRunPhase2E2E(this).catch((error) => console.error("[siyuan-video-navigator] e2e failed", error));
                void maybeRunPersistTest(this).catch((error) => console.error("[siyuan-video-navigator] persist e2e failed", error));
                void maybeRunMultiVideoE2E(this).catch((error) => console.error("[siyuan-video-navigator] multi-video e2e failed", error));
                void maybeRunKeyTestSetup(this).catch((error) => console.error("[siyuan-video-navigator] keytest setup failed", error));
                void maybeRunGenericE2E(this).catch((error) => console.error("[siyuan-video-navigator] generic e2e failed", error));
                void maybeRunCloudE2E(this).catch((error) => console.error("[siyuan-video-navigator] cloud e2e failed", error));
                void maybeRunCloudMountsE2E(this).catch((error) => console.error("[siyuan-video-navigator] cloud mounts e2e failed", error));
                void maybeRunNativeUIE2E(this).catch((error) => console.error("[siyuan-video-navigator] native cloud ui e2e failed", error));
                void maybeRunNativePlaybackE2E(this).catch((error) => console.error("[siyuan-video-navigator] native cloud playback e2e failed", error));
                void maybeRunVaultE2E(this).catch((error) => console.error("[siyuan-video-navigator] vault e2e failed", error));
            }, 1200);
        }
    }

    onunload() {
        this.mediaKbRunner?.cancel();
        this.clearMediaKBJobHideTimer();
        this.mediaKbJobButton?.remove();
        this.mediaKbJobButton = null;
        this.nativeCloud?.aliyunInjector.dispose();
        this.nativeCloud?.proxy.stop();
        this.clickBack?.unbind();
        this.clickBack = null;
        this.tracker.unbind();
        this.hotkeys?.unbind();
        this.hotkeys = null;
        this.browser.detach();
        this.stopStatusTimer();
        this.unsubscribeStatus?.();
        this.unsubscribeStatus = null;
        this.topBarElement?.remove();
        this.topBarElement = null;
        this.statusBarElement?.remove();
        this.statusBarElement = null;
        if (this.browserTabComponent) {
            unmount(this.browserTabComponent);
            this.browserTabComponent = null;
        }
        showMessage("思源视频导航笔记已卸载");
    }

    getTimestampService(): TimestampService {
        if (!this.timestampService) throw new Error("plugin not initialized");
        return this.timestampService;
    }

    private closeStaleBrowserTabs(): void {
        try {
            const opened = this.getOpenedTab() as Record<string, any[]>;
            for (const [type, customs] of Object.entries(opened || {})) {
                if (!type.includes(TAB_TYPE)) continue;
                for (const custom of customs || []) {
                    const element = custom?.element as HTMLElement | undefined;
                    const mounted = Boolean(element?.querySelector?.(".svn-browser"));
                    if (!mounted) {
                        console.warn("[siyuan-video-navigator] closing stale browser tab shell", type);
                        custom?.tab?.close?.();
                    }
                }
            }
        } catch (error) {
            console.warn("[siyuan-video-navigator] close stale tab failed", error);
        }
    }

    getScreenshotService(): ScreenshotService {
        if (!this.screenshotService) throw new Error("plugin not initialized");
        return this.screenshotService;
    }

    getClipService(): ClipService {
        if (!this.clipService) throw new Error("plugin not initialized");
        return this.clipService;
    }

    getClipSeconds(): number {
        return this.hotkeys?.getConfig().clipSeconds || 10;
    }

    async togglePlay(): Promise<void> {
        try {
            const api = this.nativeCloud?.getPlayerApi();
            if (api?.isActive()) {
                api.togglePlay();
                return;
            }
            await this.browser.togglePlay();
        } catch (error) {
            showMessage(`播放/暂停失败：${String((error as Error)?.message || error)}`, 4000, "error");
        }
    }

    async openNetdisk(): Promise<void> {
        this.openCloudTab();
    }

    openCloudTab(): void {
        openTab({
            app: this.app,
            custom: {
                id: this.name + CLOUD_TAB_TYPE,
                icon: "iconFiles",
                title: "网盘浏览",
                data: {},
            },
        });
    }

    openCloudMountsTab(): void {
        openTab({
            app: this.app,
            custom: {
                id: this.name + CLOUD_MOUNTS_TAB_TYPE,
                icon: "iconFiles",
                title: "网盘挂载",
                data: {},
            },
        });
    }

    openNativeCloudTab(): void {
        openTab({
            app: this.app,
            custom: {
                id: this.name + NATIVE_CLOUD_TAB_TYPE,
                icon: "iconFiles",
                title: "原生网盘（实验）",
                data: {},
            },
        });
    }

    async openNativeVideo(proxyUrl: string, title: string): Promise<void> {
        try {
            const browser = await this.ensureBrowser();
            await browser.navigate(buildCloudPlayerUrl(this.name, proxyUrl, title));
            showMessage(`正在播放：${title}`, 2500);
        } catch (error) {
            showMessage(`打开原生网盘视频失败：${String((error as Error)?.message || error)}`, 5000, "error");
        }
    }

    private nativeHref(context: NativePlayerContext, seconds: number): string {
        return `svn-native://play?provider=${encodeURIComponent(context.provider)}&file=${encodeURIComponent(context.fileId)}&name=${encodeURIComponent(context.name)}&t=${Math.max(0, Math.floor(seconds))}&dir=${encodeURIComponent(context.dirId)}&dirs=${encodeURIComponent(JSON.stringify(context.stack))}`;
    }

    private async insertNativeScreenshot(
        context: NativePlayerContext,
        frame: { dataUrl: string; width: number; height: number },
    ): Promise<void> {
        const target = this.tracker.validate(this.tracker.getLastTarget());
        if (!target?.blockID) throw new Error("请先在笔记中点击要插入截图的位置");
        const base64 = String(frame.dataUrl).split(",")[1] || "";
        const assetPath = await this.uploadNativeAsset(base64, "image/png", `svn-native-${context.provider}-${Date.now()}.png`);
        const href = this.nativeHref(context, context.seconds);
        const alt = formatLinkText(this.linkText!.get(), {
            target: "screenshot",
            seconds: context.seconds,
            title: context.name,
            filename: context.name,
            provider: context.provider,
            durationSeconds: 0,
        });
        const inserted = await fetchSyncPost("/api/block/insertBlock", {
            dataType: "markdown",
            data: `![${alt}](${assetPath})`,
            previousID: target.blockID,
        });
        if (!inserted || inserted.code !== 0) throw new Error("插入网盘截图块失败");
        const blockId = extractBlockId(inserted);
        if (!blockId) throw new Error("截图已插入但无法取得块 ID");
        await fetchSyncPost("/api/attr/setBlockAttrs", {
            id: blockId,
            attrs: {
                "custom-svn-type": "screenshot",
                "custom-svn-provider": context.provider,
                "custom-svn-time": String(context.seconds),
                "custom-svn-url": href,
                "custom-svn-asset": assetPath,
            },
        });
        this.screenshotIndex.add({
            blockId,
            provider: "native",
            bvid: "",
            page: 0,
            timeSeconds: context.seconds,
            assetPath,
            url: href,
        });
    }

    private async insertNativeClip(context: NativePlayerContext, clip: NativeClipCapture): Promise<void> {
        const target = this.tracker.validate(this.tracker.getLastTarget());
        if (!target?.blockID) throw new Error("请先在笔记中点击要插入片段的位置");
        const start = context.seconds;
        const assetPath = await this.uploadNativeAsset(
            clip.base64,
            clip.mime,
            `svn-native-clip-${context.provider}-${start}-${clip.duration}s-${Date.now()}.webm`,
        );
        const href = this.nativeHref(context, start);
        const label = formatLinkText(this.linkText!.get(), {
            target: "clip",
            seconds: start,
            title: context.name,
            filename: context.name,
            provider: context.provider,
            durationSeconds: clip.duration,
        });
        const inserted = await fetchSyncPost("/api/block/insertBlock", {
            dataType: "markdown",
            data: `<video controls src="${assetPath}"></video>\n\n[${label}](${href})`,
            previousID: target.blockID,
        });
        if (!inserted || inserted.code !== 0) throw new Error("插入网盘片段块失败");
        const blockId = extractBlockId(inserted);
        if (!blockId) throw new Error("片段已插入但无法取得块 ID");
        await fetchSyncPost("/api/attr/setBlockAttrs", {
            id: blockId,
            attrs: {
                "custom-svn-type": "clip",
                "custom-svn-provider": context.provider,
                "custom-svn-clip-start": String(start),
                "custom-svn-clip-end": String(start + clip.duration),
                "custom-svn-duration": String(clip.duration),
                "custom-svn-url": href,
                "custom-svn-asset": assetPath,
            },
        });
    }

    private async uploadNativeAsset(base64: string, mime: string, fileName: string): Promise<string> {
        const token = (window as any).siyuan?.config?.api?.token;
        if (!token) throw new Error("无法取得思源 API Token");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const form = new FormData();
        form.append("assetsDirPath", "/assets/");
        form.append("file[]", new Blob([bytes], { type: mime }), fileName);
        const response = await fetch("/api/asset/upload", {
            method: "POST",
            headers: { Authorization: "Token " + token },
            body: form,
        });
        const json: any = await response.json().catch(() => null);
        const path = json?.data?.succMap ? Object.values(json.data.succMap)[0] : null;
        if (!response.ok || !path) throw new Error("网盘资产上传失败：" + (json?.msg || response.status));
        return String(path);
    }

    openNativeRequest(
        provider: string,
        fileId: string,
        name: string,
        seconds: number,
        dirId?: string,
        stack?: Array<{ id: string; name: string }>,
    ): void {
        if (!fileId || !String(fileId).trim()) {
            showMessage("该链接缺少网盘文件信息，请重新插入时间戳", 4000, "error");
            return;
        }
        const request = { provider, fileId, name, seconds, dirId, stack };
        this.nativeCloud?.setPendingPlay(request);
        this.openNativeCloudTab();
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("svn-native-play", { detail: request }));
        }, 350);
    }

    insertNativeTimestamp(
        provider: string,
        fileId: string,
        name: string,
        seconds: number,
        dirId: string,
        stack: Array<{ id: string; name: string }>,
    ): void {
        try {
            const target = this.tracker.validate(this.tracker.getLastTarget());
            if (!target?.range) {
                showMessage("请先在笔记中点击要插入的位置，再点时间戳按钮", 4000);
                return;
            }
            const href = `svn-native://play?v=2&provider=${encodeURIComponent(provider)}&file=${encodeURIComponent(fileId)}&name=${encodeURIComponent(name)}&t=${Math.max(0, Math.floor(seconds))}&dir=${encodeURIComponent(dirId)}&dirs=${encodeURIComponent(JSON.stringify(stack))}`;
            const text = formatLinkText(this.linkText!.get(), {
                target: "timestamp",
                seconds,
                title: name,
                filename: name,
                provider,
                durationSeconds: 0,
            });
            const html = `<span data-type="a" data-href="${escapeAttribute(href)}">${escapeHtml(text)}</span>`;
            target.protyle.insert(html, false, true);
            showMessage(`已插入网盘时间戳 ${formatTimestamp(seconds)}`, 2500);
        } catch (error) {
            showMessage(`插入网盘时间戳失败：${String((error as Error)?.message || error)}`, 5000, "error");
        }
    }

    async openCloudVideo(url: string, title: string): Promise<void> {
        try {
            const playerUrl = buildCloudPlayerUrl(this.name, url, title);
            if (!this.browser.isAttached()) {
                // Avoid racing the tab's initial home-page navigation.
                this.browser.setPendingInitialUrl(playerUrl);
                await this.ensureBrowser();
            } else {
                await this.browser.navigate(playerUrl).catch(async () => {
                    // A navigation started by tab init can abort this one; retry once.
                    await new Promise((resolve) => window.setTimeout(resolve, 800));
                    if (!this.browser.isAttached()) {
                        this.browser.setPendingInitialUrl(playerUrl);
                        await this.ensureBrowser();
                    } else {
                        await this.browser.navigate(playerUrl);
                    }
                });
            }
            showMessage(`正在播放：${title}`, 2500);
        } catch (error) {
            showMessage(`打开网盘视频失败：${String((error as Error)?.message || error)}`, 5000, "error");
        }
    }

    private async connectCloudDrive(baseUrl: string, username: string, password: string): Promise<void> {
        try {
            await this.cloudDrive.login(baseUrl, username, password);
            await this.saveData("svn-cloud", this.cloudDrive.getConfig());
            showMessage("网盘连接成功，已保存登录状态", 3000);
        } catch (error) {
            showMessage(`网盘连接失败：${String((error as Error)?.message || error)}`, 6000, "error");
            throw error;
        }
    }

    async seekRelative(deltaSeconds: number): Promise<void> {
        try {
            const api = this.nativeCloud?.getPlayerApi();
            if (api?.isActive()) {
                api.seekRelative(deltaSeconds);
                return;
            }
            await this.browser.seekRelative(deltaSeconds);
        } catch (error) {
            showMessage(`跳转失败：${String((error as Error)?.message || error)}`, 4000, "error");
        }
    }

    openBrowserTab(): void {
        openTab({
            app: this.app,
            custom: {
                id: this.name + TAB_TYPE,
                icon: "iconVideo",
                title: "B 站 · 视频导航",
                data: {},
            },
        });
    }

    /** Open the browser tab if needed and wait until its <webview> is ready. */
    async ensureBrowser(): Promise<BrowserController> {
        if (this.browser.isAttached()) return this.browser;
        if (!this.browserReady) {
            this.browserReady = new Promise<BrowserController>((resolve, reject) => {
                this.browserReadyResolve = resolve;
                window.setTimeout(() => {
                    if (!this.browser.isAttached()) {
                        this.browserReady = null;
                        this.browserReadyResolve = null;
                        reject(new Error("浏览器页签未能初始化，请从顶栏图标重新打开。"));
                    }
                }, 15000);
            });
        }
        this.openBrowserTab();
        return this.browserReady;
    }

    openMediaKBDialog(): void {
        this.mediaKbDialog?.open();
    }

    private startMediaKBJob(options: MediaKBStartOptions): void {
        if (!this.mediaKbRunner || !this.mediaKbSettings) return;
        if (this.mediaKbRunner.isRunning()) {
            showMessage("已有 MediaKB 任务正在运行", 3000);
            return;
        }
        this.mediaKbJobLog = [];
        this.mediaKbJobError = "";
        this.mediaKbJobStatus = "running";
        this.clearMediaKBJobHideTimer();
        this.updateMediaKBJobButton("running");
        const config = this.mediaKbSettings.get();
        void this.mediaKbRunner
            .run(
                {
                    input: options.input,
                    localFile: options.localFile,
                    expandMultipart: options.expandMultipart,
                    expandCollection: config.expandCollection,
                    force: options.force,
                    onLog: (line) => {
                        this.mediaKbJobLog.push(line);
                        if (this.mediaKbJobLog.length > 400) this.mediaKbJobLog.shift();
                        this.scheduleMediaKBJobRefresh();
                    },
                },
                this.mediaKbSettings,
            )
            .then((result) => {
                this.mediaKbJobStatus = "success";
                const parts = [
                    `转写稿 ${result.importResult.transcripts.length}`,
                    `LLM ${result.importResult.cards.length}`,
                    `概念 ${result.importResult.concepts.length}`,
                ];
                if (result.importResult.topics.length) parts.push(`主题 ${result.importResult.topics.length}`);
                this.updateMediaKBJobButton("success", "MediaKB 完成（点击查看）");
                this.scheduleMediaKBJobRefresh();
                showMessage(`MediaKB 归档完成：${parts.join("，")}`, 6000);
                this.scheduleMediaKBJobHide(8000);
            })
            .catch((error) => {
                const message = String((error as any)?.message || error);
                this.mediaKbJobStatus = "error";
                this.mediaKbJobError = message;
                this.mediaKbJobLog.push(`错误：${message}`);
                this.clearMediaKBJobHideTimer();
                this.updateMediaKBJobButton("error", "MediaKB 失败（点击查看）");
                this.scheduleMediaKBJobRefresh();
                showMessage(`MediaKB 失败：${message}`, 8000, "error");
                this.openMediaKBJobDialog();
            });
    }

    private clearMediaKBJobHideTimer(): void {
        if (this.mediaKbJobHideTimer !== null) {
            window.clearTimeout(this.mediaKbJobHideTimer);
            this.mediaKbJobHideTimer = null;
        }
    }

    private scheduleMediaKBJobHide(delay: number): void {
        this.clearMediaKBJobHideTimer();
        this.mediaKbJobHideTimer = window.setTimeout(() => {
            this.mediaKbJobButton?.remove();
            this.mediaKbJobButton = null;
            this.mediaKbJobHideTimer = null;
            if (this.mediaKbJobStatus === "success") this.mediaKbJobStatus = "idle";
        }, delay);
    }

    private updateMediaKBJobButton(status: string, message = ""): void {
        if (!this.mediaKbJobButton) {
            const button = document.createElement("button");
            button.className = "b3-button b3-button--outline";
            button.style.cssText =
                "position:fixed;right:18px;bottom:48px;z-index:2147483000;box-shadow:var(--b3-dialog-shadow);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            button.addEventListener("click", () => this.openMediaKBJobDialog());
            this.mediaKbJobButton = button;
            document.body.appendChild(button);
        }
        const labels: Record<string, string> = {
            running: "MediaKB 正在后台转写…",
            success: "MediaKB 完成",
            error: "MediaKB 失败",
        };
        this.mediaKbJobButton.textContent = message || labels[status] || "MediaKB";
        this.mediaKbJobButton.setAttribute("title", status === "error" ? this.mediaKbJobError : "点击查看 MediaKB 任务日志");
    }

    private async importMediaKBRecent(): Promise<void> {
        if (!this.mediaKbSettings) return;
        if (this.mediaKbRunner?.isRunning()) {
            showMessage("MediaKB 任务正在运行，完成后会自动导入；也可先取消再导入已有结果", 4000);
            return;
        }
        try {
            const importer = new MediaKBImporter(this);
            const result = await importer.importRecent(Date.now() - 30 * 60 * 1000, "", this.mediaKbSettings);
            const parts = [
                `转写稿 ${result.transcripts.length}`,
                `LLM ${result.cards.length}`,
                `概念 ${result.concepts.length}`,
            ];
            if (result.topics.length) parts.push(`主题 ${result.topics.length}`);
            showMessage(`导入最近结果完成：${parts.join("，")}${result.indexDocId ? "，索引已更新" : ""}`, 6000);
        } catch (error) {
            showMessage(`导入最近结果失败：${String((error as any)?.message || error)}`, 7000, "error");
        }
    }

    openMediaKBJobDialog(): void {
        this.mediaKbJobDialog?.destroy();
        const statusText = this.mediaKBJobStatusText();
        const logs = this.mediaKbJobLog.length ? this.mediaKbJobLog.join("\n") : "暂无日志";
        const dialog = new Dialog({
            title: "MediaKB 任务日志",
            content: `<div style="display:flex;flex-direction:column;gap:8px;padding:8px 0;box-sizing:border-box;height:100%;">
                <div style="display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85;">
                    <span data-role="status">状态：${escapeHtml(statusText)}</span>
                    ${this.mediaKbJobStatus === "running" ? '<button class="b3-button b3-button--outline" data-role="cancel" style="margin-left:auto;">取消任务</button>' : ""}
                </div>
                <pre data-role="log" style="flex:1;min-height:0;overflow:auto;margin:0;white-space:pre-wrap;font:12px/1.55 ui-monospace,Consolas,monospace;background:var(--b3-theme-background);border:1px solid var(--b3-border-color);border-radius:6px;padding:8px;">${escapeHtml(logs)}</pre>
            </div>`,
            width: "760px",
            height: "560px",
            destroyCallback: () => {
                this.mediaKbJobDialog = null;
                this.mediaKbJobStatusElement = null;
                this.mediaKbJobLogElement = null;
            },
        });
        this.mediaKbJobDialog = dialog;
        this.mediaKbJobStatusElement = dialog.element.querySelector('[data-role="status"]') as HTMLElement | null;
        this.mediaKbJobLogElement = dialog.element.querySelector('[data-role="log"]') as HTMLElement | null;
        const cancel = dialog.element.querySelector('[data-role="cancel"]') as HTMLButtonElement | null;
        cancel?.addEventListener("click", () => {
            this.mediaKbRunner?.cancel();
            cancel.disabled = true;
            cancel.textContent = "正在取消…";
        });
    }

    private mediaKBJobStatusText(): string {
        if (this.mediaKbJobStatus === "running") return "正在运行";
        if (this.mediaKbJobStatus === "success") return "已完成";
        if (this.mediaKbJobStatus === "error") return `失败：${this.mediaKbJobError}`;
        return "空闲";
    }

    private scheduleMediaKBJobRefresh(): void {
        if (!this.mediaKbJobDialog) return;
        if (this.mediaKbJobRefreshTimer !== null) return;
        this.mediaKbJobRefreshTimer = window.setTimeout(() => {
            this.mediaKbJobRefreshTimer = null;
            if (!this.mediaKbJobDialog) return;
            if (this.mediaKbJobStatusElement) this.mediaKbJobStatusElement.textContent = `状态：${this.mediaKBJobStatusText()}`;
            const log = this.mediaKbJobLogElement;
            if (!log) return;
            const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
            log.textContent = this.mediaKbJobLog.join("\n") || "暂无日志";
            if (nearBottom) log.scrollTop = log.scrollHeight;
        }, 120);
    }

    openSetting(): void {
        const manager = this.hotkeys;
        if (!manager) return;
        const setting = new Setting({ width: "1040px", height: "680px" });
        for (const action of Object.keys(ACTION_LABELS) as HotkeyAction[]) {
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;align-items:center;gap:8px;flex:none;max-width:100%;";
            const input = document.createElement("input");
            input.className = "b3-text-field";
            input.readOnly = true;
            input.style.width = "200px";
            input.style.maxWidth = "200px";
            input.style.minWidth = "120px";
            input.style.flex = "0 1 200px";
            input.value = manager.getConfig()[action];
            input.placeholder = "点击后按组合键";
            input.addEventListener("focus", () => manager.setRecording(true));
            input.addEventListener("blur", () => manager.setRecording(false));
            input.addEventListener(
                "keydown",
                (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    const binding = bindingFromEvent(event);
                    if (!binding) {
                        showMessage("请同时按下 Ctrl/Command/Alt 与一个按键（例如 Ctrl+Alt+T）", 3000);
                        return;
                    }
                    input.value = binding;
                    void manager.setBinding(action, binding);
                },
                true,
            );
            const reset = document.createElement("button");
            reset.className = "b3-button b3-button--outline";
            reset.textContent = "恢复默认";
            reset.style.whiteSpace = "nowrap";
            reset.style.flex = "none";
            reset.addEventListener("click", async () => {
                await manager.resetBinding(action);
                input.value = manager.getConfig()[action];
            });
            wrap.append(input, reset);
            setting.addItem({
                title: ACTION_LABELS[action].title,
                description: ACTION_LABELS[action].description,
                actionElement: wrap,
            });
        }

        const linkSettings = this.linkText;
        if (linkSettings) {
            let linkConfig = linkSettings.get();
            const presetWrap = document.createElement("div");
            presetWrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
            const presetSelect = document.createElement("select");
            presetSelect.className = "b3-select";
            for (const preset of LINK_TEXT_PRESETS) {
                const option = document.createElement("option");
                option.value = preset.id;
                option.textContent = preset.label;
                option.title = preset.description;
                if (linkConfig.preset === preset.id) option.selected = true;
                presetSelect.appendChild(option);
            }
            const resetLinkText = document.createElement("button");
            resetLinkText.className = "b3-button b3-button--outline";
            resetLinkText.textContent = "恢复默认";
            presetWrap.append(presetSelect, resetLinkText);

            const templateInputs: Partial<Record<LinkTextTarget, HTMLInputElement>> = {};
            const templatesWrap = document.createElement("div");
            templatesWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;width:440px;max-width:100%;";
            const templateLabels: Array<{ target: LinkTextTarget; label: string }> = [
                { target: "timestamp", label: "时间戳" },
                { target: "screenshot", label: "截图 alt" },
                { target: "clip", label: "片段链接" },
            ];
            for (const item of templateLabels) {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;";
                const label = document.createElement("span");
                label.textContent = item.label;
                label.style.cssText = "width:70px;flex:none;font-size:12px;opacity:.8;";
                const input = document.createElement("input");
                input.className = "b3-text-field";
                input.style.cssText = "flex:1;min-width:180px;";
                input.value = linkConfig.templates[item.target];
                input.placeholder = "例如 {time} · {title:16}";
                input.addEventListener("input", () => {
                    const next = { ...linkConfig, preset: "custom" as const, templates: { ...linkConfig.templates, [item.target]: input.value } };
                    linkConfig = next;
                    if (previewText) previewText.textContent = previewFor("timestamp");
                });
                input.addEventListener("change", async () => {
                    await linkSettings.setTemplate(item.target, input.value);
                    linkConfig = linkSettings.get();
                    presetSelect.value = "custom";
                    syncTemplateInputs();
                    updatePreview();
                });
                templateInputs[item.target] = input;
                row.append(label, input);
                templatesWrap.appendChild(row);
            }

            const optionsWrap = document.createElement("div");
            optionsWrap.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
            const maxSelect = document.createElement("select");
            maxSelect.className = "b3-select";
            for (const limit of [0, 12, 16, 20, 24, 32]) {
                const option = document.createElement("option");
                option.value = String(limit);
                option.textContent = limit === 0 ? "不截断" : `${limit} 字`;
                if (linkConfig.maxChars === limit) option.selected = true;
                maxSelect.appendChild(option);
            }
            const ellipsisSelect = document.createElement("select");
            ellipsisSelect.className = "b3-select";
            for (const mode of ["end", "middle"] as const) {
                const option = document.createElement("option");
                option.value = mode;
                option.textContent = mode === "end" ? "末尾省略" : "中间省略";
                if (linkConfig.ellipsis === mode) option.selected = true;
                ellipsisSelect.appendChild(option);
            }
            const iconInput = document.createElement("input");
            iconInput.className = "b3-text-field";
            iconInput.style.width = "64px";
            iconInput.placeholder = "⏱";
            iconInput.value = linkConfig.icon;
            const stripExtLabel = document.createElement("label");
            stripExtLabel.style.cssText = "display:flex;align-items:center;gap:4px;font-size:12px;";
            const stripExt = document.createElement("input");
            stripExt.type = "checkbox";
            stripExt.checked = linkConfig.stripVideoExt;
            stripExtLabel.append(stripExt, document.createTextNode("去扩展名"));
            const cleanBiliLabel = document.createElement("label");
            cleanBiliLabel.style.cssText = "display:flex;align-items:center;gap:4px;font-size:12px;";
            const cleanBili = document.createElement("input");
            cleanBili.type = "checkbox";
            cleanBili.checked = linkConfig.cleanBilibiliTitle;
            cleanBiliLabel.append(cleanBili, document.createTextNode("清理B站后缀"));
            const syncButton = document.createElement("button");
            syncButton.className = "b3-button b3-button--text";
            syncButton.textContent = "同步到全部";
            optionsWrap.append(
                document.createTextNode("最大长度"),
                maxSelect,
                ellipsisSelect,
                iconInput,
                stripExtLabel,
                cleanBiliLabel,
                syncButton,
            );

            const previewText = document.createElement("span");
            previewText.style.cssText = "font-size:12px;opacity:.85;word-break:break-all;";
            const previewWrap = document.createElement("div");
            previewWrap.style.cssText = "display:flex;align-items:center;gap:8px;width:440px;max-width:100%;";
            previewWrap.append(previewText);

            const syncTemplateInputs = (): void => {
                for (const item of templateLabels) {
                    const input = templateInputs[item.target];
                    if (input) {
                        input.value = linkConfig.templates[item.target];
                        input.disabled = linkConfig.preset !== "custom";
                    }
                }
            };
            const previewFor = (target: LinkTextTarget): string => {
                return formatLinkText(linkConfig, {
                    target,
                    seconds: 1122,
                    title: "让天下没有难写的论文：中科院研究生如何用AI把idea一步步变成论文",
                    filename: "1-Earth Day for Kids.mp4",
                    provider: "bilibili",
                    bvid: "BV1LKjS6gEh4",
                    page: 1,
                    folder: "Holiday Videos",
                    durationSeconds: 1790,
                });
            };
            const updatePreview = (): void => {
                previewText.textContent = `预览：${previewFor("timestamp")}　|　截图：${previewFor("screenshot")}`;
            };
            const saveOptions = async (): Promise<void> => {
                await linkSettings.update({
                    maxChars: Number(maxSelect.value),
                    ellipsis: ellipsisSelect.value as "end" | "middle",
                    icon: iconInput.value,
                    stripVideoExt: stripExt.checked,
                    cleanBilibiliTitle: cleanBili.checked,
                });
                linkConfig = linkSettings.get();
                updatePreview();
            };
            presetSelect.addEventListener("change", async () => {
                await linkSettings.setPreset(presetSelect.value as any);
                linkConfig = linkSettings.get();
                syncTemplateInputs();
                updatePreview();
            });
            resetLinkText.addEventListener("click", async () => {
                await linkSettings.reset();
                linkConfig = linkSettings.get();
                presetSelect.value = linkConfig.preset;
                maxSelect.value = String(linkConfig.maxChars);
                ellipsisSelect.value = linkConfig.ellipsis;
                iconInput.value = linkConfig.icon;
                stripExt.checked = linkConfig.stripVideoExt;
                cleanBili.checked = linkConfig.cleanBilibiliTitle;
                syncTemplateInputs();
                updatePreview();
            });
            maxSelect.addEventListener("change", () => void saveOptions());
            ellipsisSelect.addEventListener("change", () => void saveOptions());
            iconInput.addEventListener("change", () => void saveOptions());
            stripExt.addEventListener("change", () => void saveOptions());
            cleanBili.addEventListener("change", () => void saveOptions());
            syncButton.addEventListener("click", async () => {
                const source = templateInputs.timestamp?.value || linkConfig.templates.timestamp;
                await linkSettings.update({
                    preset: "custom",
                    templates: { timestamp: source, screenshot: source, clip: source },
                });
                linkConfig = linkSettings.get();
                presetSelect.value = "custom";
                syncTemplateInputs();
                updatePreview();
            });
            syncTemplateInputs();
            updatePreview();

            setting.addItem({
                title: "链接文本格式",
                description: "时间戳链接、截图 alt、片段链接的显示文本。支持预设和自定义模板，链接目标不受影响。",
                actionElement: presetWrap,
            });
            setting.addItem({
                title: "模板",
                description: "Token：{time} {time_full} {title} {title:16} {filename_noext} {provider} {bv} {p} {folder} {duration} {date} {icon}。",
                actionElement: templatesWrap,
            });
            setting.addItem({
                title: "截断与清理",
                description: "默认 16 字；按中文/emoji 字素截断。去扩展名和清理 B 站标题后缀只影响显示文本。",
                actionElement: optionsWrap,
            });
            setting.addItem({
                title: "实时预览",
                description: "使用示例视频标题预览当前模板。",
                actionElement: previewWrap,
            });
        }

        const mediaKbWrap = document.createElement("div");
        mediaKbWrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
        const mediaKbConfigButton = document.createElement("button");
        mediaKbConfigButton.className = "b3-button b3-button--outline";
        mediaKbConfigButton.textContent = "配置 MediaKB";
        mediaKbConfigButton.addEventListener("click", () => this.mediaKbSettingsDialog?.open());
        const mediaKbInputButton = document.createElement("button");
        mediaKbInputButton.className = "b3-button b3-button--text";
        mediaKbInputButton.textContent = "打开链接输入框";
        mediaKbInputButton.addEventListener("click", () => this.openMediaKBDialog());
        const mediaKbHint = document.createElement("span");
        mediaKbHint.style.cssText = "font-size:11px;opacity:.75;";
        mediaKbHint.textContent = "默认快捷键 Ctrl+Alt+M";
        mediaKbWrap.append(mediaKbConfigButton, mediaKbInputButton, mediaKbHint);
        setting.addItem({
            title: "MediaKB 归档",
            description: "配置 MediaKB 路径和转写稿/LLM/概念笔记本；快捷键打开链接输入框，自动转写、LLM 整理并导入思源。",
            actionElement: mediaKbWrap,
        });
        const clipWrap = document.createElement("div");
        clipWrap.style.cssText = "display:flex;align-items:center;gap:8px;";
        const clipSelect = document.createElement("select");
        clipSelect.className = "b3-select";
        for (const seconds of CLIP_DURATION_OPTIONS) {
            const option = document.createElement("option");
            option.value = String(seconds);
            option.textContent = `${seconds} 秒`;
            if (manager.getConfig().clipSeconds === seconds) option.selected = true;
            clipSelect.appendChild(option);
        }
        clipSelect.addEventListener("change", () => {
            void manager.setClipSeconds(Number(clipSelect.value));
        });
        clipWrap.append(clipSelect);
        setting.addItem({
            title: "片段截取时长",
            description: "工具栏「片段」按钮、片段快捷键与命令都使用该时长（3/5/10/15/30 秒）。",
            actionElement: clipWrap,
        });

        const toolbarWrap = document.createElement("div");
        toolbarWrap.style.cssText = "display:flex;align-items:center;gap:8px;";
        const toolbarCheckbox = document.createElement("input");
        toolbarCheckbox.type = "checkbox";
        toolbarCheckbox.className = "b3-switch";
        toolbarCheckbox.checked = manager.getConfig().hideToolbar;
        toolbarCheckbox.addEventListener("change", async () => {
            await manager.setHideToolbar(toolbarCheckbox.checked);
            showMessage("工具栏显示设置已保存，重新打开浏览器页签后生效", 3000);
        });
        toolbarWrap.append(toolbarCheckbox);
        setting.addItem({
            title: "隐藏浏览器工具栏",
            description: "开启后只保留悬浮的小按钮，播放控制全部可通过可配置快捷键完成。",
            actionElement: toolbarWrap,
        });
        const cloudConfig = this.cloudDrive.getConfig();
        const cloudWrap = document.createElement("div");
        cloudWrap.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;";
        const cloudBaseInput = document.createElement("input");
        cloudBaseInput.className = "b3-text-field";
        cloudBaseInput.style.width = "320px";
        cloudBaseInput.placeholder = "OpenList/AList 地址，如 http://127.0.0.1:5244";
        cloudBaseInput.value = cloudConfig.baseUrl;
        const cloudUserInput = document.createElement("input");
        cloudUserInput.className = "b3-text-field";
        cloudUserInput.style.width = "120px";
        cloudUserInput.placeholder = "用户名";
        cloudUserInput.value = cloudConfig.username;
        const cloudPassInput = document.createElement("input");
        cloudPassInput.className = "b3-text-field";
        cloudPassInput.style.width = "140px";
        cloudPassInput.type = "password";
        cloudPassInput.placeholder = cloudConfig.token ? "密码（已登录，留空保留）" : "密码";
        const cloudLoginButton = document.createElement("button");
        cloudLoginButton.className = "b3-button b3-button--outline";
        cloudLoginButton.textContent = "连接并保存";
        const cloudStatus = document.createElement("span");
        cloudStatus.style.cssText = "font-size:12px;opacity:.8;";
        cloudStatus.textContent = cloudConfig.token ? `已保存登录：${cloudConfig.username || "admin"}` : "未连接";
        const cloudBrowseButton = document.createElement("button");
        cloudBrowseButton.className = "b3-button b3-button--text";
        cloudBrowseButton.textContent = "打开网盘浏览";
        cloudBrowseButton.addEventListener("click", () => this.openCloudTab());
        const cloudMountsButton = document.createElement("button");
        cloudMountsButton.className = "b3-button b3-button--text";
        cloudMountsButton.textContent = "管理挂载";
        cloudMountsButton.addEventListener("click", () => this.openCloudMountsTab());
        const nativeCloudButton = document.createElement("button");
        nativeCloudButton.className = "b3-button b3-button--outline";
        nativeCloudButton.textContent = "打开原生网盘（实验）";
        nativeCloudButton.addEventListener("click", () => this.openNativeCloudTab());
        cloudLoginButton.addEventListener("click", async () => {
            try {
                await this.connectCloudDrive(cloudBaseInput.value, cloudUserInput.value.trim(), cloudPassInput.value);
                cloudPassInput.value = "";
                cloudStatus.textContent = `已连接：${cloudUserInput.value.trim() || "admin"}`;
            } catch {
                /* message already shown */
            }
        });
        cloudWrap.append(cloudBaseInput, cloudUserInput, cloudPassInput, cloudLoginButton, cloudBrowseButton, cloudMountsButton, nativeCloudButton, cloudStatus);
        setting.addItem({
            title: "网盘挂载（OpenList / AList）",
            description:
                "在 OpenList/AList 中挂载百度、夸克、阿里云盘等存储后，填入服务地址与账号密码即可在插件内浏览目录、直接播放视频。" +
                "密码仅用于本次登录，插件只保存服务地址、用户名和临时 token；不上传任何文件。",
            actionElement: cloudWrap,
        });
        setting.addItem({
            title: "网盘说明",
            description:
                "网盘文件浏览由插件内的网盘页签完成（不是打开 OpenList 网页）；支持文件夹导航、视频直接播放。" +
                "原生百度/夸克/阿里 OAuth 授权仍由 OpenList/AList 服务负责，插件不保存这些网盘的账号密码。",
            actionElement: document.createElement("span"),
        });
        setting.addItem({
            title: "说明",
            description:
                "快捷键仅在思源窗口内生效：编辑器聚焦时用宿主键盘事件，B 站视频聚焦时用 guest 桥接。" +
                "登录状态保存在本地 webview 分区 persist:siyuan-video-navigator，重启思源后保留；插件不读取、不上传 Cookie。",
            actionElement: document.createElement("span"),
        });
        this.setting = setting;
        setting.open(this.name);
    }

    async insertTimestamp(source: "command" | "bridge" | "dev" | "hotkey"): Promise<void> {
        try {
            const api = this.nativeCloud?.getPlayerApi();
            const context = api?.isActive() ? api.getContext() : null;
            if (context) {
                this.insertNativeTimestamp(context.provider, context.fileId, context.name, context.seconds, context.dirId, context.stack);
                return;
            }
            const result = await this.getTimestampService().insertAtLastTarget();
            this.lastInsert = { at: new Date().toISOString(), source, ok: true, result };
            showMessage(`已插入时间戳 ${result.displayTime} · ${result.bvid ? `${result.bvid} P${result.page}` : "网页视频"}`, 2500);
            console.log("[siyuan-video-navigator] timestamp inserted", { source, ...result });
        } catch (error) {
            const message = String((error as Error)?.message || error);
            this.lastInsert = { at: new Date().toISOString(), source, ok: false, error: message };
            showMessage(`插入失败：${message}`, 6000, "error");
            console.error("[siyuan-video-navigator] insert timestamp failed", error);
        }
    }

    async insertScreenshot(source: "command" | "bridge" | "dev" | "hotkey"): Promise<void> {
        try {
            const api = this.nativeCloud?.getPlayerApi();
            const context = api?.isActive() ? api.getContext() : null;
            if (api && context) {
                const frame = await api.captureFrame();
                await this.insertNativeScreenshot(context, frame);
                showMessage("已插入网盘视频截图", 2500);
                return;
            }
            const result = await this.getScreenshotService().insertAtLastTarget();
            this.lastScreenshot = { at: new Date().toISOString(), source, ok: true, result };
            showMessage(`已插入截图 ${result.assetPath} · ${result.bvid ? `${result.bvid} P${result.page}` : "网页视频"} · ${result.timeSeconds}s`, 3000);
            console.log("[siyuan-video-navigator] screenshot inserted", { source, ...result });
        } catch (error) {
            const message = String((error as Error)?.message || error);
            this.lastScreenshot = { at: new Date().toISOString(), source, ok: false, error: message };
            showMessage(`截图插入失败：${message}`, 6000, "error");
            console.error("[siyuan-video-navigator] insert screenshot failed", error);
        }
    }

    async insertClip(seconds: number, source: "command" | "dev" | "hotkey" = "command"): Promise<void> {
        try {
            const api = this.nativeCloud?.getPlayerApi();
            const context = api?.isActive() ? api.getContext() : null;
            if (api && context) {
                showMessage(`正在录制网盘视频 ${seconds} 秒片段…`, 3000);
                const clip = await api.captureClip(seconds);
                await this.insertNativeClip(context, clip);
                showMessage(`已插入网盘视频 ${seconds}s 片段`, 3000);
                return;
            }
            showMessage(`正在录制 ${seconds} 秒片段，请保持播放…`, 3000);
            const result = await this.getClipService().insertAtLastTarget(seconds);
            this.lastClip = { at: new Date().toISOString(), source, ok: true, result };
            showMessage(`已插入 ${result.durationSeconds}s 片段 · ${result.bvid ? `${result.bvid} P${result.page}` : "网页视频"} · ${result.startSeconds}s`, 5000);
            console.log("[siyuan-video-navigator] clip inserted", { source, ...result });
        } catch (error) {
            const message = String((error as Error)?.message || error);
            this.lastClip = { at: new Date().toISOString(), source, ok: false, error: message };
            showMessage(`片段录制失败：${message}`, 6000, "error");
            console.error("[siyuan-video-navigator] insert clip failed", error);
        }
    }

    private subscribeStatusBar(): void {
        if (!this.statusBarElement) return;
        this.unsubscribeStatus = this.browser.subscribe((state) => {
            const text = this.statusBarElement?.querySelector(".svn-statusbar__text");
            if (!text) return;
            if (state.hasVideo && state.bvid) {
                let time = "--:--";
                try {
                    time = formatTimestamp(state.currentTime || 0);
                } catch {
                    /* ignore */
                }
                text.textContent = `${state.bvid} P${state.page} · ${time}`;
            } else if (state.attached) {
                text.textContent = "B 站浏览器";
            } else {
                text.textContent = "视频导航";
            }
        });
    }

    private startStatusTimer(): void {
        this.stopStatusTimer();
        this.statusTimer = window.setInterval(() => {
            if (this.browser.isAttached()) {
                void this.browser.getSnapshot().catch(() => undefined);
            }
        }, 1500);
    }

    private stopStatusTimer(): void {
        if (this.statusTimer !== null) {
            window.clearInterval(this.statusTimer);
            this.statusTimer = null;
        }
    }
}
