/**
 * Session Picker TUI Component.
 *
 * Renders a session list with a highlight marker and a loading indicator.
 * Delegates keyboard input to the pure reducer and calls `onEffect` when
 * the reducer emits a `switch-session` or `dismiss` effect.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import {
	type SessionPickerEffect,
	type SessionPickerEvent,
	type SessionPickerState,
	initialState,
	reduce,
} from "./session-picker-reducer.js"

export interface SessionPickerComponentOptions {
	initialState?: SessionPickerState
	onStateChange?: (state: SessionPickerState) => void
}

export class SessionPickerComponent implements Component {
	private state: SessionPickerState
	private readonly onStateChange?: (state: SessionPickerState) => void

	constructor(
		private readonly theme: Theme,
		private readonly onEffect: (effect: SessionPickerEffect) => void,
		private readonly requestRender: () => void,
		options: SessionPickerComponentOptions = {},
	) {
		this.state = options.initialState ?? initialState()
		this.onStateChange = options.onStateChange
	}

	getState(): SessionPickerState {
		return this.state
	}

	/** Update items externally (e.g. after async SessionManager.list resolves). */
	setItems(items: SessionPickerState["items"]): void {
		const result = reduce(this.state, { kind: "sessions-loaded", items })
		this.state = result.state
		this.onStateChange?.(this.state)
		this.requestRender()
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = []
		const innerWidth = Math.max(1, width)
		const add = (line = "") => lines.push(truncateToWidth(line, width, ""))

		add(this.theme.fg("accent", "Sessions"))

		if (this.state.loading) {
			add(this.theme.fg("dim", "  Loading sessions…"))
			add("")
			return lines
		}

		if (this.state.items.length === 0) {
			add(this.theme.fg("dim", "  No sessions found"))
			add("")
			return lines
		}

		for (let i = 0; i < this.state.items.length; i += 1) {
			const item = this.state.items[i]
			const selected = i === this.state.highlightIndex
			const marker = selected ? "❯ " : "  "
			const currentTag = item.isCurrent ? this.theme.fg("dim", " (current)") : ""
			const label = selected ? this.theme.fg("accent", item.label) : this.theme.fg("text", item.label)
			const prefix = selected ? this.theme.fg("accent", marker) : this.theme.fg("dim", marker)
			add(`${prefix}${label}${currentTag}`)
		}

		add("")
		return lines
	}

	handleInput(data: string): void {
		const event = keyToEvent(data)
		if (!event) return
		const result = reduce(this.state, event)
		this.state = result.state
		this.onStateChange?.(this.state)
		for (const effect of result.effects) {
			if (effect.kind === "render") {
				this.requestRender()
			} else {
				this.onEffect(effect)
			}
		}
	}
}

function keyToEvent(data: string): SessionPickerEvent | undefined {
	if (matchesKey(data, Key.up)) return { kind: "key-up" }
	if (matchesKey(data, Key.down)) return { kind: "key-down" }
	if (matchesKey(data, Key.enter)) return { kind: "key-enter" }
	if (matchesKey(data, Key.escape)) return { kind: "key-escape" }
	return undefined
}
