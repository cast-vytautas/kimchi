import type { SessionInfo } from "@earendil-works/pi-coding-agent"

/**
 * Session picker reducer — pure state machine.
 *
 * Extracted so that keyboard routing, list navigation, and session switching
 * can be unit-tested independently of the TUI runtime.
 *
 * The reducer is dependency-free: it takes a `PickerState` plus an input
 * `PickerEvent` and returns the next state together with a `PickerEffect`
 * the host must perform (switch-session, dismiss, or none).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type { SessionInfo }

export interface PickerState {
	sessions: SessionInfo[]
	highlightIndex: number
	loading: boolean
	currentSessionId: string | undefined
}

export type PickerEvent =
	| { type: "sessions-loaded"; sessions: SessionInfo[] }
	| { type: "key-up" }
	| { type: "key-down" }
	| { type: "key-enter" }
	| { type: "key-escape" }

export type PickerEffect = { type: "switch-session"; sessionPath: string } | { type: "dismiss" } | { type: "none" }

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
