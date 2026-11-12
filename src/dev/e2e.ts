import { fetchSyncPost, getAllEditor, openTab, showMessage } from "siyuan";
import type { Protyle } from "siyuan";
import type SiYuanVideoNavigatorPlugin from "@/index";
import { parseTimeParam } from "@/utils/time";
import { buildCloudPlayerUrl } from "@/cloud/CloudDriveService";

/**
 * DEV-ONLY Phase 2 end-to-end harness.
 *
 * Runs only when the test workspace has localStorage key `svn-e2e-phase2` set
 * (the Lead's tools set it explicitly). It exercises the real product paths:
 * editor caret tracking -> real Bilibili webview -> guest hotkey bridge ->
 * timestamp insertion -> click timestamp -> seek back.
 *
 * Remove this module (and the import in index.ts) before the public release.
 */
const FLAG = "svn-e2e-phase2";
const REPORT_KEY = "svn-e2e-phase2-report";
const PERSIST_FLAG = "svn-e2e-persist";
const PERSIST_REPORT_KEY = "svn-e2e-persist-report";
const MULTI_FLAG = "svn-e2e-multivideo";
const MULTI_REPORT_KEY = "svn-e2e-multivideo-report";
const KEYTEST_FLAG = "svn-e2e-keytest";
const GENERIC_FLAG = "svn-e2e-generic";
const GENERIC_REPORT_KEY = "svn-e2e-generic-report";
const GENERIC_URL = "http://127.0.0.1:8765/index.html";
const CLOUD_FLAG = "svn-e2e-cloud";
const CLOUD_REPORT_KEY = "svn-e2e-cloud-report";
const MOUNT_FLAG = "svn-e2e-mounts";
const MOUNT_REPORT_KEY = "svn-e2e-mounts-report";
const NATIVE_UI_FLAG = "svn-e2e-native-ui";
const NATIVE_UI_REPORT_KEY = "svn-e2e-native-ui-report";
const NATIVE_PLAY_FLAG = "svn-e2e-native-play";
const NATIVE_PLAY_REPORT_KEY = "svn-e2e-native-play-report";
const VAULT_FLAG = "svn-e2e-vault";
const VAULT_REPORT_KEY = "svn-e2e-vault-report";
const VIDEO = {
    url: "https://www.bilibili.com/video/BV1b7411N798/?p=2",
    bvid: "BV1b7411N798",
    page: 2,
    seek: 332,
};

export async function maybeRunPhase2E2E(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[FLAG]) return;
    const report: any = { schema: "svn-phase2-e2e/1", startedAt: new Date().toISOString(), steps: [] };
    try {
        await run(plugin, report);
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
        console.error("[siyuan-video-navigator] e2e failed", error);
    } finally {
        report.finishedAt = new Date().toISOString();
        try {
            await fetchSyncPost("/api/storage/setLocalStorageVal", { key: REPORT_KEY, val: JSON.stringify(report) });
            await fetchSyncPost("/api/storage/setLocalStorageVal", { key: FLAG, val: "" });
        } catch (error) {
            console.error("[siyuan-video-navigator] e2e report write failed", error);
        }
    }
}

interface MultiFixture {
    marker: string;
    kind: "timestamp" | "screenshot";
    bvid: string;
    page: number;
    time: number;
    label: string;
}

const MULTI_FIXTURES: MultiFixture[] = [
    { marker: "TARGET-A1", kind: "timestamp", bvid: "BV1b7411N798", page: 1, time: 80, label: "A/P1 时间戳" },
    { marker: "TARGET-B3", kind: "timestamp", bvid: "BV1nJ411V7bd", page: 3, time: 20, label: "B/P3 时间戳" },
    { marker: "TARGET-A2", kind: "timestamp", bvid: "BV1b7411N798", page: 2, time: 332, label: "A/P2 时间戳" },
    { marker: "TARGET-A1-SHOT", kind: "screenshot", bvid: "BV1b7411N798", page: 1, time: 80, label: "A/P1 截图" },
    { marker: "TARGET-B3-SHOT", kind: "screenshot", bvid: "BV1nJ411V7bd", page: 3, time: 20, label: "B/P3 截图" },
];

export async function maybeRunMultiVideoE2E(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[MULTI_FLAG]) return;
    const report: any = { schema: "svn-multivideo-e2e/1", startedAt: new Date().toISOString(), records: [], clicks: [] };
    try {
        await runMultiVideo(plugin, report);
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
        console.error("[siyuan-video-navigator] multi-video e2e failed", error);
    } finally {
        report.finishedAt = new Date().toISOString();
        try {
            await fetchSyncPost("/api/storage/setLocalStorageVal", { key: MULTI_REPORT_KEY, val: JSON.stringify(report) });
            await fetchSyncPost("/api/storage/setLocalStorageVal", { key: MULTI_FLAG, val: "" });
        } catch (error) {
            console.error("[siyuan-video-navigator] multi-video report write failed", error);
        }
    }
}

