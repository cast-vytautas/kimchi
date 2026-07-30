import { describe, expect, it } from "vitest"
import { initialPickerState, type PickerState, pickerReducer, type SessionInfo } from "./session-picker-reducer.js"

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: overrides.path ?? "/path/to/session-1.jsonl",
		id: overrides.id ?? "session-1",
		cwd: overrides.cwd ?? "/cwd",
		name: overrides.name ?? "My Session",
		created: overrides.created ?? new Date("2026-07-28T09:00:00Z"),
		modified: overrides.modified ?? new Date("2026-07-28T10:00:00Z"),
		messageCount: overrides.messageCount ?? 5,
		firstMessage: overrides.firstMessage ?? "Hello world",
		allMessagesText: overrides.allMessagesText ?? "Hello world",
	}
}

function makeSessions(count: number): SessionInfo[] {
	return Array.from({ length: count }, (_, i) =>
		makeSession({
			id: `session-${i + 1}`,
			name: `Session ${i + 1}`,
			modified: new Date(2026, 6, 28, 10, i, 0),
			path: `/path/to/session-${i + 1}.jsonl`,
		}),
	)
}

/** Helper: build a loaded (non-loading) state with sessions. */
function loadedState(sessions: SessionInfo[], currentSessionId?: string): PickerState {
	const state = initialPickerState(currentSessionId)
	return pickerReducer(state, { type: "sessions-loaded", sessions }).state
}

// ─── Group 1: Initial state ───────────────────────────────────────────────────

describe("initial state", () => {
	it("has empty sessions, highlightIndex 0, loading true, currentSessionId from arg", () => {
		const state = initialPickerState("abc-123")
		expect(state.sessions).toEqual([])
		expect(state.highlightIndex).toBe(0)
		expect(state.loading).toBe(true)
		expect(state.currentSessionId).toBe("abc-123")
		expect(state.newSessionInput).toBe("")
	})

	it("currentSessionId is undefined when not provided", () => {
		const state = initialPickerState()
		expect(state.currentSessionId).toBeUndefined()
	})
})

// ─── Group 2: sessions-loaded ─────────────────────────────────────────────────

describe("sessions-loaded", () => {
	it("populates sessions, sets loading false, and highlights index 0 when no current session", () => {
		const state = initialPickerState()
		const sessions = makeSessions(3)
		const { state: next, effect } = pickerReducer(state, { type: "sessions-loaded", sessions })
		expect(next.sessions).toHaveLength(3)
		expect(next.loading).toBe(false)
		expect(next.highlightIndex).toBe(0)
		expect(effect).toEqual({ type: "none" })
	})

	it("highlights the current session when currentSessionId matches", () => {
		const sessions = makeSessions(3)
		const state = initialPickerState("session-2")
		const { state: next } = pickerReducer(state, { type: "sessions-loaded", sessions })
		expect(next.highlightIndex).toBe(1)
	})

	it("highlights index 0 when currentSessionId does not match any session", () => {
		const sessions = makeSessions(3)
		const state = initialPickerState("nonexistent")
		const { state: next } = pickerReducer(state, { type: "sessions-loaded", sessions })
		expect(next.highlightIndex).toBe(0)
	})

	it("sorts sessions by modified descending (most recent first)", () => {
		const sessions = [
			makeSession({ id: "old", modified: new Date("2026-07-01T00:00:00Z"), name: "Old" }),
			makeSession({ id: "new", modified: new Date("2026-07-28T00:00:00Z"), name: "New" }),
			makeSession({ id: "mid", modified: new Date("2026-07-15T00:00:00Z"), name: "Mid" }),
		]
		const state = initialPickerState()
		const { state: next } = pickerReducer(state, { type: "sessions-loaded", sessions })
		expect(next.sessions.map((s) => s.id)).toEqual(["new", "mid", "old"])
	})

	it("re-highlight uses the current session after sorting", () => {
		const sessions = [
			makeSession({ id: "old", modified: new Date("2026-07-01T00:00:00Z") }),
			makeSession({ id: "current", modified: new Date("2026-07-15T00:00:00Z") }),
			makeSession({ id: "new", modified: new Date("2026-07-28T00:00:00Z") }),
		]
		const state = initialPickerState("current")
		const { state: next } = pickerReducer(state, { type: "sessions-loaded", sessions })
		// After sort: [new, current, old] → current is at index 1
		expect(next.sessions.map((s) => s.id)).toEqual(["new", "current", "old"])
		expect(next.highlightIndex).toBe(1)
	})
})

// ─── Group 3: key-up / key-down navigation ─────────────────────────────────────

