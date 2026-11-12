import { test } from "node:test";
import assert from "node:assert/strict";
import {
    cleanBilibiliTitle,
    defaultLinkTextConfig,
    formatLinkText,
    presetTemplates,
    stripVideoExtension,
    truncateText,
} from "../src/settings/LinkTextSettings.ts";

const longTitle = "让天下没有难写的论文：中科院研究生如何用AI把idea一步步变成论文";

test("default link text: time + 16-char title", () => {
    const text = formatLinkText(defaultLinkTextConfig(), {
        target: "timestamp",
        seconds: 1122,
        title: longTitle,
        provider: "bilibili",
    });
    assert.equal(text, "18:42 · 让天下没有难写的论文：中科院研…");
});

test("screenshot default has play prefix", () => {
    const text = formatLinkText(defaultLinkTextConfig(), {
        target: "screenshot",
        seconds: 9,
        title: "1-Earth Day for Kids.mp4",
        filename: "1-Earth Day for Kids.mp4",
    });
    assert.equal(text, "▶ 00:09 · 1-Earth Day for…");
});

test("time_filename preset strips extension", () => {
    const config = { ...defaultLinkTextConfig(), preset: "time_filename" as const, templates: presetTemplates("time_filename") };
    const text = formatLinkText(config, {
        target: "timestamp",
        seconds: 9,
        title: "ignored",
        filename: "1-Earth Day for Kids.mp4",
    });
    assert.equal(text, "00:09 · 1-Earth Day for…");
});

test("source + time and BV tokens", () => {
    const source = { ...defaultLinkTextConfig(), preset: "source_time" as const, templates: presetTemplates("source_time") };
    assert.equal(formatLinkText(source, { target: "timestamp", seconds: 65, provider: "quark" }), "夸克 01:05");

    const bv = { ...defaultLinkTextConfig(), preset: "custom" as const, templates: { ...defaultLinkTextConfig().templates, timestamp: "{time} · {bv} P{p}" } };
    assert.equal(formatLinkText(bv, { target: "timestamp", seconds: 5, bvid: "BV1LKjS6gEh4", page: 2 }), "00:05 · BV1LKjS6gEh4 P2");
});

test("middle ellipsis keeps head and tail", () => {
    assert.equal(truncateText("abcdefghijklmnop", 9, "middle"), "abcd…mnop");
});

test("unicode grapheme truncation does not split emoji", () => {
    const text = truncateText("ab😀cd😀ef", 5, "end");
    assert.equal(text, "ab😀c…");
    assert.equal(Array.from(text).includes("\uFFFD"), false);
});

test("clean Bilibili title suffix and video extension", () => {
    assert.equal(cleanBilibiliTitle("标题_哔哩哔哩_bilibili"), "标题");
    assert.equal(stripVideoExtension("a.mp4"), "a");
    assert.equal(stripVideoExtension("a.final.mkv"), "a.final");
});

test("sanitizes markdown link punctuation and newlines", () => {
    const config = { ...defaultLinkTextConfig(), maxChars: 0, preset: "custom" as const, templates: { ...defaultLinkTextConfig().templates, timestamp: "{title}" } };
    const text = formatLinkText(config, { target: "timestamp", seconds: 0, title: "[a]\n b|c" });
    assert.equal(text, "［a］ b｜c");
});

test("unknown tokens are preserved and empty template falls back to time", () => {
    const unknown = { ...defaultLinkTextConfig(), preset: "custom" as const, templates: { ...defaultLinkTextConfig().templates, timestamp: "{unknown}" } };
    assert.equal(formatLinkText(unknown, { target: "timestamp", seconds: 61 }), "{unknown}");

    const empty = { ...defaultLinkTextConfig(), preset: "custom" as const, templates: { ...defaultLinkTextConfig().templates, timestamp: "   " } };
    assert.equal(formatLinkText(empty, { target: "timestamp", seconds: 61 }), "01:01");
});