async function runMultiVideo(plugin: SiYuanVideoNavigatorPlugin, report: any): Promise<void> {
    const step = (name: string, data?: unknown) => {
        report.steps = report.steps || [];
        report.steps.push({ name, at: new Date().toISOString(), data });
        console.log("[siyuan-video-navigator] multi-video", name, data ?? "");
    };
    const notebooks = await fetchSyncPost("/api/notebook/lsNotebooks", {});
    const notebook = notebooks?.data?.notebooks?.find((n: any) => !n.closed);
    if (!notebook) throw new Error("no open notebook");
    const markdown = [
        "# SVN Multi-Video E2E",
        "",
        "TARGET-A1 在这里记录 A/P1。",
        "",
        "TARGET-B3 在这里记录 B/P3。",
        "",
        "TARGET-A2 在这里记录 A/P2。",
        "",
        "TARGET-A1-SHOT 在这里插入 A/P1 截图。",
        "",
        "TARGET-B3-SHOT 在这里插入 B/P3 截图。",
    ].join("\n");
    const created = await fetchSyncPost("/api/filetree/createDocWithMd", {
        notebook: notebook.id,
        path: `/svn-multivideo-e2e-${Date.now()}.sy`,
        markdown,
    });
    if (!created || created.code !== 0) throw new Error("createDocWithMd failed");
    const docId = created.data;
    report.docId = docId;
    openTab({ app: (plugin as any).app, doc: { id: docId } });
    let protyle = await waitForEditor(docId, 30000);
    step("doc-created", { docId });
    const browser = await plugin.ensureBrowser();

    for (const fixture of MULTI_FIXTURES) {
        await browser.navigate(`https://www.bilibili.com/video/${fixture.bvid}/?p=${fixture.page}`);
        const player = await waitForVideo(browser, 60000);
        if (player.bvid !== fixture.bvid || player.page !== fixture.page) {
            throw new Error(`${fixture.label}: identity mismatch ${player.bvid} p${player.page}`);
        }
        await browser.seek(fixture.time);
        await sleep(400);
        placeCaretInParagraph(protyle, fixture.marker);
        plugin.tracker.captureFromProtyle(protyle);
        const target = plugin.tracker.getLastTarget();
        if (!target || target.rootID !== docId || !target.range) {
            throw new Error(`${fixture.label}: caret target lost`);
        }
        if (fixture.kind === "timestamp") {
            plugin.lastInsert = null;
            await plugin.insertTimestamp("dev");
            const inserted = plugin.lastInsert as any;
            if (!inserted?.ok) throw new Error(`${fixture.label}: insert failed ${inserted?.error || ""}`);
            report.records.push({
                ...fixture,
                kind: "timestamp",
                html: inserted.result.html,
                timeSeconds: inserted.result.timeSeconds,
                link: inserted.result.html,
            });
            step("timestamp", { marker: fixture.marker, bvid: fixture.bvid, page: fixture.page, time: inserted.result.timeSeconds });
        } else {
            plugin.lastScreenshot = null;
            await plugin.insertScreenshot("dev");
            const inserted = plugin.lastScreenshot as any;
            if (!inserted?.ok) throw new Error(`${fixture.label}: screenshot failed ${inserted?.error || ""}`);
            report.records.push({
                ...fixture,
                kind: "screenshot",
                assetPath: inserted.result.assetPath,
                blockId: inserted.result.blockId,
                timeSeconds: inserted.result.timeSeconds,
            });
            step("screenshot", {
                marker: fixture.marker,
                bvid: fixture.bvid,
                page: fixture.page,
                time: inserted.result.timeSeconds,
                asset: inserted.result.assetPath,
                blockId: inserted.result.blockId,
            });
        }
        await sleep(800);
    }

    const kramdown = (await fetchSyncPost("/api/block/getBlockKramdown", { id: docId }))?.data?.kramdown || "";
    report.kramdownSample = kramdown.slice(0, 3000);

    // Click every timestamp link and verify it seeks to the right video/part/time.
    for (const record of report.records.filter((r: any) => r.kind === "timestamp")) {
        const link = Array.from(protyle.protyle.wysiwyg.element.querySelectorAll('[data-type="a"]')).find((el: any) =>
            String(el.getAttribute("data-href") || "").includes(`/video/${record.bvid}/?p=${record.page}`),
        ) as HTMLElement | undefined;
        if (!link) throw new Error(`timestamp link not found for ${record.label}`);
        // Move the player to a DIFFERENT video first, so a successful click
        // must actually switch BV/part (not merely seek in the current page).
        const baseline =
            record.bvid === "BV1b7411N798" && record.page === 2
                ? { bvid: "BV1nJ411V7bd", page: 1 }
                : { bvid: "BV1b7411N798", page: 2 };
        await browser.navigate(`https://www.bilibili.com/video/${baseline.bvid}/?p=${baseline.page}`);
        await waitForVideo(browser, 60000);
        await browser.seek(10);
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        const result = await waitForSeekTarget(browser, record.bvid, record.page, record.time, 20000);
        report.clicks.push({ kind: "timestamp", label: record.label, bvid: record.bvid, page: record.page, expected: record.time, actual: result.currentTime, errorSeconds: Math.abs(result.currentTime - record.time) });
        if (Math.abs(result.currentTime - record.time) > 2) throw new Error(`timestamp clickback failed for ${record.label}`);
    }

    // Click every screenshot image and verify the same.
    for (const record of report.records.filter((r: any) => r.kind === "screenshot")) {
        const image = protyle.protyle.wysiwyg.element.querySelector(
            `[data-node-id="${record.blockId}"] [data-type="img"], [data-node-id="${record.blockId}"] img`,
        ) as HTMLElement | null;
        if (!image) throw new Error(`screenshot image not found for ${record.label}`);
        const baseline =
            record.bvid === "BV1b7411N798" && record.page === 2
                ? { bvid: "BV1nJ411V7bd", page: 1 }
                : { bvid: "BV1b7411N798", page: 2 };
        await browser.navigate(`https://www.bilibili.com/video/${baseline.bvid}/?p=${baseline.page}`);
        await waitForVideo(browser, 60000);
        await browser.seek(10);
        image.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        const result = await waitForSeekTarget(browser, record.bvid, record.page, record.time, 20000);
        report.clicks.push({ kind: "screenshot", label: record.label, blockId: record.blockId, bvid: record.bvid, page: record.page, expected: record.time, actual: result.currentTime, errorSeconds: Math.abs(result.currentTime - record.time) });
        if (Math.abs(result.currentTime - record.time) > 2) throw new Error(`screenshot clickback failed for ${record.label}`);
    }

    showMessage("多视频 E2E 通过：A/P1、B/P3、A/P2 独立回溯", 6000);
}

function placeCaretInParagraph(protyle: Protyle, marker: string): { blockId: string | null } {
    const paragraphs = Array.from(protyle.protyle.wysiwyg.element.querySelectorAll('[data-type="NodeParagraph"]')) as HTMLElement[];
    const block = paragraphs.find((p) => (p.textContent || "").includes(marker));
    if (!block) throw new Error("paragraph with marker not found: " + marker);
    const editable = (block.querySelector('[contenteditable="true"]') || block) as HTMLElement;
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    protyle.protyle.toolbar.range = range.cloneRange();
    return { blockId: block.getAttribute("data-node-id") };
}

async function waitForBrowserAttached(plugin: SiYuanVideoNavigatorPlugin, timeoutMs: number): Promise<any> {
    (plugin as any).openBrowserTab();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const browser = (plugin as any).browser;
        if (browser?.isAttached?.() && browser.getWebview?.()) return browser;
        await sleep(500);
    }
    throw new Error("browser tab did not attach within timeout");
}

async function waitForSeekTarget(browser: any, bvid: string, page: number, seconds: number, timeoutMs: number): Promise<any> {
    const started = Date.now();
    let last: any = null;
    while (Date.now() - started < timeoutMs) {
        try {
            last = await browser.getSnapshot();
        } catch (error) {
            last = { error: String((error as any)?.message || error) };
        }
        if (
            last?.bvid === bvid &&
            last.page === page &&
            Number(last.duration) > 0 &&
            last.readyState >= 1 &&
            Math.abs(Number(last.currentTime) - seconds) <= 2
        ) {
            return last;
        }
        await sleep(500);
    }
    throw new Error(`seek target not reached: ${bvid} p${page} ${seconds}s, last=${JSON.stringify(last)}`);
}

async function waitForGenericSeek(browser: any, seconds: number, timeoutMs: number): Promise<any> {    const started = Date.now();
    let last: any = null;
    while (Date.now() - started < timeoutMs) {
        try {
            last = await browser.getSnapshot();
        } catch (error) {
            last = { error: String((error as any)?.message || error) };
        }
        if (Number(last?.duration) > 0 && last.readyState >= 1 && Math.abs(Number(last.currentTime) - seconds) <= 2) {
            return last;
        }
        await sleep(500);
    }
    throw new Error(`generic seek target not reached: ${seconds}s, last=${JSON.stringify(last)}`);
}

/**
 * Dev-only setup for a PHYSICAL keyboard test: creates a doc + caret target,
 * opens the browser tab on a real video, focuses the guest webview and writes
 * `svn-key-ready`. The operator then presses the real hotkey.
 */
