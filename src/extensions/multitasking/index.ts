import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { Key, matchesKey } from "@earendil-works/pi-tui"
import { NoOpPickerEditor } from "../onboarding/picker-editor.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { SessionPickerComponent } from "./session-picker-component.js"
import { initialPickerState, type PickerEffect, type PickerState, type SessionInfo } from "./session-picker-reducer.js"

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSION_PICKER_WIDGET_KEY = "kimchi-session-picker"
const SESSION_PICKER_WIDGET_OPTIONS = { placement: "aboveEditor" } as const

const NO_OP_EDITOR = new NoOpPickerEditor()

// ─── Extension factory ───────────────────────────────────────────────────────

export const multitaskingExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	let currentCtx: ExtensionContext | null = null
	let commandCtx: ExtensionCommandContext | null = null

	let pickerActive = false
	let unsubscribeInput: (() => void) | undefined
	let tuiRef: { hasOverlay(): boolean } | null = null
	let component: SessionPickerComponent | undefined
	let pickerState: PickerState = initialPickerState()
	let prevEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]> | undefined
	let editorSwapped = false

	const onPickerStateChange = (next: PickerState): void => {
		pickerState = next
	}

	// ─── Session loading ───────────────────────────────────────────────────

	async function loadSessions(ctx: ExtensionContext): Promise<void> {
		if (!component) return
		const cwd = ctx.cwd
		try {
			const sessions = await SessionManager.list(cwd)
			// Map upstream SessionInfo to our local SessionInfo type
			const mapped: SessionInfo[] = sessions.map((s) => ({
				id: s.id,
				name: s.name ?? "",
				modified: s.modified,
				messageCount: s.messageCount,
				firstMessage: s.firstMessage,
				sessionPath: s.path,
			}))
			component.setSessions(mapped)
		} catch (err) {
			ctx.ui.notify(`Could not load sessions: ${err instanceof Error ? err.message : String(err)}`, "warning")
			// Set empty sessions to stop loading state
			component?.setSessions([])
		}
	}

	// ─── Picker lifecycle ─────────────────────────────────────────────────

	const canOpenPicker = (ctx: ExtensionContext): boolean => {
		if (!ctx.hasUI) return false
		if (!ctx.isIdle()) return false
		if (ctx.ui.getEditorText().trim() !== "") return false
		if (isRawInputCaptureActive()) return false
		if (!tuiRef) return false
		if (typeof tuiRef.hasOverlay === "function" && tuiRef.hasOverlay()) return false
		return true
	}

	const openPicker = (): void => {
		if (pickerActive || !currentCtx) return
		pickerActive = true

		pickerState = initialPickerState(currentCtx.sessionManager.getSessionId())

		// Mount the picker widget
		currentCtx.ui.setWidget(
			SESSION_PICKER_WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui as unknown as { hasOverlay(): boolean }
				component = new SessionPickerComponent(
					theme,
					(effect: PickerEffect) => handleEffect(effect),
					() => tui.requestRender(),
					{ initialState: pickerState, onStateChange: onPickerStateChange },
				)
				return component
			},
			SESSION_PICKER_WIDGET_OPTIONS,
		)

		// Swap editor to no-op
		prevEditorFactory = currentCtx.ui.getEditorComponent()
		editorSwapped = true
		currentCtx.ui.setEditorComponent(() => NO_OP_EDITOR)

		// Load sessions asynchronously
		loadSessions(currentCtx)
	}

	const closePicker = (): void => {
		if (!pickerActive) return
		pickerActive = false

		currentCtx?.ui.setWidget(SESSION_PICKER_WIDGET_KEY, undefined, SESSION_PICKER_WIDGET_OPTIONS)

		if (editorSwapped && currentCtx) {
			currentCtx.ui.setEditorComponent(prevEditorFactory)
			editorSwapped = false
		}

		component = undefined
	}

	const handleEffect = (effect: PickerEffect): void => {
		switch (effect.type) {
			case "switch-session": {
				const path = effect.sessionPath
				closePicker()
				if (commandCtx) {
					commandCtx.switchSession(path).catch((err: unknown) => {
						currentCtx?.ui.notify(
							`Could not switch session: ${err instanceof Error ? err.message : String(err)}`,
							"warning",
						)
					})
				} else if (currentCtx) {
					currentCtx.ui.notify("Session switching is not available in this context.", "warning")
				}
				break
			}
			case "new-session": {
				// Ticket 02: create a new session with the typed text as first message.
				// For ticket 01, just dismiss.
				closePicker()
				break
			}
			case "dismiss": {
				closePicker()
				break
			}
			case "none":
				break
		}
	}

	// ─── Terminal input handler ──────────────────────────────────────────

	const onTerminalInput = (data: string): { consume?: boolean } | undefined => {
		// When picker is closed, watch for left arrow to open it
		if (!pickerActive) {
			if (matchesKey(data, Key.left) && currentCtx) {
				if (canOpenPicker(currentCtx)) {
					openPicker()
					return { consume: true }
				}
			}
			return undefined
		}

		// When picker is open, route all input to the component
		// Left arrow also dismisses (toggle behaviour)
		if (matchesKey(data, Key.left)) {
			closePicker()
			return { consume: true }
		}

		// Route to component
		component?.handleInput(data)
		return { consume: true }
	}

	// ─── Event handlers ──────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		// Clean up any previous picker state
		closePicker()
		currentCtx = ctx

		// Mount a shim widget to capture the tui reference before the picker opens.
		// This follows the same pattern as session-mode.ts: mount a shim, capture
		// the tui ref, then the input listener can check hasOverlay().
		ctx.ui.setWidget(
			SESSION_PICKER_WIDGET_KEY,
			(tui) => {
				tuiRef = tui as unknown as { hasOverlay(): boolean }
				return { render: () => [], invalidate: () => {} }
			},
			SESSION_PICKER_WIDGET_OPTIONS,
		)

		// Register terminal input listener for this session
		unsubscribeInput?.()
		unsubscribeInput = ctx.ui.onTerminalInput(onTerminalInput)
	})

	pi.on("session_shutdown", () => {
		closePicker()
		unsubscribeInput?.()
		unsubscribeInput = undefined
		currentCtx = null
		commandCtx = null
		tuiRef = null
	})

	// Register a /sessions command to open the picker from the slash menu
	pi.registerCommand("sessions", {
		description: "Open the session picker to switch sessions",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			commandCtx = ctx
			currentCtx = ctx
			// Remove the shim widget if it's still up, then open the picker directly
			ctx.ui.setWidget(SESSION_PICKER_WIDGET_KEY, undefined, SESSION_PICKER_WIDGET_OPTIONS)
			openPicker()
		},
	})
}

export default multitaskingExtension
