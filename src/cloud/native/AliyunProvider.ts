import type { NativeCloudCredential, NativeCloudEntry, NativeCloudProvider, NativePlaySource } from "@/cloud/native/types";

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const API_HOSTS = ["https://api.alipan.com", "https://api.aliyundrive.com", "https://openapi.alipan.com"];

interface AliyunSession {
    accessToken: string;
    refreshToken: string;
    driveId: string;
}

/** Aliyun Drive provider (experimental, refresh-token auth, read-only). */
export class AliyunProvider implements NativeCloudProvider {
    readonly id = "aliyun";
    readonly name = "阿里云盘";
    readonly credentialFields = [
        { name: "refresh_token", label: "阿里云盘 refresh_token", secret: true, placeholder: "从 alipan.com 登录态获取" },
        { name: "drive_id", label: "drive_id（可选）", placeholder: "留空则使用默认网盘" },
    ];

    private sessions = new Map<string, AliyunSession>();
    private deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);

    async validate(credential: NativeCloudCredential): Promise<void> {
        if (!credential.values.refresh_token?.trim()) throw new Error("请先填写阿里云盘 refresh_token");
        await this.session(credential);
        await this.list(credential, "root");
    }

    async list(credential: NativeCloudCredential, dir: string): Promise<NativeCloudEntry[]> {
        const session = await this.session(credential);
        const body = {
            drive_id: session.driveId,
            parent_file_id: dir || "root",
            limit: 100,
            order_by: "name",
            order_direction: "ASC",
        };
        const json = await this.request<any>("/adrive/v3/file/list", session, body);
        const items = Array.isArray(json.items) ? json.items : [];
        return items.map((item: any) => ({
            name: String(item.name || ""),
            id: String(item.file_id || ""),
            isDir: item.type === "folder",
            size: Number(item.size || 0),
            modified: String(item.updated_at || ""),
        }));
    }

    async resolvePlayUrl(credential: NativeCloudCredential, fileId: string): Promise<NativePlaySource> {
        const session = await this.session(credential);
        try {
            const preview = await this.request<any>(
                "/v2/file/get_video_preview_play_info",
                session,
                {
                    drive_id: session.driveId,
                    file_id: fileId,
                    category: "live_transcoding",
                    url_expire_sec: 14400,
                },
                "https://api.alipan.com",
            );
            const info = preview?.video_preview_play_info || {};
            const tasks = info?.live_transcoding_task_list || [];
            const list = Array.isArray(tasks) ? tasks : [tasks];
            const task = list.find((item: any) => item?.url) || null;
            if (task?.url) {
                return {
                    url: String(task.url),
                    headers: {},
                    mime: "application/vnd.apple.mpegurl",
                    kind: "hls",
                };
            }
        } catch {
            /* use signed direct URL fallback */
        }
        const body = { drive_id: session.driveId, file_id: fileId, expire_sec: 14400 };
        const attempts = [
            { host: "https://api.alipan.com", path: "/adrive/v1.0/openFile/getDownloadUrl" },
            { host: "https://api.alipan.com", path: "/v2/file/get_download_url" },
            { host: API_HOSTS[1], path: "/v2/file/get_download_url" },
            { host: API_HOSTS[2], path: "/adrive/v1.0/openFile/getDownloadUrl" },
        ];
        let lastError = "";
        for (const attempt of attempts) {
            try {
                const json = await this.request<any>(attempt.path, session, body, attempt.host);
                const url = json.url || json.download_url || json.streams_url;
                if (url) {
                    return {
                        url,
                        headers: {
                            "user-agent": USER_AGENT,
                            referer: "https://www.alipan.com/",
                        },
                        headerProfiles: [
                            { "user-agent": USER_AGENT, referer: "https://www.alipan.com/" },
                            { "user-agent": USER_AGENT, referer: "https://www.alipan.com" },
                            { "user-agent": USER_AGENT, referer: "https://www.aliyundrive.com/" },
                            { "user-agent": USER_AGENT, referer: "https://www.aliyundrive.com" },
                            { "user-agent": USER_AGENT },
                        ],
                        mime: "video/mp4",
                    };
                }
            } catch (error) {
                lastError = String((error as Error)?.message || error);
            }
        }
        throw new Error(lastError || "阿里云盘没有返回播放地址");
    }

    private async session(credential: NativeCloudCredential): Promise<AliyunSession> {
        const key = credential.values.refresh_token || credential.values.access_token || "";
        const cached = this.sessions.get(key);
        if (cached) return cached;
        if (credential.values.access_token && !credential.values.refresh_token) {
            const session: AliyunSession = {
                accessToken: credential.values.access_token,
                refreshToken: "",
                driveId: credential.values.drive_id || "root",
            };
            this.sessions.set(key, session);
            return session;
        }
        let lastError = "";
        const refreshAttempts = [
            { host: "https://auth.alipan.com", path: "/v2/account/token" },
            { host: API_HOSTS[0], path: "/token/refresh" },
            { host: API_HOSTS[1], path: "/token/refresh" },
        ];
        for (const attempt of refreshAttempts) {
            try {
                const json = await this.request<any>(attempt.path, null, {
                    refresh_token: credential.values.refresh_token,
                    grant_type: "refresh_token",
                }, attempt.host);
                const session: AliyunSession = {
                    accessToken: json.access_token || json.accessToken,
                    refreshToken: json.refresh_token || credential.values.refresh_token,
                    driveId: credential.values.drive_id || json.default_drive_id || json.defaultDriveId || "root",
                };
                if (!session.accessToken) throw new Error("阿里云盘没有返回 access_token");
                this.sessions.set(key, session);
                return session;
            } catch (error) {
                lastError = String((error as Error)?.message || error);
            }
        }
        throw new Error("阿里云盘登录失败：" + lastError);
    }

    private async request<T>(
        path: string,
        session: AliyunSession | null,
        body: Record<string, unknown>,
        host = API_HOSTS[0],
    ): Promise<T> {
        const requireFn = (globalThis as any).require || (window as any).require;
        const https = requireFn("https");
        const payload = JSON.stringify(body);
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            "x-device-id": this.deviceId,
            "x-canary": "client=Android,app=adrive,version=v4.1.0",
            origin: "https://www.alipan.com",
            referer: "https://alipan.com/",
        };
        if (session?.accessToken) headers.authorization = `Bearer\t${session.accessToken}`;
        return new Promise<T>((resolve, reject) => {
            const target = new URL(host);
            const request = https.request(
                {
                    protocol: "https:",
                    hostname: target.hostname,
                    path,
                    method: "POST",
                    headers: { ...headers, "content-length": new TextEncoder().encode(payload).length },
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
                            reject(new Error(`阿里云盘接口返回非 JSON（HTTP ${response.statusCode}）`));
                            return;
                        }
                        if (response.statusCode === 401 || response.statusCode === 403) {
                            reject(new Error("阿里云盘 refresh_token 已过期或无效"));
                            return;
                        }
                        if (json.code && json.code !== "Success" && json.code !== 200) {
                            reject(new Error(`阿里云盘接口错误：${json.message || json.code}`));
                            return;
                        }
                        resolve(json as T);
                    });
                },
            );
            request.on("timeout", () => request.destroy(new Error("阿里云盘请求超时")));
            request.on("error", (error: Error) => reject(error));
            request.write(payload);
            request.end();
        });
    }
}
