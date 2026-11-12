import { fetchSyncPost } from "siyuan";
import type { MediaKBSettings } from "@/mediaKB/MediaKBSettings";

export interface ImportedDoc {
    title: string;
    docId: string;
    notebook: string;
}

export interface MediaKBImportResult {
    sources: number;
    skipped: number;
    transcripts: ImportedDoc[];
    cards: ImportedDoc[];
    concepts: ImportedDoc[];
    topics: ImportedDoc[];
    indexDocId?: string;
    warnings: string[];
}

interface FrontMatter {
    [key: string]: string | string[];
}

interface SourceItem {
    transcriptPath: string;
    title: string;
    sourceId: string;
    sourceUrl: string;
    meta: FrontMatter;
    body: string;
    cardPath: string;
    cardMeta: FrontMatter;
    cardBody: string;
    conceptNames: string[];
}

function nodeRequire(name: string): any {
    const requireFn = (globalThis as any).require || (window as any).require;
    return requireFn(name);
}

function readText(file: string): string {
    return nodeRequire("fs").readFileSync(file, "utf8");
}

function listMarkdown(dir: string): string[] {
    try {
        const fs = nodeRequire("fs");
        const path = nodeRequire("path");
        if (!fs.existsSync(dir)) return [];
        return (fs.readdirSync(dir) as string[])
            .filter((name) => name.toLowerCase().endsWith(".md"))
            .map((name) => path.join(dir, name));
    } catch {
        return [];
    }
}

