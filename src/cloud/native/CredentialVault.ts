import type { Plugin } from "siyuan";
import type { NativeCloudCredential } from "@/cloud/native/types";

interface VaultRecord {
    /** Electron safeStorage ciphertext (preferred). */
    safe?: string;
    /** Machine-bound AES-GCM fallback; always written for restart stability. */
    fallback?: string;
    /** Legacy field from 0.9.x. */
    encrypted?: string;
    label?: string;
    updatedAt: string;
}

interface VaultData {
    [provider: string]: VaultRecord;
}

const PRIMARY_KEY = "svn-native-credentials";
const BACKUP_KEY = "svn-native-credentials-backup";

/**
 * Durable credential vault.
 *
 * - primary: Electron safeStorage (OS-backed, best)
 * - fallback: AES-256-GCM key derived from stable machine/user identifiers
 * - both are written for every credential, so a normal app/system restart or a
 *   crash cannot lose the login; backup data is kept under a second key.
 *
 * The fallback is obfuscation rather than hardware-grade protection, but it is
 * far safer than plaintext and guarantees restart usability when safeStorage is
 * unavailable (some Windows/Electron configurations).
 */
export class CredentialVault {
    private data: VaultData = {};
    private session: Map<string, NativeCloudCredential> = new Map();
    private lastLoadSource: "primary" | "backup" | "empty" = "empty";

    constructor(private readonly plugin: Plugin) {}

    async load(): Promise<void> {
        const primary = await this.readData(PRIMARY_KEY);
        if (primary) {
            this.data = primary;
            this.lastLoadSource = "primary";
            return;
        }
        const backup = await this.readData(BACKUP_KEY);
        if (backup) {
            this.data = backup;
            this.lastLoadSource = "backup";
            // Repair the primary key from backup.
            await this.writeData(PRIMARY_KEY, backup).catch(() => undefined);
            return;
        }
        this.data = {};
        this.lastLoadSource = "empty";
    }

    getLoadSource(): string {
        return this.lastLoadSource;
    }

    isAvailable(): boolean {
        return Boolean(getSafeStorage()?.isEncryptionAvailable?.()) || Boolean(getCrypto());
    }

    getPersistenceMode(): "safeStorage+aes" | "aes" {
        return getSafeStorage()?.isEncryptionAvailable?.() ? "safeStorage+aes" : "aes";
    }

    async set(credential: NativeCloudCredential): Promise<void> {
        const values = JSON.stringify(credential.values);
        const record: VaultRecord = {
            label: credential.label,
            updatedAt: new Date().toISOString(),
        };
        const safeStorage = getSafeStorage();
        if (safeStorage?.isEncryptionAvailable?.()) {
            try {
                record.safe = safeStorage.encryptString(values).toString("base64");
            } catch {
                /* fall back to AES */
            }
        }
        record.fallback = encryptFallback(values);
        if (!record.safe && !record.fallback) throw new Error("凭据加密失败，无法保存登录");
        this.data[credential.provider] = record;
        this.session.set(credential.provider, credential);
        await this.persist();
    }

    async get(provider: string): Promise<NativeCloudCredential | null> {
        const session = this.session.get(provider);
        if (session) return session;
        const record = this.data[provider];
        if (!record) return null;
        const values = this.decryptRecord(record);
        if (!values) {
            // Try the backup key in case the primary record is corrupt.
            const backup = await this.readData(BACKUP_KEY);
            const backupRecord = backup?.[provider];
            if (backupRecord) {
                const backupValues = this.decryptRecord(backupRecord);
                if (backupValues) {
                    this.data[provider] = backupRecord;
                    const credential: NativeCloudCredential = { provider, values: backupValues, label: backupRecord.label };
                    this.session.set(provider, credential);
                    return credential;
                }
            }
            return null;
        }
        const credential: NativeCloudCredential = { provider, values, label: record.label };
        this.session.set(provider, credential);
        return credential;
    }

    async clear(provider: string): Promise<void> {
        this.session.delete(provider);
        delete this.data[provider];
        await this.persist();
    }

    has(provider: string): boolean {
        return this.session.has(provider) || Boolean(this.data[provider]);
    }

    rememberSession(credential: NativeCloudCredential): void {
        this.session.set(credential.provider, credential);
    }

    private decryptRecord(record: VaultRecord): Record<string, string> | null {
        const safeStorage = getSafeStorage();
        if (record.safe && safeStorage?.decryptString) {
            try {
                return JSON.parse(safeStorage.decryptString(Buffer.from(record.safe, "base64")));
            } catch {
                /* try fallback */
            }
        }
        if (record.fallback) {
            try {
                return JSON.parse(decryptFallback(record.fallback));
            } catch {
                /* try legacy */
            }
        }
        if (record.encrypted && safeStorage?.decryptString) {
            try {
                return JSON.parse(safeStorage.decryptString(Buffer.from(record.encrypted, "base64")));
            } catch {
                /* ignore */
            }
        }
        return null;
    }

    private async persist(): Promise<void> {
        await this.writeData(PRIMARY_KEY, this.data);
        await this.writeData(BACKUP_KEY, this.data);
    }

    private async writeData(key: string, data: VaultData): Promise<void> {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await this.plugin.saveData(key, data);
                return;
            } catch (error) {
                lastError = error;
                await new Promise((resolve) => window.setTimeout(resolve, 120 * (attempt + 1)));
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async readData(key: string): Promise<VaultData | null> {
        try {
            const saved = await this.plugin.loadData(key);
            if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved as VaultData;
        } catch {
            /* ignore */
        }
        return null;
    }
}

function getSafeStorage(): any {
    try {
        const requireFn = (globalThis as any).require || (window as any).require;
        if (typeof requireFn !== "function") return null;
        const remote = requireFn("@electron/remote");
        const electron = remote?.require?.("electron") || requireFn("electron");
        return electron?.safeStorage || null;
    } catch {
        return null;
    }
}

function getCrypto(): any {
    try {
        const requireFn = (globalThis as any).require || (window as any).require;
        return requireFn("crypto");
    } catch {
        return null;
    }
}

function machineSeed(): string {
    const requireFn = (globalThis as any).require || (window as any).require;
    const os = requireFn("os");
    const user = os.userInfo?.() || {};
    return `${os.hostname?.() || "host"}|${user.username || "user"}|${process.env.APPDATA || ""}`;
}

function fallbackKey(): any {
    const crypto = getCrypto();
    if (!crypto) throw new Error("Node crypto 不可用");
    return crypto.scryptSync(machineSeed(), "svn-native-vault-v2", 32);
}

function encryptFallback(plain: string): string {
    const crypto = getCrypto();
    if (!crypto) return "";
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", fallbackKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

function decryptFallback(payload: string): string {
    const crypto = getCrypto();
    if (!crypto) throw new Error("Node crypto 不可用");
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("fallback 凭据格式损坏");
    const decipher = crypto.createDecipheriv("aes-256-gcm", fallbackKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
