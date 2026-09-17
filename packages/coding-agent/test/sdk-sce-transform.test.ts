import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SCE_SLICE_MARKER } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { scanWorkspaceDocs } from "../src/core/sce-scan.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("createAgentSession SCE wiring", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-sce-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prepends real workspace excerpts that survive convertToLlm", async () => {
		writeFileSync(
			join(cwd, "src", "auth.ts"),
			"// session handling\nexport function authenticateUser(name: string) {\n  return 'token:' + name;\n}\n",
		);
		writeFileSync(join(cwd, "src", "unrelated.ts"), "export const greeting = 'hello';\n");
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			const messages: AgentMessage[] = [
				{ role: "user", content: "how does authenticateUser work", timestamp: Date.now() },
			];
			const after = await session.agent.transformContext!(messages);
			// Stored history untouched: new array with the slice prepended.
			expect(messages.length).toBe(1);
			expect(after.length).toBe(2);
			const first = after[0];
			expect(first.role).toBe("user");
			if (first.role !== "user" || typeof first.content !== "string") throw new Error("expected SCE text slice");
			expect(first.content.startsWith(SCE_SLICE_MARKER)).toBe(true);
			expect(first.content.includes("src/auth.ts:2:")).toBe(true);
			expect(first.content.includes("authenticateUser")).toBe(true);

			// The slice reaches the model: convertToLlm keeps it.
			const llm = convertToLlm(after);
			const joined = JSON.stringify(llm);
			expect(joined).toContain(SCE_SLICE_MARKER);
			expect(joined).toContain("authenticateUser");

			// Second identical turn is served from cache (same slice, no rescan).
			const again = await session.agent.transformContext!(messages);
			expect(again[0]).toEqual(after[0]);
		} finally {
			session.dispose();
		}
	});

	it("falls back to real entry files when nothing matches", async () => {
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", main: "index.js" }));
		writeFileSync(join(cwd, "index.js"), "export const entry = 42;\n");
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			const messages: AgentMessage[] = [
				{ role: "user", content: "zebra quux nonexistent identifier", timestamp: Date.now() },
			];
			const after = await session.agent.transformContext!(messages);
			expect(after.length).toBe(2);
			const first = after[0];
			if (first.role !== "user" || typeof first.content !== "string") throw new Error("expected SCE text slice");
			expect(first.content.startsWith(SCE_SLICE_MARKER)).toBe(true);
			expect(first.content.includes("index.js:1:")).toBe(true);
			expect(JSON.stringify(after)).not.toContain("No matches found");
		} finally {
			session.dispose();
		}
	});

	it("never indexes secrets into the slice", async () => {
		writeFileSync(join(cwd, ".env"), "AUTH_TOKEN=authenticateUser-secret-value\n");
		writeFileSync(join(cwd, ".env.local"), "AUTH_TOKEN=authenticateUser-secret-value\n");
		writeFileSync(join(cwd, "server.pem"), "-----BEGIN CERTIFICATE-----\n");
		writeFileSync(join(cwd, "server.key"), "-----BEGIN PRIVATE KEY-----\n");
		// SSH private keys typically have no extension.
		writeFileSync(join(cwd, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
		writeFileSync(join(cwd, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
		writeFileSync(join(cwd, "keystore.p12"), "binary keystore bytes\n");
		writeFileSync(join(cwd, "src", "auth.ts"), "export function authenticateUser() {}\n");
		const scanned = await scanWorkspaceDocs(cwd, ["authenticateuser"]);
		expect(scanned.docs.length).toBeGreaterThan(0);
		for (const doc of scanned.docs) {
			expect(doc.path).not.toContain(".env");
			expect(doc.path).not.toContain("server.pem");
			expect(doc.path).not.toContain("server.key");
			expect(doc.path).not.toContain("id_rsa");
			expect(doc.path).not.toContain("id_ed25519");
			expect(doc.path).not.toContain("keystore.p12");
		}
		expect(scanned.docs.some((d) => d.path === "src/auth.ts")).toBe(true);
	});

	it("keeps an exactly named file past count-inflated candidates", async () => {
		// 70 junk files stuffed with a common term outnumber the candidate cut;
		// the file named outright in the query must still survive it.
		for (let i = 0; i < 70; i++) {
			writeFileSync(join(cwd, `junk${i}.txt`), `${"line file common\n".repeat(50)}`);
		}
		writeFileSync(join(cwd, "widget.ts"), "export const widget = 1;\n");
		const scanned = await scanWorkspaceDocs(cwd, ["common", "line", "file", "widget"]);
		expect(scanned.docs.some((d) => d.path === "widget.ts")).toBe(true);
	});

	it("skips generated lockfiles and minified bundles at discovery", async () => {
		writeFileSync(join(cwd, "package-lock.json"), `${"packages widget common\n".repeat(500)}`);
		writeFileSync(join(cwd, "app.min.js"), `${"widget common\n".repeat(500)}`);
		writeFileSync(join(cwd, "widget.ts"), "export const widget = 1;\n");
		const scanned = await scanWorkspaceDocs(cwd, ["widget", "common"]);
		expect(scanned.docs.some((d) => d.path === "package-lock.json")).toBe(false);
		expect(scanned.docs.some((d) => d.path === "app.min.js")).toBe(false);
		expect(scanned.docs.some((d) => d.path === "widget.ts")).toBe(true);
	});

	it("stays silent when the workspace is empty", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			const messages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
			const after = await session.agent.transformContext!(messages);
			expect(after).toEqual(messages);
		} finally {
			session.dispose();
		}
	});
});
