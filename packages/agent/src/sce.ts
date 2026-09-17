/**
 * Smart Context Engine (SCE) — per-request workspace slice.
 *
 * Runs inside `transformContext` (before COE) and prepends a small slice of
 * real workspace excerpts so the model sees relevant code without loading
 * whole files. Composes with COE (`./coe.ts`): SCE adds context, COE trims
 * the request back inside budget. COE never drops the SCE slice (it matches
 * {@link SCE_SLICE_MARKER}, mirrored in `coe.ts`).
 *
 * Pipeline per turn:
 *  1. Query = last user message + last assistant reply, terms split like COE
 *     (camelCase/snake_case/kebab-case, lowercase, stopwords, deduped).
 *  2. Scan (injected I/O) returns candidate files with matching line numbers.
 *  3. Rank: BM25-light term scorer by default; trigram-similarity scorer when
 *     `enableSemantic` is on (dependency-free fuzzy match, no model download).
 *  4. Snippet builder: top N files inside a shared token budget, each excerpt
 *     headed with `path:line`. Fallback entry files arrive as head-mode docs.
 *
 * Like COE: pure orchestration, never mutates the input, never throws (the
 * `transformContext` caller falls back to the input). An empty scan yields a
 * silent no-op — SCE never injects placeholder or "no results" text.
 */

import { extractQueryTerms, latestUserText, messageText } from "./coe.ts";
import { estimateTokens } from "./harness/compaction/compaction.ts";
import type { AgentMessage } from "./types.ts";

/** Marker heading every SCE slice. Mirrored as a literal in `coe.ts`. */
export const SCE_SLICE_MARKER = "<workspace-context>";
/** Default number of files included in the slice. */
export const DEFAULT_SCE_MAX_FILES = 6;
/** Default shared token budget for the slice. */
export const DEFAULT_SCE_BUDGET_TOKENS = 2000;
/** Default cache TTL in milliseconds. */
export const DEFAULT_SCE_TTL_MS = 30_000;

const CHARS_PER_TOKEN = 4;
/** Long source lines are clipped so one line cannot eat the budget. */
const MAX_SNIPPET_LINE_CHARS = 240;
/** Semantic scorer only reads this many chars per file (speed cap). */
const SEMANTIC_MAX_CHARS_PER_FILE = 20_000;

/** One workspace file with its query-matching lines (1-indexed). */
export interface SceFileDoc {
	/** Workspace-relative path, e.g. `src/auth.ts`. */
	path: string;
	/** File lines. */
	lines: string[];
	/** 1-indexed matching lines. Empty = head-mode (fallback entry file). */
	matchedLines: number[];
}

/** Result of the injected workspace scan. */
export interface SceScanResult {
	docs: SceFileDoc[];
	/** True when the scan found nothing and fell back to entry files. */
	fallback: boolean;
}

export interface SceOptions {
	/** Max files in the slice. Defaults to 6. */
	maxFiles?: number;
	/** Shared token budget for the slice. Defaults to 2000. */
	budgetTokens?: number;
	/** Trigram-similarity ranking instead of BM25 term overlap. Default off. */
	enableSemantic?: boolean;
}

/** Ranker: one score per doc, higher = more relevant. */
export type SceScoreFn = (docs: SceFileDoc[], terms: string[], query: string) => number[];

function positiveInt(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Build the SCE query: last user message plus last assistant reply.
 * Empty when there is no user message yet.
 */
export function buildSceQuery(messages: AgentMessage[]): string {
	const userText = latestUserText(messages);
	if (userText.trim().length === 0) return "";
	let assistantText = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			assistantText = messageText(messages[i]);
			break;
		}
	}
	return assistantText.trim().length > 0 ? `${userText}\n${assistantText}` : userText;
}

function countOccurrences(lowerHaystack: string, term: string): number {
	if (term.length === 0) return 0;
	return lowerHaystack.split(term).length - 1;
}

/**
 * Exact filename-stem bonus: naming a file is the strongest relevance signal
 * (e.g. query term `sdk` for `src/sdk.ts`), outweighing tf inflation in
 * unrelated docs that merely mention the term many times.
 */