export async function maybeRunKeyTestSetup(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[KEYTEST_FLAG]) return;
    const report: any = { schema: "svn-keytest-setup/1", startedAt: new Date().toISOString() };
    try {
        const notebooks = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const notebook = notebooks?.data?.notebooks?.find((n: any) => !n.closed);
        if (!notebook) throw new Error("no open notebook");
        const created = await fetchSyncPost("/api/filetree/createDocWithMd", {
            notebook: notebook.id,
            path: `/svn-keytest-${Date.now()}.sy`,
            markdown: "# SVN Physical Key Test\n\n请把光标放在这一行末尾，然后按 Ctrl+Alt+T。",
        });
        const docId = created.data;
        report.docId = docId;
        openTab({ app: (plugin as any).app, doc: { id: docId } });
        const protyle = await waitForEditor(docId, 30000);
        placeCaret(protyle);
        plugin.tracker.captureFromProtyle(protyle);
        const browser = await plugin.ensureBrowser();
        await browser.navigate("https://www.bilibili.com/video/BV1b7411N798/?p=2");
        const player = await waitForVideo(browser, 60000);
        browser.focus();
        await sleep(400);
        report.player = { bvid: player.bvid, page: player.page, currentTime: player.currentTime };
        document.addEventListener(
            "keydown",
            (event) => {
                void fetchSyncPost("/api/storage/setLocalStorageVal", {
                    key: "svn-host-key-log",
                    val: JSON.stringify({ at: new Date().toISOString(), key: event.key, ctrl: event.ctrlKey, alt: event.altKey, target: (event.target as HTMLElement)?.tagName }),
                }).catch(() => undefined);
            },
            true,
        );
        await fetchSyncPost("/api/storage/setLocalStorageVal", {
            key: "svn-key-ready",
            val: JSON.stringify({ docId, at: new Date().toISOString(), player: report.player }),
        });
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: KEYTEST_FLAG, val: "" });
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
    } finally {
        report.finishedAt = new Date().toISOString();
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: "svn-keytest-setup-report", val: JSON.stringify(report) }).catch(() => undefined);
    }
}

/** Dev-only persistence/restart check for native credentials and links. */
export async function maybeRunVaultE2E(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[VAULT_FLAG]) return;
    const report: any = { schema: "svn-vault-e2e/1", startedAt: new Date().toISOString() };
    try {
        const config = storage[VAULT_FLAG];
        const parsed = typeof config === "string" && config !== "1" ? JSON.parse(config) : {};
        const service = (plugin as any).nativeCloud;
        const vault = service.vault;
        report.loadSource = vault.getLoadSource?.();
        report.persistenceMode = vault.getPersistenceMode?.();
        report.providers = {};
        for (const id of ["baidu", "quark", "aliyun"]) {
            const credential = await vault.get(id);
            report.providers[id] = credential
                ? { present: true, keys: Object.keys(credential.values), label: credential.label || "" }
                : { present: false };
            if (parsed.write && credential) {
                await vault.set(credential);
                report.providers[id].rewritten = true;
            }
        }
        if (parsed.link) {
            const sql = await fetchSyncPost("/api/query/sql", {
                stmt: "SELECT id, root_id, content FROM blocks WHERE content LIKE '%svn-native://%' ORDER BY created DESC LIMIT 1",
            });
            const row = sql?.data?.[0];
            report.linkBlock = row ? { id: row.id, rootId: row.root_id } : null;
            if (row) {
                openTab({ app: (plugin as any).app, doc: { id: row.root_id } });
                const protyle = await waitForEditor(row.root_id, 30000);
                await sleep(800);
                const anchors = Array.from(protyle.protyle.wysiwyg.element.querySelectorAll('[data-type="a"]')) as HTMLElement[];
                const anchor = anchors.find((item) => String(item.getAttribute("data-href") || "").startsWith("svn-native://"));
                report.linkAnchor = anchor ? String(anchor.getAttribute("data-href") || "").slice(0, 120) : null;
                if (anchor) {
                    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                    await sleep(7000);
                    const video = document.querySelector(".svn-native__video") as HTMLVideoElement | null;
                    report.linkPlayback = {
                        videoExists: Boolean(video),
                        readyState: video?.readyState ?? -1,
                        paused: video?.paused ?? null,
                        duration: video?.duration ?? null,
                    };
                }
            }
        }
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
    } finally {
        report.finishedAt = new Date().toISOString();
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: VAULT_REPORT_KEY, val: JSON.stringify(report) }).catch(() => undefined);
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: VAULT_FLAG, val: "" }).catch(() => undefined);
    }
}

/** Dev-only native playback probe using the already-saved login in the plugin. */
export async function maybeRunNativePlaybackE2E(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[NATIVE_PLAY_FLAG]) return;
    const report: any = { schema: "svn-native-play-e2e/1", startedAt: new Date().toISOString() };
    try {
        const config = JSON.parse(String(storage[NATIVE_PLAY_FLAG]));
        report.config = config;
        const service = (plugin as any).nativeCloud;
        if (config.provider) service.setActiveProvider(config.provider);
        const provider = service.getProvider(config.provider || service.getActiveProviderId());
        const credential = await service.vault.get(provider.id);
        report.provider = provider.id;
        report.hasCredential = Boolean(credential);
        if (!credential) throw new Error("没有已保存的登录凭据，请先在原生网盘页签登录");
        if (provider.id === "quark") {
            report.oldLinkLocate = await service.locate("37610cc286154262b808e6cf7786b28e").catch((error: any) => ({ error: String(error?.message || error) }));
            if (report.oldLinkLocate?.dirId) {
                const oldRequest = {
                    provider: "quark",
                    fileId: "37610cc286154262b808e6cf7786b28e",
                    name: "1.《地理是什么？》.mp4",
                    seconds: 5,
                };
                service.setPendingPlay(oldRequest);
                (plugin as any).openNativeCloudTab();
                window.setTimeout(() => window.dispatchEvent(new CustomEvent("svn-native-play", { detail: oldRequest })), 500);
                await sleep(7000);
                report.oldLinkUi = {
                    breadcrumbs: Array.from(document.querySelectorAll(".svn-native__crumb")).map((el) => el.textContent),
                    playlistRows: document.querySelectorAll(".svn-native__playlist-row").length,
                    videoReadyState: (document.querySelector(".svn-native__video") as HTMLVideoElement | null)?.readyState ?? -1,
                };
            }
        }
        const video = provider.id === "aliyun"
            ? await (async () => {
                  const root = await service.list("root");
                  const dirs = root.filter((item: any) => item.isDir);
                  const dir = dirs.find((item: any) => item.name.includes("微分几何")) || dirs[0];
                  if (!dir) return null;
                  report.path = [dir.name];
                  const files = await service.list(dir.id);
                  return files.find((item: any) => !item.isDir && /\.(mp4|mkv|webm|mov)$/i.test(item.name)) || null;
              })()
            : await (async function find(dir: string, depth: number): Promise<any> {
            if (depth > 3) return null;
            const entries = await service.list(dir);
            const direct = entries.find((item: any) => !item.isDir && /\.(mp4|mkv|webm|mov)$/i.test(item.name));
            if (direct) return direct;
            for (const item of entries.filter((entry: any) => entry.isDir).slice(0, 8)) {
                const found = await find(item.id, depth + 1);
                if (found) return found;
            }
            return null;
        })(provider.id === "baidu" ? "/" : provider.id === "aliyun" ? "root" : "0", 0);
        report.video = video;
        if (!report.video && provider.id === "quark") {
            const pathKeywords = ["分享", "2026洋葱", "地球", "1-6年级", "认识地球", "地理"];
            let currentDir = "0";
            for (const keyword of pathKeywords) {
                const children = await service.list(currentDir);
                const child = children.find((item: any) => item.isDir && item.name.includes(keyword));
                if (!child) break;
                currentDir = child.id;
                report.path = [...(report.path || []), child.name];
            }
            const folderEntries = await service.list(currentDir);
            const found = folderEntries.find((item: any) => !item.isDir && /\.mp4$/i.test(item.name));
            if (found) report.video = found;
        }
        const selectedVideo = report.video;
        if (!selectedVideo) throw new Error("未找到视频文件");
        const playable = await service.makePlayableUrl(selectedVideo.id);
        report.playable = playable;
        report.playDebug = service.lastPlayDebug;
        if (playable.kind === "hls") {
            report.videoProbe = { skipped: "hls", url: playable.url };
        } else {
            const videoElement = document.createElement("video");
            videoElement.src = playable.url;
            videoElement.muted = true;
            videoElement.style.display = "none";
            document.body.appendChild(videoElement);
            report.videoProbe = await new Promise<any>((resolve) => {
                const timer = window.setTimeout(() => resolve({ timeout: true, readyState: videoElement.readyState }), 15000);
                videoElement.addEventListener("loadeddata", () => {
                    window.clearTimeout(timer);
                    resolve({ loaded: true, duration: videoElement.duration, videoWidth: videoElement.videoWidth, videoHeight: videoElement.videoHeight });
                }, { once: true });
                videoElement.addEventListener("error", () => {
                    window.clearTimeout(timer);
                    resolve({ errorCode: videoElement.error?.code, errorMessage: videoElement.error?.message });
                }, { once: true });
                videoElement.load();
            });
            videoElement.remove();
            if (!report.videoProbe?.loaded) throw new Error("本地播放器未能解码视频：" + JSON.stringify(report.videoProbe));
        }
        const request = { provider: provider.id, fileId: selectedVideo.id, name: selectedVideo.name, seconds: 5 };
        service.setPendingPlay(request);
        (plugin as any).openNativeCloudTab();
        window.setTimeout(() => window.dispatchEvent(new CustomEvent("svn-native-play", { detail: request })), 500);
        await sleep(provider.id === "aliyun" ? 12000 : 5000);
        const uiVideo = document.querySelector(".svn-native__video") as HTMLVideoElement | null;
        report.uiPlayer = {
            exists: Boolean(uiVideo),
            readyState: uiVideo?.readyState ?? -1,
            paused: uiVideo?.paused ?? null,
            muted: uiVideo?.muted ?? null,
            volume: uiVideo?.volume ?? null,
            duration: uiVideo?.duration ?? 0,
            controls: document.querySelectorAll(".svn-native__controls .svn-native__ctrl").length,
            playlistRows: document.querySelectorAll(".svn-native__playlist-row").length,
        };
        if (!uiVideo || uiVideo.readyState < 1) throw new Error("原生播放器 UI 未加载视频：" + JSON.stringify(report.uiPlayer));
        if (uiVideo.paused) {
            (document.querySelector(".svn-native__controls .svn-native__ctrl") as HTMLElement | null)?.click();
            await sleep(3000);
            report.uiPlayerAfterClick = {
                paused: uiVideo.paused,
                muted: uiVideo.muted,
                volume: uiVideo.volume,
                currentTime: uiVideo.currentTime,
                readyState: uiVideo.readyState,
                errorCode: uiVideo.error?.code ?? null,
            };
        }
        const nativeApi = service.getPlayerApi();
        if (nativeApi?.isActive()) {
            const frame = await nativeApi.captureFrame();
            const clip = await nativeApi.captureClip(1);
            report.nativeCapture = {
                frame: { width: frame.width, height: frame.height, dataUrlLength: frame.dataUrl.length },
                clip: { bytes: clip.byteLength, mime: clip.mime, hasAudio: clip.hasAudio },
            };
        }
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
    } finally {
        report.finishedAt = new Date().toISOString();
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: NATIVE_PLAY_REPORT_KEY, val: JSON.stringify(report) }).catch(() => undefined);
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: NATIVE_PLAY_FLAG, val: "" }).catch(() => undefined);
    }
}

