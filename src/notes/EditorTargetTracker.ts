import { getAllEditor, getActiveEditor, type Plugin, type Protyle } from "siyuan";

export interface EditorTarget {
    protyle: Protyle;
    rootID: string;
    blockID: string | null;
    title: string;
    range: Range | null;
    capturedAt: number;
}

interface CaptureOptions {
    /** Allow using protyle.toolbar.range even without a live selection. */
    allowCachedRange?: boolean;
}

/**
 * Tracks the last explicitly selected SiYuan editor/caret. The Bilibili webview
 * steals focus, so insertion must reuse this cached target + range.
 *
 * Important: switching tabs/windows emits `switch-protyle` without a selection.
 * Such events must NOT overwrite the last real caret, otherwise a timestamp can
 * land in a different document (observed in the Phase 2 E2E run).
 */
export class EditorTargetTracker {
    private last: EditorTarget | null = null;
    private timer: number | null = null;
    private bound = false;

    private readonly onSwitch = (event: any) => this.captureFromEvent(event);
    private readonly onLoaded = (event: any) => this.captureFromEvent(event);
    private readonly onClick = (event: any) => this.captureFromEvent(event);
    private readonly onSelectionChange = () => this.schedule();

    constructor(private readonly plugin: Plugin) {}

    bind(): void {
        if (this.bound) return;
        this.bound = true;
        this.plugin.eventBus.on("switch-protyle", this.onSwitch);
        this.plugin.eventBus.on("loaded-protyle-static", this.onLoaded);
        this.plugin.eventBus.on("loaded-protyle-dynamic", this.onLoaded);
        this.plugin.eventBus.on("click-editorcontent", this.onClick);
        document.addEventListener("selectionchange", this.onSelectionChange);
    }

    unbind(): void {
        if (!this.bound) return;
        this.bound = false;
        this.plugin.eventBus.off("switch-protyle", this.onSwitch);
        this.plugin.eventBus.off("loaded-protyle-static", this.onLoaded);
        this.plugin.eventBus.off("loaded-protyle-dynamic", this.onLoaded);
        this.plugin.eventBus.off("click-editorcontent", this.onClick);
        document.removeEventListener("selectionchange", this.onSelectionChange);
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    getLastTarget(): EditorTarget | null {
        return this.last;
    }

    /** Capture from a specific Protyle (used by the E2E harness and event handlers). */
    captureFromProtyle(protyle: Protyle, preferredRange?: Range | null, options: CaptureOptions = {}): EditorTarget | null {
        if (!protyle?.protyle || !protyle.protyle.element?.isConnected) return null;
        const wysiwyg = protyle.protyle.wysiwyg?.element;
        if (!wysiwyg) return null;

        const selection = document.getSelection();
        const selectionInside = Boolean(selection?.rangeCount && wysiwyg.contains(selection.anchorNode));
        let range: Range | null = null;
        if (preferredRange) {
            range = preferredRange.cloneRange();
        } else if (selectionInside) {
            range = selection!.getRangeAt(0).cloneRange();
        } else if (options.allowCachedRange) {
            const toolbarRange = protyle.protyle.toolbar?.range;
            if (toolbarRange && toolbarRange.startContainer?.isConnected && wysiwyg.contains(toolbarRange.startContainer)) {
                range = toolbarRange.cloneRange();
            }
        }
        // No real selection and no explicitly allowed cached range: do not
        // overwrite the last known caret (e.g. browser tab activated).
        if (!range) return null;

        const rootID = protyle.protyle.block?.rootID || "";
        if (!rootID) return null;
        let blockID: string | null = protyle.protyle.block?.id || null;
        const blockElement = protyle.hasClosestBlock(range.startContainer);
        if (blockElement) blockID = blockElement.getAttribute("data-node-id") || blockID;

        const title = protyle.protyle.title?.element?.textContent?.trim() || "";
        this.last = {
            protyle,
            rootID,
            blockID,
            title,
            range,
            capturedAt: Date.now(),
        };
        return this.last;
    }

    /** Re-validate the cached target; returns null if the document/editor is gone. */
    validate(target: EditorTarget | null): EditorTarget | null {
        if (!target) return null;
        if (!target.protyle?.protyle?.element?.isConnected) return null;
        return target;
    }

    /** Directly set a target (used by tests after a programmatic selection). */
    setTarget(target: EditorTarget | null): void {
        this.last = target;
    }

    private captureFromEvent(event: any): void {
        const protyle: Protyle | undefined = event?.detail?.protyle ?? event?.protyle;
        if (protyle) {
            this.captureFromProtyle(protyle, null, { allowCachedRange: false });
            return;
        }
        const active = getActiveEditor(true);
        if (active) this.captureFromProtyle(active, null, { allowCachedRange: false });
    }

    private schedule(): void {
        if (this.timer !== null) return;
        this.timer = window.setTimeout(() => {
            this.timer = null;
            this.captureFromSelection();
        }, 160);
    }

    private captureFromSelection(): void {
        const selection = document.getSelection();
        if (!selection?.rangeCount) return;
        const anchor = selection.anchorNode;
        if (!anchor) return;
        const editors = getAllEditor();
        for (const protyle of editors) {
            const element = protyle?.protyle?.wysiwyg?.element;
            if (element?.contains(anchor)) {
                this.captureFromProtyle(protyle);
                return;
            }
        }
    }
}
