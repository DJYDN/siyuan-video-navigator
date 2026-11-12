import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, parseTimeParam } from "../src/utils/time.ts";
import { buildTimestampUrl, buildVideoUrl, isBilibiliVideoUrl, parseBilibiliUrl } from "../src/utils/url.ts";

test("formatTimestamp: basic values", () => {
    assert.equal(formatTimestamp(0), "00:00");
    assert.equal(formatTimestamp(59), "00:59");
    assert.equal(formatTimestamp(60), "01:00");
    assert.equal(formatTimestamp(332), "05:32");
    assert.equal(formatTimestamp(3599), "59:59");
    assert.equal(formatTimestamp(3600), "1:00:00");
    assert.equal(formatTimestamp(3661.9), "1:01:01");
});

test("formatTimestamp: rejects invalid values", () => {
    assert.throws(() => formatTimestamp(-1));
    assert.throws(() => formatTimestamp(Number.NaN));
    assert.throws(() => formatTimestamp(Number.POSITIVE_INFINITY));
});

test("parseTimeParam: plain seconds and h/m/s forms", () => {
    assert.equal(parseTimeParam(null), null);
    assert.equal(parseTimeParam(""), null);
    assert.equal(parseTimeParam("332"), 332);
    assert.equal(parseTimeParam("5.9"), 5);
    assert.equal(parseTimeParam("1h2m3s"), 3723);
    assert.equal(parseTimeParam("2m"), 120);
    assert.equal(parseTimeParam("20s"), 20);
    assert.equal(parseTimeParam("abc"), null);
    assert.equal(parseTimeParam("1h2"), null);
});

test("parseBilibiliUrl: normal video URLs", () => {
    const p1 = parseBilibiliUrl("https://www.bilibili.com/video/BV1b7411N798/");
    assert.ok(p1);
    assert.equal(p1?.bvid, "BV1b7411N798");
    assert.equal(p1?.page, 1);
    assert.equal(p1?.timeSeconds, null);

    const p2 = parseBilibiliUrl("https://www.bilibili.com/video/BV1b7411N798/?p=2&t=332&spm_id_from=x");
    assert.equal(p2?.page, 2);
    assert.equal(p2?.timeSeconds, 332);

    const m = parseBilibiliUrl("https://m.bilibili.com/video/BV1nJ411V7bd?p=3&t=20");
    assert.equal(m?.bvid, "BV1nJ411V7bd");
    assert.equal(m?.page, 3);
    assert.equal(m?.timeSeconds, 20);
});

test("parseBilibiliUrl: invalid or unsupported URLs", () => {
    assert.equal(parseBilibiliUrl("https://www.bilibili.com/"), null);
    assert.equal(parseBilibiliUrl("https://search.bilibili.com/all?keyword=x"), null);
    assert.equal(parseBilibiliUrl("https://b23.tv/abc"), null);
    assert.equal(parseBilibiliUrl("https://example.com/video/BV1b7411N798/"), null);
    assert.equal(parseBilibiliUrl("not a url"), null);
    assert.equal(parseBilibiliUrl("https://www.bilibili.com/bangumi/play/ep123"), null);
});

test("isBilibiliVideoUrl", () => {
    assert.equal(isBilibiliVideoUrl("https://www.bilibili.com/video/BV1b7411N798/"), true);
    assert.equal(isBilibiliVideoUrl("https://www.bilibili.com/"), false);
});

test("buildTimestampUrl/buildVideoUrl", () => {
    const source = { provider: "bilibili" as const, bvid: "BV1b7411N798", page: 2, canonicalUrl: "" };
    assert.equal(buildTimestampUrl(source, 332.9), "https://www.bilibili.com/video/BV1b7411N798/?p=2&t=332");
    assert.equal(buildTimestampUrl(source, -5), "https://www.bilibili.com/video/BV1b7411N798/?p=2&t=0");
    assert.equal(buildVideoUrl(source), "https://www.bilibili.com/video/BV1b7411N798/?p=2");
});