/** Dev-only check that the experimental native cloud tab mounts. */
export async function maybeRunNativeUIE2E(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[NATIVE_UI_FLAG]) return;
    const report: any = { schema: "svn-native-ui-e2e/1", startedAt: new Date().toISOString() };
    try {
        (plugin as any).openNativeCloudTab();
        await sleep(1500);
        report.ui = Boolean(document.querySelector(".svn-native"));
        report.cookieField = Boolean(document.querySelector(".svn-native__login textarea"));
        report.warningVisible = Boolean(document.querySelector(".svn-native__warn"));
        if (!report.ui || !report.cookieField) throw new Error("native cloud tab did not mount");
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
    } finally {
        report.finishedAt = new Date().toISOString();
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: NATIVE_UI_REPORT_KEY, val: JSON.stringify(report) }).catch(() => undefined);
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: NATIVE_UI_FLAG, val: "" }).catch(() => undefined);
    }
}

/**
 * Dev-only cloud mount manager E2E: fetch driver schemas and create/delete a
 * real storage through the same admin APIs used by the in-plugin manager.
 */
export async function maybeRunCloudMountsE2E(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[MOUNT_FLAG]) return;
    const report: any = { schema: "svn-cloud-mounts-e2e/1", startedAt: new Date().toISOString() };
    try {
        const config = JSON.parse(String(storage[MOUNT_FLAG]));
        report.baseUrl = config.baseUrl;
        const cloud = (plugin as any).cloudDrive;
        await cloud.login(config.baseUrl, config.username, config.password);
        report.login = true;
        for (const driver of ["BaiduNetdisk", "Quark", "AliyundriveOpen", "Local"]) {
            try {
                const info = await cloud.getDriverInfo(driver);
                report[driver] = {
                    additional: info.additional.map((field: any) => field.name),
                    required: info.additional.filter((field: any) => field.required).map((field: any) => field.name),
                };
            } catch (error) {
                report[driver] = { error: String((error as any)?.message || error) };
            }
        }
        report.drivers = await cloud.listDrivers();
        const mountPath = `/svn-mount-${Date.now()}`;
        report.mountPath = mountPath;
        await cloud.createStorage({
            mount_path: mountPath,
            order: 0,
            driver: "Local",
            cache_expiration: 30,
            status: "work",
            addition: JSON.stringify({ root_folder_path: config.localPath, thumbnail: false, directory_size: false, show_hidden: true }),
            remark: "svn mount e2e",
            webdav_policy: "native_proxy",
            disable_index: false,
            enable_sign: false,
            seed_policy: "inherit",
            web_proxy: false,
            down_proxy_url: "",
            disable_proxy_sign: false,
            order_by: "",
            order_direction: "",
            extract_folder: "",
        });
        const storages = await cloud.listStorages();
        report.created = storages.find((item: any) => item.mountPath === mountPath) || null;
        if (!report.created) throw new Error("created mount not found in storage list");
        const files = await cloud.list(mountPath);
        report.files = files.map((item: any) => item.name);
        if (!files.some((item: any) => item.name === "test.mp4")) throw new Error("mounted directory listing failed");
        await cloud.deleteStorage(report.created.id);
        const afterDelete = await cloud.listStorages();
        report.deleted = !afterDelete.some((item: any) => item.mountPath === mountPath);
        if (!report.deleted) throw new Error("mount delete failed");
        (plugin as any).openCloudMountsTab();
        await sleep(1200);
        report.uiTab = Boolean(document.querySelector(".svn-mounts"));
        if (!report.uiTab) throw new Error("mount manager tab did not mount");
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
    } finally {
        report.finishedAt = new Date().toISOString();
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: MOUNT_REPORT_KEY, val: JSON.stringify(report) }).catch(() => undefined);
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: MOUNT_FLAG, val: "" }).catch(() => undefined);
    }
}

/**
 * Dev-only cloud-drive E2E against a real OpenList/AList server. Credentials
 * are read from localStorage `svn-e2e-cloud` (JSON) and never stored in repo.
 */
