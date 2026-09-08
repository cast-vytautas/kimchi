import { beforeEach, describe, expect, it } from "vitest"
import {
	clearCredentialStale,
	isAuthRejectedMessage,
	isCredentialStale,
	markCredentialStale,
	resetCredentialStalenessForTests,
} from "./credential-staleness.js"

describe("credential-staleness registry", () => {
	beforeEach(() => {
		resetCredentialStalenessForTests()
	})

	it("starts clean", () => {
		expect(isCredentialStale("some-key", "kimchi-dev")).toBe(false)
	})

	it("marks a specific key stale for a provider and reports it", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(true)
	})

	it("scopes staleness to the apiKey: a different key (re-login) is not stale", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		expect(isCredentialStale("fresh-key", "kimchi-dev")).toBe(false)
	})

	it("scopes provider-level staleness: a 401 on kimchi-dev poisons the provider even without a key", () => {
		markCredentialStale(undefined, "kimchi-dev")
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(true)
		// A provider-level mark blames "some credential" — we cannot tell at
		// read time whether the key being presented is the one that 401'd, so
		// ANY key for that provider counts as stale until an authenticated
		// success (model refresh / re-login) explicitly clears the mark.
		expect(isCredentialStale("fresh-key", "kimchi-dev")).toBe(true)
	})

	it("clearCredentialStale wipes both key-level and provider-level marks", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		markCredentialStale(undefined, "kimchi-dev")
		clearCredentialStale("kimchi-dev")
		expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(false)
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(false)
	})

	it("does not leak staleness across providers", () => {
		markCredentialStale(undefined, "kimchi-dev")
		expect(isCredentialStale(undefined, "other-provider")).toBe(false)
	})
})

describe("isAuthRejectedMessage", () => {
	it.each([
		"Failed to fetch models: 401 Unauthorized",
		"Request failed with status code 401: Unauthorized",
		"invalid api key provided",
		"invalid token",
		"expired token",
		"unauthenticated request",
	])("detects auth-class error text: %s", (message) => {
		expect(isAuthRejectedMessage(message)).toBe(true)
	})

	it.each([
		"Failed to fetch models: 500 Internal Server Error",
		"rate limited, retry in 30s",
		"network down",
		// A bare substring must not falsely trigger: "authentication" is fine,
		// but unrelated prose mentioning keys is not an auth rejection.
		"keybinding conflict detected",
	])("does not flag non-auth errors: %s", (message) => {
		expect(isAuthRejectedMessage(message)).toBe(false)
	})
})
