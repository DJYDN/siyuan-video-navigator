<script lang="ts">
    import { onMount } from "svelte";
    import type { BrowserController } from "@/browser/BrowserController";
    import { formatTimestamp } from "@/utils/time";

    export let controller: BrowserController;
    export let onOpenSettings: (() => void) | undefined = undefined;
    export let onTogglePlay: (() => void) | undefined = undefined;
    export let onSeekRelative: ((delta: number) => void) | undefined = undefined;
    export let onCaptureClip: (() => void) | undefined = undefined;
    export let onOpenNetdisk: (() => void) | undefined = undefined;
    export let hideToolbar = true;
    export let onHideToolbarChange: ((hidden: boolean) => void) | undefined = undefined;

    let state = controller.getState();
    let address = controller.getState().url || "https://www.bilibili.com/";
    let host: HTMLDivElement;
    let addressInput: HTMLInputElement;
    let error: string | null = null;
    let toolbarVisible = !hideToolbar;
    let holdTimer: number | null = null;

    function stopHold(): void {
        if (holdTimer !== null) {
            window.clearInterval(holdTimer);
            holdTimer = null;
        }
    }

    function startSeek(delta: number): void {
        if (!onSeekRelative) return;
        onSeekRelative(delta);
        stopHold();
        holdTimer = window.setInterval(() => onSeekRelative?.(delta), 280);
    }

    function setToolbarVisible(visible: boolean): void {
        toolbarVisible = visible;
        onHideToolbarChange?.(!visible);
    }

    onMount(() => {
        const unsubscribe = controller.subscribe((next) => {
            state = next;
            error = next.error;
            if (document.activeElement !== addressInput) {
                address = next.url || address;
            }
        });
        controller.attach(host).catch((e) => {
            error = String(e?.message || e);
        });
        return () => {
            unsubscribe();
            controller.detach();
        };
    });

    function go() {
        const value = address.trim();
        if (!value) return;
        let url = value;
        if (!/^https?:\/\//i.test(url)) {
            if (/^BV[0-9A-Za-z]+$/.test(url)) {
                url = `https://www.bilibili.com/video/${url}/`;
            } else if (/^[\w.-]+\.[a-z]{2,}/i.test(url)) {
                url = `https://${url}`;
            } else {
                url = `https://search.bilibili.com/all?keyword=${encodeURIComponent(url)}`;
            }
        }
        controller.navigate(url).catch((e) => (error = String(e?.message || e)));
    }

    function onAddressKey(event: KeyboardEvent) {
        if (event.key === "Enter") {
            event.preventDefault();
            go();
        }
    }

    function timeText(value: number | null): string {
        if (value === null || !Number.isFinite(value)) return "--:--";
        try {
            return formatTimestamp(value);
        } catch {
            return "--:--";
        }
    }
</script>

