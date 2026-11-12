import type { Plugin } from "siyuan";
import { CredentialVault } from "@/cloud/native/CredentialVault";
import { MediaProxy } from "@/cloud/native/MediaProxy";
import { QuarkProvider } from "@/cloud/native/QuarkProvider";
import { BaiduProvider } from "@/cloud/native/BaiduProvider";
import { AliyunProvider } from "@/cloud/native/AliyunProvider";
import { AliyunSessionInjector } from "@/cloud/native/AliyunSessionInjector";
import { MountManager } from "@/cloud/native/MountManager";
import type { NativeCloudCredential, NativeCloudEntry, NativeCloudProvider } from "@/cloud/native/types";

export interface NativeMountInfo {
    provider: string;
    label: string;
    connected: boolean;
    encrypted: boolean;
}

export interface NativePlayRequest {
    provider: string;
    fileId: string;
    name: string;
    seconds: number;
    /** Folder containing the file, so click-back can restore the list. */
    dirId?: string;
    stack?: Array<{ id: string; name: string }>;
}

export interface NativePlayerContext extends NativePlayRequest {
    dirId: string;
    stack: Array<{ id: string; name: string }>;
}

export interface NativeClipCapture {
    base64: string;
    mime: string;
    byteLength: number;
    duration: number;
    width: number;
    height: number;
    hasAudio: boolean;
    mode: string;
}

/** Interface exposed by the inline native player to plugin hotkeys. */
export interface NativePlayerApi {
    isActive(): boolean;
    togglePlay(): void;
    seekRelative(delta: number): void;
    getContext(): NativePlayerContext | null;
    captureFrame(): Promise<{ dataUrl: string; width: number; height: number }>;
    captureClip(seconds: number): Promise<NativeClipCapture>;
}

/** Experimental native cloud service: credentials, provider dispatch and playable streams. */
export class NativeCloudService {
    readonly vault: CredentialVault;
    readonly proxy = new MediaProxy();
    readonly mounts: MountManager;
    readonly aliyunInjector = new AliyunSessionInjector();
    private readonly providers: Record<string, NativeCloudProvider> = {};
    private activeProviderId = "baidu";
    private pendingPlay: NativePlayRequest | null = null;
    private playerApi: NativePlayerApi | null = null;
    private readonly playableCache = new Map<string, { result: { url: string; title: string; kind?: "video" | "hls" }; expiresAt: number }>();
    private readonly playableInflight = new Map<string, Promise<{ url: string; title: string; kind?: "video" | "hls" }>>();
    private readonly dirCache = new Map<string, { entries: NativeCloudEntry[]; expiresAt: number }>();
    private readonly locateCache = new Map<string, { result: { dirId: string; stack: Array<{ id: string; name: string }> } | null; expiresAt: number }>();
    lastPlayDebug: { host: string; additionalHeaders: string; urlHostKind: string } | null = null;

    constructor(plugin: Plugin) {
        this.vault = new CredentialVault(plugin);
        this.mounts = new MountManager(plugin);
        for (const provider of [new BaiduProvider(), new QuarkProvider(), new AliyunProvider()]) {
            this.providers[provider.id] = provider;
        }
    }

    async init(): Promise<void> {
        await this.vault.load();
        await this.mounts.load();
        await this.restoreFromLoginPartitions();
        for (const provider of Object.values(this.providers)) {
            if (this.vault.has(provider.id)) {
                this.activeProviderId = provider.id;
                break;
            }
        }
    }

