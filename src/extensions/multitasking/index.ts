/**
 * Multitasking — Session Picker Extension
 *
 * Registers a terminal input listener for the left-arrow key. When pressed
 * (and conditions are met: ctx.hasUI, agent idle, editor empty, no overlay
 * active, no raw input capture active), opens a session picker overlay
 * showing all sessions sorted by last-modified.
 *
 * The picker is mounted via `setWidget` (aboveEditor), the editor is
 * swapped to a NoOpPickerEditor, and both are restored on cleanup.
 *
 * `switchSession` is only available on `ExtensionCommandContext` (from
 * command handlers), so the extension registers a `/sessions` slash command
 * that captures the command context. The left-arrow listener shares the
 * closure and uses the captured context for session switching. If the
 * command context hasn't been captured yet, Enter shows a notification.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { Key, isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import { NoOpPickerEditor } from "../onboarding/picker-editor.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { SessionPickerComponent } from "./session-picker-component.js"
import {
	type SessionPickerEffect,
	type SessionPickerState,
	buildItems,
	initialState,
} from "./session-picker-reducer.js"

type EditorFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>

const SESSION_PICKER_WIDGET_KEY = "kimchi-session-picker"
const SESSION_PICKER_WIDGET_OPTIONS = { placement: "aboveEditor" } as const

// Stateless editor — share a single instance across factory invocations.
const NO_OP_EDITOR = new NoOpPickerEditor()

export default function multitaskingExtension(pi: ExtensionAPI): void {
	let cleanupActivePicker: (() => void) | undefined
	let unsubscribeTerminalInput: (() => void) | undefined
	// Captured from the /sessions command handler. switchSession is only on
	// ExtensionCommandContext, not ExtensionContext.
	let commandCtx: ExtensionCommandContext | undefined
	let currentCtx: ExtensionContext | undefined
	let pickerState: SessionPickerState = initialState()

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx
		cleanupActivePicker?.()
		cleanupActivePicker = undefined

		if (!ctx.hasUI) return

		unsubscribeTerminalInput?.()
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			// Ignore key release events (Kitty keyboard protocol).
			if (isKeyRelease(data)) return undefined

			// Only react to left-arrow when the picker isn't already open.
			if (cleanupActivePicker) return undefined

			if (!matchesKey(data, Key.left)) return undefined

			// Defer to a foreground UI that is forwarding raw terminal input.
			if (isRawInputCaptureActive()) return undefined

			// Only open when: agent idle, editor empty, no overlay active.
			if (!ctx.isIdle()) return undefined
			if (ctx.ui.getEditorText().trim() !== "") return undefined

			// Check for active overlay via the tui reference.
			// We do this lazily by attempting to open; the activate() function
			// re-checks hasOverlay() before mounting.
			openPicker(ctx)

			return { consume: true }
		})
	})

	pi.on("session_shutdown", () => {
		cleanupActivePicker?.()
		cleanupActivePicker = undefined
		unsubscribeTerminalInput?.()
		unsubscribeTerminalInput = undefined
		currentCtx = undefined
	})

	// Register /sessions slash command — captures ExtensionCommandContext
	// and opens the picker. This is the primary entry point; the left-arrow
	// listener uses the captured context for switchSession.
	pi.registerCommand("sessions", {
		description: "Switch to a different session",
		handler: async (_args, ctx) => {
			commandCtx = ctx
			cleanupActivePicker?.()
			openPicker(ctx)
		},
	})

	function openPicker(ctx: ExtensionContext): void {
		if (cleanupActivePicker) return

		let finished = false
		let activated = false
		let unsubscribeInput: (() => void) | undefined
		let tuiRef: { hasOverlay(): boolean } | null = null
		let component: SessionPickerComponent | undefined
		let editorSwapped = false
		let prevEditorFactory: EditorFactory | undefined

		const onPickerStateChange = (next: SessionPickerState): void => {
			pickerState = next
		}

		// Empty shim component mounted before activation. Renders nothing so
		// the picker contributes zero visual footprint while we wait for any
		// overlay to clear.
		const SHIM_COMPONENT = { render: () => [], invalidate: () => {} } as const

		const activate = () => {
			if (activated || finished) return
			if (!tuiRef || (typeof tuiRef.hasOverlay === "function" && tuiRef.hasOverlay())) return
			activated = true

			ctx.ui.setWidget(
				SESSION_PICKER_WIDGET_KEY,
				(tui, theme) => {
					tuiRef = tui as unknown as { hasOverlay(): boolean }
					component = new SessionPickerComponent(theme, handleEffect, () => tui.requestRender(), {
						initialState: pickerState,
					})
					return component
				},
				SESSION_PICKER_WIDGET_OPTIONS,
			)
			prevEditorFactory = ctx.ui.getEditorComponent()
			editorSwapped = true
			ctx.ui.setEditorComponent(() => NO_OP_EDITOR)

			// Load sessions asynchronously after the picker is mounted.
			void loadSessions(ctx, component)
		}

		const cleanup = () => {
			unsubscribeInput?.()
			unsubscribeInput = undefined
			ctx.ui.setWidget(SESSION_PICKER_WIDGET_KEY, undefined, SESSION_PICKER_WIDGET_OPTIONS)
			if (editorSwapped) {
				ctx.ui.setEditorComponent(prevEditorFactory)
				editorSwapped = false
			}
			onCleanup()
		}

		const onCleanup = () => {
			if (finished) return
			finished = true
			cleanupActivePicker = undefined
		}

		const handleEffect = (effect: SessionPickerEffect) => {
			if (finished) return
			if (effect.kind === "switch-session") {
				finished = true
				cleanup()
				if (commandCtx) {
					void commandCtx.switchSession(effect.path)
				} else {
					ctx.ui.notify("Run /sessions first to enable session switching", "warning")
				}
			} else if (effect.kind === "dismiss") {
				cleanup()
			}
		}

		// Mount an invisible shim so we can capture the tui reference.
		ctx.ui.setWidget(
			SESSION_PICKER_WIDGET_KEY,
			(tui) => {
				tuiRef = tui as unknown as { hasOverlay(): boolean }
				queueMicrotask(activate)
				return SHIM_COMPONENT
			},
			SESSION_PICKER_WIDGET_OPTIONS,
		)

		// Also register a terminal input listener for when the picker is active,
		// so arrow keys, enter, and escape are consumed by the picker.
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!activated || finished) return undefined
			const overlayUp = typeof tuiRef?.hasOverlay === "function" ? tuiRef.hasOverlay() : false
			if (overlayUp) return undefined

			if (
				matchesKey(data, Key.up) ||
				matchesKey(data, Key.down) ||
				matchesKey(data, Key.enter) ||
				matchesKey(data, Key.escape)
			) {
				component?.handleInput(data)
				return { consume: true }
			}
			return undefined
		})

		cleanupActivePicker = () => {
			if (finished) return
			finished = true
			cleanup()
		}
	}
}

async function loadSessions(ctx: ExtensionContext, component: SessionPickerComponent | undefined): Promise<void> {
	if (!component) return
	try {
		const sessions = await SessionManager.list(ctx.cwd)
		const currentSessionFile = ctx.sessionManager.getSessionFile()
		const items = buildItems(sessions, currentSessionFile)
		component.setItems(items)
	} catch (err) {
		ctx.ui.notify(`Failed to load sessions: ${err instanceof Error ? err.message : String(err)}`, "warning")
	}
}
