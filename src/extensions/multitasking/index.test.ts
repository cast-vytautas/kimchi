import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent")
	return {
		...(actual as object),
		SessionManager: {
			list: vi.fn(),
			open: vi.fn(),
		},
	}
})

// ─── Mock helpers ────────────────────────────────────────────────────────────

interface MockCommand {
	description: string
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void
}

interface MockPI {
	_handlers: Record<string, (event: unknown, ctx?: ExtensionContext) => unknown>
	_commands: Record<string, MockCommand>
	on: (event: string, handler: (e: unknown, ctx?: ExtensionContext) => unknown) => void
	registerCommand: (name: string, opts: MockCommand) => void
	getFlag: (name: string) => unknown
}

function makeMockPI(): MockPI {
	const handlers: Record<string, (event: unknown, ctx?: ExtensionContext) => unknown> = {}
	const commands: Record<string, MockCommand> = {}
	return {
		_handlers: handlers,
		_commands: commands,
		on(event: string, handler: (e: unknown, ctx?: ExtensionContext) => unknown) {
			handlers[event] = handler
		},
		registerCommand(name: string, opts: MockCommand) {
			commands[name] = opts
		},
		getFlag: () => undefined,
	}
}

interface MockCtxData {
	_inputListeners: Array<(data: string) => unknown>
	_widgets: Map<string, unknown>
}

function makeMockCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext & MockCtxData {
	const inputListeners: Array<(data: string) => unknown> = []
	const widgets: Map<string, unknown> = new Map()
	return {
		cwd: "/tmp",
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		ui: {
			getEditorComponent: vi.fn(() => undefined),
			setEditorComponent: vi.fn(),
			setWidget: vi.fn((key: string, content: unknown) => {
				if (content === undefined) widgets.delete(key)
				else widgets.set(key, content)
			}),
			onTerminalInput: vi.fn((handler: (data: string) => unknown) => {
				inputListeners.push(handler)
				return () => {
					const idx = inputListeners.indexOf(handler)
					if (idx >= 0) inputListeners.splice(idx, 1)
				}
			}),
			notify: vi.fn(),
			getEditorText: vi.fn(() => ""),
			theme: { fg: vi.fn((_color: string, text: string) => text) },
		},
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => "/tmp/session.md",
		},
		_inputListeners: inputListeners,
		_widgets: widgets,
		...overrides,
	} as unknown as ExtensionContext & MockCtxData
}

function makeMockCommandCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext & MockCtxData {
	const ctx = makeMockCtx(overrides)
	return {
		...ctx,
		switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
	} as unknown as ExtensionContext & MockCtxData
}

async function triggerSessionStart(pi: MockPI, ctx: ExtensionContext): Promise<void> {
	await pi._handlers.session_start?.({ reason: "startup" }, ctx)
}

async function triggerSessionShutdown(pi: MockPI, ctx: ExtensionContext): Promise<void> {
	await pi._handlers.session_shutdown?.({}, ctx)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("multitasking extension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("registration", () => {
		it("registers /sessions command", async () => {
			const mockPI = makeMockPI()
			const { default: multitaskingExtension } = await import("./index.js")
			multitaskingExtension(mockPI as unknown as ExtensionAPI)
			expect(mockPI._commands.sessions).toBeDefined()
			expect(mockPI._commands.sessions.description).toBeTruthy()
		})

		it("registers session_start and session_shutdown handlers", async () => {
			const mockPI = makeMockPI()
			const { default: multitaskingExtension } = await import("./index.js")
			multitaskingExtension(mockPI as unknown as ExtensionAPI)
			expect(mockPI._handlers.session_start).toBeDefined()
			expect(mockPI._handlers.session_shutdown).toBeDefined()
		})
	})

	describe("left-arrow listener", () => {
		it("opens picker on left-arrow when idle, editor empty, no overlay", async () => {
			const mockPI = makeMockPI()
			const { default: multitaskingExtension } = await import("./index.js")
			multitaskingExtension(mockPI as unknown as ExtensionAPI)

			const ctx = makeMockCtx()
			await triggerSessionStart(mockPI, ctx)

			expect(ctx._inputListeners.length).toBeGreaterThan(0)

			// Simulate left-arrow key (ESC [ D)
			const result = ctx._inputListeners[0]("\x1b[D")
			expect(result).toEqual({ consume: true })

			expect(ctx._widgets.has("kimchi-session-picker")).toBe(true)
		})

		it("does not open when editor has text", async () => {
			const mockPI = makeMockPI()
			const { default: multitaskingExtension } = await import("./index.js")
			multitaskingExtension(mockPI as unknown as ExtensionAPI)

			const ctx = makeMockCtx()
			// Override getEditorText to return non-empty string
			vi.mocked(ctx.ui.getEditorText).mockReturnValue("some text here")
			await triggerSessionStart(mockPI, ctx)

			const result = ctx._inputListeners[0]("\x1b[D")
			expect(result).toBeUndefined()
			expect(ctx._widgets.has("kimchi-session-picker")).toBe(false)
		})

		it("does not open when agent is not idle", async () => {
			const mockPI = makeMockPI()
			const { default: multitaskingExtension } = await import("./index.js")
			multitaskingExtension(mockPI as unknown as ExtensionAPI)

			const ctx = makeMockCtx({ isIdle: () => false })
			await triggerSessionStart(mockPI, ctx)

			const result = ctx._inputListeners[0]("\x1b[D")
			expect(result).toBeUndefined()
			expect(ctx._widgets.has("kimchi-session-picker")).toBe(false)
		})

		it("does not register listener when hasUI is false", async () => {
			const mockPI = makeMockPI()
			const { default: multitaskingExtension } = await import("./index.js")
			multitaskingExtension(mockPI as unknown as ExtensionAPI)

			const ctx = makeMockCtx({ hasUI: false })
			await triggerSessionStart(mockPI, ctx)

			expect(ctx._inputListeners.length).toBe(0)
		})
	})

	describe("/sessions command", () => {
		it("opens picker and captures command context for switchSession", async () => {
			const mockPI = makeMockPI()
			const { default: multitaskingExtension } = await import("./index.js")
			multitaskingExtension(mockPI as unknown as ExtensionAPI)

			const ctx = makeMockCommandCtx()
			await mockPI._commands.sessions.handler("", ctx)

			expect(ctx._widgets.has("kimchi-session-picker")).toBe(true)
		})
	})

	describe("session_shutdown cleanup", () => {
		it("cleans up listeners on shutdown", async () => {
			const mockPI = makeMockPI()
			const { default: multitaskingExtension } = await import("./index.js")
			multitaskingExtension(mockPI as unknown as ExtensionAPI)

			const ctx = makeMockCtx()
			await triggerSessionStart(mockPI, ctx)
			expect(ctx._inputListeners.length).toBeGreaterThan(0)

			await triggerSessionShutdown(mockPI, ctx)
			expect(ctx._inputListeners.length).toBe(0)
		})
	})
})
