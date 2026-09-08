import { describe, expect, it } from "vitest"
import { handleAuthStatus } from "./auth-status.js"

describe("handleAuthStatus", () => {
	it("reports authenticated when the credential lookup finds credentials", () => {
		expect(handleAuthStatus(() => true)).toEqual({ authenticated: true })
	})

	it("reports unauthenticated when the credential lookup finds none", () => {
		expect(handleAuthStatus(() => false)).toEqual({ authenticated: false })
	})

	it("evaluates the lookup on every call so credential changes are reflected", () => {
		let hasCredentials = false
		expect(handleAuthStatus(() => hasCredentials).authenticated).toBe(false)
		hasCredentials = true
		expect(handleAuthStatus(() => hasCredentials).authenticated).toBe(true)
		hasCredentials = false
		expect(handleAuthStatus(() => hasCredentials).authenticated).toBe(false)
	})
})
