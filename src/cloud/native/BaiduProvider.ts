import type { NativeCloudCredential, NativeCloudEntry, NativeCloudProvider, NativePlaySource } from "@/cloud/native/types";

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/** Baidu Netdisk provider (experimental, cookie auth, read-only). */
export class BaiduProvider implements NativeCloudProvider {
    readonly id = "baidu";
    readonly name = "百度网盘";
    readonly credentialFields = [
        {
            name: "cookie",
            label: "百度网盘 Cookie",
            secret: true,
            placeholder: "BDUSS=...; STOKEN=...; PANWEB=1;",
        },
    ];

    private headers(credential: NativeCloudCredential): Record<string, string> {
        return {
            cookie: credential.values.cookie || "",
            "user-agent": USER_AGENT,
            referer: "https://pan.baidu.com/",
            accept: "application/json, text/plain, */*",
        };
    }

    async validate(credential: NativeCloudCredential): Promise<void> {
        if (!credential.values.cookie?.trim()) throw new Error("请先填写百度网盘 Cookie");
        await this.list(credential, "/");
    }

    async list(credential: NativeCloudCredential, dir: string): Promise<NativeCloudEntry[]> {
        const bdstoken = await this.getBdstoken(credential);
        const params = new URLSearchParams({
            dir: dir || "/",
            web: "1",
            order: "name",
            desc: "0",
            showempty: "0",
            page: "1",
            num: "200",
            channel: "chunlei",
            clienttype: "0",
            app_id: "250528",
            bdstoken,
        });
        const json = await this.request<any>("GET", `https://pan.baidu.com/api/list?${params.toString()}`, credential);
        const list = Array.isArray(json.list) ? json.list : [];
        return list.map((item: any) => ({
            name: String(item.server_filename || ""),
            id: String(item.path || ""),
            isDir: Number(item.isdir) === 1,
            size: Number(item.size || 0),
            modified: item.server_mtime ? new Date(Number(item.server_mtime) * 1000).toISOString() : "",
        }));
    }

    async locate(_credential: NativeCloudCredential, fileId: string): Promise<{ dirId: string; stack: Array<{ id: string; name: string }> } | null> {
        if (!fileId.startsWith("/")) return null;
        const parts = fileId.split("/").filter(Boolean);
        parts.pop();
        const stack: Array<{ id: string; name: string }> = [{ id: "/", name: "百度网盘根目录" }];
        let current = "";
        for (const part of parts) {
            current += `/${part}`;
            stack.push({ id: current, name: part });
        }
        return { dirId: current || "/", stack };
    }

    async resolvePlayUrl(credential: NativeCloudCredential, filePath: string): Promise<NativePlaySource> {
        const bdstoken = await this.getBdstoken(credential);
        const params = new URLSearchParams({
            dlink: "1",
            target: JSON.stringify([filePath]),
            bdstoken,
            web: "5",
            origin: "dlna",
            clienttype: "0",
            app_id: "250528",
        });
        const json = await this.request<any>("GET", `https://pan.baidu.com/api/filemetas?${params.toString()}`, credential);
        const info = Array.isArray(json.info) ? json.info[0] : null;
        const url = info?.dlink;
        if (!url) throw new Error("百度未返回播放地址（可能为共享文件权限限制或临时限流，稍后重试）");
        const cookie = credential.values.cookie || "";
        const common = {
            referer: "https://pan.baidu.com/",
            origin: "https://pan.baidu.com",
            cookie,
            accept: "*/*",
        };
        const profiles = [
            { ...common, "user-agent": "pan.baidu.com" },
            { ...common, "user-agent": USER_AGENT },
            { referer: "https://pan.baidu.com/", accept: "*/*", "user-agent": "pan.baidu.com" },
            { referer: "https://pan.baidu.com/", accept: "*/*", "user-agent": USER_AGENT },
        ];
        return {
            url,
            headers: profiles[0],
            headerProfiles: profiles,
            mime: "video/mp4",
        };
    }

    private async getBdstoken(credential: NativeCloudCredential): Promise<string> {
        const params = new URLSearchParams({
            fields: JSON.stringify(["bdstoken"]),
            clienttype: "0",
            app_id: "250528",
            web: "1",
        });
        const json = await this.request<any>("GET", `https://pan.baidu.com/api/gettemplatevariable?${params.toString()}`, credential);
        const token = json?.result?.bdstoken;
        if (!token) throw new Error("无法获取百度 bdstoken，Cookie 可能无效");
        return token;
    }

    private async request<T>(method: string, url: string, credential: NativeCloudCredential): Promise<T> {
        const requireFn = (globalThis as any).require || (window as any).require;
        const https = requireFn("https");
        const target = new URL(url);
        return new Promise<T>((resolve, reject) => {
            const request = https.request(
                {
                    protocol: "https:",
                    hostname: target.hostname,
                    path: `${target.pathname}${target.search}`,
                    method,
                    headers: this.headers(credential),
                    timeout: 20000,
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
                        const text = new TextDecoder("utf-8").decode(merged);
                        let json: any;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            reject(new Error(`百度接口返回非 JSON（HTTP ${response.statusCode}）`));
                            return;
                        }
                        if (response.statusCode === 401 || response.statusCode === 403 || json.errno === -9 || json.errno === 2) {
                            reject(new Error("百度 Cookie 已过期或无效，请重新登录"));
                            return;
                        }
                        if (json.errno !== undefined && json.errno !== 0) {
                            reject(new Error(`百度接口错误：${json.errmsg || json.errno}`));
                            return;
                        }
                        resolve(json as T);
                    });
                },
            );
            request.on("timeout", () => request.destroy(new Error("百度请求超时")));
            request.on("error", (error: Error) => reject(error));
            request.end();
        });
    }
}
