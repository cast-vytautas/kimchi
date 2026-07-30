import type { SessionInfo } from "@earendil-works/pi-coding-agent"

/**
 * Session picker reducer — pure state machine.
 *
 * Extracted so that keyboard routing, list navigation, and session switching
 * can be unit-tested independently of the TUI runtime.
 *
 * The reducer is dependency-free: it takes a `PickerState` plus an input
 * `PickerEvent` and returns the next state together with a `PickerEffect`
 * the host must perform (switch-session, new-session, dismiss, or none).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type { SessionInfo }

export interface PickerState {
	sessions: SessionInfo[]
	highlightIndex: number
	loading: boolean
	currentSessionId: string | undefined
	/** Accumulated typed text for creating a new session. */
	newSessionInput: string
}

export type PickerEvent =
	| { type: "sessions-loaded"; sessions: SessionInfo[] }
	| { type: "key-up" }
	| { type: "key-down" }
	| { type: "key-enter" }
	| { type: "key-escape" }
	| { type: "key-text"; text: string }
	| { type: "key-backspace" }

export type PickerEffect =
	| { type: "switch-session"; sessionPath: string }
	| { type: "new-session"; text: string }
	| { type: "dismiss" }
	| { type: "none" }

export interface PickerReduceResult {
	state: PickerState
	effect: PickerEffect
}

// ─── Initial state ───────────────────────────────────────────────────────────

export function initialPickerState(currentSessionId?: string): PickerState {
	return {
		sessions: [],
		highlightIndex: 0,
		loading: true,
		currentSessionId,
		newSessionInput: "",
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the total number of navigable entries: the sessions plus the
 * virtual "New session" entry at the bottom.
 */
function entryCount(state: PickerState): number {
	return state.sessions.length + 1 // +1 for the "New session" entry
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function pickerReducer(state: PickerState, event: PickerEvent): PickerReduceResult {
	switch (event.type) {
		case "sessions-loaded": {
			const sessions = [...event.sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime())
			// Highlight defaults to the current session index.
			let highlightIndex = 0
			if (state.currentSessionId) {
				const idx = sessions.findIndex((s) => s.id === state.currentSessionId)
				if (idx >= 0) highlightIndex = idx
			}
			return {
				state: { ...state, sessions, highlightIndex, loading: false },
				effect: { type: "none" },
			}
		}

		case "key-up": {
			if (state.loading) return { state, effect: { type: "none" } }
			const total = entryCount(state)
			const newIndex = state.highlightIndex <= 0 ? total - 1 : state.highlightIndex - 1
			return {
				state: { ...state, highlightIndex: newIndex },
				effect: { type: "none" },
			}
		}

		case "key-down": {
			if (state.loading) return { state, effect: { type: "none" } }
			const total = entryCount(state)
			const newIndex = state.highlightIndex >= total - 1 ? 0 : state.highlightIndex + 1
			return {
				state: { ...state, highlightIndex: newIndex },
				effect: { type: "none" },
			}
		}

		case "key-text": {
			// Accumulate typed characters into the new-session input buffer.
			return {
				state: { ...state, newSessionInput: state.newSessionInput + event.text },
				effect: { type: "none" },
			}
		}

		case "key-backspace": {
			if (state.newSessionInput.length === 0) return { state, effect: { type: "none" } }
			return {
				state: { ...state, newSessionInput: state.newSessionInput.slice(0, -1) },
				effect: { type: "none" },
			}
		}

		case "key-enter": {
			// If the user has typed text, always create a new session
			// regardless of which entry is highlighted.
			if (state.newSessionInput.length > 0) {
				return {
					state,
					effect: { type: "new-session", text: state.newSessionInput },
				}
			}

			// No text typed — check if the "New session" entry is highlighted.
			if (state.highlightIndex === state.sessions.length) {
				return {
					state,
					effect: { type: "new-session", text: "" },
				}
			}

			// Regular session entry highlighted with no typed text — switch.
			if (state.sessions.length === 0) return { state, effect: { type: "none" } }
			const session = state.sessions[state.highlightIndex]
			if (!session) return { state, effect: { type: "none" } }
			return {
				state,
				effect: { type: "switch-session", sessionPath: session.path },
			}
		}

		case "key-escape": {
			return { state, effect: { type: "dismiss" } }
		}

		default:
			return { state, effect: { type: "none" } }
	}
}