    /**
     * If the plugin data was lost/corrupted but the embedded login webview
     * partition still has cookies, recover the login automatically.
     */
    async restoreFromLoginPartitions(): Promise<string[]> {
        const restored: string[] = [];
        try {
            const requireFn = (globalThis as any).require || (window as any).require;
            const remote = requireFn("@electron/remote");
            const sessionApi = remote?.session;
            if (!sessionApi?.fromPartition) return restored;
            const targets: Array<{ provider: string; partition: string; url: string }> = [
                { provider: "baidu", partition: "persist:svn-native-login-baidu", url: "https://pan.baidu.com/" },
                { provider: "quark", partition: "persist:svn-native-login-quark", url: "https://pan.quark.cn/" },
            ];
            for (const target of targets) {
                if (this.vault.has(target.provider)) continue;
                try {
                    const session = sessionApi.fromPartition(target.partition);
                    const cookies = await session.cookies.get({ url: target.url });
                    const header = (cookies || []).map((item: any) => `${item.name}=${item.value}`).join("; ");
                    if (!header) continue;
                    const credential: NativeCloudCredential = { provider: target.provider, values: { cookie: header } };
                    await this.getProvider(target.provider).validate(credential);
                    await this.vault.set(credential);
                    restored.push(target.provider);
                } catch {
                    /* expired or unavailable; keep going */
                }
            }
        } catch {
            /* remote/session unavailable */
        }
        return restored;
    }

    getActiveProviderId(): string {
        return this.activeProviderId;
    }

    setActiveProvider(providerId: string): void {
        if (this.providers[providerId]) this.activeProviderId = providerId;
    }

    setPendingPlay(request: NativePlayRequest): void {
        this.pendingPlay = request;
    }

    consumePendingPlay(): NativePlayRequest | null {
        const request = this.pendingPlay;
        this.pendingPlay = null;
        return request;
    }

    setPlayerApi(api: NativePlayerApi | null): void {
        this.playerApi = api;
    }

    getPlayerApi(): NativePlayerApi | null {
        return this.playerApi;
    }

    getProvider(id = this.activeProviderId): NativeCloudProvider {
        const provider = this.providers[id];
        if (!provider) throw new Error("不支持的网盘驱动：" + id);
        return provider;
    }

    getMounts(): NativeMountInfo[] {
        return Object.values(this.providers).map((provider) => ({
            provider: provider.id,
            label: provider.name,
            connected: this.vault.has(provider.id),
            encrypted: this.vault.isAvailable(),
        }));
    }

    async connect(providerId: string, values: Record<string, string>): Promise<void> {
        const provider = this.getProvider(providerId);
        const credential: NativeCloudCredential = { provider: providerId, values };
        await provider.validate(credential);
        this.activeProviderId = providerId;
        this.clearPlayableCache(providerId);
        this.clearDirectoryCache(providerId);
        try {
            await this.vault.set(credential);
        } catch {
            this.vault.rememberSession(credential);
        }
    }

    async disconnect(providerId: string): Promise<void> {
        await this.vault.clear(providerId);
        this.clearPlayableCache(providerId);
        this.clearDirectoryCache(providerId);
        this.proxy.stop();
    }

    async list(dirId: string, providerId = this.activeProviderId, force = false): Promise<NativeCloudEntry[]> {
        const key = `${providerId}:${dirId}`;
        const cached = this.dirCache.get(key);
        if (!force && cached && cached.expiresAt > Date.now()) return cached.entries;
        const credential = await this.vault.get(providerId);
        if (!credential) throw new Error("尚未登录网盘");
        const entries = await this.getProvider(providerId).list(credential, dirId);
        this.dirCache.set(key, { entries, expiresAt: Date.now() + 30 * 1000 });
        return entries;
    }

    clearDirectoryCache(providerId?: string): void {
        if (!providerId) {
            this.dirCache.clear();
            return;
        }
        for (const key of [...this.dirCache.keys()]) {
            if (key.startsWith(`${providerId}:`)) this.dirCache.delete(key);
        }
    }

    async search(query: string, providerId = this.activeProviderId): Promise<NativeCloudEntry[]> {
        const credential = await this.vault.get(providerId);
        if (!credential) throw new Error("尚未登录网盘");
        const provider = this.getProvider(providerId);
        if (!provider.search) throw new Error("当前网盘驱动不支持搜索");
        return provider.search(credential, query);
    }

