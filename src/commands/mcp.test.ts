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
	vi.spyOn(process.stdout, "write").mockImplementation(
		// process.stdout.write is overloaded: (chunk, cb?) or (chunk, encoding?, cb?).
		// Accept both shapes so the mock satisfies the union type.
		(
			chunk: string | Uint8Array,
			encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
			cb?: (err?: Error | null) => void,
		) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
			const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb
			// Node's write callback is asynchronous — defer it so the emitResult
			// promise that awaits it resolves on the next tick, mirroring real I/O.
			if (callback) process.nextTick(() => callback(null))
			return true
		},
	)
	return {
		get data() {
			return writes.join("")
		},
		get json() {
			return JSON.parse(writes.join(""))
		},
	}
}

const SERVER_NAME = "my-server"
const STDIO_SERVER = { command: "node", args: ["server.js"] }
const URL_SERVER = { url: "https://example.com/mcp" }
const OAUTH_SERVER = { url: "https://example.com/mcp", auth: "oauth" as const }

/** Wrap a server entry in the { name, server } stdin contract. */
function probeInput(
	server: typeof STDIO_SERVER | typeof URL_SERVER | typeof OAUTH_SERVER | Record<string, unknown>,
	name = SERVER_NAME,
): string {
	return JSON.stringify({ name, server })
}

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

	it("returns 1 and emits JSON error on stdout when --json flag is missing", async () => {
		const out = captureStdout()
		const code = await runMcp(["probe"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("--json")
	})

	it("returns 1 when server config has neither command nor url", async () => {
		mockStdin(probeInput({}))
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
	})

	it("returns 1 when input is missing the 'name' field", async () => {
		mockStdin(JSON.stringify({ server: STDIO_SERVER }))
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
		mockStdin(probeInput(STDIO_SERVER))
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
		expect(mockProbeTools).toHaveBeenCalledWith(STDIO_SERVER, SERVER_NAME)
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})

	// --- needsAuth without OAuth (returns needsAuth: true) ----------------

	it("returns needsAuth: true when server needs auth but OAuth is not supported", async () => {
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: true })
		mockSupportsOAuth.mockReturnValue(false)
		mockStdin(probeInput(URL_SERVER))
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

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(mockAuthenticate).toHaveBeenCalledTimes(1)
		expect(mockAuthenticate).toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER.url, OAUTH_SERVER)
		expect(mockProbeTools).toHaveBeenCalledTimes(2)
		expect(mockProbeTools).toHaveBeenNthCalledWith(1, OAUTH_SERVER, SERVER_NAME)
		expect(mockProbeTools).toHaveBeenNthCalledWith(2, OAUTH_SERVER, SERVER_NAME)
		expect(out.json).toEqual({
			tools: [{ name: "secure_tool", title: undefined, description: undefined }],
			needsAuth: false,
			error: null,
		})
	})

	// --- repeat probe: tokens already exist, OAuth is skipped -------------

	it("skips OAuth when the first probe returns tools (tokens already exist)", async () => {
		mockSupportsOAuth.mockReturnValue(true)
		// First probe returns tools directly — stored tokens were found.
		mockProbeTools.mockResolvedValue({
			tools: [{ name: "secure_tool" }],
			needsAuth: false,
		})

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(mockProbeTools).toHaveBeenCalledTimes(1)
		expect(mockProbeTools).toHaveBeenCalledWith(OAUTH_SERVER, SERVER_NAME)
		expect(mockAuthenticate).not.toHaveBeenCalled()
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

		mockStdin(probeInput(OAUTH_SERVER))
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

			mockStdin(probeInput(OAUTH_SERVER))
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
		mockStdin(probeInput(STDIO_SERVER))
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
		mockStdin(probeInput(STDIO_SERVER))

		await runMcp(["probe", "--json"])
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})

	// --- stdout flush ------------------------------------------------------

	it("awaits the stdout write callback before resolving (large payload >64KB is not truncated)", async () => {
		// A payload larger than the ~64KB pipe buffer: backpressure could cause
		// process.exit() to fire before the write drains if emitResult didn't
		// wait for the write callback. Here we verify the promise only resolves
		// after the callback fires and that the full payload is captured.
		const bigDescription = "x".repeat(80_000)
		mockProbeTools.mockResolvedValue({
			tools: [{ name: "big_tool", description: bigDescription }],
			needsAuth: false,
		})

		let writeCallbackCalled = false
		vi.spyOn(process.stdout, "write").mockImplementation(
			(
				_chunk: string | Uint8Array,
				encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
				cb?: (err?: Error | null) => void,
			) => {
				process.nextTick(() => {
					writeCallbackCalled = true
					const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb
					callback?.(null)
				})
				return true
			},
		)

		mockStdin(probeInput(STDIO_SERVER))
		const code = await runMcp(["probe", "--json"])

		expect(code).toBe(0)
		expect(writeCallbackCalled).toBe(true)
	})
})
