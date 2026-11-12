export interface CloudDriveConfig {
    baseUrl: string;
    username: string;
    token: string;
}

export interface CloudEntry {
    name: string;
    path: string;
    isDir: boolean;
    size: number;
    modified: string;
    type: number;
}

export interface CloudFileInfo extends CloudEntry {
    rawUrl: string;
    provider: string;
}

const VIDEO_EXTENSIONS = new Set([
    "mp4",
    "mkv",
    "webm",
    "avi",
    "mov",
    "flv",
    "wmv",
    "m4v",
    "ts",
    "m3u8",
    "mpg",
    "mpeg",
    "rmvb",
    "rm",
]);

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"]);

export function isVideoFile(name: string): boolean {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    return VIDEO_EXTENSIONS.has(ext);
}

export function isImageFile(name: string): boolean {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    return IMAGE_EXTENSIONS.has(ext);
}

function nodeRequire(): any {
    const req = (globalThis as any).require || (window as any).require;
    if (typeof req !== "function") throw new Error("当前环境没有 Node 网络能力，无法连接网盘服务");
    return req;
}

interface HttpResponse {
    status: number;
    body: string;
}

/** Small Node HTTP client so OpenList/AList requests are not blocked by CORS. */
async function nodeHttpRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    timeoutMs = 20000,
): Promise<HttpResponse> {
    const req = nodeRequire();
    const target = new URL(url);
    const transport = target.protocol === "https:" ? req("https") : req("http");
    return new Promise<HttpResponse>((resolve, reject) => {
        const request = transport.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (target.protocol === "https:" ? 443 : 80),
                path: `${target.pathname}${target.search}`,
                method,
                headers: { ...headers, ...(body ? { "Content-Length": new TextEncoder().encode(body).length } : {}) },
                timeout: timeoutMs,
            },
            (response: any) => {
                const chunks: Uint8Array[] = [];
                response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
                response.on("end", () => {
                    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                    const merged = new Uint8Array(total);
                    let offset = 0;
                    for (const chunk of chunks) {
                        merged.set(chunk, offset);
                        offset += chunk.length;
                    }
                    resolve({ status: response.statusCode || 0, body: new TextDecoder("utf-8").decode(merged) });
                });
            },
        );
        request.on("timeout", () => request.destroy(new Error("请求超时")));
        request.on("error", (error: Error) => reject(error));
        if (body) request.write(body);
        request.end();
    });
}

/**
 * Integrated cloud-drive browsing backed by OpenList / AList's HTTP API.
 * Drives (Baidu/Quark/Aliyun/WebDAV/...) are mounted inside the OpenList
 * server; this service performs login, directory listing and raw-file lookup
 * so the plugin can browse and play them without leaving SiYuan.
 */
export class CloudDriveService {
    private config: CloudDriveConfig = { baseUrl: "", username: "", token: "" };

    getConfig(): CloudDriveConfig {
        return { ...this.config };
    }

    isConfigured(): boolean {
        return Boolean(this.config.baseUrl && this.config.token);
    }

    setConfig(config: Partial<CloudDriveConfig>): void {
        this.config = { ...this.config, ...config, baseUrl: (config.baseUrl ?? this.config.baseUrl).trim().replace(/\/+$/, "") };
    }