    async locate(fileId: string, providerId = this.activeProviderId): Promise<{ dirId: string; stack: Array<{ id: string; name: string }> } | null> {
        const key = `${providerId}:${fileId}`;
        const cached = this.locateCache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.result;
        const credential = await this.vault.get(providerId);
        if (!credential) return null;
        const provider = this.getProvider(providerId);
        const result = provider.locate ? await provider.locate(credential, fileId) : null;
        this.locateCache.set(key, { result, expiresAt: Date.now() + 10 * 60 * 1000 });
        return result;
    }

    async makePlayableUrl(fileId: string, providerId = this.activeProviderId): Promise<{ url: string; title: string; kind?: "video" | "hls" }> {
        if (!fileId || !String(fileId).trim()) throw new Error("文件 ID 为空，链接可能已损坏，请重新插入时间戳");
        const provider = providerId;
        const key = `${provider}:${fileId}`;
        const cached = this.playableCache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.result;
        const existing = this.playableInflight.get(key);
        if (existing) return existing;
        const promise = this.resolvePlayableUrlWithRetry(provider, fileId)
            .then((result) => {
                this.playableCache.set(key, { result, expiresAt: Date.now() + 5 * 60 * 1000 });
                return result;
            })
            .finally(() => {
                this.playableInflight.delete(key);
            });
        this.playableInflight.set(key, promise);
        return promise;
    }

    clearPlayableCache(providerId?: string): void {
        if (!providerId) {
            this.playableCache.clear();
            return;
        }
        for (const key of [...this.playableCache.keys()]) {
            if (key.startsWith(`${providerId}:`)) this.playableCache.delete(key);
        }
    }

    private async resolvePlayableUrlWithRetry(providerId: string, fileId: string): Promise<{ url: string; title: string; kind?: "video" | "hls" }> {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await this.resolvePlayableUrl(providerId, fileId);
            } catch (error) {
                lastError = error;
                const message = String((error as Error)?.message || error);
                // Auth errors cannot be fixed by retrying.
                if (/cookie|登录|refresh_token|access_token|已过期|未登录/i.test(message)) throw error;
                if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async resolvePlayableUrl(providerId: string, fileId: string): Promise<{ url: string; title: string; kind?: "video" | "hls" }> {
        const credential = await this.vault.get(providerId);
        if (!credential) throw new Error("尚未登录网盘");
        const source = await this.getProvider(providerId).resolvePlayUrl(credential, fileId);
        if (providerId === "aliyun") {
            await this.aliyunInjector.install();
            return { url: source.url, title: "网盘视频", kind: source.kind || "video" };
        }
        let signedAdditionalHeaders = "";
        try {
            signedAdditionalHeaders = new URL(source.url).searchParams.get("x-oss-additional-headers") || "";
            this.lastPlayDebug = {
                host: new URL(source.url).hostname,
                additionalHeaders: signedAdditionalHeaders,
                urlHostKind: new URL(source.url).hostname.includes("-internal") ? "internal" : "public",
            };
        } catch {
            signedAdditionalHeaders = "";
            this.lastPlayDebug = null;
        }
        const profiles = [source.headers, ...(source.headerProfiles || [])];
        let chosen: Record<string, string> | null = null;
        let lastError = "";
        for (const headers of profiles) {
            try {
                const probe = await this.proxy.probe(source.url, headers);
                const contentType = probe.contentType.toLowerCase();
                const looksVideo =
                    contentType.includes("video") ||
                    contentType.includes("octet-stream") ||
                    probe.prefix.includes("ftyp") ||
                    probe.prefix.startsWith("ID3");
                if (probe.status < 400 && looksVideo) {
                    chosen = headers;
                    break;
                }
                lastError = `直链返回 HTTP ${probe.status}，Content-Type=${probe.contentType || "空"}，additionalHeaders=${signedAdditionalHeaders || "无"}，内容片段：${probe.prefix
                    .replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, " ")
                    .slice(0, 500)}`;
            } catch (error) {
                lastError = String((error as Error)?.message || error);
            }
        }
        if (!chosen) throw new Error(lastError || "所有百度直链请求头配置均被拒绝");
        const localUrl = await this.proxy.register(source.url, chosen, source.mime, this.activeProviderId === "aliyun");
        return { url: localUrl, title: "网盘视频" };
    }
}