describe("key-up / key-down navigation", () => {
	it("key-down increments highlightIndex", () => {
		const state = loadedState(makeSessions(3))
		const { state: next } = pickerReducer(state, { type: "key-down" })
		expect(next.highlightIndex).toBe(1)
	})

	it("key-up decrements highlightIndex", () => {
		const state: PickerState = {
			...loadedState(makeSessions(3)),
			highlightIndex: 2,
		}
		const { state: next } = pickerReducer(state, { type: "key-up" })
		expect(next.highlightIndex).toBe(1)
	})

	it("key-down wraps around from last (New session entry) to first", () => {
		// 3 sessions + 1 "New session" = 4 entries (indices 0-3)
		const state: PickerState = {
			...loadedState(makeSessions(3)),
			highlightIndex: 3, // "New session" entry
		}
		const { state: next } = pickerReducer(state, { type: "key-down" })
		expect(next.highlightIndex).toBe(0)
	})

	it("key-up wraps around from first to last (New session entry)", () => {
		const state: PickerState = {
			...loadedState(makeSessions(3)),
			highlightIndex: 0,
		}
		const { state: next } = pickerReducer(state, { type: "key-up" })
		expect(next.highlightIndex).toBe(3) // index 3 = "New session"
	})

	it("key-up/down on empty sessions list still navigates to New session entry", () => {
		const state = loadedState([])
		// No sessions → only "New session" entry at index 0
		expect(state.highlightIndex).toBe(0)
		const downResult = pickerReducer(state, { type: "key-down" })
		// Only 1 entry, wraps to itself
		expect(downResult.state.highlightIndex).toBe(0)
		const upResult = pickerReducer(state, { type: "key-up" })
		expect(upResult.state.highlightIndex).toBe(0)
	})

	it("key-up/down on single session wraps through session and New session", () => {
		const state = loadedState(makeSessions(1))
		// 1 session + 1 "New session" = 2 entries (indices 0-1)
		const downResult = pickerReducer(state, { type: "key-down" })
		expect(downResult.state.highlightIndex).toBe(1) // "New session"
		const downResult2 = pickerReducer(downResult.state, { type: "key-down" })
		expect(downResult2.state.highlightIndex).toBe(0) // wraps to session
	})

	it("key-up/down is no-op while loading", () => {
		const state = initialPickerState()
		const upResult = pickerReducer(state, { type: "key-up" })
		expect(upResult.state.highlightIndex).toBe(0)
		expect(upResult.effect).toEqual({ type: "none" })
		const downResult = pickerReducer(state, { type: "key-down" })
		expect(downResult.state.highlightIndex).toBe(0)
		expect(downResult.effect).toEqual({ type: "none" })
	})
})

// ─── Group 4: key-enter (switch-session / new-session) ────────────────────────

describe("key-enter", () => {
	it("produces switch-session effect with the highlighted session path when input is empty", () => {
		const sessions = makeSessions(3)
		const state: PickerState = {
			...loadedState(sessions),
			highlightIndex: 1,
		}
		const { state: nextState, effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "switch-session", sessionPath: sessions[1].path })
		expect(nextState).toStrictEqual(state)
	})

	it("produces switch-session for the first session when highlightIndex is 0 and input empty", () => {
		const sessions = makeSessions(2)
		const state = loadedState(sessions)
		// After sorting by modified desc, the most recent session is at index 0
		const sortedFirst = state.sessions[0]
		const { effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "switch-session", sessionPath: sortedFirst.path })
	})

	it("produces new-session('') when pressing Enter on the New session entry with empty input", () => {
		const sessions = makeSessions(3)
		const state: PickerState = {
			...loadedState(sessions),
			highlightIndex: 3, // "New session" entry
		}
		const { effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "new-session", text: "" })
	})

	it("produces new-session with typed text regardless of highlight when input is non-empty", () => {
		const sessions = makeSessions(3)
		const state: PickerState = {
			...loadedState(sessions),
			highlightIndex: 0, // a regular session is highlighted
			newSessionInput: "fix the bug",
		}
		const { effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "new-session", text: "fix the bug" })
	})

	it("produces new-session with typed text even when New session entry is highlighted", () => {
		const sessions = makeSessions(2)
		const state: PickerState = {
			...loadedState(sessions),
			highlightIndex: 2, // "New session" entry
			newSessionInput: "hello",
		}
		const { effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "new-session", text: "hello" })
	})

	it("produces none when sessions list is empty and input is empty and highlight is not on New session", () => {
		// With no sessions, "New session" is at index 0, and highlight defaults to 0,
		// so Enter would produce new-session(""). Test a true "none" by forcing
		// highlightIndex out of range.
		const state: PickerState = {
			...loadedState([]),
			highlightIndex: 99,
		}
		const { effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "none" })
	})
})

// ─── Group 5: key-text (text accumulation) ───────────────────────────────────

