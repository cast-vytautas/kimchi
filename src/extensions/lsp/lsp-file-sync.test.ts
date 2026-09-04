// Regression tests for the "LSP file sync failed" code-frame dump observed in
// worktree sessions: a server that fails to start (e.g. typescript-language-server
// with no resolvable tsserver.js) must be reported once as a one-line message
// and never re-spawned for the rest of the session.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const mocks = vi.hoisted(() => {
	const tsServer = {
		name: "typescript-language-server",
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
		installHint: "npm i -g typescript-language-server typescript",
	}
	return {
		tsServer,
		getOrCreateClient: vi.fn(),
		ensureFileOpen: vi.fn(async () => {}),
		refreshFile: vi.fn(async () => {}),
		waitForDiagnostics: vi.fn(async () => false),
	}
})

vi.mock("./client.js", () => ({
	getOrCreateClient: mocks.getOrCreateClient,
	ensureFileOpen: mocks.ensureFileOpen,
	refreshFile: mocks.refreshFile,
	waitForDiagnostics: mocks.waitForDiagnostics,
	sendRequest: vi.fn(),
	shutdownAll: vi.fn(),
}))

vi.mock("./servers.js", () => ({
	detectServers: vi.fn(() => [mocks.tsServer]),
	detectMissingCandidates: vi.fn(() => []),
	serverForFile: vi.fn((filePath: string) => (filePath.endsWith(".ts") ? mocks.tsServer : null)),
	findRoot: vi.fn((_file: string, _server: string, sessionCwd: string) => sessionCwd),
	resolveTsserverPath: vi.fn(() => undefined),
	findMainRepoRoot: vi.fn(() => undefined),
}))

vi.mock("../prompt-construction/index.js", () => ({
	createSystemPromptBlocks: vi.fn(() => ({ register: vi.fn() })),
}))
vi.mock("../prompt-construction/tool-visibility.js", () => ({
	createToolVisibility: vi.fn(() => ({ disable: vi.fn() })),
}))
vi.mock("../steer-marker.js", () => ({
	markHarnessSteer: vi.fn((content: string) => content),
}))

import lspExtension from "../lsp.js"

const INIT_FAILURE =
	"LSP error: Request initialize failed with message: Could not find a valid TypeScript installation."

function makeSession(files?: string[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kimchi-lsp-fail-"))
	for (const name of files ?? []) {
		fs.writeFileSync(path.join(dir, name), "{}\n")
	}
	const ext = createExtensionApi()
	lspExtension(ext.api)
	const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	return { dir, ext, consoleSpy }
}

function editToolResult(filePath: string) {
	return { toolName: "edit", isError: false, input: { path: filePath }, content: [], details: undefined }
}

type RawHandler = (event: unknown, ctx: unknown) => Promise<unknown>

describe("lsp file sync failure handling", () => {
	beforeEach(() => {
		mocks.getOrCreateClient.mockReset().mockRejectedValue(new Error(INIT_FAILURE))
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("logs a single one-line error and stops respawning after a start failure", async () => {
		const { dir, ext, consoleSpy } = makeSession()
		const sessionCtx = createContext({ cwd: dir })
		await (ext.getHandler("session_start") as RawHandler)(null, sessionCtx)
		// No tsconfig/package.json in dir → no eager server start.
		expect(mocks.getOrCreateClient).not.toHaveBeenCalled()

		const toolResult = ext.getHandler("tool_result") as RawHandler
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		await toolResult(editToolResult("bar.ts"), createContext({ cwd: dir }))

		// One spawn attempt total; the failure is remembered for the session.
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		// The failure is logged exactly once, as a plain single-line message —
		// never as an Error object (Bun would dump the bundled-source code frame).
		expect(consoleSpy).toHaveBeenCalledTimes(1)
		const logged = consoleSpy.mock.calls[0][0]
		expect(typeof logged).toBe("string")
		expect(logged.startsWith("LSP file sync failed: ")).toBe(true)
		expect(logged.includes(INIT_FAILURE)).toBe(true)
		expect(logged.includes("\n")).toBe(false)
		// The status bar reflects the degraded server.
		const setStatus = sessionCtx.ui.setStatus as ReturnType<typeof vi.fn>
		expect(setStatus.mock.lastCall).toEqual(["lsp", "LSP: typescript-language-server failed to start"])
	})

	it("records an eager session_start failure and skips respawning on later file ops", async () => {
		const { dir, ext, consoleSpy } = makeSession(["package.json"])
		const sessionCtx = createContext({ cwd: dir })
		await (ext.getHandler("session_start") as RawHandler)(null, sessionCtx)
		// Marker present → eager start attempted and failed (rejection handled async).
		await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalledTimes(1))
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)

		const toolResult = ext.getHandler("tool_result") as RawHandler
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))

		// No respawn, no repeat log, no file sync attempted.
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		expect(consoleSpy).toHaveBeenCalledTimes(1)
		expect(mocks.ensureFileOpen).not.toHaveBeenCalled()
		expect(mocks.refreshFile).not.toHaveBeenCalled()
	})

	it("retries server startup in a new session", async () => {
		const { dir, ext, consoleSpy } = makeSession()
		const toolResult = ext.getHandler("tool_result") as RawHandler

		await (ext.getHandler("session_start") as RawHandler)(null, createContext({ cwd: dir }))
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		expect(consoleSpy).toHaveBeenCalledTimes(1)

		// session_start resets the failure cache — a new session retries once.
		await (ext.getHandler("session_start") as RawHandler)(null, createContext({ cwd: dir }))
		await toolResult(editToolResult("foo.ts"), createContext({ cwd: dir }))
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(2)
		expect(consoleSpy).toHaveBeenCalledTimes(2)
	})

	it("lsp tools fail with an actionable message instead of respawning", async () => {
		const { dir, ext } = makeSession()
		const sessionCtx = createContext({ cwd: dir })
		await (ext.getHandler("session_start") as RawHandler)(null, sessionCtx)

		const diagnosticTool = ext.getRegisteredTool("lsp_diagnostics")
		const filePath = path.join(dir, "foo.ts")
		const args = [filePath] as const

		// First call propagates the real server error (agent-readable).
		await expect(
			diagnosticTool.execute(
				"call-1",
				{ file_path: args[0] },
				undefined as never,
				undefined as never,
				sessionCtx as never,
			),
		).rejects.toThrow(INIT_FAILURE)
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)

		// Second call short-circuits with the actionable session-scoped message.
		await expect(
			diagnosticTool.execute(
				"call-2",
				{ file_path: args[0] },
				undefined as never,
				undefined as never,
				sessionCtx as never,
			),
		).rejects.toThrow(/failed to start for this session/)
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
	})
})
