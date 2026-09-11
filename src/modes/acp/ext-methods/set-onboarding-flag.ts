// ACP extension method handler for marking Studio onboarding complete.
//
// Wire name: `_kimchi.dev/set_onboarding_flag` — the vendor-namespaced method
// for Studio's onboarding flow (ADR-0043), advertised via
// _meta["kimchi.dev"].set_onboarding_flag. Sessionless on purpose: onboarding
// completion is global per-machine state, not session-scoped.
//
// Deliberately separate from the import methods (`import_discover` /
// `import_apply`): a user who declines the import never reaches it, but they
// have still finished onboarding — so completion cannot be a side effect of
// importing. The flag lands in the shared config's existing `onboarding`
// namespace via the harness's read-modify-write helper, so a concurrent write
// cannot clobber neighbouring "user has seen this" markers.

import { RequestError } from "@agentclientprotocol/sdk"
import { writeStudioOnboardingSeenAt } from "../../../config.js"

/**
 * Config locations the flag write targets. Only the harness config override is
 * needed for tests; production always writes the shared KIMCHI_CONFIG_PATH.
 */
export type SetOnboardingFlagPaths = {
	/** Harness config path override; defaults to the shared KIMCHI_CONFIG_PATH. */
	configPath?: string
}

/**
 * Handler for the `_kimchi.dev/set_onboarding_flag` ACP extension method.
 *
 * Records that the user finished onboarding by writing
 * `onboarding.studioOnboardingSeenAt` into the shared harness config
 * (`~/.config/kimchi/config.json`). Sibling keys in the `onboarding` namespace
 * and every other top-level config field (apiKey, skillPaths, …) are
 * preserved, because the write goes through the same read-modify-write helper
 * the terminal wizard's onboarding markers use.
 *
 * Params: `{ seenAt?: string }` — optional ISO-8601 timestamp the client saw
 * the user finish onboarding. When omitted, the harness stamps the current
 * time.
 */
export function handleSetOnboardingFlag(
	paths: SetOnboardingFlagPaths,
	params: Record<string, unknown> = {},
): Record<string, unknown> {
	writeStudioOnboardingSeenAt(resolveSeenAt(params.seenAt), paths.configPath)
	return {}
}

// ISO-8601 date-time with a UTC designator or numeric offset. Deliberately
// strict: the value is a shared contract with Studio and any future reader of
// the config, so arbitrary parseable strings (e.g. "September 11, 2026") are
// rejected — Date.parse's handling of non-ISO input is engine-specific and
// would persist non-machine-standard strings into the shared config.
const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/

function resolveSeenAt(seenAt: unknown): string {
	if (seenAt === undefined) return new Date().toISOString()
	if (
		typeof seenAt !== "string" ||
		seenAt.length === 0 ||
		!ISO_8601_TIMESTAMP.test(seenAt) ||
		Number.isNaN(Date.parse(seenAt))
	) {
		throw RequestError.invalidParams(undefined, "seenAt must be an ISO-8601 timestamp string")
	}
	return seenAt
}
