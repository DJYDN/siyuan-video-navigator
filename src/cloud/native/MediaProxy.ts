/**
 * Localhost-only media proxy for native cloud providers.
 * Cloud playback URLs usually need Cookie/Referer/User-Agent headers; the
 * proxy adds them, follows redirects and forwards Range requests so <video>
 * can seek normally.
 */
export class MediaProxy {
    private server: any = null;
    private port = 0;
    private token = "";
    private readonly streams = new Map<string, { url: string; headers: Record<string, string>; mime?: string; expiresAt: number; ignoreRange?: boolean }>();
    private readonly ttlMs = 30 * 60 * 1000;
    lastError = "";

    isRunning(): boolean {
        return Boolean(this.server);
    }

    getPort(): number {
        return this.port;
    }

    async start(): Promise<void> {
        if (this.server) return;
        const requireFn = (globalThis as any).require || (window as any).require;
        const http = requireFn("http");
        const crypto = requireFn("crypto");
        this.token = crypto.randomBytes(18).toString("hex");
        this.server = http.createServer((request: any, response: any) => this.handleRequest(request, response));
        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => {
                this.port = this.server.address().port;
                this.server.removeListener("error", reject);
                resolve();
            });
        });
    }

    stop(): void {
        if (!this.server) return;
        try {
            this.server.close();
        } catch {
            /* ignore */
        }
        this.server = null;
        this.port = 0;
        this.streams.clear();
    }

    async register(url: string, headers: Record<string, string>, mime?: string, ignoreRange = false): Promise<string> {
        await this.start();
        const requireFn = (globalThis as any).require || (window as any).require;
        const crypto = requireFn("crypto");
        const id = crypto.randomBytes(12).toString("hex");
        this.streams.set(id, { url, headers, mime, expiresAt: Date.now() + this.ttlMs, ignoreRange });
        return `http://127.0.0.1:${this.port}/stream/${id}?token=${this.token}`;
    }

    /** First-bytes probe for diagnostics: returns status/content-type/prefix. */
    async probe(url: string, headers: Record<string, string>): Promise<{ status: number; contentType: string; prefix: string; finalUrl: string }> {
        const requireFn = (globalThis as any).require || (window as any).require;
        const http = requireFn("http");
        const https = requireFn("https");
        return new Promise((resolve, reject) => {
            const run = (currentUrl: string, redirects: number) => {
                const target = new URL(currentUrl);
                const transport = target.protocol === "https:" ? https : http;
                const request = transport.request(
                    {
                        protocol: target.protocol,
                        hostname: target.hostname,
                        port: target.port || (target.protocol === "https:" ? 443 : 80),
                        path: `${target.pathname}${target.search}`,
                        method: "GET",
                        headers: { ...headers, Range: "bytes=0-4095", accept: "*/*" },
                        timeout: 20000,
                    },
                    (response: any) => {
                        const status = response.statusCode || 0;
                        const location = response.headers.location;
                        if (status >= 300 && status < 400 && location && redirects > 0) {
                            response.resume();
                            run(new URL(location, target).href, redirects - 1);
                            return;
                        }
                        const chunks: Uint8Array[] = [];
                        let size = 0;
                        response.on("data", (chunk: Uint8Array) => {
                            if (size < 8192) {
                                chunks.push(chunk);
                                size += chunk.length;
                            }
                            if (size >= 8192) response.destroy();
                        });
                        response.on("end", () => {
                            const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                            const merged = new Uint8Array(total);
                            let offset = 0;
                            for (const chunk of chunks) {
                                merged.set(chunk, offset);
                                offset += chunk.length;
                            }
                            resolve({
                                status,
                                contentType: String(response.headers["content-type"] || ""),
                                prefix: new TextDecoder("latin1").decode(merged.slice(0, 2048)),
                                finalUrl: currentUrl,
                            });
                        });
                        response.on("error", reject);
                    },
                );
                request.on("timeout", () => request.destroy(new Error("probe timeout")));
                request.on("error", reject);
                request.end();
            };
            run(url, 5);
        });
    }

    private handleRequest(request: any, response: any): void {
        try {
            const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
            if (requestUrl.pathname === "/health") {
                response.writeHead(200, { "Content-Type": "text/plain" });
                response.end("ok");
                return;
            }
            if (requestUrl.searchParams.get("token") !== this.token) {
                response.writeHead(403).end("forbidden");
                return;
            }
            const id = requestUrl.pathname.replace(/^\/stream\//, "");
            const entry = this.streams.get(id);
            if (!entry || entry.expiresAt < Date.now()) {
                response.writeHead(404).end("stream not found");
                return;
            }
            this.fetchUpstream(entry.url, entry.headers, entry.ignoreRange ? undefined : request.headers.range, 5, response).catch((error) => {
                this.lastError = String(error?.message || error);
                if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain" });
                response.end(`upstream error: ${this.lastError}`);
            });
        } catch (error) {
            if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
            response.end(`proxy error: ${String((error as any)?.message || error)}`);
        }
    }

    private fetchUpstream(
        url: string,
        baseHeaders: Record<string, string>,
        range: string | undefined,
        redirectsLeft: number,
        clientResponse: any,
    ): Promise<void> {
        const requireFn = (globalThis as any).require || (window as any).require;
        const http = requireFn("http");
        const https = requireFn("https");
        return new Promise((resolve, reject) => {
            const target = new URL(url);
            const headers: Record<string, string> = { ...baseHeaders };
            if (range) headers.Range = range;
            headers["accept"] = headers["accept"] || "*/*";
            const transport = target.protocol === "https:" ? https : http;
            const upstream = transport.request(
                {
                    protocol: target.protocol,
                    hostname: target.hostname,
                    port: target.port || (target.protocol === "https:" ? 443 : 80),
                    path: `${target.pathname}${target.search}`,
                    method: "GET",
                    headers,
                    timeout: 30000,
                },
                (upstreamResponse: any) => {
                    const status = upstreamResponse.statusCode || 0;
                    const location = upstreamResponse.headers.location;
                    if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
                        upstreamResponse.resume();
                        const next = new URL(location, target).href;
                        this.fetchUpstream(next, baseHeaders, range, redirectsLeft - 1, clientResponse).then(resolve, reject);
                        return;
                    }
                    if (status >= 400) {
                        this.lastError = `HTTP ${status} from ${target.hostname}`;
                        upstreamResponse.resume();
                        if (!clientResponse.headersSent) {
                            clientResponse.writeHead(status, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
                        }
                        clientResponse.end(`upstream HTTP ${status}`);
                        resolve();
                        return;
                    }
                    const outHeaders: Record<string, string> = {
                        "Content-Type": upstreamResponse.headers["content-type"] || "video/mp4",
                        "Accept-Ranges": "bytes",
                        "Access-Control-Allow-Origin": "*",
                    };
                    for (const name of ["content-length", "content-range", "last-modified", "etag"]) {
                        if (upstreamResponse.headers[name]) {
                            outHeaders[name.replace(/(^|-)([a-z])/g, (_, p, c) => p + c.toUpperCase())] = upstreamResponse.headers[name];
                        }
                    }
                    clientResponse.writeHead(status, outHeaders);
                    upstreamResponse.pipe(clientResponse);
                    upstreamResponse.on("end", resolve);
                    upstreamResponse.on("error", reject);
                },
            );
            upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
            upstream.on("error", reject);
            upstream.end();
        });
    }
}