export async function maybeRunCloudE2E(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[CLOUD_FLAG]) return;
    const report: any = { schema: "svn-cloud-e2e/1", startedAt: new Date().toISOString() };
    try {
        const config = JSON.parse(String(storage[CLOUD_FLAG]));
        report.baseUrl = config.baseUrl;
        const cloud = (plugin as any).cloudDrive;
        if (!cloud) throw new Error("cloudDrive service missing");
        await cloud.login(config.baseUrl, config.username, config.password);
        report.login = true;
        const root = await cloud.list("/");
        report.root = root;
        const local = root.find((item: any) => item.isDir);
        if (!local) throw new Error("no mounted directory found at /");
        const files = await cloud.list(local.path);
        report.files = files;
        const video = files.find((item: any) => !item.isDir && /\.(mp4|mkv|webm|m3u8)$/i.test(item.name));
        if (!video) throw new Error("no video file found in mounted directory");
        const info = await cloud.getFile(video.path);
        report.video = info;
        if (!/^https?:\/\//.test(info.rawUrl || "")) throw new Error("invalid raw_url");

        const notebooks = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const notebook = notebooks?.data?.notebooks?.find((n: any) => !n.closed);
        if (!notebook) throw new Error("no open notebook");
        const created = await fetchSyncPost("/api/filetree/createDocWithMd", {
            notebook: notebook.id,
            path: `/svn-cloud-e2e-${Date.now()}.sy`,
            markdown: "# Cloud Video E2E\n\nTARGET-CLOUD 在这里插入网盘视频标记。",
        });
        const docId = created.data;
        report.docId = docId;
        openTab({ app: (plugin as any).app, doc: { id: docId } });
        const protyle = await waitForEditor(docId, 30000);
        placeCaret(protyle);
        plugin.tracker.captureFromProtyle(protyle);

        const browser = (plugin as any).browser;
        browser.setPendingInitialUrl(buildCloudPlayerUrl((plugin as any).name, info.rawUrl, info.name));
        const attached = await waitForBrowserAttached(plugin, 30000);
        report.browserAttached = attached.isAttached();
        const player = await waitForVideo(attached, 60000);
        report.player = player;
        if (!player.hasVideo) throw new Error("cloud video did not play in webview");

        await attached.seek(4);
        plugin.lastInsert = null;
        await plugin.insertTimestamp("dev");
        report.insert = plugin.lastInsert;
        if (!plugin.lastInsert?.ok) throw new Error("cloud timestamp insertion failed");
        plugin.lastScreenshot = null;
        await plugin.insertScreenshot("dev");
        report.screenshot = await waitForScreenshot(plugin, 30000);
        if (!report.screenshot?.ok) throw new Error("cloud screenshot failed");
        plugin.lastClip = null;
        await plugin.insertClip(2, "dev");
        report.clip = await waitForClip(plugin, 30000);
        if (!report.clip?.ok) throw new Error("cloud clip failed");
        // Open the integrated cloud tab and verify it renders a file row.
        (plugin as any).openCloudTab();
        await sleep(1500);
        report.uiRows = document.querySelectorAll(".svn-cloud__row").length;
        report.uiTab = Boolean(document.querySelector(".svn-cloud"));
        if (!report.uiTab) throw new Error("integrated cloud tab did not mount");
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
    } finally {
        report.finishedAt = new Date().toISOString();
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: CLOUD_REPORT_KEY, val: JSON.stringify(report) }).catch(() => undefined);
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: CLOUD_FLAG, val: "" }).catch(() => undefined);
    }
}

/**
 * Dev-only generic HTML5 video E2E (cloud-drive / OpenList foundation).
 * Runs against a local fixture page so it does not depend on Bilibili network.
 */
export async function maybeRunGenericE2E(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[GENERIC_FLAG]) return;
    const report: any = { schema: "svn-generic-video-e2e/1", startedAt: new Date().toISOString(), url: GENERIC_URL };
    try {
        const notebooks = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const notebook = notebooks?.data?.notebooks?.find((n: any) => !n.closed);
        if (!notebook) throw new Error("no open notebook");
        const created = await fetchSyncPost("/api/filetree/createDocWithMd", {
            notebook: notebook.id,
            path: `/svn-generic-e2e-${Date.now()}.sy`,
            markdown: "# Generic Video E2E\n\nTARGET-GENERIC 在这里插入网页视频时间戳。",
        });
        const docId = created.data;
        report.docId = docId;
        openTab({ app: (plugin as any).app, doc: { id: docId } });
        const protyle = await waitForEditor(docId, 30000);
        placeCaret(protyle);
        plugin.tracker.captureFromProtyle(protyle);

        plugin.browser.setPendingInitialUrl(GENERIC_URL);
        const browser = await plugin.ensureBrowser();
        // A restored browser tab may already be attached on the previous page;
        // navigate explicitly to the fixture after the tab is ready.
        await browser.navigate(GENERIC_URL);
        const player = await waitForVideo(browser, 60000);
        const source = await browser.getSource();
        report.player = player;
        report.source = source;
        if (source?.provider !== "url") throw new Error("generic source not detected");
        await browser.seek(4);
        plugin.lastInsert = null;
        await plugin.insertTimestamp("dev");
        report.insert = plugin.lastInsert;
        if (!plugin.lastInsert?.ok) throw new Error("generic timestamp insertion failed");
        const link = Array.from(protyle.protyle.wysiwyg.element.querySelectorAll('[data-type="a"]')).find((el: any) =>
            String(el.getAttribute("data-href") || "").includes("#svn-t="),
        ) as HTMLElement | undefined;
        if (!link) throw new Error("generic timestamp link not found");
        const href = link.getAttribute("data-href") || "";
        const expected = Number((href.match(/svn-t=(\d+)/) || [])[1] || 0);
        await browser.seek(0);
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        const seek = await waitForGenericSeek(browser, expected, 20000);
        report.clickBack = { expected, actual: seek.currentTime };
        if (Math.abs(Number(seek.currentTime) - expected) > 2) throw new Error("generic click-back seek failed");

        plugin.lastClip = null;
        placeCaret(protyle);
        plugin.tracker.captureFromProtyle(protyle);
        await plugin.insertClip(2, "dev");
        report.clip = await waitForClip(plugin, 30000);
        if (!report.clip?.ok) throw new Error("generic clip insertion failed");
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
    } finally {
        report.finishedAt = new Date().toISOString();
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: GENERIC_REPORT_KEY, val: JSON.stringify(report) }).catch(() => undefined);
        await fetchSyncPost("/api/storage/setLocalStorageVal", { key: GENERIC_FLAG, val: "" }).catch(() => undefined);
    }
}

export async function maybeRunPersistTest(plugin: SiYuanVideoNavigatorPlugin): Promise<void> {
    const storage = (window as any)?.siyuan?.storage || {};
    if (!storage[PERSIST_FLAG]) return;
    const report: any = { schema: "svn-persist-e2e/1", startedAt: new Date().toISOString() };
    try {
        // Wait for ScreenshotIndex.refresh() triggered by onLayoutReady.
        await sleep(1200);
        const sql = await fetchSyncPost("/api/query/sql", {
            stmt: "SELECT id, root_id FROM blocks WHERE ial LIKE '%custom-svn-type=\"screenshot\"%' ORDER BY created DESC LIMIT 1",
        });
        const row = sql?.data?.[0];
        if (!row) throw new Error("no screenshot block found in SQL index");
        report.blockId = row.id;
        report.rootId = row.root_id;
        const attrs = await fetchSyncPost("/api/attr/getBlockAttrs", { id: row.id });
        const expectedTime = Number(attrs?.data?.["custom-svn-time"] || 0);
        report.attrs = attrs?.data;
        openTab({ app: (plugin as any).app, doc: { id: row.root_id } });
        const protyle = await waitForEditor(row.root_id, 30000);
        await sleep(500);
        const imageElement = protyle.protyle.wysiwyg.element.querySelector(
            `[data-node-id="${row.id}"] [data-type="img"], [data-node-id="${row.id}"] img`,
        ) as HTMLElement | null;
        if (!imageElement) throw new Error("screenshot image not found in DOM after reload");
        imageElement.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        const started = Date.now();
        let snap: any = null;
        while (Date.now() - started < 20000) {
            snap = await plugin.browser.getSnapshot().catch(() => null);
            if (
                snap?.bvid &&
                Number(snap.duration) > 0 &&
                snap.readyState >= 1 &&
                Math.abs(Number(snap.currentTime) - expectedTime) <= 2
            ) {
                break;
            }
            await sleep(600);
        }
        report.clickBack = { expectedTime, snapshot: snap };
        if (!snap?.bvid || !(Number(snap.duration) > 0) || Math.abs(Number(snap.currentTime) - expectedTime) > 2) {
            throw new Error(`post-reload click-back seek failed: expected ${expectedTime}, got ${snap?.currentTime}`);
        }
    } catch (error) {
        report.error = String((error as any)?.stack || (error as any)?.message || error);
    } finally {
        report.finishedAt = new Date().toISOString();
        try {
            await fetchSyncPost("/api/storage/setLocalStorageVal", { key: PERSIST_REPORT_KEY, val: JSON.stringify(report) });
            await fetchSyncPost("/api/storage/setLocalStorageVal", { key: PERSIST_FLAG, val: "" });
        } catch (error) {
            console.error("[siyuan-video-navigator] persist report write failed", error);
        }
    }
}

