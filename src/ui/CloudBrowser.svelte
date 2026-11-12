<script lang="ts">
    import { onMount } from "svelte";
    import { showMessage } from "siyuan";
    import { CloudDriveService, formatSize, isVideoFile, parentCloudPath, type CloudEntry } from "@/cloud/CloudDriveService";

    export let service: CloudDriveService;
    export let onOpenVideo: ((url: string, title: string) => void) | undefined = undefined;
    export let onOpenSettings: (() => void) | undefined = undefined;
    export let onOpenMounts: (() => void) | undefined = undefined;
    export let onOpenNative: (() => void) | undefined = undefined;

    let path = "/";
    let entries: CloudEntry[] = [];
    let loading = false;
    let error: string | null = null;
    let connected = service.isConfigured();

    onMount(() => {
        if (connected) void load("/");
    });

    async function load(target: string): Promise<void> {
        loading = true;
        error = null;
        try {
            entries = await service.list(target);
            path = target;
            connected = true;
        } catch (e) {
            error = String((e as Error)?.message || e);
            connected = service.isConfigured();
        } finally {
            loading = false;
        }
    }

    function openEntry(entry: CloudEntry): void {
        if (entry.isDir) {
            void load(entry.path);
            return;
        }
        if (!isVideoFile(entry.name)) {
            showMessage("当前仅支持从网盘直接播放视频文件（mp4/mkv/webm 等）。", 3000);
            return;
        }
        loading = true;
        service
            .getFile(entry.path)
            .then((file) => onOpenVideo?.(file.rawUrl, file.name))
            .catch((e) => {
                error = String((e as Error)?.message || e);
            })
            .finally(() => {
                loading = false;
            });
    }

    function up(): void {
        void load(parentCloudPath(path));
    }

    function crumbs(): Array<{ name: string; path: string }> {
        const parts = path.split("/").filter(Boolean);
        const list = [{ name: "网盘根目录", path: "/" }];
        let current = "";
        for (const part of parts) {
            current += `/${part}`;
            list.push({ name: part, path: current });
        }
        return list;
    }
</script>

<div class="svn-cloud">
    <div class="svn-cloud__toolbar">
        <button class="b3-button b3-button--text" title="返回上一级" onclick={up} disabled={path === "/"}>↑</button>
        <button class="b3-button b3-button--text" title="根目录" onclick={() => load("/")}>⌂</button>
        <button class="b3-button b3-button--text" title="刷新" onclick={() => load(path)}>⟳</button>
        <div class="svn-cloud__crumbs">
            {#each crumbs() as crumb}
                <button class="svn-cloud__crumb" onclick={() => load(crumb.path)}>{crumb.name}</button>
                <span class="svn-cloud__sep">/</span>
            {/each}
        </div>
        {#if onOpenSettings}
            <button class="b3-button b3-button--outline" onclick={onOpenSettings}>网盘设置</button>
        {/if}
        {#if onOpenMounts}
            <button class="b3-button b3-button--outline" onclick={onOpenMounts}>挂载管理</button>
        {/if}
        {#if onOpenNative}
            <button class="b3-button b3-button--outline" onclick={onOpenNative}>原生网盘（实验）</button>
        {/if}
    </div>

    {#if !connected}
        <div class="svn-cloud__empty">
            <h3>尚未连接网盘</h3>
            <p>
                在设置中填写 OpenList / AList 服务地址与账号密码。百度、夸克、阿里云盘等在 OpenList/AList
                中挂载后，即可在这里直接浏览目录并打开视频。
            </p>
            {#if onOpenSettings}
                <button class="b3-button b3-button--outline" onclick={onOpenSettings}>打开网盘设置</button>
            {/if}
        </div>
    {:else if loading}
        <div class="svn-cloud__empty">正在加载 {path} …</div>
    {:else if error}
        <div class="svn-cloud__error">
            <p>{error}</p>
            <button class="b3-button b3-button--outline" onclick={() => load(path)}>重试</button>
            {#if onOpenSettings}
                <button class="b3-button b3-button--text" onclick={onOpenSettings}>检查设置</button>
            {/if}
        </div>
    {:else}
        <div class="svn-cloud__list">
            {#each entries as entry (entry.path)}
                <button class="svn-cloud__row" onclick={() => openEntry(entry)} title={entry.name}>
                    <span class="svn-cloud__icon">{entry.isDir ? "📁" : isVideoFile(entry.name) ? "▶" : "📄"}</span>
                    <span class="svn-cloud__name">{entry.name}</span>
                    <span class="svn-cloud__meta">{entry.isDir ? "" : formatSize(entry.size)}</span>
                    <span class="svn-cloud__type">{entry.isDir ? "文件夹" : isVideoFile(entry.name) ? "视频" : ""}</span>
                </button>
            {:else}
                <div class="svn-cloud__empty">此目录为空</div>
            {/each}
        </div>
    {/if}
</div>

<style>
    .svn-cloud {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-background);
    }
    .svn-cloud__toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-bottom: 1px solid var(--b3-border-color);
        flex-wrap: wrap;
    }
    .svn-cloud__crumbs {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 1;
        min-width: 0;
        overflow: hidden;
    }
    .svn-cloud__crumb {
        background: none;
        border: none;
        color: var(--b3-theme-primary);
        cursor: pointer;
        padding: 2px 4px;
        white-space: nowrap;
    }
    .svn-cloud__sep {
        color: var(--b3-theme-on-surface);
        opacity: 0.5;
    }
    .svn-cloud__list {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 6px;
    }
    .svn-cloud__row {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
    }
    .svn-cloud__row:hover {
        background: var(--b3-theme-surface);
    }
    .svn-cloud__icon {
        width: 20px;
        text-align: center;
    }
    .svn-cloud__name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .svn-cloud__meta,
    .svn-cloud__type {
        color: var(--b3-theme-on-surface);
        font-size: 12px;
        min-width: 56px;
        text-align: right;
    }
    .svn-cloud__empty,
    .svn-cloud__error {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 24px;
        text-align: center;
        color: var(--b3-theme-on-surface);
    }
    .svn-cloud__error p {
        color: var(--b3-theme-error);
        max-width: 640px;
        word-break: break-word;
    }
</style>
