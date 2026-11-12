import type { NativeCloudCredential, NativeCloudEntry, NativeCloudProvider, NativePlaySource } from "@/cloud/native/types";

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

interface QuarkListResponse {
    status?: number;
    code?: number;
    message?: string;
    data?: { list?: any[]; total?: number };
}

/** Quark personal drive provider (experimental, cookie auth, read-only). */
export class QuarkProvider implements NativeCloudProvider {
    readonly id = "quark";
    readonly name = "夸克网盘";
    readonly credentialFields = [
        {
            name: "cookie",
            label: "夸克 Cookie",
            secret: true,
            placeholder: "__kps=...; __uid=...; __pus=...; sign=...; vcode=...",
        },
    ];

    private headers(credential: NativeCloudCredential): Record<string, string> {
        return {
            cookie: credential.values.cookie || "",
            "user-agent": USER_AGENT,
            origin: "https://pan.quark.cn",
            referer: "https://pan.quark.cn/",
            accept: "application/json, text/plain, */*",
            "content-type": "application/json",
        };
    }

    async validate(credential: NativeCloudCredential): Promise<void> {
        if (!credential.values.cookie?.trim()) throw new Error("请先填写夸克 Cookie");
        await this.list(credential, "0");
    }

    async list(credential: NativeCloudCredential, dirId: string): Promise<NativeCloudEntry[]> {
        const params = new URLSearchParams({
            pr: "ucpro",
            fr: "pc",
            uc_param_str: "",
            pdir_fid: dirId || "0",
            _page: "1",
            _size: "200",
            _sort: "file_type:asc,file_name:asc",
            _fetch_total: "1",
            _fetch_sub_dirs: "0",
            fetch_all_file: "1",
            fetch_risk_file_name: "1",
        });
        const json = await this.request<QuarkListResponse>("GET", `/file/sort?${params.toString()}`, credential);
        const list = json.data?.list || [];
        return list.map((item: any) => ({
            name: String(item.file_name || ""),
            id: String(item.fid || ""),
            isDir: Boolean(item.dir),
            size: Number(item.size || 0),
            modified: item.updated_at ? new Date(Number(item.updated_at)).toISOString() : "",
        }));
    }

    async search(credential: NativeCloudCredential, query: string): Promise<NativeCloudEntry[]> {
        const params = new URLSearchParams({
            pr: "ucpro",
            fr: "pc",
            q: query,
            _page: "1",
            _size: "30",
            _fetch_total: "1",
            _sort: "file_type:asc,updated_at:desc",
        });
        const json = await this.request<QuarkListResponse>("GET", `/file/search?${params.toString()}`, credential);
        const list = json.data?.list || [];
        return list.map((item: any) => ({
            name: String(item.file_name || ""),
            id: String(item.fid || ""),
            isDir: Boolean(item.dir),
            size: Number(item.size || 0),
            modified: item.updated_at ? new Date(Number(item.updated_at)).toISOString() : "",
        }));
    }

