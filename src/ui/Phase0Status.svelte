<script lang="ts">
    interface Props {
        appId?: string;
        versions?: { electron?: string; chrome?: string; node?: string };
    }

    let { appId = "", versions = {} }: Props = $props();
    let count: number = $state(0);
</script>

<div class="svn-phase0-status b3-dialog__content">
    <h2 class="svn-phase0-status__title">SiYuan Video Navigator</h2>
    <p class="svn-phase0-status__ok">Phase 0 最小可运行插件已加载 ✅</p>
    <p class="svn-phase0-status__meta">思源视频导航笔记 · 插件骨架（Vite + Svelte 5 + TypeScript）</p>
    <div class="fn__hr"></div>
    <p class="svn-phase0-status__meta">运行时：Electron {versions.electron ?? "?"} · Chrome {versions.chrome ?? "?"} · Node {versions.node ?? "?"}</p>
    <p class="svn-phase0-status__meta">App ID：{appId || "unknown"}</p>
    <div class="fn__hr"></div>
    <button class="b3-button b3-button--outline" onclick={() => (count += 1)}>
        Svelte 5 响应式测试：{count}
    </button>
    <div class="fn__hr"></div>
    <p class="svn-phase0-status__next">
        下一步（Gate 0 已通过）：浏览器工作台、时间戳插入、真实视频帧截图、点击回溯。
    </p>
</div>