function fileMtime(file: string): number {
    try {
        return nodeRequire("fs").statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}

function parseFrontMatter(text: string): { meta: FrontMatter; body: string } {
    const value = String(text || "");
    if (!value.startsWith("---")) return { meta: {}, body: value };
    const end = value.indexOf("\n---", 3);
    if (end < 0) return { meta: {}, body: value };
    const raw = value.slice(3, end).split(/\r?\n/);
    const meta: FrontMatter = {};
    let currentKey = "";
    for (const line of raw) {
        const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (keyMatch) {
            currentKey = keyMatch[1];
            const rawValue = keyMatch[2].trim();
            if (!rawValue) {
                meta[currentKey] = [];
            } else {
                meta[currentKey] = rawValue.replace(/^["']|["']$/g, "");
            }
            continue;
        }
        const itemMatch = line.match(/^\s*-\s*(.+)$/);
        if (itemMatch && currentKey) {
            const list = Array.isArray(meta[currentKey]) ? (meta[currentKey] as string[]) : [];
            list.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
            meta[currentKey] = list;
        }
    }
    return { meta, body: value.slice(end + 4).replace(/^\s*\n/, "") };
}

function metaList(meta: FrontMatter, key: string): string[] {
    const value = meta[key];
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
}

function normalizeConceptName(name: string): string {
    return String(name || "")
        .replace(/^\[\[|\]\]$/g, "")
        .replace(/^[#\s]+/, "")
        .trim();
}

function extractWikilinks(text: string): string[] {
    const names: string[] = [];
    const regex = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
        const name = normalizeConceptName(match[1]);
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

function replaceWikilinks(text: string, conceptDocs: Map<string, string>): string {
    return String(text || "").replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_whole, rawName: string, alias?: string) => {
        const name = normalizeConceptName(rawName);
        const label = (alias || name).trim();
        const docId = conceptDocs.get(name);
        return docId ? `((${docId} "${label.replace(/"/g, "&quot;")}"))` : label || name;
    });
}

function sanitizePathPart(value: string): string {
    return String(value || "未命名")
        .replace(/[\\/:*?"<>|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "未命名";
}

function formatDuration(value: string | undefined): string {
    return String(value || "").trim();
}

function timeLink(sourceUrl: string, stamp: string): string | null {
    try {
        const url = new URL(sourceUrl);
        if (!url.hostname.includes("bilibili.com")) return null;
        const pieces = stamp.split(":").map(Number);
        if (pieces.some((item) => !Number.isFinite(item))) return null;
        const seconds = pieces.length === 3 ? pieces[0] * 3600 + pieces[1] * 60 + pieces[2] : pieces[0] * 60 + pieces[1];
        url.searchParams.set("t", String(seconds));
        return url.toString();
    } catch {
        return null;
    }
}

function convertTranscriptTimestamps(body: string, sourceUrl: string): string {
    if (!sourceUrl) return body;
    return String(body || "").replace(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/gm, (_whole, stamp: string) => {
        const url = timeLink(sourceUrl, stamp);
        return url ? `[${stamp}](${url})` : _whole;
    });
}

function metadataBlock(meta: FrontMatter): string {
    const sourceUrl = String(meta.source_url || "");
    const platform = String(meta.platform || "");
    const author = String(meta.author || "");
    const duration = formatDuration(String(meta.duration || ""));
    const lines: string[] = [];
    if (sourceUrl) lines.push(`> 来源：${sourceUrl}`);
    const facts = [platform, author, duration].filter(Boolean);
    if (facts.length) lines.push(`> ${facts.join(" · ")}`);
    if (!lines.length) return "";
    return `${lines.join("\n")}\n\n`;
}

/** Import MediaKB markdown/vault output into SiYuan notebooks. */
export class MediaKBImporter {
    private imported: Record<string, { transcript: string; card: string; concepts: string; at: string }> = {};
    private conceptDocs: Record<string, string> = {};
    private indexDocId = "";
    private indexRows: Array<{ date: string; title: string; platform: string; transcript: string; card: string; concepts: string }> = [];
    private readonly storageKey = "svn-mediakb-import-state";
    private readonly plugin: any;

    constructor(plugin: any) {
        this.plugin = plugin;
    }

    async loadState(): Promise<void> {
        try {
            const saved = await this.plugin.loadData(this.storageKey);
            if (saved && typeof saved === "object") {
                this.imported = saved.imported || {};
                this.conceptDocs = saved.conceptDocs || {};
                this.indexDocId = saved.indexDocId || "";
                this.indexRows = Array.isArray(saved.indexRows) ? saved.indexRows : [];
            }
        } catch {
            /* empty state */
        }
    }

    async importRecent(startedAt: number, input: string, settings: MediaKBSettings): Promise<MediaKBImportResult> {
        await this.loadState();
        const config = settings.get();
        const vault = settings.getJobVaultDir();
        const files = listMarkdown(config.outputDir).filter((file) => fileMtime(file) >= startedAt - 8000);
        const cards = listMarkdown(nodeRequire("path").join(vault, "02_Cards"));
        const conceptsDir = nodeRequire("path").join(vault, "03_Concepts");
        const cardMap = new Map<string, { path: string; meta: FrontMatter; body: string }>();
        const cardByName = new Map<string, { path: string; meta: FrontMatter; body: string }>();
        for (const path of cards) {
            const parsed = parseFrontMatter(readText(path));
            const sourceId = String(parsed.meta.source_id || "").trim();
            if (sourceId) cardMap.set(sourceId, { path, ...parsed });
            cardByName.set(String(parsed.meta.title || "").trim(), { path, ...parsed });
        }

        const sources: SourceItem[] = [];
        const warnings: string[] = [];
        const parsedFiles = files.map((transcriptPath) => {
            const parsed = parseFrontMatter(readText(transcriptPath));
            return {
                transcriptPath,
                parsed,
                sourceId: String(parsed.meta.source_id || nodeRequire("path").basename(transcriptPath, ".md")).trim(),
                sourceUrl: String(parsed.meta.source_url || "").trim(),
                title: String(parsed.meta.title || nodeRequire("path").basename(transcriptPath, ".md")),
            };
        });
        const hasMatch = parsedFiles.some((item) => matchesInput(item.sourceUrl, input));
        if (!hasMatch && parsedFiles.length) {
            warnings.push("输入链接与转写稿来源不完全一致，已导入本次任务新生成的全部转写稿");
        }
        for (const item of parsedFiles) {
            const { transcriptPath, parsed, sourceId, sourceUrl, title } = item;
            if (!sourceUrl && !parsed.meta.title) continue;
            if (hasMatch && !matchesInput(sourceUrl, input)) continue;
            if (this.imported[sourceId] && config.skipDuplicates) continue;
            const card = cardMap.get(sourceId) || cardByName.get(String(parsed.meta.title || "").trim()) || null;
            const conceptNames = new Set<string>([
                ...extractWikilinks(card?.body || ""),
                ...metaList(card?.meta || {}, "concepts").map(normalizeConceptName),
            ]);
            sources.push({
                transcriptPath,
                title,
                sourceId,
                sourceUrl,
                meta: parsed.meta,
                body: parsed.body,
                cardPath: card?.path || "",
                cardMeta: card?.meta || {},
                cardBody: card?.body || "",
                conceptNames: [...conceptNames].filter(Boolean),
            });
        }

        const result: MediaKBImportResult = { sources: sources.length, skipped: 0, transcripts: [], cards: [], concepts: [], topics: [], warnings };
        if (!sources.length) {
            if (files.length) {
                result.skipped = files.length;
                result.warnings.push("没有新来源需要导入（重复来源已按设置跳过）");
                return result;
            }
            throw new Error("MediaKB 已结束，但没有找到新的转写稿（可能被跳过或输出目录不匹配）");
        }

        const conceptFiles = new Map<string, string>();
        for (const file of listMarkdown(conceptsDir)) {
            const name = normalizeConceptName(nodeRequire("path").basename(file, ".md"));
            if (name) conceptFiles.set(name, file);
        }

        // 1) Ensure all concept docs exist before writing any [[links]].
        for (const source of sources) {
            for (const name of source.conceptNames) {
                await this.ensureConceptDoc(name, settings, result);
            }
        }

        // 2) Import concept content, now that every target doc ID is known.
        for (const source of sources) {
            for (const name of source.conceptNames) {
                const file = conceptFiles.get(name);
                if (!file) continue;
                const parsed = parseFrontMatter(readText(file));
                const body = replaceWikilinks(parsed.body, this.conceptDocMap());
                await this.appendConceptContent(name, body, source, result);
            }
        }

        for (const source of sources) {
            const prior = this.imported[source.sourceId];
            if (prior && prior.card && config.skipDuplicates) continue;
            const existingTranscriptId = await this.findDocBySourceId(source.sourceId, "transcript");
            const transcriptBody = (config.importFrontmatter ? metadataBlock(source.meta) : "") + (config.timestampLinks ? convertTranscriptTimestamps(source.body, source.sourceUrl) : source.body);
            let transcript: ImportedDoc | null = existingTranscriptId
                ? { title: source.title, docId: existingTranscriptId, notebook: config.transcriptNotebook }
                : await this.createDoc(
                      config.transcriptNotebook,
                      `MediaKB/转写稿/${sanitizePathPart(source.title)}.sy`,
                      replaceWikilinks(transcriptBody, this.conceptDocMap()),
                  );
            if (transcript && !existingTranscriptId) {
                result.transcripts.push(transcript);
                await this.setDocAttrs(transcript.docId, {
                    "custom-mediakb-source-id": source.sourceId,
                    "custom-mediakb-source-url": source.sourceUrl,
                    "custom-mediakb-type": "transcript",
                    "custom-mediakb-title": source.title,
                });
            }
            let cardDoc: ImportedDoc | null = null;
            const existingCardId = await this.findDocBySourceId(source.sourceId, "card");
            if (existingCardId) {
                cardDoc = { title: source.title, docId: existingCardId, notebook: config.llmNotebook };
            } else if (source.cardPath) {
                const cardBody = (config.importFrontmatter ? metadataBlock(source.cardMeta) : "") + replaceWikilinks(source.cardBody, this.conceptDocMap());
                cardDoc = await this.createDoc(
                    config.llmNotebook,
                    `MediaKB/LLM/${sanitizePathPart(source.title)}.sy`,
                    cardBody,
                );
                if (cardDoc) {
                    result.cards.push(cardDoc);
                    await this.setDocAttrs(cardDoc.docId, {
                        "custom-mediakb-source-id": source.sourceId,
                        "custom-mediakb-source-url": source.sourceUrl,
                        "custom-mediakb-type": "card",
                        "custom-mediakb-title": source.title,
                    });
                }
            } else {
                warnings.push(`未找到 LLM 卡片，已先导入转写稿：${source.title}`);
            }
            this.imported[source.sourceId] = {
                transcript: transcript?.docId || "",
                card: cardDoc?.docId || "",
                concepts: source.conceptNames.join("|"),
                at: new Date().toISOString(),
            };
            await this.addIndexRow(source, transcript, cardDoc, settings, result);
        }

        await this.importTopics(startedAt, settings, result);
        await this.saveState();
        result.skipped = files.length - sources.length;
        return result;
    }

    private conceptDocMap(): Map<string, string> {
        return new Map(Object.entries(this.conceptDocs));
    }

    private async ensureConceptDoc(name: string, settings: MediaKBSettings, result: MediaKBImportResult): Promise<void> {
        if (this.conceptDocs[name]) return;
        const existing = await this.findConceptDoc(name);
        if (existing) {
            this.conceptDocs[name] = existing;
            return;
        }
        const config = settings.get();
        const doc = await this.createDoc(config.conceptNotebook, `MediaKB/概念/${sanitizePathPart(name)}.sy`, `# ${name}`);
        if (!doc) return;
        this.conceptDocs[name] = doc.docId;
        result.concepts.push(doc);
        await this.setDocAttrs(doc.docId, {
            "custom-mediakb-type": "concept",
            "custom-mediakb-concept": name,
        });
    }

    private async appendConceptContent(
        name: string,
        body: string,
        source: SourceItem,
        result: MediaKBImportResult,
    ): Promise<void> {
        const docId = this.conceptDocs[name];
        if (!docId) return;
        const stateKey = `${name}\u0000${source.sourceId}`;
        if (!this.imported[stateKey]) {
            const section = `\n\n## 来源：${source.title}\n\n${body}\n\n[打开原视频](${source.sourceUrl})`;
            const response = await fetchSyncPost("/api/block/appendBlock", {
                parentID: docId,
                dataType: "markdown",
                data: section,
            });
            if (response?.code !== 0) result.warnings.push(`概念内容写入失败：${name}`);
            this.imported[stateKey] = { transcript: source.sourceId, card: "", concepts: name, at: new Date().toISOString() };
        }
    }

    private async addIndexRow(
        source: SourceItem,
        transcript: ImportedDoc | null,
        card: ImportedDoc | null,
        settings: MediaKBSettings,
        result: MediaKBImportResult,
    ): Promise<void> {
        const config = settings.get();
        if (!config.indexEnabled) return;
        const notebook = config.indexNotebook || config.llmNotebook;
        if (!notebook) return;
        const indexId = await this.ensureIndexDoc(notebook, result);
        if (!indexId) return;
        const conceptLinks = source.conceptNames
            .map((name) => (this.conceptDocs[name] ? `[${name}](siyuan://blocks/${this.conceptDocs[name]})` : name))
            .join("、");
        const row = {
            date: new Date().toISOString().slice(0, 10),
            title: source.title,
            platform: String(source.meta.platform || ""),
            transcript: transcript ? `[转写稿](siyuan://blocks/${transcript.docId})` : "",
            card: card ? `[LLM 卡片](siyuan://blocks/${card.docId})` : "",
            concepts: conceptLinks,
        };
        const existing = this.indexRows.findIndex((item) => item.title === row.title && item.date === row.date);
        if (existing >= 0) this.indexRows[existing] = row;
        else this.indexRows.push(row);
        const written = await this.writeIndexTable(indexId);
        if (!written) {
            const fallback = `- ${row.date} | ${row.title} | ${row.platform} | ${[row.transcript, row.card, row.concepts].filter(Boolean).join(" | ")}`;
            const response = await fetchSyncPost("/api/block/appendBlock", {
                parentID: indexId,
                dataType: "markdown",
                data: fallback,
            });
            if (response?.code !== 0) result.warnings.push("索引表写入失败");
        }
        result.indexDocId = indexId;
    }

    private indexMarkdown(): string {
        const header = [
            "# MediaKB 索引",
            "",
            "| 日期 | 视频 | 平台 | 转写稿 | LLM 卡片 | 概念 |",
            "| --- | --- | --- | --- | --- | --- |",
        ];
        const rows = this.indexRows.map(
            (row) =>
                `| ${row.date} | ${row.title.replace(/\|/g, "｜")} | ${row.platform} | ${row.transcript} | ${row.card} | ${row.concepts} |`,
        );
        return `${header.concat(rows).join("\n")}\n`;
    }

    private async writeIndexTable(indexId: string): Promise<boolean> {
        const response = await fetchSyncPost("/api/block/updateBlock", {
            id: indexId,
            dataType: "markdown",
            data: this.indexMarkdown(),
        });
        return Boolean(response && response.code === 0);
    }

    private async importTopics(startedAt: number, settings: MediaKBSettings, result: MediaKBImportResult): Promise<void> {
        const config = settings.get();
        if (!config.topicNotebook) return;
        const topicsDir = nodeRequire("path").join(settings.getJobVaultDir(), "04_Topics");
        const files = listMarkdown(topicsDir).filter((file) => fileMtime(file) >= startedAt - 8000);
        for (const file of files) {
            const parsed = parseFrontMatter(readText(file));
            const name = String(parsed.meta.title || nodeRequire("path").basename(file, ".md")).trim();
            if (!name) continue;
            const existing = await this.findDocByAttr("custom-mediakb-topic", name);
            if (existing) continue;
            const body = (config.importFrontmatter ? metadataBlock(parsed.meta) : "") + replaceWikilinks(parsed.body, this.conceptDocMap());
            const doc = await this.createDoc(config.topicNotebook, `MediaKB/主题/${sanitizePathPart(name)}.sy`, body);
            if (!doc) continue;
            result.topics.push(doc);
            await this.setDocAttrs(doc.docId, {
                "custom-mediakb-type": "topic",
                "custom-mediakb-topic": name,
            });
        }
    }

    private async ensureIndexDoc(notebook: string, result: MediaKBImportResult): Promise<string> {
        if (this.indexDocId) return this.indexDocId;
        const existing = await this.findDocByAttr("custom-mediakb-index", "1");
        if (existing) {
            this.indexDocId = existing;
            return existing;
        }
        const doc = await this.createDoc(notebook, "MediaKB/索引.sy", this.indexMarkdown());
        if (!doc) return "";
        this.indexDocId = doc.docId;
        result.indexDocId = doc.docId;
        await this.setDocAttrs(doc.docId, { "custom-mediakb-index": "1" });
        return doc.docId;
    }

    private async findConceptDoc(name: string): Promise<string> {
        return this.findDocByAttr("custom-mediakb-concept", name);
    }

    private async findDocBySourceId(sourceId: string, type: "transcript" | "card"): Promise<string> {
        const escaped = sourceId.replace(/"/g, "&quot;");
        const response = await fetchSyncPost("/api/query/sql", {
            stmt: `SELECT id FROM blocks WHERE ial LIKE '%custom-mediakb-source-id="${escaped}"%' AND ial LIKE '%custom-mediakb-type="${type}"%' LIMIT 1`,
        });
        return String(response?.data?.[0]?.id || "");
    }

    private async findDocByAttr(attr: string, value: string): Promise<string> {
        const escaped = value.replace(/"/g, "&quot;");
        const response = await fetchSyncPost("/api/query/sql", {
            stmt: `SELECT id FROM blocks WHERE ial LIKE '%${attr}="${escaped}"%' LIMIT 1`,
        });
        return String(response?.data?.[0]?.id || "");
    }

    private async createDoc(notebook: string, docPath: string, markdown: string): Promise<ImportedDoc | null> {
        if (!notebook) throw new Error("未选择目标笔记本");
        const normalized = docPath.endsWith(".sy") ? docPath : `${docPath}.sy`;
        const path = normalized.startsWith("/") ? normalized : `/${normalized}`;
        let response = await fetchSyncPost("/api/filetree/createDocWithMd", {
            notebook,
            path,
            markdown,
        });
        if (response?.code !== 0 && /exist|存在/i.test(String(response?.msg || ""))) {
            const retryPath = path.replace(/\.sy$/, `-${Date.now()}.sy`);
            response = await fetchSyncPost("/api/filetree/createDocWithMd", { notebook, path: retryPath, markdown });
        }
        if (response?.code !== 0 || !response?.data) throw new Error("创建思源文档失败：" + (response?.msg || "unknown"));
        return { title: path, docId: String(response.data), notebook };
    }

    private async setDocAttrs(docId: string, attrs: Record<string, string>): Promise<void> {
        const response = await fetchSyncPost("/api/attr/setBlockAttrs", { id: docId, attrs });
        if (response?.code !== 0) throw new Error("写入文档属性失败");
    }

    private async saveState(): Promise<void> {
        await this.plugin.saveData(this.storageKey, {
            imported: this.imported,
            conceptDocs: this.conceptDocs,
            indexDocId: this.indexDocId,
            indexRows: this.indexRows,
        });
    }
}

function matchesInput(sourceUrl: string, input: string): boolean {
    if (!input) return true;
    const value = input.trim();
    const firstUrl = value.match(/https?:\/\/[^\s]+/)?.[0] || value;
    if (/^[A-Za-z]:[\\/]|^\//.test(firstUrl)) return true;
    if (/collectiondetail|\/list\//i.test(firstUrl)) return true;
    if (!sourceUrl) return true;
    if (sourceUrl === firstUrl) return true;
    // Short links (v.douyin.com, b23.tv) do not share a path with the final
    // canonical URL; match by platform instead.
    if (/douyin\.com|iesdouyin/i.test(firstUrl)) return /douyin|tiktok_douyin/i.test(sourceUrl);
    if (/b23\.tv/i.test(firstUrl)) return /bilibili\.com/i.test(sourceUrl);
    const bv = firstUrl.match(/BV[0-9A-Za-z]+/);
    if (bv && sourceUrl.includes(bv[0])) return true;
    try {
        const source = new URL(sourceUrl);
        const requested = new URL(firstUrl);
        if (source.hostname !== requested.hostname) return false;
        if (source.pathname === requested.pathname) return true;
        return source.pathname.includes(requested.pathname) || requested.pathname.includes(source.pathname);
    } catch {
        return sourceUrl.includes(firstUrl);
    }
}
