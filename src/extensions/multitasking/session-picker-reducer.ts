/**
 * Session picker reducer — pure state machine.
 *
 * Extracted so that keyboard routing, list navigation, session switching
 * and the new-session input buffer can be unit-tested independently of the
 * TUI runtime.
 *
 * The reducer is dependency-free: it takes a `PickerState` plus an input
 * `PickerEvent` and returns the next state together with a `PickerEffect`
 * the host must perform (switch-session, dismiss, or none).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionInfo {
	id: string
	name: string
	modified: Date
	messageCount: number
	firstMessage: string
	sessionPath: string
}

export interface PickerState {
	sessions: SessionInfo[]
	highlightIndex: number
	loading: boolean
	currentSessionId: string | undefined
	/** Accumulated text for the new-session input buffer (ticket 02). */
	newSessionInput: string
}

export type PickerEvent =
	| { type: "sessions-loaded"; sessions: SessionInfo[] }
	| { type: "key-up" }
	| { type: "key-down" }
	| { type: "key-enter" }
	| { type: "key-escape" }
	| { type: "key-text"; text: string }

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
			if (state.sessions.length === 0) return { state, effect: { type: "none" } }
			const newIndex = state.highlightIndex <= 0 ? state.sessions.length - 1 : state.highlightIndex - 1
			return {
				state: { ...state, highlightIndex: newIndex },
				effect: { type: "none" },
			}
		}

		case "key-down": {
			if (state.sessions.length === 0) return { state, effect: { type: "none" } }
			const newIndex = state.highlightIndex >= state.sessions.length - 1 ? 0 : state.highlightIndex + 1
			return {
				state: { ...state, highlightIndex: newIndex },
				effect: { type: "none" },
			}
		}

		case "key-enter": {
			// If the user has typed text, produce a new-session effect (ticket 02).
			// For ticket 01, just produce switch-session.
			if (state.newSessionInput.trim().length > 0) {
				return {
					state,
					effect: { type: "new-session", text: state.newSessionInput },
				}
			}
			if (state.sessions.length === 0) return { state, effect: { type: "none" } }
			const session = state.sessions[state.highlightIndex]
			if (!session) return { state, effect: { type: "none" } }
			return {
				state,
				effect: { type: "switch-session", sessionPath: session.sessionPath },
			}
		}

		case "key-escape": {
			return { state, effect: { type: "dismiss" } }
		}

		case "key-text": {
			// Accumulate typed text into newSessionInput (for ticket 02 new-session flow).
			return {
				state: { ...state, newSessionInput: state.newSessionInput + event.text },
				effect: { type: "none" },
			}
		}

		default:
			return { state, effect: { type: "none" } }
	}
}