async function run(plugin: SiYuanVideoNavigatorPlugin, report: any): Promise<void> {
    const step = (name: string, data?: unknown) => {
        report.steps.push({ name, at: new Date().toISOString(), data });
        console.log("[siyuan-video-navigator] e2e step", name, data ?? "");
    };
    step("start");

    // 1. Fresh test doc in the first open notebook, so no user note is touched.
    const notebooks = await fetchSyncPost("/api/notebook/lsNotebooks", {});
    const notebook = notebooks?.data?.notebooks?.find((n: any) => !n.closed);
    if (!notebook) throw new Error("no open notebook");
    const created = await fetchSyncPost("/api/filetree/createDocWithMd", {
        notebook: notebook.id,
        path: `/svn-phase2-e2e-${Date.now()}.sy`,
        markdown: "# SVN Phase 2 E2E\n\n这是 E2E 插入目标段落。\n\n## 另一段\n\n内容。",
    });
    if (!created || created.code !== 0) throw new Error("createDocWithMd failed: " + JSON.stringify(created));
    const docId = created.data;
    report.docId = docId;
    step("doc-created", { docId, notebook: notebook.id });

    openTab({ app: (plugin as any).app, doc: { id: docId } });
    const protyle = await waitForEditor(docId, 30000);
    step("editor-opened");

    // 2. Simulate a real caret at the end of the first paragraph and let the
    //    product tracker snapshot it (same code path as a user click).
    const caret = placeCaret(protyle);
    plugin.tracker.captureFromProtyle(protyle);
    const target = plugin.tracker.getLastTarget();
    report.caret = caret;
    report.target = target
        ? { rootID: target.rootID, blockID: target.blockID, hasRange: Boolean(target.range), title: target.title }
        : null;
    if (!target?.range) throw new Error("tracker did not capture a caret range");
    step("caret-captured", report.target);

    // 3. Open the real browser tab and load the real video.
    const browser = await plugin.ensureBrowser();
    report.webContentsId = browser.getWebContentsId();
    await browser.navigate(VIDEO.url);
    const player = await waitForVideo(browser, 60000);
    report.video1 = player;
    if (player.bvid !== VIDEO.bvid || player.page !== VIDEO.page) {
        throw new Error(`unexpected video identity: ${player.bvid} p${player.page}`);
    }
    step("video-loaded", { bvid: player.bvid, page: player.page, title: player.title, currentTime: player.currentTime });

    // Toolbar can be hidden/shown; verify the toggle and long-press rewind repeat.
    try {
        const hideButton = document.querySelector('.svn-browser__toolbar button[title^="隐藏工具栏"]') as HTMLElement | null;
        hideButton?.click();
        await sleep(350);
        const showButton = document.querySelector(".svn-browser__show-toolbar") as HTMLElement | null;
        const hidden = Boolean(showButton) && !document.querySelector(".svn-browser__toolbar");
        showButton?.click();
        await sleep(350);
        const shown = Boolean(document.querySelector(".svn-browser__toolbar"));
        report.toolbar = { hidden, shown };
        if (!hidden || !shown) throw new Error("toolbar hide/show failed");
        const rewindButton = Array.from(document.querySelectorAll(".svn-browser__playback")).find((el) =>
            (el.textContent || "").includes("«3s"),
        ) as HTMLElement | undefined;
        if (!rewindButton) throw new Error("rewind 3s button not found");
        await browser.seek(100);
        rewindButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" }));
        await sleep(1000);
        rewindButton.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" }));
        const afterHold = (await browser.getSnapshot()).currentTime;
        report.longPress = { before: 100, after: afterHold, steps: Math.round((100 - Number(afterHold)) / 3) };
        step("toolbar-longpress", report.longPress);
        if (Number(afterHold) > 94) throw new Error("long press did not repeat rewind");
        await (plugin as any).hotkeys?.setHideToolbar(true);
    } catch (error) {
        report.toolbar = { ...(report.toolbar || {}), error: String((error as any)?.message || error) };
        throw error;
    }

    // Playback controls: rewind / forward / play-pause.
    try {
        await browser.seek(100);
        const beforeSkip = (await browser.getSnapshot()).currentTime;
        await browser.seekRelative(-3);
        const afterRewind = (await browser.getSnapshot()).currentTime;
        await browser.seekRelative(3);
        const afterForward = (await browser.getSnapshot()).currentTime;
        await browser.togglePlay();
        const paused = (await browser.getSnapshot()).paused;
        await browser.togglePlay();
        const resumed = (await browser.getSnapshot()).paused;
        report.controls = { beforeSkip, afterRewind, afterForward, paused, resumed };
        step("playback-controls", report.controls);
        if (Math.abs(Number(afterRewind) - (Number(beforeSkip) - 3)) > 2) throw new Error("rewind 3s mismatch");
        if (Math.abs(Number(afterForward) - Number(beforeSkip)) > 2) throw new Error("forward 3s mismatch");
        if (paused !== true) throw new Error("togglePlay did not pause");
        if (resumed !== false) throw new Error("togglePlay did not resume");
    } catch (error) {
        report.controls = { error: String((error as any)?.message || error) };
        throw error;
    }
    await browser.seek(5);

    // 4. Focus guest, then send a REAL input event (Ctrl+Alt+T) into the guest.
    browser.focus();
    await sleep(300);
    report.hostActiveElement = document.activeElement?.tagName || null;
    const targetAfterFocus = plugin.tracker.getLastTarget();
    report.targetAfterFocus = targetAfterFocus
        ? { rootID: targetAfterFocus.rootID, blockID: targetAfterFocus.blockID, hasRange: Boolean(targetAfterFocus.range) }
        : null;
    if (targetAfterFocus?.rootID !== docId) {
        throw new Error(`编辑器目标在视频获得焦点后发生变化：${targetAfterFocus?.rootID} != ${docId}`);
    }
    const guestInput = await sendGuestHotkey(browser, "T");
    report.guestInput = guestInput;
    step("guest-hotkey", guestInput);
    await sleep(2500);
    report.realHotkey = { events: browser.keyBindings.slice(-10), lastInsert: plugin.lastInsert };

    if (!report.realHotkey.events.length) {
        // Diagnostic fallback: synthetic DOM keydown inside the guest. If this
        // works, the bridge is fine and only synthetic-input delivery differs.
        const wv = browser.getWebview();
        report.syntheticHotkey = await wv.executeJavaScript(`(() => {
            const e = new KeyboardEvent("keydown", { key: "t", code: "KeyT", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
            window.dispatchEvent(e);
            return { dispatched: true, installed: !!window.__svnBridgeInstalled };
        })()`, true);
        await sleep(2500);
        report.realHotkey.syntheticEvents = browser.keyBindings.slice(-10);
        report.realHotkey.syntheticLastInsert = plugin.lastInsert;
        step("synthetic-hotkey", report.syntheticHotkey);
    }

    // 5. Verify the timestamp was inserted at the cached caret.
    const kramdown = await waitForKramdownContains(docId, "▶", 12000);
    const hasTimestamp = kramdown.includes("▶");
    report.insert = { hasTimestamp, kramdownSample: kramdown.slice(0, 1600) };
    if (!hasTimestamp) throw new Error("timestamp was not inserted into the document");
    step("timestamp-inserted", { hasTimestamp });

    // 6. Click the timestamp itself; the product click-back handler must seek.
    const anchor = protyle.protyle.wysiwyg.element.querySelector('[data-type="a"][data-href*="bilibili.com/video"], a[href*="bilibili.com/video"]') as HTMLElement | null;
    if (!anchor) throw new Error("inserted timestamp link not found in DOM");
    const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
    const expectedSeconds = parseTimeParam(new URL(href, location.href).searchParams.get("t")) ?? 0;
    report.timestampLink = { href, expectedSeconds };

    // Move the player away first so we can observe the seek-back.
    await browser.seek(VIDEO.seek);
    await browser.getWebview().executeJavaScript(`(() => { const v = document.querySelector("video"); if (v) v.muted = false; return { muted: v ? v.muted : null }; })()`, true);
    await sleep(500);
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    const clicked = await waitForSeekBack(browser, expectedSeconds, 15000);
    report.clickBack = { ...clicked, mutedAfterClickBack: clicked.muted };
    step("click-back", report.clickBack);
    if (Math.abs(Number(clicked.currentTime) - expectedSeconds) > 2) {
        throw new Error(`click-back seek error ${clicked.currentTime} vs ${expectedSeconds}`);
    }
    if (clicked.muted === true) {
        throw new Error("click-back left the player muted");
    }

    // 7. Screenshot: capture the current frame, upload to assets, insert image
    //    block + custom source attrs, then click the image itself to seek back.
    placeCaret(protyle);
    plugin.tracker.captureFromProtyle(protyle);
    browser.focus();
    await sleep(300);
    const wvForScreenshot = browser.getWebview();
    report.screenshotHotkey = await wvForScreenshot.executeJavaScript(`(() => {
        const e = new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
        window.dispatchEvent(e);
        return { dispatched: true };
    })()`, true);
    const screenshot = await waitForScreenshot(plugin, 15000);
    report.screenshot = screenshot;
    step("screenshot-inserted", {
        ok: screenshot.ok,
        assetPath: screenshot.result?.assetPath,
        blockId: screenshot.result?.blockId,
        timeSeconds: screenshot.result?.timeSeconds,
        error: screenshot.error,
    });
    if (!screenshot.ok || !screenshot.result?.blockId) {
        throw new Error("screenshot insertion failed: " + (screenshot.error || JSON.stringify(screenshot)));
    }

    const screenshotBlockId = screenshot.result.blockId;
    const attrsResponse = await fetchSyncPost("/api/attr/getBlockAttrs", { id: screenshotBlockId });
    report.screenshotAttrs = {
        code: attrsResponse?.code,
        attrs: attrsResponse?.data
            ? {
                  type: attrsResponse.data["custom-svn-type"],
                  bvid: attrsResponse.data["custom-svn-bvid"],
                  page: attrsResponse.data["custom-svn-page"],
                  time: attrsResponse.data["custom-svn-time"],
                  asset: attrsResponse.data["custom-svn-asset"],
              }
            : null,
    };
    const screenshotTime = Number(screenshot.result.timeSeconds);
    await browser.seek(VIDEO.seek);
    await sleep(500);
    const imageElement = protyle.protyle.wysiwyg.element.querySelector(
        `[data-node-id="${screenshotBlockId}"] [data-type="img"], [data-node-id="${screenshotBlockId}"] img`,
    ) as HTMLElement | null;
    if (!imageElement) throw new Error("inserted screenshot image not found in DOM");
    imageElement.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    const screenshotClick = await waitForSeekBack(browser, screenshotTime, 15000);
    report.screenshotClickBack = screenshotClick;
    step("screenshot-click-back", screenshotClick);
    if (Math.abs(Number(screenshotClick.currentTime) - screenshotTime) > 2) {
        throw new Error(`screenshot click-back seek error ${screenshotClick.currentTime} vs ${screenshotTime}`);
    }

    // 7b. Record a real 3-second clip and insert it as a playable video block.
    try {
        placeCaret(protyle);
        plugin.tracker.captureFromProtyle(protyle);
        plugin.lastClip = null;
        await plugin.insertClip(3, "dev");
        const clip = await waitForClip(plugin, 30000);
        report.clip = clip;
        step("clip-inserted", {
            ok: clip.ok,
            assetPath: clip.result?.assetPath,
            blockId: clip.result?.blockId,
            duration: clip.result?.durationSeconds,
            bytes: clip.result?.byteLength,
            mode: clip.result?.mode,
            hasAudio: clip.result?.hasAudio,
            error: clip.error,
        });
        if (!clip.ok) throw new Error("clip insertion failed: " + (clip.error || ""));
        const clipDom = await fetchSyncPost("/api/block/getBlockDOM", { id: clip.result.blockId });
        report.clipDom = { code: clipDom?.code, type: (clipDom?.data?.dom || "").match(/data-type="([^"]+)"/)?.[1] || null };
        if (report.clipDom.type !== "NodeVideo") throw new Error("clip block is not a video block");
        const clipAttrs = await fetchSyncPost("/api/attr/getBlockAttrs", { id: clip.result.blockId });
        report.clipAttrs = clipAttrs?.data
            ? {
                  type: clipAttrs.data["custom-svn-type"],
                  start: clipAttrs.data["custom-svn-clip-start"],
                  end: clipAttrs.data["custom-svn-clip-end"],
                  asset: clipAttrs.data["custom-svn-asset"],
              }
            : null;
    } catch (error) {
        report.clip = { ...(report.clip || {}), error: String((error as any)?.message || error) };
        throw error;
    }

    // 8. Custom hotkey: change the timestamp binding at runtime, then trigger
    //    the NEW key from the guest and verify insertion still works.
    const hotkeys = (plugin as any).hotkeys;
    const originalConfig = hotkeys.getConfig();
    try {
        await hotkeys.setBinding("timestamp", "Ctrl+Alt+U");
        report.customHotkey = { binding: "Ctrl+Alt+U", before: plugin.lastInsert?.at || null };
        const wvForCustom = browser.getWebview();
        await wvForCustom.executeJavaScript(`(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "u", code: "KeyU", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
            return { dispatched: true };
        })()`, true);
        await sleep(3000);
        report.customHotkey.afterLastInsert = plugin.lastInsert;
        report.customHotkey.ok = Boolean(plugin.lastInsert?.ok && plugin.lastInsert?.source === "hotkey");
        step("custom-hotkey", report.customHotkey);
        if (!report.customHotkey.ok) throw new Error("custom hotkey did not trigger insertion");
    } finally {
        await hotkeys.setBinding("timestamp", originalConfig.timestamp);
        report.customHotkeyRestored = hotkeys.getConfig();
    }

    // 9. Settings panel opens and shows the current hotkey values.
    try {
        (plugin as any).openSetting();
        await sleep(900);
        const dialogInputs = Array.from(document.querySelectorAll(".b3-dialog input")).map((el) => (el as HTMLInputElement).value);
        report.settingsPanel = {
            dialogCount: document.querySelectorAll(".b3-dialog").length,
            inputs: dialogInputs,
        };
        try {
            const closeEl = document.querySelector(".b3-dialog__close") as HTMLElement | null;
            if (closeEl && typeof closeEl.click === "function") closeEl.click();
            else (closeEl?.closest?.("button") as HTMLElement | null)?.click?.();
        } catch {
            /* closing the dialog is best-effort */
        }
    } catch (error) {
        report.settingsPanel = { error: String((error as any)?.message || error) };
    }

    // Direct-reopen video behavior is covered by the earlier e2e-custom-hotkey run.

    // 11. Ctrl+wheel zoom: guest wheel -> host zoom factor.
    try {
        const zoomBefore = browser.getZoom();
        const zoomView = browser.getWebview();
        await zoomView.executeJavaScript(`(() => {
            window.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, ctrlKey: true, cancelable: true, bubbles: true }));
            return { dispatched: true };
        })()`, true);
        await sleep(800);
        const zoomAfter = browser.getZoom();
        report.zoom = {
            before: zoomBefore,
            after: zoomAfter,
            webviewZoomFactor: zoomView.getZoomFactor ? zoomView.getZoomFactor() : null,
        };
        step("wheel-zoom", report.zoom);
        if (!(zoomAfter > zoomBefore)) throw new Error("ctrl+wheel did not increase page zoom");
        browser.resetZoom();
    } catch (error) {
        report.zoom = { error: String((error as any)?.message || error) };
        throw error;
    }

    // 12. Generic HTML5 video page (cloud-drive/OpenList foundation):
    //     timestamp + click-back must work without a BV id.
    try {
        const genericUrl = "http://127.0.0.1:8765/index.html";
        await browser.navigate(genericUrl);
        const genericPlayer = await waitForVideo(browser, 60000);
        const genericSource = await browser.getSource();
        report.generic = { player: genericPlayer, source: genericSource };
        if (genericSource?.provider !== "url") throw new Error("generic source was not detected");
        await browser.seek(3);
        placeCaret(protyle);
        plugin.tracker.captureFromProtyle(protyle);
        plugin.lastInsert = null;
        await plugin.insertTimestamp("dev");
        const genericInsert = plugin.lastInsert as any;
        report.generic.insert = genericInsert;
        if (!genericInsert?.ok || genericInsert.result?.bvid !== "") throw new Error("generic timestamp insertion failed");
        const genericLink = Array.from(protyle.protyle.wysiwyg.element.querySelectorAll('[data-type="a"]')).find((el: any) =>
            String(el.getAttribute("data-href") || "").includes("#svn-t="),
        ) as HTMLElement | undefined;
        if (!genericLink) throw new Error("generic timestamp link not found");
        const genericHref = genericLink.getAttribute("data-href") || "";
        const genericSeconds = Number((genericHref.match(/svn-t=(\d+)/) || [])[1] || 0);
        await browser.navigate("http://127.0.0.1:8765/index.html");
        await waitForVideo(browser, 60000);
        await browser.seek(0);
        genericLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        const genericSeek = await waitForGenericSeek(browser, genericSeconds, 20000);
        report.generic.clickBack = { expected: genericSeconds, actual: genericSeek.currentTime };
        step("generic-video", report.generic);
        if (Math.abs(Number(genericSeek.currentTime) - genericSeconds) > 2) throw new Error("generic click-back seek failed");
    } catch (error) {
        report.generic = { ...(report.generic || {}), error: String((error as any)?.message || error) };
        throw error;
    }

    showMessage("Phase 2 E2E 通过：时间戳 + 截图 + 片段 + 自定义快捷键", 5000);
}

