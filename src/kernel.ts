import type * as kernel from "siyuan/kernel";

/**
 * Kernel-side entry. Phase 0 does not need kernel functionality yet; it is kept
 * as a no-op so the official template's dual app+kernel build pipeline stays
 * intact (screenshots/assets/seek will be implemented on the frontend first).
 */
const api: kernel.ISiyuan = siyuan;

api.plugin.lifecycle.onload = async () => {
    await api.logger.info(`[${api.plugin.name}] kernel plugin idle (Phase 0)`);
};

api.plugin.lifecycle.onunload = async () => {
    await api.logger.info(`[${api.plugin.name}] kernel plugin unloading (Phase 0)`);
};
