import { parseTimeParam } from "./time.ts";

export type VideoProvider = "bilibili" | "url";

export interface VideoSource {
    provider: VideoProvider;
    bvid?: string;
    page?: number;
    canonicalUrl: string;
    title?: string;
}

export interface ParsedBilibiliLink {
    provider: "bilibili";
    bvid: string;
    page: number;
    canonicalUrl: string;
    title?: string;
    timeSeconds: number | null;
    originalUrl: string;
}

export interface ParsedGenericLink {
    provider: "url";
    url: string;
    timeSeconds: number;
}

const BVID_RE = /\/video\/(BV[0-9A-Za-z]+)/;

export function isBilibiliVideoUrl(raw: string): boolean {
    try {
        const url = new URL(raw);
        return /(^|\.)bilibili\.com$/.test(url.hostname) && BVID_RE.test(url.pathname);
    } catch {
        return false;
    }
}

/**
 * Parse a normal Bilibili /video/BV... link (P0 scope).
 * Returns null for non-video pages, short links, bangumi, and other providers.
 */
export function parseBilibiliUrl(raw: string): ParsedBilibiliLink | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (!/(^|\.)bilibili\.com$/.test(url.hostname)) return null;
    const match = url.pathname.match(BVID_RE);
    if (!match) return null;
    const bvid = match[1];
    const rawPage = url.searchParams.get("p");
    const page = rawPage && /^\d+$/.test(rawPage) ? Math.max(1, Number(rawPage)) : 1;
    const canonicalUrl = `https://www.bilibili.com/video/${bvid}/?p=${page}`;
    const timeSeconds = parseTimeParam(url.searchParams.get("t"));
    return {
        provider: "bilibili",
        bvid,
        page,
        canonicalUrl,
        timeSeconds,
        originalUrl: url.href,
    };
}

/** Build the canonical link stored in notes: includes part and start second. */
export function buildTimestampUrl(source: VideoSource, seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    if (source.provider === "bilibili" && source.bvid) {
        return `https://www.bilibili.com/video/${source.bvid}/?p=${source.page || 1}&t=${total}`;
    }
    try {
        const url = new URL(source.canonicalUrl);
        url.hash = `svn-t=${total}`;
        return url.href;
    } catch {
        const separator = source.canonicalUrl.includes("#") ? "&" : "#";
        return `${source.canonicalUrl}${separator}svn-t=${total}`;
    }
}

/** URL used to open the browser workspace at a given video/part. */
export function buildVideoUrl(source: VideoSource): string {
    if (source.provider === "bilibili" && source.bvid) {
        return `https://www.bilibili.com/video/${source.bvid}/?p=${source.page || 1}`;
    }
    return source.canonicalUrl;
}

/** Parse our generic `#svn-t=seconds` marker from any HTML5 video page link. */
export function parseGenericTimestampUrl(raw: string): ParsedGenericLink | null {
    try {
        const url = new URL(raw);
        const match = url.hash.match(/svn-t=(\d+(?:\.\d+)?)/);
        if (!match) return null;
        const timeSeconds = Math.floor(Number(match[1]));
        url.hash = "";
        return { provider: "url", url: url.href, timeSeconds };
    } catch {
        return null;
    }
}
