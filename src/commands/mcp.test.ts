import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — declared before imports that consume them
// ---------------------------------------------------------------------------

// Mock McpServerManager so we never spawn real subprocesses or HTTP connections.
const { mockProbeTools, mockCloseAll } = vi.hoisted(() => ({
	mockProbeTools: vi.fn(),
	mockCloseAll: vi.fn(),
}))

vi.mock("../extensions/mcp-adapter/server-manager.js", () => ({
	McpServerManager: class MockMcpServerManager {
		probeTools = mockProbeTools
		closeAll = mockCloseAll
	},
}))

// Mock the auth flow module — we control supportsOAuth and authenticate.
const { mockSupportsOAuth, mockAuthenticate } = vi.hoisted(() => ({
	mockSupportsOAuth: vi.fn(),
	mockAuthenticate: vi.fn(),
}))

vi.mock("../extensions/mcp-adapter/mcp-auth-flow.js", () => ({
	supportsOAuth: mockSupportsOAuth,
	authenticate: mockAuthenticate,
}))

import { runMcp } from "./mcp.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feed stdin data to process.stdin and emit 'end'. */
function mockStdin(data: string): void {
	const stdin = process.stdin as unknown as {
		setEncoding: (enc: string) => void
		emit: (event: string, ...args: unknown[]) => boolean
	}
	// Buffer the data, then emit 'data' and 'end' on next tick.
	process.nextTick(() => {
		stdin.emit("data", data)
		stdin.emit("end")
	})
}

/** Read and parse the JSON written to stdout. */
function captureStdout(): { data: string; json: Record<string, unknown> } {
	const writes: string[] = []
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
		return true
	})
	return {
		get data() {
			return writes.join("")
		},
		get json() {
			return JSON.parse(writes.join(""))
		},
	}
}

const STDIO_SERVER = { command: "node", args: ["server.js"] }
const URL_SERVER = { url: "https://example.com/mcp" }
const OAUTH_SERVER = { url: "https://example.com/mcp", auth: "oauth" as const }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kimchi mcp probe", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCloseAll.mockResolvedValue(undefined)
		mockSupportsOAuth.mockReturnValue(false)
		// Default: no pending auth
		mockAuthenticate.mockResolvedValue("authenticated")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// --- argument parsing -------------------------------------------------

	it("returns 1 and prints error for unknown subcommand", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const code = await runMcp(["bogus"])
		expect(code).toBe(1)
		expect(stderrSpy).toHaveBeenCalled()
	})

	it("returns 1 when --json flag is missing", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const code = await runMcp(["probe"])
		expect(code).toBe(1)
		expect(stderrSpy.mock.calls.flat().join("")).toContain("--json")
	})

	it("returns 1 when server config has neither command nor url", async () => {
		mockStdin(JSON.stringify({}))
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
	})

	// --- successful stdio probe -------------------------------------------

	it("connects, lists tools, and prints JSON for a stdio server", async () => {
		mockProbeTools.mockResolvedValue({
			tools: [
				{ name: "tool_a", title: "Tool A", description: "Does A" },
				{ name: "tool_b", description: "Does B" },
			],
			needsAuth: false,
		})
		mockStdin(JSON.stringify(STDIO_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json).toEqual({
			tools: [
				{ name: "tool_a", title: "Tool A", description: "Does A" },
				{ name: "tool_b", title: undefined, description: "Does B" },
			],
			needsAuth: false,
			error: null,
		})
		expect(mockProbeTools).toHaveBeenCalledTimes(1)
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})

	// --- needsAuth without OAuth (returns needsAuth: true) ----------------

	it("returns needsAuth: true when server needs auth but OAuth is not supported", async () => {
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: true })
		mockSupportsOAuth.mockReturnValue(false)
		mockStdin(JSON.stringify(URL_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json).toEqual({ tools: [], needsAuth: true, error: null })
		expect(mockAuthenticate).not.toHaveBeenCalled()
	})

	// --- OAuth flow: auth succeeds, retries probe --------------------------

	it("attempts OAuth flow and retries probe when needsAuth + OAuth supported", async () => {
		mockSupportsOAuth.mockReturnValue(true)
		mockAuthenticate.mockResolvedValue("authenticated")

		// First probe returns needsAuth, second probe (after auth) returns tools
		mockProbeTools
			.mockResolvedValueOnce({ tools: [], needsAuth: true })
			.mockResolvedValueOnce({ tools: [{ name: "secure_tool" }], needsAuth: false })

		mockStdin(JSON.stringify(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(mockAuthenticate).toHaveBeenCalledTimes(1)
		expect(mockAuthenticate).toHaveBeenCalledWith(
			expect.stringMatching(/^__probe_\d+$/),
			OAUTH_SERVER.url,
			OAUTH_SERVER,
		)
		expect(mockProbeTools).toHaveBeenCalledTimes(2)
		expect(out.json).toEqual({
			tools: [{ name: "secure_tool", title: undefined, description: undefined }],
			needsAuth: false,
			error: null,
		})
	})

	// --- OAuth flow: auth fails, returns needsAuth: true ------------------

	it("returns needsAuth: true when OAuth flow fails", async () => {
		mockSupportsOAuth.mockReturnValue(true)
		mockAuthenticate.mockRejectedValue(new Error("user denied"))

		// Auth fails immediately — no retry probe should happen.
		mockProbeTools.mockResolvedValueOnce({ tools: [], needsAuth: true })

		mockStdin(JSON.stringify(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(mockAuthenticate).toHaveBeenCalledTimes(1)
		expect(mockProbeTools).toHaveBeenCalledTimes(1)
		expect(out.json).toEqual({ tools: [], needsAuth: true, error: null })
	})

	// --- OAuth flow: auth times out, returns needsAuth: true --------------

	it("returns needsAuth: true when OAuth flow times out", async () => {
		vi.useFakeTimers()
		try {
			mockSupportsOAuth.mockReturnValue(true)
			// authenticate never resolves — simulates user walking away
			mockAuthenticate.mockReturnValue(new Promise(() => {}))
			mockProbeTools.mockResolvedValueOnce({ tools: [], needsAuth: true })

			mockStdin(JSON.stringify(OAUTH_SERVER))
			const out = captureStdout()

			const probePromise = runMcp(["probe", "--json"])
			// Advance past the 60s OAuth timeout
			await vi.advanceTimersByTimeAsync(60_000)
			const code = await probePromise

			expect(code).toBe(0)
			expect(out.json).toEqual({ tools: [], needsAuth: true, error: null })
		} finally {
			vi.useRealTimers()
		}
	})

	// --- error handling ---------------------------------------------------

	it("returns exit code 1 with error JSON when probe throws", async () => {
		mockProbeTools.mockRejectedValue(new Error("connection refused"))
		mockStdin(JSON.stringify(STDIO_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json).toEqual({
			tools: [],
			needsAuth: false,
			error: "connection refused",
		})
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})

	it("returns exit code 1 when stdin is not valid JSON", async () => {
		mockStdin("not json {{{")
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Failed to parse JSON")
	})

	// --- cleanup ----------------------------------------------------------

	it("always calls closeAll in the finally block", async () => {
		mockProbeTools.mockRejectedValue(new Error("boom"))
		mockStdin(JSON.stringify(STDIO_SERVER))

		await runMcp(["probe", "--json"])
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})
})