    async locate(credential: NativeCloudCredential, fileId: string): Promise<{ dirId: string; stack: Array<{ id: string; name: string }> } | null> {
        try {
            const params = new URLSearchParams({ pr: "ucpro", fr: "pc", fids: fileId });
            const json = await this.request<any>("GET", `/file?${params.toString()}`, credential);
            const item = Array.isArray(json.data?.list) ? json.data.list[0] : null;
            const filePath = String(item?.file_path || "");
            if (filePath.startsWith("/")) {
                const parts = filePath.split("/").filter(Boolean);
                parts.pop();
                let current = "0";
                const stack = [{ id: "0", name: "夸克网盘根目录" }];
                for (const part of parts) {
                    const children = await this.list(credential, current);
                    const child = children.find((entry) => entry.isDir && entry.name === part);
                    if (!child) break;
                    current = child.id;
                    stack.push({ id: child.id, name: child.name });
                }
                if (current !== "0") return { dirId: current, stack };
            }
            const parentId = item?.pdir_fid || item?.parent_fid;
            if (parentId && String(parentId) !== "0") {
                return {
                    dirId: String(parentId),
                    stack: [
                        { id: "0", name: "夸克网盘根目录" },
                        { id: String(parentId), name: "文件所在目录" },
                    ],
                };
            }
            // Old links only contain the file id. Walk the share tree to locate
            // the containing folder (bounded to avoid runaway requests).
            let visited = 0;
            const maxDirs = 120;
            const walk = async (dirId: string, depth: number, stack: Array<{ id: string; name: string }>): Promise<{ dirId: string; stack: Array<{ id: string; name: string }> } | null> => {
                if (depth > 6 || visited > maxDirs) return null;
                visited++;
                const children = await this.list(credential, dirId);
                if (children.some((entry) => entry.id === fileId)) return { dirId, stack };
                for (const child of children.filter((entry) => entry.isDir).slice(0, 24)) {
                    const found = await walk(child.id, depth + 1, [...stack, { id: child.id, name: child.name }]);
                    if (found) return found;
                }
                return null;
            };
            return await walk("0", 0, [{ id: "0", name: "夸克网盘根目录" }]);
        } catch {
            return null;
        }
    }

    async resolvePlayUrl(credential: NativeCloudCredential, fileId: string): Promise<NativePlaySource> {        const json = await this.request<any>("POST", "/file/download?pr=ucpro&fr=pc", credential, { fids: [fileId] });
        const item = Array.isArray(json.data) ? json.data[0] : null;
        const url = item?.download_url;
        if (!url) throw new Error("夸克没有返回下载地址，可能 Cookie 已过期");
        return {
            url,
            headers: {
                "user-agent": USER_AGENT,
                referer: "https://pan.quark.cn/",
                origin: "https://pan.quark.cn",
                cookie: credential.values.cookie || "",
                accept: "*/*",
                "accept-language": "zh-CN,zh;q=0.9",
            },
            headerProfiles: [
                {
                    "user-agent": USER_AGENT,
                    referer: "https://pan.quark.cn/",
                    origin: "https://pan.quark.cn",
                    cookie: credential.values.cookie || "",
                    accept: "*/*",
                    "accept-language": "zh-CN,zh;q=0.9",
                },
                {
                    "user-agent": USER_AGENT,
                    referer: "https://pan.quark.cn/",
                    cookie: credential.values.cookie || "",
                    accept: "*/*",
                },
                {
                    "user-agent": USER_AGENT,
                    referer: "https://pan.quark.cn/",
                    accept: "*/*",
                },
            ],
            mime: "video/mp4",
        };
    }

    private async request<T>(method: string, path: string, credential: NativeCloudCredential, body?: any): Promise<T> {
        const requireFn = (globalThis as any).require || (window as any).require;
        const https = requireFn("https");
        return new Promise<T>((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : undefined;
            const request = https.request(
                {
                    protocol: "https:",
                    hostname: "drive-pc.quark.cn",
                    path: `/1/clouddrive${path}`,
                    method,
                    headers: {
                        ...this.headers(credential),
                        ...(payload ? { "content-length": new TextEncoder().encode(payload).length } : {}),
                    },
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
                            reject(new Error(`夸克接口返回非 JSON（HTTP ${response.statusCode}）`));
                            return;
                        }
                        if (response.statusCode === 401 || response.statusCode === 403) {
                            reject(new Error("夸克 Cookie 已过期或无效，请重新登录"));
                            return;
                        }
                        if (json.status !== undefined ? json.status !== 200 : json.code !== 0) {
                            reject(new Error(`夸克接口错误：${json.message || json.code || json.status || "unknown"}`));
                            return;
                        }
                        resolve(json as T);
                    });
                },
            );
            request.on("timeout", () => request.destroy(new Error("夸克请求超时")));
            request.on("error", (error: Error) => reject(error));
            if (payload) request.write(payload);
            request.end();
        });
    }
}