async function waitForEditor(docId: string, timeoutMs: number): Promise<Protyle> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const editors = getAllEditor();
        for (const protyle of editors) {
            if (protyle?.protyle?.block?.rootID === docId) return protyle;
        }
        await sleep(350);
    }
    throw new Error("editor not found for doc " + docId);
}

function placeCaret(protyle: Protyle): { blockId: string | null; blockType: string | null } {
    const wysiwyg = protyle.protyle.wysiwyg.element;
    const block = wysiwyg.querySelector('[data-type="NodeParagraph"]') || wysiwyg.querySelector("[data-node-id]");
    if (!block) throw new Error("no paragraph in test doc");
    const editable = (block.querySelector('[contenteditable="true"]') || block) as HTMLElement;
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    protyle.protyle.toolbar.range = range.cloneRange();
    return {
        blockId: block.getAttribute("data-node-id"),
        blockType: block.getAttribute("data-type"),
    };
}

async function waitForVideo(browser: any, timeoutMs: number): Promise<any> {
    const started = Date.now();
    let last: any = null;
    while (Date.now() - started < timeoutMs) {
        last = await browser.getSnapshot();
        if (last.hasVideo && last.readyState >= 1 && Number(last.duration) > 0) return last;
        await sleep(800);
    }
    throw new Error("video not ready: " + JSON.stringify(last));
}