    async login(baseUrl: string, username: string, password: string): Promise<string> {
        const normalized = baseUrl.trim().replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(normalized)) throw new Error("网盘地址必须以 http:// 或 https:// 开头");
        const response = await this.post(normalized, "/api/auth/login", { username, password }, "");
        const token = response?.token;
        if (!token) throw new Error("登录失败：服务端没有返回 token；data=" + JSON.stringify(response).slice(0, 300));
        this.config = { baseUrl: normalized, username, token };
        return token;
    }

    async list(path: string): Promise<CloudEntry[]> {
        const data = await this.post(this.config.baseUrl, "/api/fs/list", {
            path,
            password: "",
            page: 1,
            per_page: 500,
            refresh: false,
        });
        const content = Array.isArray(data?.content) ? data.content : [];
        return content
            .map((item: any) => ({
                name: String(item.name || ""),
                path: joinCloudPath(path, String(item.name || "")),
                isDir: Boolean(item.is_dir),
                size: Number(item.size || 0),
                modified: String(item.modified || ""),
                type: Number(item.type ?? 0),
            }))
            .filter((item: CloudEntry) => item.name)
            .sort((a: CloudEntry, b: CloudEntry) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name, "zh-CN");
            });
    }

    async getFile(path: string): Promise<CloudFileInfo> {
        const data = await this.post(this.config.baseUrl, "/api/fs/get", { path, password: "" });
        const rawUrl = String(data?.raw_url || "");
        if (!rawUrl) throw new Error("服务端没有返回可播放地址（raw_url）");
        return {
            name: String(data?.name || path.split("/").pop() || ""),
            path,
            isDir: Boolean(data?.is_dir),
            size: Number(data?.size || 0),
            modified: String(data?.modified || ""),
            type: Number(data?.type ?? 0),
            rawUrl,
            provider: String(data?.provider || ""),
        };
    }

    async listStorages(): Promise<CloudStorage[]> {
        const data = await this.get(this.config.baseUrl, "/api/admin/storage/list");
        const list = Array.isArray(data) ? data : Array.isArray(data?.content) ? data.content : [];
        return list.map((item: any) => ({
            id: Number(item.id),
            mountPath: String(item.mount_path || ""),
            driver: String(item.driver || ""),
            status: String(item.status || ""),
            remark: String(item.remark || ""),
            disabled: Boolean(item.disabled),
        }));
    }

    async getDriverInfo(driver: string): Promise<CloudDriverInfo> {
        const data = await this.get(this.config.baseUrl, `/api/admin/driver/info?driver=${encodeURIComponent(driver)}`);
        return {
            common: Array.isArray(data?.common) ? data.common : [],
            additional: Array.isArray(data?.additional) ? data.additional : [],
            config: data?.config || {},
        };
    }

    /** All driver display names -> schema (OpenList is case-sensitive). */
    async listDrivers(): Promise<string[]> {
        const data = await this.get(this.config.baseUrl, "/api/admin/driver/list");
        return Object.keys(data || {}).sort((a, b) => a.localeCompare(b));
    }

    async createStorage(payload: CloudStoragePayload): Promise<void> {
        await this.post(this.config.baseUrl, "/api/admin/storage/create", payload as unknown as Record<string, unknown>);
    }

    async deleteStorage(id: number): Promise<void> {
        await this.post(this.config.baseUrl, `/api/admin/storage/delete?id=${id}`, {});
    }

    async updateStorage(payload: CloudStoragePayload & { id: number }): Promise<void> {
        await this.post(this.config.baseUrl, "/api/admin/storage/update", payload as unknown as Record<string, unknown>);
    }

    private async post(baseUrl: string, apiPath: string, body: Record<string, unknown>, token?: string): Promise<any> {
        return this.request(baseUrl, "POST", apiPath, body, token);
    }

    private async get(baseUrl: string, apiPath: string, token?: string): Promise<any> {
        return this.request(baseUrl, "GET", apiPath, undefined, token);
    }

    private async request(baseUrl: string, method: string, apiPath: string, body?: Record<string, unknown>, token?: string): Promise<any> {
        if (!baseUrl) throw new Error("尚未配置网盘地址");
        const auth = token === undefined ? this.config.token : token;
        const headers: Record<string, string> = {};
        if (body) headers["Content-Type"] = "application/json";
        if (auth) headers.Authorization = auth;
        const response = await nodeHttpRequest(`${baseUrl}${apiPath}`, method, headers, body ? JSON.stringify(body) : undefined);
        let json: any = null;
        try {
            json = JSON.parse(response.body);
        } catch {
            throw new Error(`网盘接口返回非 JSON（HTTP ${response.status}）：${response.body.slice(0, 160)}`);
        }
        if (response.status >= 400 || json?.code !== 200) {
            throw new Error(json?.message || `网盘接口错误 HTTP ${response.status}`);
        }
        return json.data;
    }
}

export interface CloudStorage {
    id: number;
    mountPath: string;
    driver: string;
    status: string;
    remark: string;
    disabled: boolean;
}

export interface CloudDriverField {
    name: string;
    type: string;
    default?: string;
    options?: string;
    required?: boolean;
    help?: string;
}

export interface CloudDriverInfo {
    common: CloudDriverField[];
    additional: CloudDriverField[];
    config: any;
}

export interface CloudStoragePayload {
    mount_path: string;
    order: number;
    driver: string;
    cache_expiration: number;
    status: string;
    addition: string;
    remark: string;
    webdav_policy: string;
    disable_index: boolean;
    enable_sign: boolean;
    seed_policy: string;
    web_proxy: boolean;
    down_proxy_url: string;
    disable_proxy_sign: boolean;
    order_by: string;
    order_direction: string;
    extract_folder: string;
}

export function joinCloudPath(parent: string, name: string): string {
    const left = parent === "/" ? "" : parent.replace(/\/+$/, "");
    return `${left}/${name}`;
}

export function parentCloudPath(path: string): string {
    if (!path || path === "/") return "/";
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
}

export function formatSize(size: number): string {
    if (!Number.isFinite(size) || size <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Build the plugin-hosted player page URL. SiYuan serves plugin files under
 * `/plugins/<name>/`, so the page is same-origin with the app while embedding
 * the cloud raw URL; this avoids the webview treating the file as a download.
 */
export function buildCloudPlayerUrl(pluginName: string, rawUrl: string, title: string, seconds = 0): string {
    const siyuan = (window as any)?.siyuan;
    const configured = siyuan?.config?.system?.kernelUrl;
    const hostname = window.location.hostname || "127.0.0.1";
    const baseOrigin = typeof configured === "string" && /^https?:\/\//i.test(configured)
        ? configured.replace(/\/+$/, "")
        : `http://${hostname}:6806`;
    const base = `${baseOrigin}/plugins/${pluginName}/player.html`;
    const params = new URLSearchParams({ src: rawUrl, title });
    if (seconds > 0) params.set("t", String(Math.floor(seconds)));
    return `${base}?${params.toString()}`;
}
