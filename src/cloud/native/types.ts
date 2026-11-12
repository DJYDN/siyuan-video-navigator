/**
 * Native cloud provider contracts (experimental build only).
 * No private API details live here; each provider owns its own endpoints.
 */

export interface NativeCloudCredential {
    provider: string;
    /** Provider-specific secret fields (cookie/token/...). Never log this. */
    values: Record<string, string>;
    /** Optional display name of the mount. */
    label?: string;
}

export interface NativeCloudEntry {
    name: string;
    /** Provider-specific stable id/path used by list/play. */
    id: string;
    isDir: boolean;
    size: number;
    modified: string;
}

export interface NativePlaySource {
    url: string;
    headers: Record<string, string>;
    /** Additional header profiles to try if the first one is rejected. */
    headerProfiles?: Array<Record<string, string>>;
    mime?: string;
    kind?: "video" | "hls";
}

export interface NativeCloudProvider {
    readonly id: string;
    readonly name: string;
    /** Human-readable list of credential fields shown by the login UI. */
    readonly credentialFields: Array<{ name: string; label: string; secret?: boolean; placeholder?: string }>;
    validate(credential: NativeCloudCredential): Promise<void>;
    list(credential: NativeCloudCredential, dirId: string): Promise<NativeCloudEntry[]>;
    search?(credential: NativeCloudCredential, query: string): Promise<NativeCloudEntry[]>;
    locate?(credential: NativeCloudCredential, fileId: string): Promise<{ dirId: string; stack: Array<{ id: string; name: string }> } | null>;
    resolvePlayUrl(credential: NativeCloudCredential, fileId: string): Promise<NativePlaySource>;
}