async function sendGuestHotkey(browser: any, keyCode: string): Promise<any> {
    const wv = browser.getWebview();
    if (!wv) throw new Error("no webview");
    const remote = require("@electron/remote");
    const electron = remote.require ? remote.require("electron") : null;
    const webContents = remote.webContents || electron?.webContents;
    const wc = webContents?.fromId?.(wv.getWebContentsId());
    if (!wc) throw new Error("@electron/remote webContents.fromId unavailable");
    wc.focus?.();
    await sleep(250);
    wc.sendInputEvent({ type: "keyDown", keyCode, modifiers: ["control", "alt"] });
    wc.sendInputEvent({ type: "keyUp", keyCode, modifiers: ["control", "alt"] });
    return { method: "webContents.sendInputEvent", keyCode, modifiers: ["control", "alt"], focused: true };
}

async function waitForKramdownContains(docId: string, needle: string, timeoutMs: number): Promise<string> {
    const started = Date.now();
    let last = "";
    while (Date.now() - started < timeoutMs) {
        const response = await fetchSyncPost("/api/block/getBlockKramdown", { id: docId });
        last = response?.data?.kramdown || "";
        if (last.includes(needle)) return last;
        await sleep(400);
    }
    return last;
}

async function waitForScreenshot(plugin: SiYuanVideoNavigatorPlugin, timeoutMs: number): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (plugin.lastScreenshot) return plugin.lastScreenshot;
        await sleep(300);
    }
    throw new Error("screenshot service did not finish within timeout");
}

async function waitForClip(plugin: SiYuanVideoNavigatorPlugin, timeoutMs: number): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (plugin.lastClip) return plugin.lastClip;
        await sleep(400);
    }
    throw new Error("clip service did not finish within timeout");
}

async function waitForSeekBack(browser: any, expectedSeconds: number, timeoutMs: number): Promise<any> {
    const started = Date.now();
    let last: any = null;
    while (Date.now() - started < timeoutMs) {
        last = await browser.getSnapshot();
        if (last.bvid && last.page === VIDEO.page && Math.abs(Number(last.currentTime) - expectedSeconds) <= 2) {
            return { ...last, expectedSeconds };
        }
        await sleep(500);
    }
    throw new Error("seek-back did not reach " + expectedSeconds + "s; last=" + JSON.stringify(last));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
