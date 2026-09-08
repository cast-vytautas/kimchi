// Process-local registry of credentials observed REJECTED by providers
// (401-class responses), so presence-based auth surfaces can start reporting
// validity instead of just existence.
//
// Why this exists: the shared credential store (config.json apiKey,
// auth.json entries) answers "is a credential present", never "does it
// still work". A present-but-dead key therefore shows as logged in
// everywhere (auth_status, Studio's account section) until an actual
// request fails. The 401s ARE observed by this process — model-metadata
// refresh at startup and per-turn LLM calls — but were discarded as
// warnings. This registry keeps them: mark on observed auth rejection,
// clear on a successful authenticated fetch or fresh login, read in
// auth_status so clients (Studio's onboarding gate, reactive login pane)
// can flip to logged-out before another request has to fail.
//
// Process-local on purpose: auth_status is served by the same ACP server
// process that makes the requests, so the signal travels in-memory. A new
// process rebuilds the marker on its own first 401 (startup refresh).

// Deliberately dependency-free (no flow.js/models.js imports): models.ts
// imports this module for refresh 401s, and login/flow.ts imports models.ts
// — importing either would create a cycle. Callers pass provider ids in.

/**
 * Text patterns that unambiguously mean "the provider rejected our
 * credentials". pi exposes stopReason + errorMessage and the model API
 * surfaces status lines — not structured status codes — so detection keys
 * off the error text. Deliberately tight: a false positive would log a
 * healthy user out (login pane that cannot help), a false negative merely
 * degrades to the previous presence-only behaviour.
 */
const AUTH_REJECTED_TEXT =
	/\b401\b|unauthorized|unauthenticated|invalid (api[- ]?key|token|credentials?)|expired (token|credentials?)/i

export function isAuthRejectedMessage(message: string | undefined): boolean {
	return message !== undefined && AUTH_REJECTED_TEXT.test(message)
}

type ProviderStaleness = {
	/** Set when an auth-class failure could not be attributed to a specific key. */
	providerStale: boolean
	/** apiKeys observed individually rejected (401-class). */
	staleKeys: Set<string>
}

const stalenessByProvider = new Map<string, ProviderStaleness>()

function providerEntry(providerId: string): ProviderStaleness {
	let entry = stalenessByProvider.get(providerId)
	if (!entry) {
		entry = { providerStale: false, staleKeys: new Set() }
		stalenessByProvider.set(providerId, entry)
	}
	return entry
}

/**
 * Record an observed auth rejection. Pass the apiKey when the failing call
 * carried one (model refresh, config-key auth); pass undefined when only
 * "this provider rejected us" is known (auth.json OAuth-turn failures).
 */
export function markCredentialStale(apiKey: string | undefined, providerId: string): void {
	const entry = providerEntry(providerId)
	if (apiKey !== undefined && apiKey.length > 0) {
		entry.staleKeys.add(apiKey)
	} else {
		entry.providerStale = true
	}
}

/**
 * A successful authenticated fetch (model refresh after a fresh login, or
 * any later cycle) proves credentials work again — wipe all marks for the
 * provider.
 */
export function clearCredentialStale(providerId: string): void {
	stalenessByProvider.delete(providerId)
}

/**
 * Whether a credential for providerId is known-dead. A key-level mark
 * blames exactly that key; a provider-level mark blames "some credential"
 * for the provider and therefore reports stale for ANY presented key —
 * readers cannot distinguish the dead key from a fresh one, so marks hold
 * until an authenticated success (refresh / re-login) explicitly clears.
 */
export function isCredentialStale(apiKey: string | undefined, providerId: string): boolean {
	const entry = stalenessByProvider.get(providerId)
	if (!entry) return false
	if (apiKey !== undefined && apiKey.length > 0) {
		return entry.staleKeys.has(apiKey) || entry.providerStale
	}
	return entry.providerStale
}

export function resetCredentialStalenessForTests(): void {
	stalenessByProvider.clear()
}
