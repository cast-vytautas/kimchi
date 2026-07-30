import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { claimRawInputCapture } from "../shared-input.js"
import { multitaskingExtension } from "./index.js"

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LEFT_ARROW = "\x1b[D"
const UP_ARROW = "\x1b[A"
const DOWN_ARROW = "\x1b[B"
const ENTER = "\r"

type InputHandler = (data: string) => { consume?: boolean } | undefined

interface Controls {
	hasUI: boolean
	idle: boolean
	editorText: string
	hasOverlay: boolean
}

interface Fixture {
	api: ExtensionAPI
	sessionStart: (ctx: ExtensionContext) => void
	terminalInput: () => InputHandler | undefined
	commands: Map<string, (args: string, ctx: unknown) => Promise<void>>
	controls: Controls
	/** Whether the picker (not the session-start shim) is currently mounted. */
	pickerOpen: () => boolean
	/** Mock of setEditorComponent calls — used to detect editor swap. */
	setEditorComponent: ReturnType<typeof vi.fn>
	/** Build a fresh ExtensionContext reading the fixture's controls live. */
	makeCtx: () => ExtensionContext
	/** Mock for commandCtx.newSession */
	newSessionMock: ReturnType<typeof vi.fn>
	/** Mock for pi.sendUserMessage */
	sendUserMessageMock: ReturnType<typeof vi.fn>
	/** Invoke the /sessions command to capture a command context. */
	invokeSessionsCommand: () => Promise<void>
}

function makeFixture(): Fixture {
	const eventHandlers: Record<string, ((event: unknown, ctx: ExtensionContext) => void) | undefined> = {}
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()

	const controls: Controls = {
		hasUI: true,
		idle: true,
		editorText: "",
		hasOverlay: false,
	}

	// The session_start shim and the openPicker both mount a widget under the
	// same key, so counting setWidget(key, non-undefined) calls would conflate
	// them. Instead, the picker uniquely swaps the editor via setEditorComponent,
	// so we treat an editor swap as the unambiguous "picker opened" signal.
	let editorSwapped = false
	const setEditorComponent = vi.fn((factory: unknown) => {
		// The extension calls setEditorComponent(() => NO_OP_EDITOR) to swap,
		// and setEditorComponent(prevEditorFactory) to restore.
		// A function factory means the picker is active; undefined means restored.
		if (typeof factory === "function") {
			editorSwapped = true
		} else {
			editorSwapped = false
		}
	})

	// Tracks how many times the picker widget factory (vs. the shim) was mounted,
	// so tests can assert the picker specifically was mounted.
	let pickerFactoryMounts = 0

	let terminalInput: InputHandler | undefined

	const fakeTui = {
		hasOverlay: () => controls.hasOverlay,
		requestRender: () => {},
	}

	const newSessionMock = vi.fn().mockResolvedValue({ cancelled: false })
	const sendUserMessageMock = vi.fn()

	const api = {
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			eventHandlers[event] = handler
		}),
		registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, options.handler)
		}),
		sendUserMessage: sendUserMessageMock,
	} as unknown as ExtensionAPI

	multitaskingExtension(api)

	const makeCtx = (): ExtensionContext =>
		({
			hasUI: controls.hasUI,
			mode: "tui",
			cwd: "/cwd",
			isIdle: () => controls.idle,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
			sessionManager: {
				getCwd: () => "/cwd",
				getSessionDir: () => undefined,
				getSessionId: () => "current-session-id",
				getSessionFile: () => "/cwd/.kimchi/sessions/current.jsonl",
				getLeafId: () => "leaf-1",
			},
			modelRegistry: {} as never,
			model: undefined,
			ui: {
				// Mounting a widget factory invokes it with (tui, theme) so the
				// extension captures the tui ref — mirroring how pi mounts widgets.
				setWidget: vi.fn((_key: string, content: unknown) => {
					if (content === undefined) return
					if (typeof content === "function") {
						// Distinguish the picker factory from the shim: only the picker
						// factory returns a SessionPickerComponent (with setSessions).
						const instance = (content as (tui: unknown, theme: unknown) => unknown)(fakeTui, {})
						if (instance && typeof (instance as { setSessions?: unknown }).setSessions === "function") {
							pickerFactoryMounts++
						}
					}
				}),
				notify: vi.fn(),
				getEditorText: () => controls.editorText,
				getEditorComponent: () => undefined,
				setEditorComponent,
				onTerminalInput: vi.fn((handler: InputHandler) => {
					terminalInput = handler
					return () => {
						terminalInput = undefined
					}
				}),
			},
		}) as unknown as ExtensionContext

	const invokeSessionsCommand = async () => {
		const handler = commands.get("sessions")
		if (!handler) throw new Error("sessions command not registered")
		// Build a command context that includes newSession
		const cmdCtx = {
			...makeCtx(),
			newSession: newSessionMock,
		} as unknown as ExtensionCommandContext
		await handler("", cmdCtx)
	}

	return {
		api,
		sessionStart: (ctx: ExtensionContext) => eventHandlers.session_start?.({ type: "session_start" }, ctx),
		terminalInput: () => terminalInput,
		commands,
		controls,
		pickerOpen: () => pickerFactoryMounts > 0 && editorSwapped,
		setEditorComponent,
		makeCtx,
		newSessionMock,
		sendUserMessageMock,
		invokeSessionsCommand,
	}
}