describe("key-text", () => {
	it("accumulates a single character into newSessionInput", () => {
		const state = loadedState(makeSessions(2))
		const { state: next, effect } = pickerReducer(state, { type: "key-text", text: "a" })
		expect(next.newSessionInput).toBe("a")
		expect(effect).toEqual({ type: "none" })
	})

	it("accumulates multiple characters sequentially", () => {
		const state = loadedState(makeSessions(2))
		let result = pickerReducer(state, { type: "key-text", text: "h" })
		result = pickerReducer(result.state, { type: "key-text", text: "i" })
		result = pickerReducer(result.state, { type: "key-text", text: "!" })
		expect(result.state.newSessionInput).toBe("hi!")
	})

	it("accumulates multi-character text", () => {
		const state = loadedState(makeSessions(2))
		const { state: next } = pickerReducer(state, { type: "key-text", text: "abc" })
		expect(next.newSessionInput).toBe("abc")
	})

	it("does not change highlightIndex or sessions", () => {
		const sessions = makeSessions(3)
		const state: PickerState = {
			...loadedState(sessions),
			highlightIndex: 1,
		}
		const { state: next } = pickerReducer(state, { type: "key-text", text: "x" })
		expect(next.highlightIndex).toBe(1)
		expect(next.sessions).toBe(state.sessions)
	})
})

// ─── Group 6: key-backspace ──────────────────────────────────────────────────

describe("key-backspace", () => {
	it("deletes the last character from newSessionInput", () => {
		const state: PickerState = {
			...loadedState(makeSessions(2)),
			newSessionInput: "hello",
		}
		const { state: next, effect } = pickerReducer(state, { type: "key-backspace" })
		expect(next.newSessionInput).toBe("hell")
		expect(effect).toEqual({ type: "none" })
	})

	it("is a no-op when newSessionInput is empty", () => {
		const state = loadedState(makeSessions(2))
		const { state: next, effect } = pickerReducer(state, { type: "key-backspace" })
		expect(next.newSessionInput).toBe("")
		expect(effect).toEqual({ type: "none" })
	})

	it("deletes multiple characters via repeated events", () => {
		const state: PickerState = {
			...loadedState(makeSessions(2)),
			newSessionInput: "abc",
		}
		let result = pickerReducer(state, { type: "key-backspace" })
		result = pickerReducer(result.state, { type: "key-backspace" })
		expect(result.state.newSessionInput).toBe("a")
	})
})

// ─── Group 7: key-escape (dismiss) ───────────────────────────────────────────

describe("key-escape", () => {
	it("produces dismiss effect", () => {
		const state = loadedState(makeSessions(2))
		const { state: nextState, effect } = pickerReducer(state, { type: "key-escape" })
		expect(effect).toEqual({ type: "dismiss" })
		expect(nextState).toStrictEqual(state)
	})

	it("produces dismiss even when sessions are empty", () => {
		const state = initialPickerState()
		const { effect } = pickerReducer(state, { type: "key-escape" })
		expect(effect).toEqual({ type: "dismiss" })
	})
})

// ─── Group 8: Integration — type then Enter ──────────────────────────────────

describe("type-then-enter flow", () => {
	it("typing text and pressing Enter produces new-session with the typed text", () => {
		const state = loadedState(makeSessions(3))
		let result = pickerReducer(state, { type: "key-text", text: "f" })
		result = pickerReducer(result.state, { type: "key-text", text: "i" })
		result = pickerReducer(result.state, { type: "key-text", text: "x" })
		result = pickerReducer(result.state, { type: "key-enter" })
		expect(result.effect).toEqual({ type: "new-session", text: "fix" })
	})

	it("typing then backspace then Enter sends the trimmed text", () => {
		const state = loadedState(makeSessions(3))
		let result = pickerReducer(state, { type: "key-text", text: "hi!" })
		result = pickerReducer(result.state, { type: "key-backspace" }) // removes "!"
		result = pickerReducer(result.state, { type: "key-enter" })
		expect(result.effect).toEqual({ type: "new-session", text: "hi" })
	})

	it("navigating with arrow keys does not affect typed text", () => {
		const state = loadedState(makeSessions(3))
		let result = pickerReducer(state, { type: "key-text", text: "hello" })
		result = pickerReducer(result.state, { type: "key-down" })
		result = pickerReducer(result.state, { type: "key-up" })
		expect(result.state.newSessionInput).toBe("hello")
		expect(result.state.highlightIndex).toBe(0)
	})
})

// ─── Group 9: Unknown/unhandled events ────────────────────────────────────────

describe("unhandled events", () => {
	it("returns state unchanged with none effect for unknown event types", () => {
		const state = loadedState(makeSessions(1))
		const { state: nextState, effect } = pickerReducer(state, { type: "unknown" } as never)
		expect(nextState).toStrictEqual(state)
		expect(effect).toEqual({ type: "none" })
	})
})
