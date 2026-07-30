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

// ─── Group 1: Initial state ───────────────────────────────────────────────────

describe("initial state", () => {
	it("has empty sessions, highlightIndex 0, loading true, currentSessionId from arg", () => {
		const state = initialPickerState("abc-123")
		expect(state.sessions).toEqual([])
		expect(state.highlightIndex).toBe(0)
		expect(state.loading).toBe(true)
		expect(state.currentSessionId).toBe("abc-123")
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
		const state: PickerState = {
			...initialPickerState(),
			sessions: makeSessions(3),
			loading: false,
		}
		const { state: next } = pickerReducer(state, { type: "key-down" })
		expect(next.highlightIndex).toBe(1)
	})

	it("key-up decrements highlightIndex", () => {
		const state: PickerState = {
			...initialPickerState(),
			sessions: makeSessions(3),
			highlightIndex: 2,
			loading: false,
		}
		const { state: next } = pickerReducer(state, { type: "key-up" })
		expect(next.highlightIndex).toBe(1)
	})

	it("key-down wraps around from last to first", () => {
		const state: PickerState = {
			...initialPickerState(),
			sessions: makeSessions(3),
			highlightIndex: 2,
			loading: false,
		}
		const { state: next } = pickerReducer(state, { type: "key-down" })
		expect(next.highlightIndex).toBe(0)
	})

	it("key-up wraps around from first to last", () => {
		const state: PickerState = {
			...initialPickerState(),
			sessions: makeSessions(3),
			highlightIndex: 0,
			loading: false,
		}
		const { state: next } = pickerReducer(state, { type: "key-up" })
		expect(next.highlightIndex).toBe(2)
	})

	it("key-up/down on empty sessions is a no-op", () => {
		const state = initialPickerState()
		const upResult = pickerReducer(state, { type: "key-up" })
		expect(upResult.state.highlightIndex).toBe(0)
		expect(upResult.effect).toEqual({ type: "none" })
		const downResult = pickerReducer(state, { type: "key-down" })
		expect(downResult.state.highlightIndex).toBe(0)
		expect(downResult.effect).toEqual({ type: "none" })
	})

	it("key-up/down on single session wraps to same index", () => {
		const state: PickerState = {
			...initialPickerState(),
			sessions: makeSessions(1),
			loading: false,
		}
		const downResult = pickerReducer(state, { type: "key-down" })
		expect(downResult.state.highlightIndex).toBe(0)
		const upResult = pickerReducer(state, { type: "key-up" })
		expect(upResult.state.highlightIndex).toBe(0)
	})
})

// ─── Group 4: key-enter (switch-session) ───────────────────────────────────────

describe("key-enter", () => {
	it("produces switch-session effect with the highlighted session path", () => {
		const sessions = makeSessions(3)
		const state: PickerState = {
			...initialPickerState(),
			sessions,
			highlightIndex: 1,
			loading: false,
		}
		const { state: nextState, effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "switch-session", sessionPath: sessions[1].path })
		// State unchanged
		expect(nextState).toStrictEqual(state)
	})

	it("produces switch-session for the first session when highlightIndex is 0", () => {
		const sessions = makeSessions(2)
		const state: PickerState = {
			...initialPickerState(),
			sessions,
			highlightIndex: 0,
			loading: false,
		}
		const { effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "switch-session", sessionPath: sessions[0].path })
	})

	it("produces none when sessions list is empty", () => {
		const state = initialPickerState()
		const { effect } = pickerReducer(state, { type: "key-enter" })
		expect(effect).toEqual({ type: "none" })
	})
})

// ─── Group 5: key-escape (dismiss) ─────────────────────────────────────────────

describe("key-escape", () => {
	it("produces dismiss effect", () => {
		const state: PickerState = {
			...initialPickerState(),
			sessions: makeSessions(2),
			loading: false,
		}
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

// ─── Group 6: Unknown/unhandled events ────────────────────────────────────────

describe("unhandled events", () => {
	it("returns state unchanged with none effect for unknown event types", () => {
		const state: PickerState = {
			...initialPickerState(),
			sessions: makeSessions(1),
			loading: false,
		}
		// Cast to test the default branch
		const { state: nextState, effect } = pickerReducer(state, { type: "unknown" } as never)
		expect(nextState).toStrictEqual(state)
		expect(effect).toEqual({ type: "none" })
	})
})