<div class="svn-browser">
    {#if toolbarVisible}
        <div class="svn-browser__toolbar">
            <button class="b3-button b3-button--text svn-browser__nav" title="后退" onclick={() => controller.goBack()} disabled={!state.canGoBack}>
                <svg><use href="#iconLeft"></use></svg>
            </button>
            <button class="b3-button b3-button--text svn-browser__nav" title="前进" onclick={() => controller.goForward()} disabled={!state.canGoForward}>
                <svg><use href="#iconRight"></use></svg>
            </button>
            <button class="b3-button b3-button--text svn-browser__nav" title="刷新" onclick={() => controller.reload()}>
                <svg><use href={state.loading ? "#iconClose" : "#iconRefresh"}></use></svg>
            </button>
            <input
                bind:this={addressInput}
                bind:value={address}
                class="b3-text-field fn__flex-1"
                onkeydown={onAddressKey}
                onfocus={() => (address = state.url || address)}
                placeholder="B 站网址、BV 号或搜索关键词"
                spellcheck="false"
            />
            <button class="b3-button b3-button--outline" onclick={go}>打开</button>
            <button class="b3-button b3-button--text svn-browser__nav" title="回到 B 站首页" onclick={() => controller.navigate("https://www.bilibili.com/")}>
                <svg><use href="#iconHome"></use></svg>
            </button>
            {#if onSeekRelative}
                <button
                    class="b3-button b3-button--text svn-browser__playback"
                    title="快退 3 秒（长按持续后退）"
                    onpointerdown={(event) => {
                        event.preventDefault();
                        startSeek(-3);
                    }}
                    onpointerup={stopHold}
                    onpointerleave={stopHold}
                    onpointercancel={stopHold}
                >«3s</button>
            {/if}
            {#if onTogglePlay}
                <button class="b3-button b3-button--text svn-browser__playback" title={state.paused ? "播放" : "暂停"} onclick={onTogglePlay}>
                    {state.paused ? "▶" : "⏸"}
                </button>
            {/if}
            {#if onSeekRelative}
                <button
                    class="b3-button b3-button--text svn-browser__playback"
                    title="快进 3 秒（长按持续前进）"
                    onpointerdown={(event) => {
                        event.preventDefault();
                        startSeek(3);
                    }}
                    onpointerup={stopHold}
                    onpointerleave={stopHold}
                    onpointercancel={stopHold}
                >3s»</button>
            {/if}
            {#if onCaptureClip}
                <button class="b3-button b3-button--outline svn-browser__clip" title="按设置时长截取片段并插入笔记" onclick={onCaptureClip}>✂ 片段</button>
            {/if}
            {#if onOpenNetdisk}
                <button class="b3-button b3-button--text svn-browser__nav" title="打开网盘（OpenList/AList）" onclick={onOpenNetdisk}>网盘</button>
            {/if}
            <button class="b3-button b3-button--text svn-browser__nav" title="缩小页面（也可 Ctrl+滚轮）" onclick={() => controller.zoomOut()}>−</button>
            <button class="b3-button b3-button--text svn-browser__zoom" title="重置缩放" onclick={() => controller.resetZoom()}>{Math.round((state.zoom || 1) * 100)}%</button>
            <button class="b3-button b3-button--text svn-browser__nav" title="放大页面（也可 Ctrl+滚轮）" onclick={() => controller.zoomIn()}>+</button>
            {#if onOpenSettings}
                <button class="b3-button b3-button--text svn-browser__nav" title="快捷键/片段/工具栏设置" onclick={onOpenSettings}>
                    <svg><use href="#iconSettings"></use></svg>
                </button>
            {/if}
            <button class="b3-button b3-button--text svn-browser__nav" title="隐藏工具栏（可再用右上角小按钮显示）" onclick={() => setToolbarVisible(false)}>⌃</button>
        </div>

        <div class="svn-browser__status">
            {#if state.hasVideo}
                <span class="svn-browser__badge">▶ {state.bvid ? `${state.bvid} · P${state.page}` : "网页视频"}</span>
                <span class="svn-browser__time">{timeText(state.currentTime)} / {timeText(state.duration)}</span>
            {:else}
                <span class="svn-browser__badge svn-browser__badge--muted">当前页面无视频</span>
            {/if}
            <span class="fn__flex-1"></span>
            <span class="svn-browser__title" title={state.title}>{state.title}</span>
        </div>
    {:else}
        <button class="svn-browser__show-toolbar" title="显示浏览器工具栏" onclick={() => setToolbarVisible(true)}>⌄</button>
    {/if}

    {#if error}
        <div class="svn-browser__error">{error}</div>
    {/if}

    <div bind:this={host} class="svn-browser__host"></div>
</div>

<style>
    .svn-browser {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--b3-theme-background);
        position: relative;
    }
    .svn-browser__show-toolbar {
        position: absolute;
        top: 4px;
        right: 6px;
        z-index: 20;
        width: 24px;
        height: 22px;
        border: 1px solid var(--b3-border-color);
        border-radius: 6px;
        background: var(--b3-theme-surface);
        color: var(--b3-theme-on-surface);
        opacity: 0.35;
        cursor: pointer;
        line-height: 1;
    }
    .svn-browser__show-toolbar:hover {
        opacity: 1;
    }
    .svn-browser__toolbar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 6px;
        border-bottom: 1px solid var(--b3-border-color);
        flex: 0 0 auto;
    }
    .svn-browser__nav {
        padding: 2px 6px;
        min-width: 26px;
    }
    .svn-browser__nav svg {
        width: 14px;
        height: 14px;
    }
    .svn-browser__zoom {
        padding: 2px 4px;
        min-width: 48px;
        font-variant-numeric: tabular-nums;
    }
    .svn-browser__playback {
        padding: 2px 5px;
        min-width: 34px;
        font-variant-numeric: tabular-nums;
    }
    .svn-browser__clip {
        padding: 2px 8px;
        white-space: nowrap;
    }
    .svn-browser__status {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 3px 8px;
        font-size: 12px;
        border-bottom: 1px solid var(--b3-border-color);
        background: var(--b3-theme-surface);
        flex: 0 0 auto;
        min-height: 24px;
    }
    .svn-browser__badge {
        color: var(--b3-theme-primary);
        font-weight: 600;
        white-space: nowrap;
    }
    .svn-browser__badge--muted {
        color: var(--b3-theme-on-surface);
        opacity: 0.65;
        font-weight: 400;
    }
    .svn-browser__time {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }
    .svn-browser__title {
        opacity: 0.75;
        max-width: 55%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .svn-browser__error {
        padding: 4px 8px;
        color: var(--b3-theme-error);
        font-size: 12px;
        border-bottom: 1px solid var(--b3-border-color);
        flex: 0 0 auto;
    }
    .svn-browser__host {
        flex: 1 1 auto;
        min-height: 0;
        position: relative;
    }
</style>
