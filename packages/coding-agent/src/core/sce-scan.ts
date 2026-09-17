/**
 * SCE workspace scan (I/O boundary).
 *
 * Pure ranking lives in `@earendil-works/pi-agent-core` (`sce.ts`); this
 * module only walks the workspace and reads real file bytes. Case-insensitive
 * substring match per query term, entry-file fallback when nothing matches.
 * Never throws: unreadable paths are skipped, total failure yields no docs.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { filenameStem, type SceFileDoc, type SceScanResult } from "@earendil-works/pi-agent-core";

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	"target",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
]);

/** Never index secrets into LLM context (unless the user explicitly lists the file). */
function isSensitiveFile(baseName: string): boolean {
	if (baseName === ".env" || baseName.startsWith(".env.")) return true;
	if (baseName.endsWith(".pem") || baseName.endsWith(".key")) return true;
	// Private key material and key stores (SSH keys typically have no extension).
	if (
		baseName.endsWith(".p12") ||
		baseName.endsWith(".pfx") ||
		baseName.endsWith(".jks") ||
		baseName.endsWith(".keystore")
	) {
		return true;
	}
	return /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/.test(baseName);
}
/** Files larger than this are skipped (binary-ish or too costly per turn). */
const MAX_FILE_BYTES = 131_072;
/** Lines kept per file (enough for ranking + snippets). */
const MAX_LINES_PER_FILE = 2000;
/** Walk cap so huge workspaces stay fast. */
const MAX_FILES_WALKED = 4000;
/** Candidate cap before ranking. */
const MAX_CANDIDATE_DOCS = 60;
/** Head lines read per fallback entry file. */
const FALLBACK_HEAD_LINES = 120;
/** Files read concurrently per chunk (bounds fd pressure; ~10x faster cold scans). */
const READ_CHUNK = 32;

export interface SceScanOptions {
	importantFiles?: string[];
}

function toPosix(path: string): string {
	return path.split(sep).join("/");
}

interface IgnoreRule {
	kind: "dir" | "suffix" | "name";
	value: string;
}

/** Best-effort .gitignore: `dir/`, `*.ext`, and bare-name patterns. */
function parseGitignore(text: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
		const pattern = line.startsWith("/") ? line.slice(1) : line;
		if (pattern.endsWith("/")) {
			rules.push({ kind: "dir", value: pattern.slice(0, -1) });
		} else if (pattern.startsWith("*.")) {
			rules.push({ kind: "suffix", value: pattern.slice(1) });
		} else if (!pattern.includes("/")) {
			rules.push({ kind: "name", value: pattern });
		}
	}
	return rules;
}

function ignoredBy(rel: string, rules: IgnoreRule[]): boolean {
	const parts = rel.split("/");
	const base = parts[parts.length - 1];
	for (const rule of rules) {
		if (rule.kind === "dir" && parts.includes(rule.value)) return true;
		if (rule.kind === "suffix" && base.endsWith(rule.value)) return true;
		if (rule.kind === "name" && base === rule.value) return true;
	}
	return false;
}

function isBinaryLike(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
	for (let i = 0; i < sample.length; i++) {
		if (sample[i] === 0) return true;
	}
	return false;
}

function matchLines(lines: string[], terms: string[]): { matched: number[]; count: number } {
	const matched: number[] = [];
	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		const lower = lines[i].toLowerCase();
		let hits = 0;
		for (const term of terms) {
			if (lower.includes(term)) hits++;
		}
		if (hits > 0) {
			count += hits;
			if (matched.length < 200) matched.push(i + 1);
		}
	}
	return { matched, count };
}

/**
 * Walk the workspace and return files containing any query term.
 * Real bytes only: no excerpts are invented, paths are all on disk.
 * Two phases: discovery (cheap readdir walk), then chunked-parallel reads
 * so a cold first query does not serialize thousands of file reads.
 */
export async function scanWorkspaceDocs(
	root: string,
	terms: string[],
	options: SceScanOptions = {},
): Promise<SceScanResult> {
	try {
		let rules: IgnoreRule[] = [];
		try {
			rules = parseGitignore(await readFile(join(root, ".gitignore"), "utf-8"));
		} catch {
			rules = [];
		}
		const lowerTerms = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
		if (lowerTerms.length === 0) return { docs: [], fallback: true };

		const paths = await collectFilePaths(root, rules);
		const candidates = await readCandidates(root, paths, lowerTerms);
		// Files named outright in the query always survive the candidate cut:
		// raw hit counts favor huge generated files over the exact match.
		const termSet = new Set(lowerTerms);
		const stemRank = (path: string): number => (termSet.has(filenameStem(path)) ? 0 : 1);
		candidates.sort(
			(a, b) =>
				stemRank(a.doc.path) - stemRank(b.doc.path) || b.count - a.count || (a.doc.path < b.doc.path ? -1 : 1),
		);
		const docs = candidates.slice(0, MAX_CANDIDATE_DOCS).map((c) => c.doc);
		if (docs.length > 0) return { docs, fallback: false };
		return { docs: await fallbackDocs(root, options.importantFiles ?? []), fallback: true };
	} catch {
		return { docs: [], fallback: true };
	}
}

