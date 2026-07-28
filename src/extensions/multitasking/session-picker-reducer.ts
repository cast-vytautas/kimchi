/**
 * Session Picker reducer — pure state machine.
 *
 * Extracted so keyboard navigation, highlight tracking, and the
 * switch-session effect can be unit-tested independently of the TUI
 * runtime.
 *
 * The reducer is dependency-free: it takes a `SessionPickerState` plus
 * an input `SessionPickerEvent` and returns the next state together with a
 * list of `SessionPickerEffect`s the host must perform (render request,
 * switch-session, dismiss).
 */

import type { SessionInfo } from "@earendil-works/pi-coding-agent"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionPickerItem {
	/** Absolute path to the session file. */
	path: string
	/** Display name — falls back to firstMessage excerpt if no name. */
	label: string
	/** Whether this is the currently active session. */
	isCurrent: boolean
	/** Last modified date. */
	modified: Date
}

export interface SessionPickerState {
	items: SessionPickerItem[]
	/** Highlighted row index (wraps). */
	highlightIndex: number
	/** True while sessions are being loaded. */
	loading: boolean
}

export type SessionPickerEvent =
	| { kind: "sessions-loaded"; items: SessionPickerItem[] }
	| { kind: "key-up" }
	| { kind: "key-down" }
	| { kind: "key-enter" }
	| { kind: "key-escape" }

export type SessionPickerEffect = { kind: "render" } | { kind: "switch-session"; path: string } | { kind: "dismiss" }

export interface SessionPickerReduceResult {
	state: SessionPickerState
	effects: SessionPickerEffect[]
}

// ─── Initial state ───────────────────────────────────────────────────────────

export function initialState(): SessionPickerState {
	return {
		items: [],
		highlightIndex: 0,
		loading: true,
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build picker items from SessionInfo[] returned by SessionManager.list().
 * The current session (matching currentSessionPath) is flagged so the
 * highlight defaults to it.
 */
export function buildItems(sessions: SessionInfo[], currentSessionPath: string | undefined): SessionPickerItem[] {
	const sorted = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime())
	return sorted.map((s) => ({
		path: s.path,
		label: s.name || truncate(s.firstMessage, 60),
		isCurrent: currentSessionPath ? s.path === currentSessionPath : false,
		modified: s.modified,
	}))
}

/**
 * Find the index of the current session in the items array.
 * Falls back to 0 if not found.
 */
export function defaultHighlight(items: SessionPickerItem[]): number {
	const idx = items.findIndex((i) => i.isCurrent)
	return idx >= 0 ? idx : 0
}

function truncate(s: string, max: number): string {
	const trimmed = s.trim()
	if (trimmed.length <= max) return trimmed
	return `${trimmed.slice(0, max - 1)}…`
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function reduce(state: SessionPickerState, event: SessionPickerEvent): SessionPickerReduceResult {
	switch (event.kind) {
		case "sessions-loaded": {
			const highlightIndex = defaultHighlight(event.items)
			return {
				state: { items: event.items, highlightIndex, loading: false },
				effects: [{ kind: "render" }],
			}
		}

		case "key-up": {
			if (state.items.length === 0) return { state, effects: [] }
			const n = state.items.length
			const highlightIndex = (state.highlightIndex - 1 + n) % n
			return {
				state: { ...state, highlightIndex },
				effects: [{ kind: "render" }],
			}
		}

		case "key-down": {
			if (state.items.length === 0) return { state, effects: [] }
			const n = state.items.length
			const highlightIndex = (state.highlightIndex + 1) % n
			return {
				state: { ...state, highlightIndex },
				effects: [{ kind: "render" }],
			}
		}

		case "key-enter": {
			const item = state.items[state.highlightIndex]
			if (!item) return { state, effects: [{ kind: "dismiss" }] }
			return {
				state,
				effects: [{ kind: "switch-session", path: item.path }],
			}
		}

		case "key-escape": {
			return { state, effects: [{ kind: "dismiss" }] }
		}
	}
}
