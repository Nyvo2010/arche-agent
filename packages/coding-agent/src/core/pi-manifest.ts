import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read resource declarations from a package.json manifest.
 * Prefers the "arche" field; falls back to Pi's "pi" field so existing
 * Pi extensions and packages keep working unchanged.
 */
export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg)) {
			return null;
		}
		const section = isObject(pkg.arche) ? pkg.arche : isObject(pkg.pi) ? pkg.pi : null;
		if (!section) {
			return null;
		}

		const manifest: PiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = section[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