/** Depth-first walk collecting candidate file paths (discovery only: no reads). */
async function collectFilePaths(root: string, rules: IgnoreRule[]): Promise<string[]> {
	const paths: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0 && paths.length < MAX_FILES_WALKED) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (paths.length >= MAX_FILES_WALKED) break;
			const abs = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				// Hidden directories (.git, .vscode, ...) are never indexed.
				if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
				if (ignoredBy(toPosix(relative(root, abs)), rules)) continue;
				stack.push(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			if (isSensitiveFile(entry.name)) continue;
			const rel = toPosix(relative(root, abs));
			if (ignoredBy(rel, rules)) continue;
			paths.push(rel);
		}
	}
	return paths;
}

/** Read+match collected paths in parallel chunks. All walked paths are matched so relevance (not walk order) decides the top candidates. */
async function readCandidates(
	root: string,
	paths: string[],
	lowerTerms: string[],
): Promise<Array<{ doc: SceFileDoc; count: number }>> {
	const candidates: Array<{ doc: SceFileDoc; count: number }> = [];
	for (let i = 0; i < paths.length; i += READ_CHUNK) {
		const chunk = paths.slice(i, i + READ_CHUNK);
		const found = await Promise.all(
			chunk.map(async (rel): Promise<{ doc: SceFileDoc; count: number } | undefined> => {
				try {
					const abs = join(root, rel);
					if ((await stat(abs)).size > MAX_FILE_BYTES) return undefined;
					const buffer = await readFile(abs);
					if (buffer.length === 0 || isBinaryLike(buffer)) return undefined;
					const lines = buffer.toString("utf-8").split("\n").slice(0, MAX_LINES_PER_FILE);
					const { matched, count } = matchLines(lines, lowerTerms);
					if (matched.length === 0) return undefined;
					return { doc: { path: rel, lines, matchedLines: matched }, count };
				} catch {
					return undefined;
				}
			}),
		);
		for (const candidate of found) {
			if (candidate) candidates.push(candidate);
		}
	}
	return candidates;
}

/** Entry files + user `importantFiles`, head lines only, all read from disk. */
async function fallbackDocs(root: string, importantFiles: string[]): Promise<SceFileDoc[]> {
	const paths: string[] = [];
	try {
		const pkgRaw = await readFile(join(root, "package.json"), "utf-8");
		const pkg = JSON.parse(pkgRaw) as { main?: unknown; bin?: unknown };
		if (typeof pkg.main === "string") paths.push(pkg.main);
		if (typeof pkg.bin === "string") paths.push(pkg.bin);
		else if (pkg.bin && typeof pkg.bin === "object") {
			for (const value of Object.values(pkg.bin)) {
				if (typeof value === "string") paths.push(value);
			}
		}
	} catch {
		// No package.json — fall through to index.* scan.
	}
	try {
		const entries = await readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && /^index\.[^.]+$/.test(entry.name)) paths.push(entry.name);
		}
	} catch {
		// Unreadable root — importantFiles may still work.
	}
	for (const extra of importantFiles) {
		if (typeof extra === "string" && extra.length > 0) paths.push(extra);
	}
	const docs: SceFileDoc[] = [];
	const seen = new Set<string>();
	const explicit = new Set(
		importantFiles.filter((f): f is string => typeof f === "string").map((f) => toPosix(f.replace(/^\.\//, ""))),
	);
	for (const raw of paths) {
		const rel = toPosix(raw.replace(/^\.\//, ""));
		if (seen.has(rel) || rel.includes("..")) continue;
		seen.add(rel);
		const base = rel.split("/").pop() ?? rel;
		if (isSensitiveFile(base) && !explicit.has(rel)) continue;
		try {
			const abs = join(root, rel);
			if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
			const buffer = await readFile(abs);
			if (isBinaryLike(buffer)) continue;
			const lines = buffer.toString("utf-8").split("\n").slice(0, FALLBACK_HEAD_LINES);
			if (lines.length > 0) docs.push({ path: rel, lines, matchedLines: [] });
		} catch {
			continue;
		}
		if (docs.length >= 6) break;
	}
	return docs;
}
