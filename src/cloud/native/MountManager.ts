import type { Plugin } from "siyuan";

/**
 * Mount model inspired by OpenList/AList's storage abstraction:
 * a mount binds a driver + driver-specific `addition` config to a mount_path.
 *
 * This is an independent TypeScript implementation; no OpenList code is
 * bundled or required.
 */
export interface NativeMountConfig {
    id: string;
    driverId: string;
    name: string;
    /** Virtual path shown to the user, e.g. /quark. Must be unique. */
    mountPath: string;
    /** Driver-specific settings (cookie/token/root id/...). Encrypted at rest. */
    addition: Record<string, string>;
    /** OpenList-like status: work / disabled. */
    status: "work" | "disabled";
    order: number;
}

export interface VirtualMountEntry {
    name: string;
    path: string;
    isDir: true;
    driverId: string;
    mountId: string;
}

export class MountManager {
    private mounts: NativeMountConfig[] = [];
    private readonly storageKey = "svn-native-mounts";

    constructor(private readonly plugin: Plugin) {}

    async load(): Promise<void> {
        try {
            const saved = await this.plugin.loadData(this.storageKey);
            if (Array.isArray(saved)) {
                this.mounts = saved.filter((item: any) => item && item.id && item.driverId && item.mountPath);
            }
        } catch {
            this.mounts = [];
        }
    }

    list(): NativeMountConfig[] {
        return [...this.mounts].sort((a, b) => a.order - b.order || a.mountPath.localeCompare(b.mountPath));
    }

    get(id: string): NativeMountConfig | null {
        return this.mounts.find((mount) => mount.id === id) || null;
    }

    async add(input: Omit<NativeMountConfig, "id" | "status" | "order"> & { order?: number }): Promise<NativeMountConfig> {
        const mountPath = normalizeMountPath(input.mountPath);
        if (!mountPath) throw new Error("挂载路径不能为空");
        if (this.mounts.some((mount) => mount.mountPath === mountPath)) {
            throw new Error(`挂载路径已存在：${mountPath}`);
        }
        const mount: NativeMountConfig = {
            ...input,
            mountPath,
            id: `mnt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            status: "work",
            order: input.order ?? this.mounts.length,
        };
        this.mounts.push(mount);
        await this.save();
        return mount;
    }

    async remove(id: string): Promise<void> {
        this.mounts = this.mounts.filter((mount) => mount.id !== id);
        await this.save();
    }

    async update(id: string, patch: Partial<Pick<NativeMountConfig, "name" | "mountPath" | "addition" | "status" | "order">>): Promise<void> {
        const mount = this.get(id);
        if (!mount) throw new Error("挂载不存在");
        if (patch.mountPath) {
            const normalized = normalizeMountPath(patch.mountPath);
            if (this.mounts.some((item) => item.id !== id && item.mountPath === normalized)) throw new Error("挂载路径已存在");
            mount.mountPath = normalized;
        }
        Object.assign(mount, patch);
        await this.save();
    }

    /** Virtual root listing: mount points, like OpenList's root directory. */
    rootEntries(): VirtualMountEntry[] {
        return this.list().map((mount) => ({
            name: mount.mountPath.replace(/^\//, "") || mount.name,
            path: mount.mountPath,
            isDir: true,
            driverId: mount.driverId,
            mountId: mount.id,
        }));
    }

    /** Longest-prefix mount resolution, like OpenList's fs mount lookup. */
    resolve(path: string): { mount: NativeMountConfig; innerPath: string } | null {
        const normalized = normalizeMountPath(path);
        let best: NativeMountConfig | null = null;
        for (const mount of this.list()) {
            if (normalized === mount.mountPath || normalized.startsWith(mount.mountPath + "/")) {
                if (!best || mount.mountPath.length > best.mountPath.length) best = mount;
            }
        }
        if (!best) return null;
        const inner = normalized.slice(best.mountPath.length).replace(/^\/+/, "");
        return { mount: best, innerPath: inner };
    }

    private async save(): Promise<void> {
        await this.plugin.saveData(this.storageKey, this.mounts);
    }
}

export function normalizeMountPath(value: string): string {
    const trimmed = String(value || "").trim().replace(/\\+/g, "/");
    if (!trimmed) return "";
    const parts = trimmed.split("/").filter(Boolean);
    return `/${parts.join("/")}`;
}