/** Start a session in the given fixture and return the captured input handler. */
function start(f: Fixture): InputHandler {
	f.sessionStart(f.makeCtx())
	const handler = f.terminalInput()
	if (!handler) throw new Error("terminal input listener was not registered")
	return handler
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("multitaskingExtension lifecycle", () => {
	it("registers a /sessions command", () => {
		const { commands } = makeFixture()
		expect(commands.has("sessions")).toBe(true)
	})

	it("opens the picker on left-arrow when all conditions are valid", () => {
		const f = makeFixture()
		const handler = start(f)

		const result = handler(LEFT_ARROW)

		expect(f.pickerOpen()).toBe(true)
		expect(result).toEqual({ consume: true })
	})

	it("does NOT open when the agent is streaming (not idle)", () => {
		const f = makeFixture()
		f.controls.idle = false
		const handler = start(f)

		const result = handler(LEFT_ARROW)

		expect(f.pickerOpen()).toBe(false)
		expect(result).toBeUndefined()
	})

	it("does NOT open when the editor is non-empty", () => {
		const f = makeFixture()
		f.controls.editorText = "half-typed message"
		const handler = start(f)

		const result = handler(LEFT_ARROW)

		expect(f.pickerOpen()).toBe(false)
		expect(result).toBeUndefined()
	})

	it("does NOT open when an overlay is active", () => {
		const f = makeFixture()
		f.controls.hasOverlay = true
		const handler = start(f)

		const result = handler(LEFT_ARROW)

		expect(f.pickerOpen()).toBe(false)
		expect(result).toBeUndefined()
	})

	it("does NOT open when there is no UI (hasUI false)", () => {
		const f = makeFixture()
		f.controls.hasUI = false
		const handler = start(f)

		const result = handler(LEFT_ARROW)

		expect(f.pickerOpen()).toBe(false)
		expect(result).toBeUndefined()
	})

	it("does NOT open when raw input capture is active", () => {
		const f = makeFixture()
		const handler = start(f)

		const release = claimRawInputCapture()
		try {
			const result = handler(LEFT_ARROW)
			expect(f.pickerOpen()).toBe(false)
			expect(result).toBeUndefined()
		} finally {
			release()
		}
	})

	it("does not consume non-left-arrow input when the picker is closed", () => {
		const f = makeFixture()
		const handler = start(f)

		const result = handler("a")

		expect(result).toBeUndefined()
		expect(f.pickerOpen()).toBe(false)
	})
})

// ─── Typing & new-session tests ──────────────────────────────────────────────

describe("typing and new session creation", () => {
	it("typing does not interfere with session list navigation (arrow keys still work)", () => {
		const f = makeFixture()
		const handler = start(f)

		// Open the picker
		handler(LEFT_ARROW)
		expect(f.pickerOpen()).toBe(true)

		// Type some text
		handler("h")
		handler("i")

		// Navigate with arrow keys — should still work and consume input
		const downResult = handler(DOWN_ARROW)
		expect(downResult).toEqual({ consume: true })
		const upResult = handler(UP_ARROW)
		expect(upResult).toEqual({ consume: true })

		// Picker should still be open
		expect(f.pickerOpen()).toBe(true)
	})

	it("creates a new session with the typed message when Enter is pressed", async () => {
		const f = makeFixture()
		const handler = start(f)

		// Capture command context via /sessions command
		await f.invokeSessionsCommand()
		expect(f.pickerOpen()).toBe(true)

		// Type a message
		handler("f")
		handler("i")
		handler("x")

		// Press Enter
		handler(ENTER)

		// Wait for microtasks (newSession is async)
		await vi.waitFor(() => {
			expect(f.newSessionMock).toHaveBeenCalledTimes(1)
		})

		// sendUserMessage should be called with the typed text
		expect(f.sendUserMessageMock).toHaveBeenCalledTimes(1)
		expect(f.sendUserMessageMock).toHaveBeenCalledWith("fix")
	})

	it("creates a new session without sending a message when text is empty", async () => {
		const f = makeFixture()
		const handler = start(f)

		await f.invokeSessionsCommand()
		expect(f.pickerOpen()).toBe(true)

		// Navigate to "New session" entry (bottom of list).
		// With no sessions loaded (loading state), the only entry is "New session" at index 0.
		// Press Enter without typing anything
		handler(ENTER)

		await vi.waitFor(() => {
			expect(f.newSessionMock).toHaveBeenCalledTimes(1)
		})

		// sendUserMessage should NOT be called (empty text)
		expect(f.sendUserMessageMock).not.toHaveBeenCalled()
	})

	it("picker is dismissed after creating a new session", async () => {
		const f = makeFixture()
		const handler = start(f)

		await f.invokeSessionsCommand()
		expect(f.pickerOpen()).toBe(true)

		handler("h")
		handler("i")
		handler(ENTER)

		// Picker should be closed immediately (closePicker is called before async newSession)
		expect(f.pickerOpen()).toBe(false)
	})
})
