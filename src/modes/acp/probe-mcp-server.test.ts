import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { McpServerManager } from "../../extensions/mcp-adapter/server-manager.js"
import type { ProbeResult, ServerEntry } from "../../extensions/mcp-adapter/types.js"
import { AVAILABLE_METHODS } from "./capabilities.js"
import { type AcpSessionFactory, KimchiAcpAgent } from "./server.js"

// Minimal fake — we only need sessionId/subscribe/dispose/prompt/abort for the
// ACP agent to accept a session. The probeMcpServer extMethod doesn't touch
// the session at all.
class FakeAgentSession {
	sessionId: string
	disposed = false
	model = { provider: "test", id: "test-model" }
	modelRegistry = { getAvailable: () => [{ provider: "test", id: "test-model", name: "Test" }] }
	sessionManager = { getBranch: () => [] }
	bindExtensionsImpl: ((opts: unknown) => Promise<void>) | null = null

	constructor(id: string) {
		this.sessionId = id
	}

	subscribe = () => () => {}
	async bindExtensions(opts: unknown): Promise<void> {
		if (this.bindExtensionsImpl) await this.bindExtensionsImpl(opts)
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<void> {}
	dispose(): void {
		this.disposed = true
	}
	extensionRunner = { emit: async () => {} }
}

function asSession(fake: FakeAgentSession): AgentSession {
	return fake as unknown as AgentSession
}

function makeConn(): AgentSideConnection {
	const stub = {
		sessionUpdate: async (_p: SessionNotification) => {},
	}
	return stub as unknown as AgentSideConnection
}

function makeFakeMcpServerManager(probeResult: ProbeResult): McpServerManager {
	return {
		probeTools: vi.fn().mockResolvedValue(probeResult),
	} as unknown as McpServerManager
}

function makeAgent(mcpServerManager?: McpServerManager): KimchiAcpAgent {
	const fake = new FakeAgentSession("probe-test-session")
	const sessionFactory: AcpSessionFactory = async () => asSession(fake)
	return new KimchiAcpAgent(makeConn(), {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory,
		mcpServerManager,
	})
}

describe("KimchiAcpAgent extMethod probeMcpServer", () => {
	it("routes _kimchi.dev/probeMcpServer to mcpServerManager.probeTools", async () => {
		const serverEntry: ServerEntry = { command: "echo", args: ["test"] }
		const probeResult: ProbeResult = {
			tools: [
				{ name: "tool_a", description: "Does A" },
				{ name: "tool_b", description: "Does B" },
			],
			needsAuth: false,
			error: null,
		}
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)

		const result = await agent.extMethod(AVAILABLE_METHODS.probeMcpServer, {
			server: serverEntry,
			serverName: "test-server",
		})

		expect(result).toEqual(probeResult)
		expect(manager.probeTools).toHaveBeenCalledWith("test-server", serverEntry)
	})

	it("returns tools array, needsAuth flag, and error string", async () => {
		const serverEntry: ServerEntry = { command: "echo", args: [] }
		const probeResult: ProbeResult = {
			tools: [{ name: "tool_x" }],
			needsAuth: true,
			error: null,
		}
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)

		const result = (await agent.extMethod(AVAILABLE_METHODS.probeMcpServer, {
			server: serverEntry,
		})) as unknown as ProbeResult

		expect(result.tools).toHaveLength(1)
		expect(result.tools[0].name).toBe("tool_x")
		expect(result.needsAuth).toBe(true)
		expect(result.error).toBeNull()
	})

	it("passes through error from probeTools", async () => {
		const serverEntry: ServerEntry = { command: "nonexistent-binary" }
		const probeResult: ProbeResult = {
			tools: [],
			needsAuth: false,
			error: "spawn nonexistent-binary ENOENT",
		}
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)

		const result = (await agent.extMethod(AVAILABLE_METHODS.probeMcpServer, {
			server: serverEntry,
		})) as unknown as ProbeResult

		expect(result.tools).toEqual([])
		expect(result.needsAuth).toBe(false)
		expect(result.error).toBe("spawn nonexistent-binary ENOENT")
	})

	it("throws methodNotFound for unknown extMethod", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(agent.extMethod("_kimchi.dev/unknown", {})).rejects.toMatchObject({ code: -32601 })
	})

	it("throws invalidParams when server parameter is missing", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(agent.extMethod(AVAILABLE_METHODS.probeMcpServer, {})).rejects.toMatchObject({ code: -32602 })
	})

	it("throws invalidParams when mcpServerManager is not configured", async () => {
		// No mcpServerManager injected — simulates a misconfigured agent
		const fake = new FakeAgentSession("no-mgr-session")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})
		await expect(
			agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: { command: "echo" } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("defaults serverName to 'probe' when not provided", async () => {
		const serverEntry: ServerEntry = { command: "echo", args: [] }
		const probeResult: ProbeResult = { tools: [], needsAuth: false, error: null }
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)

		await agent.extMethod(AVAILABLE_METHODS.probeMcpServer, {
			server: serverEntry,
		})

		expect(manager.probeTools).toHaveBeenCalledWith("probe", serverEntry)
	})
})

describe("KimchiAcpAgent extMethod probeMcpServer validation", () => {
	it("rejects non-object server param", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: "not-an-object" })).rejects.toMatchObject({
			code: -32602,
		})
		await expect(agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: null })).rejects.toMatchObject({
			code: -32602,
		})
		await expect(agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: [] })).rejects.toMatchObject({
			code: -32602,
		})
	})

	it("rejects server without command or url", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: {} })).rejects.toMatchObject({
			code: -32602,
		})
	})

	it("rejects non-string command", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: { command: 123 } })).rejects.toMatchObject(
			{ code: -32602 },
		)
	})

	it("rejects non-array args", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(
			agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: { command: "echo", args: "not-array" } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects non-string elements in args", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(
			agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: { command: "echo", args: ["ok", 42] } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("rejects env with non-string values", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		await expect(
			agent.extMethod(AVAILABLE_METHODS.probeMcpServer, { server: { command: "echo", env: { KEY: 123 } } }),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("accepts a valid stdio server entry", async () => {
		const probeResult: ProbeResult = { tools: [{ name: "tool1" }], needsAuth: false, error: null }
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)
		const result = await agent.extMethod(AVAILABLE_METHODS.probeMcpServer, {
			server: { command: "echo", args: ["hello"], env: { FOO: "bar" } },
		})
		expect(result).toEqual(probeResult)
	})

	it("accepts a valid URL server entry", async () => {
		const probeResult: ProbeResult = { tools: [{ name: "tool1" }], needsAuth: false, error: null }
		const manager = makeFakeMcpServerManager(probeResult)
		const agent = makeAgent(manager)
		const result = await agent.extMethod(AVAILABLE_METHODS.probeMcpServer, {
			server: { url: "https://mcp.example.com/sse" },
		})
		expect(result).toEqual(probeResult)
	})
})

describe("probeMcpServer capability advertisement", () => {
	it("advertises probeMcpServer in initialize response", async () => {
		const agent = makeAgent(makeFakeMcpServerManager({ tools: [], needsAuth: false, error: null }))
		const response = await agent.initialize({ protocolVersion: 1 })
		const meta = response.agentCapabilities?._meta?.["kimchi.dev"] as Record<string, boolean> | undefined
		expect(meta?.probeMcpServer).toBe(true)
	})
})