const EXACT_FILENAME_BONUS = 1000;

/** Lowercase basename without its last extension, e.g. `src/SDK.ts` → `sdk`. Shared with the scan pre-filter (`sce-scan.ts`). */
export function filenameStem(path: string): string {
	const base = path.split("/").pop() ?? path;
	const dot = base.lastIndexOf(".");
	return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/**
 * BM25-light scorer: term frequency weighted by inverse document frequency,
 * plus a path bonus so `auth` ranks `src/auth.ts` above a file that merely
 * mentions it, plus an exact filename-stem bonus so a named file always
 * surfaces. Case-insensitive substring matching, deterministic.
 */
export function scoreTermOverlap(docs: SceFileDoc[], terms: string[], _query: string): number[] {
	if (terms.length === 0 || docs.length === 0) return docs.map(() => 0);
	const n = docs.length;
	const lowerTexts = docs.map((d) => d.lines.join("\n").toLowerCase());
	const lowerPaths = docs.map((d) => d.path.toLowerCase());
	const stems = docs.map((d) => filenameStem(d.path));
	const termSet = new Set(terms);
	const df = terms.map((term) => lowerTexts.filter((text) => text.includes(term)).length);
	return docs.map((_, i) => {
		let score = 0;
		for (let t = 0; t < terms.length; t++) {
			if (df[t] === 0) continue;
			const idf = Math.log((n - df[t] + 0.5) / (df[t] + 0.5) + 1);
			const tf = countOccurrences(lowerTexts[i], terms[t]);
			score += tf * idf;
			if (lowerPaths[i].includes(terms[t])) score += 2 * idf;
		}
		if (termSet.has(stems[i])) score += EXACT_FILENAME_BONUS;
		return score;
	});
}

function trigramsOf(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	const padded = `  ${text}  `;
	for (let i = 0; i + 3 <= padded.length; i++) {
		const gram = padded.slice(i, i + 3);
		if (gram.trim().length === 0) continue;
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	return counts;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (const count of a.values()) normA += count * count;
	for (const [gram, countB] of b) {
		normB += countB * countB;
		const countA = a.get(gram);
		if (countA !== undefined) dot += countA * countB;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantic scorer: character-trigram cosine similarity between the query and
 * each file. Tolerates morphological variants and typos that term overlap
 * misses (`colour` ~ `color`, `configur` ~ `configuration`). BM25 breaks
 * ties. Dependency-free and deterministic; an embedding-model backend may
 * replace it later behind the same `enableSemantic` knob.
 */
export function scoreSemanticSimilarity(docs: SceFileDoc[], terms: string[], query: string): number[] {
	if (docs.length === 0) return [];
	const queryGrams = trigramsOf(query.toLowerCase());
	const bm25 = scoreTermOverlap(docs, terms, query);
	return docs.map((doc, i) => {
		const text = doc.lines.join("\n").toLowerCase().slice(0, SEMANTIC_MAX_CHARS_PER_FILE);
		return cosineSimilarity(queryGrams, trigramsOf(text)) * 1000 + bm25[i];
	});
}

/** Pick the ranker for the mode. Pure: the semantic path needs no model. */
export function resolveSceScoreFn(enableSemantic: boolean | undefined): { fn: SceScoreFn; name: string } {
	return enableSemantic === true
		? { fn: scoreSemanticSimilarity, name: "semantic-trigram" }
		: { fn: scoreTermOverlap, name: "term-bm25" };
}

/** Rank doc indexes best-first; ties keep scan order (stable). */
export function rankSceDocs(docs: SceFileDoc[], terms: string[], query: string, fn: SceScoreFn): number[] {
	const scores = fn(docs, terms, query);
	return docs
		.map((_, i) => i)
		.map((i) => ({ i, score: scores[i] ?? 0 }))
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.map((entry) => entry.i);
}

/** Build the slice text for ranked docs inside the char budget. */
export function buildSceSliceText(ranked: SceFileDoc[], budgetTokens: number): { text: string; files: string[] } {
	const budgetChars = Math.max(1, Math.floor(budgetTokens * CHARS_PER_TOKEN));
	const perFileChars = Math.max(256, Math.ceil(budgetChars / Math.max(1, ranked.length)));
	const out: string[] = [SCE_SLICE_MARKER];
	const files: string[] = [];
	let used = 0;
	for (const doc of ranked) {
		if (used >= budgetChars) break;
		const room = Math.min(perFileChars, budgetChars - used);
		const picked = pickSnippetLines(doc);
		if (picked.length === 0) continue;
		const head = `<file: ${doc.path}>`;
		const body: string[] = [head];
		let fileUsed = head.length + 1;
		for (const lineNo of picked) {
			const raw = doc.lines[lineNo - 1] ?? "";
			const clipped = raw.length > MAX_SNIPPET_LINE_CHARS ? raw.slice(0, MAX_SNIPPET_LINE_CHARS) : raw;
			const row = `${doc.path}:${lineNo}: ${clipped}`;
			if (fileUsed + row.length + 1 > room) break;
			body.push(row);
			fileUsed += row.length + 1;
		}
		// Guarantee at least one excerpt row per kept file: clip the first
		// match into whatever room is left instead of emitting an empty file.
		if (body.length < 2 && picked.length > 0) {
			const lineNo = picked[0] as number;
			const prefix = `${doc.path}:${lineNo}: `;
			const roomLeft = room - fileUsed;
			if (roomLeft <= prefix.length + 4) continue;
			const row = prefix + (doc.lines[lineNo - 1] ?? "").slice(0, roomLeft - prefix.length);
			body.push(row);
			fileUsed += row.length + 1;
		}
		if (body.length < 2) continue;
		out.push(body.join("\n"));
		files.push(doc.path);
		used += fileUsed;
	}
	return { text: out.join("\n"), files };
}

/** Matching lines ±1 context, or head lines for fallback docs. */
function pickSnippetLines(doc: SceFileDoc): number[] {
	if (doc.matchedLines.length === 0) {
		const head: number[] = [];
		for (let i = 1; i <= Math.min(40, doc.lines.length); i++) head.push(i);
		return head;
	}
	const picked = new Set<number>();
	for (const lineNo of doc.matchedLines) {
		for (const near of [lineNo - 1, lineNo, lineNo + 1]) {
			if (near >= 1 && near <= doc.lines.length) picked.add(near);
		}
		if (picked.size >= 60) break;
	}
	return [...picked].sort((a, b) => a - b);
}

/** Wrap slice text as a per-request user message (never stored). */
export function createSceSliceMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** TTL cache keyed on workspace + user terms + mode. Never throws. */
export class SceCache {
	private entry: { key: string; at: number; message: AgentMessage; files: string[]; fallback: boolean } | undefined;
	/** Drop the cached slice; called on workspace mutations. */
	invalidate(): void {
		this.entry = undefined;
	}
	get(key: string, ttlMs: number): { message: AgentMessage; files: string[]; fallback: boolean } | undefined {
		const hit = this.entry;
		if (!hit || hit.key !== key) return undefined;
		if (Date.now() - hit.at > ttlMs) {
			this.entry = undefined;
			return undefined;
		}
		return { message: hit.message, files: hit.files, fallback: hit.fallback };
	}
	store(key: string, message: AgentMessage, files: string[], fallback: boolean): void {
		this.entry = { key, at: Date.now(), message, files, fallback };
	}
}

export interface SceRunArgs extends SceOptions {
	/** Workspace root for the cache key. */
	root: string;
	cache: SceCache;
	/** Injected I/O: scan the workspace for the terms. */
	scanDocs: (root: string, terms: string[], options: { importantFiles?: string[] }) => Promise<SceScanResult>;
	importantFiles?: string[];
	ttlMs?: number;
	debug?: (line: string) => void;
}

export interface SceApplied {
	messages: AgentMessage[];
	queryTerms: string[];
	files: string[];
	cached: boolean;
	fallback: boolean;
}

/**
 * Run one SCE pass over a message list. Pure orchestration: returns a new
 * array with the slice prepended, or the input unchanged when there is
 * nothing worth injecting. Never throws.
 */
export async function applySceSlice(messages: AgentMessage[], args: SceRunArgs): Promise<SceApplied> {
	const passthrough = (extra?: Partial<SceApplied>): SceApplied => ({
		messages,
		queryTerms: [],
		files: [],
		cached: false,
		fallback: false,
		...extra,
	});
	try {
		if (messages.length === 0) {
			args.debug?.("[SCE] skip: no messages");
			return passthrough();
		}
		const first = messages[0];
		if (first.role === "user" && typeof first.content === "string" && first.content.startsWith(SCE_SLICE_MARKER)) {
			args.debug?.("[SCE] skip: slice already present (double-inject guard)");
			return passthrough();
		}
		const query = buildSceQuery(messages);
		const terms = extractQueryTerms(query);
		if (terms.length === 0) {
			args.debug?.("[SCE] skip: no query terms");
			return passthrough();
		}
		// The rescan decision keys on the USER's terms, not the full query:
		// assistant chatter between tool calls must not trigger a fresh
		// workspace walk every turn. Ranking still uses the full query.
		const userTerms = extractQueryTerms(latestUserText(messages));
		const keyTerms = userTerms.length > 0 ? userTerms : terms;
		// Single short probes ("hi", "thanks") skip the workspace walk: they
		// would only ever hit the entry-file fallback, which is noise.
		if (keyTerms.length <= 1 && latestUserText(messages).trim().length < 12) {
			args.debug?.(`[SCE] skip: short probe (query: ${terms.slice(0, 8).join(",")})`);
			return passthrough({ queryTerms: terms });
		}
		const maxFiles = positiveInt(args.maxFiles, DEFAULT_SCE_MAX_FILES);
		const budgetTokens = positiveInt(args.budgetTokens, DEFAULT_SCE_BUDGET_TOKENS);
		const ttlMs = positiveInt(args.ttlMs, DEFAULT_SCE_TTL_MS);
		const mode = args.enableSemantic === true ? "sem" : "term";
		const key = `${args.root}\n${mode}\n${maxFiles}\n${budgetTokens}\n${keyTerms.join(" ")}`;
		const hit = args.cache.get(key, ttlMs);
		if (hit) {
			args.debug?.(
				`[SCE] +${hit.files.length} files (cached${hit.fallback ? ", fallback" : ""}, ~${estimateTokens(hit.message)} tokens, query: ${terms.slice(0, 8).join(",")}, files: ${hit.files.join(",")})`,
			);
			return {
				messages: [hit.message, ...messages],
				queryTerms: terms,
				files: hit.files,
				cached: true,
				fallback: hit.fallback,
			};
		}
		const scanned = await args.scanDocs(args.root, terms, { importantFiles: args.importantFiles });
		if (scanned.docs.length === 0) {
			args.debug?.(`[SCE] skip: empty scan (query: ${terms.slice(0, 8).join(",")})`);
			return passthrough({ queryTerms: terms });
		}
		const { fn, name } = resolveSceScoreFn(args.enableSemantic);
		const order = rankSceDocs(scanned.docs, terms, query, fn);
		const top = order.slice(0, maxFiles).map((i) => scanned.docs[i] as SceFileDoc);
		if (top.length === 0) {
			args.debug?.(`[SCE] skip: no docs after rank (query: ${terms.slice(0, 8).join(",")})`);
			return passthrough({ queryTerms: terms });
		}
		const { text, files } = buildSceSliceText(top, budgetTokens);
		if (files.length === 0) {
			args.debug?.(`[SCE] skip: slice empty after budget trim (query: ${terms.slice(0, 8).join(",")})`);
			return passthrough({ queryTerms: terms });
		}
		const message = createSceSliceMessage(text);
		args.cache.store(key, message, files, scanned.fallback);
		args.debug?.(
			`[SCE] +${files.length} files (${name}${scanned.fallback ? ", fallback" : ""}, ~${estimateTokens(message)} tokens, query: ${terms.slice(0, 8).join(",")}, files: ${files.join(",")})`,
		);
		return { messages: [message, ...messages], queryTerms: terms, files, cached: false, fallback: scanned.fallback };
	} catch {
		return passthrough();
	}
}
