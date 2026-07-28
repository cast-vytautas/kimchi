import type { SessionInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { type SessionPickerItem, buildItems, defaultHighlight, initialState, reduce } from "./session-picker-reducer.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<SessionPickerItem> = {}): SessionPickerItem {
	return {
		path: "/sessions/sess-1.jsonl",
		label: "My Session",
		isCurrent: false,
		modified: new Date("2025-01-15T10:00:00Z"),
		...overrides,
	}
}

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: "/sessions/sess-1.jsonl",
		id: "sess-1",
		cwd: "/tmp",
		created: new Date("2025-01-10T10:00:00Z"),
		modified: new Date("2025-01-15T10:00:00Z"),
		messageCount: 5,
		firstMessage: "Hello world",
		allMessagesText: "Hello world",
		...overrides,
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("session-picker-reducer", () => {
	describe("initialState", () => {
		it("starts with empty items, highlight at 0, loading true", () => {
			const state = initialState()
			expect(state.items).toEqual([])
			expect(state.highlightIndex).toBe(0)
			expect(state.loading).toBe(true)
		})
	})

	describe("buildItems", () => {
		it("sorts by modified desc", () => {
			const sessions = [
				makeSessionInfo({ path: "/a.jsonl", modified: new Date("2025-01-01T00:00:00Z"), firstMessage: "old" }),
				makeSessionInfo({ path: "/b.jsonl", modified: new Date("2025-01-10T00:00:00Z"), firstMessage: "new" }),
			]
			const items = buildItems(sessions, undefined)
			expect(items[0].path).toBe("/b.jsonl")
			expect(items[1].path).toBe("/a.jsonl")
		})

		it("uses session name when available", () => {
			const sessions = [makeSessionInfo({ name: "My Custom Name", firstMessage: "ignored" })]
			const items = buildItems(sessions, undefined)
			expect(items[0].label).toBe("My Custom Name")
		})

		it("falls back to firstMessage excerpt when no name", () => {
			const sessions = [makeSessionInfo({ name: undefined, firstMessage: "Do the thing" })]
			const items = buildItems(sessions, undefined)
			expect(items[0].label).toBe("Do the thing")
		})

		it("truncates long firstMessage excerpts", () => {
			const longMsg = "x".repeat(100)
			const sessions = [makeSessionInfo({ name: undefined, firstMessage: longMsg })]
			const items = buildItems(sessions, undefined)
			expect(items[0].label.length).toBe(60)
			expect(items[0].label).toMatch(/…$/)
		})

		it("flags isCurrent matching currentSessionPath", () => {
			const sessions = [makeSessionInfo({ path: "/a.jsonl" }), makeSessionInfo({ path: "/b.jsonl" })]
			const items = buildItems(sessions, "/b.jsonl")
			expect(items[0].isCurrent).toBe(false)
			expect(items[1].isCurrent).toBe(true)
		})
	})

	describe("defaultHighlight", () => {
		it("returns index of current session", () => {
			const items = [makeItem({ isCurrent: false }), makeItem({ isCurrent: true }), makeItem({ isCurrent: false })]
			expect(defaultHighlight(items)).toBe(1)
		})

		it("falls back to 0 when no current session", () => {
			const items = [makeItem({ isCurrent: false }), makeItem({ isCurrent: false })]
			expect(defaultHighlight(items)).toBe(0)
		})

		it("falls back to 0 when items is empty", () => {
			expect(defaultHighlight([])).toBe(0)
		})
	})

	describe("reduce — sessions-loaded", () => {
		it("sets items, clears loading, sets highlight to current session", () => {
			const state = initialState()
			const items = [makeItem({ isCurrent: false }), makeItem({ isCurrent: true })]
			const result = reduce(state, { kind: "sessions-loaded", items })
			expect(result.state.items).toBe(items)
			expect(result.state.loading).toBe(false)
			expect(result.state.highlightIndex).toBe(1)
			expect(result.effects).toEqual([{ kind: "render" }])
		})

		it("defaults highlight to 0 when no current session", () => {
			const state = initialState()
			const items = [makeItem({ isCurrent: false }), makeItem({ isCurrent: false })]
			const result = reduce(state, { kind: "sessions-loaded", items })
			expect(result.state.highlightIndex).toBe(0)
		})
	})

	describe("reduce — key-up", () => {
		it("moves highlight up by 1", () => {
			const items = [makeItem(), makeItem(), makeItem()]
			const state = { items, highlightIndex: 2, loading: false }
			const result = reduce(state, { kind: "key-up" })
			expect(result.state.highlightIndex).toBe(1)
			expect(result.effects).toEqual([{ kind: "render" }])
		})

		it("wraps from top to bottom", () => {
			const items = [makeItem(), makeItem(), makeItem()]
			const state = { items, highlightIndex: 0, loading: false }
			const result = reduce(state, { kind: "key-up" })
			expect(result.state.highlightIndex).toBe(2)
		})

		it("no-ops when items is empty", () => {
			const state = initialState()
			const result = reduce(state, { kind: "key-up" })
			expect(result.state.highlightIndex).toBe(0)
			expect(result.effects).toEqual([])
		})
	})

	describe("reduce — key-down", () => {
		it("moves highlight down by 1", () => {
			const items = [makeItem(), makeItem(), makeItem()]
			const state = { items, highlightIndex: 0, loading: false }
			const result = reduce(state, { kind: "key-down" })
			expect(result.state.highlightIndex).toBe(1)
			expect(result.effects).toEqual([{ kind: "render" }])
		})

		it("wraps from bottom to top", () => {
			const items = [makeItem(), makeItem(), makeItem()]
			const state = { items, highlightIndex: 2, loading: false }
			const result = reduce(state, { kind: "key-down" })
			expect(result.state.highlightIndex).toBe(0)
		})

		it("no-ops when items is empty", () => {
			const state = initialState()
			const result = reduce(state, { kind: "key-down" })
			expect(result.state.highlightIndex).toBe(0)
			expect(result.effects).toEqual([])
		})
	})

	describe("reduce — key-enter", () => {
		it("emits switch-session with highlighted item path", () => {
			const items = [makeItem({ path: "/a.jsonl" }), makeItem({ path: "/b.jsonl" })]
			const state = { items, highlightIndex: 1, loading: false }
			const result = reduce(state, { kind: "key-enter" })
			expect(result.effects).toEqual([{ kind: "switch-session", path: "/b.jsonl" }])
		})

		it("emits dismiss when no items", () => {
			const state = initialState()
			const result = reduce(state, { kind: "key-enter" })
			expect(result.effects).toEqual([{ kind: "dismiss" }])
		})
	})

	describe("reduce — key-escape", () => {
		it("emits dismiss", () => {
			const items = [makeItem()]
			const state = { items, highlightIndex: 0, loading: false }
			const result = reduce(state, { kind: "key-escape" })
			expect(result.effects).toEqual([{ kind: "dismiss" }])
		})
	})
})
