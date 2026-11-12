/**
 * Format a playback position as `mm:ss` (or `h:mm:ss` when >= 1 hour).
 * Throws on negative/non-finite input so callers cannot silently insert bad data.
 */
export function formatTimestamp(seconds: number): string {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`invalid timestamp: ${seconds}`);
    }
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Parse a Bilibili `t` URL parameter (plain seconds or `1h2m3s` form). */
export function parseTimeParam(raw: string | null | undefined): number | null {
    if (!raw) return null;
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.floor(Number(raw));
    const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m) return null;
    const seconds = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
    return seconds > 0 ? seconds : null;
}
