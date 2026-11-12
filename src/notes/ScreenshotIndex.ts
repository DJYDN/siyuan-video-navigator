import { fetchSyncPost } from "siyuan";

export interface ScreenshotRecord {
    blockId: string;
    provider: "bilibili" | "url" | "native";
    bvid: string;
    page: number;
    timeSeconds: number;
    assetPath: string;
    url: string;
}

const ATTR_RE = /custom-svn-([a-z-]+)="([^"]*)"/g;

function parseIal(ial: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    let match: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((match = ATTR_RE.exec(ial))) {
        attrs[match[1]] = decodeHtmlEntities(match[2]);
    }
    return attrs;
}

/** SQL/IAL returns escaped attributes; native URLs contain `&` and must be decoded. */
function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

/**
 * In-memory index of screenshot blocks -> video source. Loaded from the
 * kernel SQL index (block `ial` attributes) so clicking a screenshot still
 * works after a SiYuan restart.
 */
export class ScreenshotIndex {
    private readonly map = new Map<string, ScreenshotRecord>();

    get(blockId: string | null | undefined): ScreenshotRecord | null {
        if (!blockId) return null;
        return this.map.get(blockId) || null;
    }

    add(record: ScreenshotRecord): void {
        this.map.set(record.blockId, record);
    }

    async refresh(): Promise<number> {
        const response = await fetchSyncPost("/api/query/sql", {
            stmt: "SELECT id, ial FROM blocks WHERE ial LIKE '%custom-svn-type%'",
        });
        if (!response || response.code !== 0) return this.map.size;
        for (const row of response.data || []) {
            const attrs = parseIal(String(row.ial || ""));
            if (attrs["type"] !== "screenshot") continue;
            const bvid = attrs["bvid"] || "";
            const url = attrs["url"] || "";
            const page = Number(attrs["page"] || "1");
            const timeSeconds = Number(attrs["time"] || "0");
            if (!bvid && !url) continue;
            this.map.set(row.id, {
                blockId: row.id,
                provider: (attrs["provider"] as "bilibili" | "url" | "native") || (bvid ? "bilibili" : "url"),
                bvid,
                page: Number.isFinite(page) ? page : 1,
                timeSeconds: Number.isFinite(timeSeconds) ? timeSeconds : 0,
                assetPath: attrs["asset"] || "",
                url,
            });
        }
        return this.map.size;
    }
}
