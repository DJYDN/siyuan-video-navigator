<script lang="ts">
    import { onMount } from "svelte";
    import { showMessage } from "siyuan";
    import {
        CloudDriveService,
        type CloudDriverField,
        type CloudStorage,
    } from "@/cloud/CloudDriveService";

    export let service: CloudDriveService;
    export let onBack: (() => void) | undefined = undefined;
    export let onOpenSettings: (() => void) | undefined = undefined;
    export let onOpenNative: (() => void) | undefined = undefined;

    const PRESETS: Array<{ driver: string; label: string }> = [
        { driver: "BaiduNetdisk", label: "百度网盘" },
        { driver: "Quark", label: "夸克网盘" },
        { driver: "AliyundriveOpen", label: "阿里云盘（Open）" },
        { driver: "Aliyundrive", label: "阿里云盘（旧版）" },
        { driver: "UC", label: "UC 网盘" },
        { driver: "115 Open", label: "115 网盘（Open）" },
        { driver: "WebDav", label: "WebDAV" },
        { driver: "Local", label: "本地文件夹" },
    ];
    let presetDrivers = [...PRESETS];
    let allDrivers: string[] = PRESETS.map((preset) => preset.driver);

    let storages: CloudStorage[] = [];
    let loading = false;
    let error: string | null = null;
    let selectedDriver = "BaiduNetdisk";
    let customDriver = "";
    let fields: CloudDriverField[] = [];
    let values: Record<string, any> = {};
    let mountPath = "/baidu";
    let remark = "";
    let saving = false;

    onMount(() => {
        if (!service.isConfigured()) {
            error = "请先在设置中连接 OpenList/AList";
            return;
        }
        void loadStorages();
        void loadDriverList();
    });

    async function loadDriverList(): Promise<void> {
        try {
            const names = await service.listDrivers();
            if (names.length) {
                allDrivers = names;
                presetDrivers = names.map((name) => {
                    const preset = PRESETS.find((item) => item.driver === name);
                    return { driver: name, label: preset ? `${preset.label}（${name}）` : name };
                });
                if (!allDrivers.includes(selectedDriver)) selectedDriver = allDrivers[0];
            }
        } catch {
            /* fall back to built-in presets */
        }
        await loadDriver(selectedDriver);
    }

    async function loadStorages(): Promise<void> {
        loading = true;
        error = null;
        try {
            storages = await service.listStorages();
        } catch (e) {
            error = String((e as Error)?.message || e);
        } finally {
            loading = false;
        }
    }

    async function loadDriver(driver: string): Promise<void> {
        selectedDriver = driver;
        fields = [];
        values = {};
        if (driver === "__custom__") return;
        try {
            const info = await service.getDriverInfo(driver);
            fields = [...info.common.filter((item) => !["mount_path", "order", "remark", "cache_expiration", "custom_cache_policies", "web_proxy", "webdav_policy", "down_proxy_url", "disable_proxy_sign", "order_by", "order_direction", "extract_folder", "disable_index", "enable_sign", "seed_policy"].includes(item.name)), ...info.additional];
            for (const field of fields) {
                const raw = field.default ?? "";
                values[field.name] = field.type === "bool" ? raw === "true" : raw;
            }
        } catch (e) {
            error = `读取驱动 ${driver} 配置失败：${String((e as Error)?.message || e)}`;
        }
    }

    function typeOf(field: CloudDriverField): string {
        return field.type || "string";
    }

    function optionsOf(field: CloudDriverField): string[] {
        return String(field.options || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }

    function inputType(field: CloudDriverField): string {
        if (typeOf(field) === "number") return "number";
        if (/token|cookie|secret|password|key/i.test(field.name)) return "password";
        return "text";
    }

    async function createMount(): Promise<void> {
        const driver = selectedDriver === "__custom__" ? customDriver.trim() : selectedDriver;
        if (!driver) {
            showMessage("请填写或选择驱动", 3000);
            return;
        }
        if (!mountPath.trim() || !mountPath.startsWith("/")) {
            showMessage("挂载路径必须以 / 开头，例如 /baidu", 3000);
            return;
        }
        const addition: Record<string, any> = {};
        for (const field of fields) {
            const value = values[field.name];
            if (field.type === "bool") {
                addition[field.name] = Boolean(value);
            } else if (value !== undefined && value !== null && String(value).trim() !== "") {
                addition[field.name] = field.type === "number" ? Number(value) : String(value);
            } else if (field.required) {
                showMessage(`请填写必填项：${field.name}`, 3000);
                return;
            }
        }
        saving = true;
        try {
            await service.createStorage({
                mount_path: mountPath.trim(),
                order: 0,
                driver,
                cache_expiration: 30,
                status: "work",
                addition: JSON.stringify(addition),
                remark,
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
            showMessage(`挂载已创建：${mountPath}（${driver}）`, 3000);
            await loadStorages();
            mountPath = `/${driver}`;
            remark = "";
        } catch (e) {
            showMessage(`创建挂载失败：${String((e as Error)?.message || e)}`, 6000, "error");
        } finally {
            saving = false;
        }
    }

    async function removeMount(storage: CloudStorage): Promise<void> {
        if (!window.confirm(`删除挂载 ${storage.mountPath}（${storage.driver}）？这只是移除 OpenList 中的挂载索引，不会删除网盘文件。`)) return;
        try {
            await service.deleteStorage(storage.id);
            showMessage("挂载已删除", 2500);
            await loadStorages();
        } catch (e) {
            showMessage(`删除失败：${String((e as Error)?.message || e)}`, 5000, "error");
        }
    }
</script>

<div class="svn-mounts">
    <div class="svn-mounts__toolbar">
        {#if onBack}
            <button class="b3-button b3-button--text" onclick={onBack}>← 文件浏览</button>
        {/if}
        <strong>网盘挂载管理</strong>
        <span class="fn__flex-1"></span>
        <button class="b3-button b3-button--text" onclick={loadStorages}>刷新</button>
        {#if onOpenSettings}
            <button class="b3-button b3-button--outline" onclick={onOpenSettings}>连接设置</button>
        {/if}
        {#if onOpenNative}
            <button class="b3-button b3-button--outline" onclick={onOpenNative}>原生网盘（实验）</button>
        {/if}
    </div>

    {#if error}
        <div class="svn-mounts__error">{error}</div>
    {/if}

    <div class="svn-mounts__body">
        <section class="svn-mounts__section">
            <h3>已挂载的网盘</h3>
            {#if loading}
                <p class="svn-mounts__muted">加载中…</p>
            {:else if storages.length === 0}
                <p class="svn-mounts__muted">还没有挂载。可在下方添加百度、夸克、阿里云盘等存储。</p>
            {:else}
                <div class="svn-mounts__list">
                    {#each storages as storage (storage.id)}
                        <div class="svn-mounts__row">
                            <span class="svn-mounts__mount">{storage.mountPath}</span>
                            <span class="svn-mounts__driver">{storage.driver}</span>
                            <span class="svn-mounts__status {storage.status === "work" ? "is-ok" : ""}">{storage.status || "?"}</span>
                            {#if storage.remark}<span class="svn-mounts__remark">{storage.remark}</span>{/if}
                            <button class="b3-button b3-button--text svn-mounts__delete" onclick={() => removeMount(storage)}>删除</button>
                        </div>
                    {/each}
                </div>
            {/if}
        </section>

        <section class="svn-mounts__section">
            <h3>添加网盘挂载</h3>
            <p class="svn-mounts__muted">选择驱动并填写该驱动的必填参数（如 refresh_token、cookie 等）。创建后立即可在「文件浏览」中访问。</p>
            <div class="svn-mounts__grid">
                <label>驱动
                    <select class="b3-select" value={selectedDriver} onchange={(e) => loadDriver((e.currentTarget as HTMLSelectElement).value)}>
                        {#each presetDrivers as preset}
                            <option value={preset.driver}>{preset.label}</option>
                        {/each}
                        <option value="__custom__">自定义驱动…</option>
                    </select>
                </label>
                {#if selectedDriver === "__custom__"}
                    <label>驱动名称
                        <input class="b3-text-field" bind:value={customDriver} placeholder="OpenList 驱动显示名，如 BaiduNetdisk" />
                    </label>
                {/if}
                <label>挂载路径
                    <input class="b3-text-field" bind:value={mountPath} placeholder="/baidu" />
                </label>
                <label>备注
                    <input class="b3-text-field" bind:value={remark} placeholder="可选" />
                </label>
            </div>

            {#if fields.length > 0}
                <div class="svn-mounts__grid">
                    {#each fields as field}
                        <label class:svn-mounts__required={field.required}>
                            {field.name}{#if field.required} *{/if}
                            {#if typeOf(field) === "bool"}
                                <input type="checkbox" class="b3-switch" bind:checked={values[field.name]} />
                            {:else if typeOf(field) === "select"}
                                <select class="b3-select" bind:value={values[field.name]}>
                                    {#each optionsOf(field) as option}
                                        <option value={option}>{option}</option>
                                    {/each}
                                </select>
                            {:else if typeOf(field) === "text"}
                                <textarea class="b3-text-field" rows="2" bind:value={values[field.name]}></textarea>
                            {:else}
                                <input class="b3-text-field" type={inputType(field)} bind:value={values[field.name]} placeholder={field.default || ""} />
                            {/if}
                            {#if field.help}<small>{field.help}</small>{/if}
                        </label>
                    {/each}
                </div>
            {:else if selectedDriver !== "__custom__"}
                <p class="svn-mounts__muted">该驱动没有额外参数，或正在读取配置…</p>
            {/if}

            <div class="svn-mounts__actions">
                <button class="b3-button b3-button--outline" onclick={createMount} disabled={saving}>{saving ? "创建中…" : "创建挂载"}</button>
            </div>
        </section>
    </div>
</div>

<style>
    .svn-mounts {
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--b3-theme-background);
        color: var(--b3-theme-on-background);
    }
    .svn-mounts__toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-bottom: 1px solid var(--b3-border-color);
    }
    .svn-mounts__body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 10px 14px 24px;
    }
    .svn-mounts__section {
        margin-bottom: 20px;
    }
    .svn-mounts__section h3 {
        margin: 6px 0 8px;
        font-size: 14px;
    }
    .svn-mounts__muted {
        color: var(--b3-theme-on-surface);
        font-size: 12px;
        margin: 4px 0 10px;
    }
    .svn-mounts__error {
        color: var(--b3-theme-error);
        padding: 6px 10px;
        border-bottom: 1px solid var(--b3-border-color);
        font-size: 12px;
    }
    .svn-mounts__list {
        border: 1px solid var(--b3-border-color);
        border-radius: 6px;
        overflow: hidden;
    }
    .svn-mounts__row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 10px;
        border-bottom: 1px solid var(--b3-border-color);
        font-size: 13px;
    }
    .svn-mounts__row:last-child {
        border-bottom: none;
    }
    .svn-mounts__mount {
        font-weight: 600;
        min-width: 100px;
    }
    .svn-mounts__driver {
        opacity: 0.8;
        min-width: 110px;
    }
    .svn-mounts__status {
        color: var(--b3-theme-error);
        min-width: 44px;
    }
    .svn-mounts__status.is-ok {
        color: var(--b3-theme-primary);
    }
    .svn-mounts__remark {
        flex: 1;
        opacity: 0.7;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .svn-mounts__delete {
        margin-left: auto;
    }
    .svn-mounts__grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 10px;
        margin-bottom: 12px;
    }
    .svn-mounts__grid label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }
    .svn-mounts__grid label :global(input),
    .svn-mounts__grid label :global(select),
    .svn-mounts__grid label :global(textarea) {
        width: 100%;
        box-sizing: border-box;
    }
    .svn-mounts__grid label small {
        opacity: 0.7;
        font-size: 11px;
    }
    .svn-mounts__required {
        color: var(--b3-theme-on-background);
    }
    .svn-mounts__actions {
        display: flex;
        gap: 8px;
    }
</style>
