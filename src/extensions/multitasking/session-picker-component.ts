import type { Theme } from "@earendil-works/pi-coding-agent"
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import {
	initialPickerState,
	type PickerEffect,
	type PickerEvent,
	type PickerState,
	pickerReducer,
	type SessionInfo,
} from "./session-picker-reducer.js"

// ─── Key mapping ─────────────────────────────────────────────────────────────

/**
 * Maps raw terminal input to a picker event.
 * Returns a `PickerEvent` (including `key-text` and `key-backspace`) or
 * `undefined` if the input doesn't map to any picker action.
 */
export function keyToPickerEvent(data: string): PickerEvent | undefined {
	if (matchesKey(data, Key.up)) return { type: "key-up" }
	if (matchesKey(data, Key.down)) return { type: "key-down" }
	if (matchesKey(data, Key.enter)) return { type: "key-enter" }
	if (matchesKey(data, Key.escape)) return { type: "key-escape" }
	if (matchesKey(data, Key.left)) return { type: "key-escape" } // left arrow dismisses
	if (matchesKey(data, Key.backspace)) return { type: "key-backspace" }
	// Printable characters: single-char strings that aren't control sequences
	if (data.length === 1 && data >= " " && data <= "~") {
		return { type: "key-text", text: data }
	}
	// Multi-byte printable (e.g. unicode): accept if no escape prefix or carriage return
	if (data.length > 1 && !data.startsWith("\x1b") && !data.startsWith("\r")) {
		// Check all chars are printable (no control chars)
		if (
			[...data].every((ch) => {
				const code = ch.codePointAt(0)
				return code !== undefined && code >= 0x20 && code !== 0x7f
			})
		) {
			return { type: "key-text", text: data }
		}
	}
	return undefined
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function formatRelativeTime(date: Date, now: Date = new Date()): string {
	const diffMs = now.getTime() - date.getTime()
	const diffMin = Math.floor(diffMs / 60000)
	if (diffMin < 1) return "just now"
	if (diffMin < 60) return `${diffMin}m ago`
	const diffHr = Math.floor(diffMin / 60)
	if (diffHr < 24) return `${diffHr}h ago`
	const diffDay = Math.floor(diffHr / 24)
	if (diffDay < 7) return `${diffDay}d ago`
	return date.toLocaleDateString()
}

function truncateText(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return ""
	return truncateToWidth(text, maxWidth, "…")
}

export function renderPickerLines(state: PickerState, theme: Theme, width: number): string[] {
	const lines: string[] = []
	const add = (line = "") => lines.push(truncateToWidth(line, width, ""))
	const indent = "  "

	add("")

	if (state.loading) {
		add(`${indent}${theme.fg("dim", "Loading sessions…")}`)
		add("")
		return lines
	}

	if (state.sessions.length === 0) {
		add(`${indent}${theme.fg("dim", "No sessions found.")}`)
	}

	for (let i = 0; i < state.sessions.length; i++) {
		const session = state.sessions[i]
		const isHighlighted = i === state.highlightIndex
		const isCurrent = session.id === state.currentSessionId

		const marker = isCurrent ? "▶" : isHighlighted ? "›" : " "
		const markerColor = isHighlighted ? "accent" : "dim"

		const name = session.name || truncateText(session.firstMessage, 40) || session.id.slice(0, 8)
		const time = formatRelativeTime(session.modified)
		const count = `${session.messageCount} msg`

		const label = isHighlighted ? theme.fg("accent", name) : theme.fg("text", name)
		const meta = theme.fg("dim", ` ${time} · ${count}`)

		const markerStr = theme.fg(markerColor, `${marker} `)
		add(`${indent}${markerStr}${label}${meta}`)

		if (isHighlighted && session.firstMessage) {
			const preview = theme.fg("dim", truncateText(session.firstMessage, width - 4))
			add(`${indent}  ${preview}`)
		}
	}

	// "New session" entry at the bottom of the list
	const newSessionIndex = state.sessions.length
	const isNewSessionHighlighted = state.highlightIndex === newSessionIndex
	const newSessionMarker = isNewSessionHighlighted ? "›" : " "
	const newSessionMarkerColor = isNewSessionHighlighted ? "accent" : "dim"
	const newSessionLabel = isNewSessionHighlighted ? theme.fg("accent", "New session") : theme.fg("dim", "New session")
	const newSessionMarkerStr = theme.fg(newSessionMarkerColor, `${newSessionMarker} `)
	add(`${indent}${newSessionMarkerStr}${newSessionLabel}`)

	// New-session input line — shows typed text with a cursor
	const inputPrompt = theme.fg("dim", "  › ")
	const cursor = theme.fg("accent", "▏")
	if (state.newSessionInput.length > 0) {
		const inputText = theme.fg("text", state.newSessionInput)
		add(`${inputPrompt}${inputText}${cursor}`)
	} else {
		add(`${inputPrompt}${cursor}`)
	}

	add("")
	return lines
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface SessionPickerComponentOptions {
	initialState?: PickerState
	onStateChange?: (state: PickerState) => void
}

export class SessionPickerComponent implements Component {
	private state: PickerState
	private readonly onStateChange?: (state: PickerState) => void

	constructor(
		private readonly theme: Theme,
		private readonly onEffect: (effect: PickerEffect) => void,
		private readonly requestRender: () => void,
		options: SessionPickerComponentOptions = {},
	) {
		this.state = options.initialState ?? initialPickerState()
		this.onStateChange = options.onStateChange
	}

	getState(): PickerState {
		return this.state
	}

	setState(state: PickerState): void {
		this.state = state
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderPickerLines(this.state, this.theme, width)
	}

	handleInput(data: string): void {
		const event = keyToPickerEvent(data)
		if (!event) return

		const result = pickerReducer(this.state, event)
		this.state = result.state
		this.onStateChange?.(this.state)

		if (result.effect.type !== "none") {
			this.onEffect(result.effect)
			return
		}
		this.requestRender()
	}

	/** Called by the host when sessions are loaded. */
	setSessions(sessions: SessionInfo[]): void {
		const result = pickerReducer(this.state, { type: "sessions-loaded", sessions })
		this.state = result.state
		this.onStateChange?.(this.state)
		this.requestRender()
	}
}
