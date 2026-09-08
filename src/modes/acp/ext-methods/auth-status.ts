// ACP extension method handler for reporting harness auth state.
//
// Wire name: `_kimchi.dev/auth_status` — the vendor-namespaced method from
// ADR-0042 (bundled harness and in-app ACP auth), advertised via
// _meta["kimchi.dev"].auth_status. Sessionless on purpose: identity is
// global, not session-scoped, so the request carries no sessionId.

export type AuthStatusResponse = {
	authenticated: boolean
}

/**
 * Auth status handler for `_kimchi.dev/auth_status`.
 *
 * Reports whether the shared credential store currently holds Kimchi
 * credentials, so clients (e.g. Studio's onboarding gate) can ask on the
 * live ACP connection without attempting a session.
 *
 * The check is a caller-supplied lookup evaluated per request, so state
 * written by authenticate()/unstable_logout() on this connection — or by
 * other Kimchi surfaces sharing the credential store (terminal
 * `kimchi login`, the VS Code extension) — is reflected immediately on the
 * next call.
 */
export function handleAuthStatus(isAuthenticated: () => boolean): AuthStatusResponse {
	return { authenticated: isAuthenticated() }
}
