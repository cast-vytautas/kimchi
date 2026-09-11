import { existsSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent"
import type { ServerEntry } from "../extensions/mcp-adapter/types.js"
import type { AgentDefinition, AgentDiscovery, DirCandidate, DiscoveredSkill } from "./index.js"

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export function hasBearerAuthorizationHeader(headers: unknown): boolean {
	// Defensive: `headers` comes from arbitrary parsed JSON and may be null,
	// an array, or a primitive at runtime even though the call sites cast it
	// to Record<string, string>. Treat anything that isn't a plain object as
	// "no bearer header" rather than crashing the discovery pass.
	if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return false
	return Object.entries(headers as Record<string, unknown>).some(
		([k, v]) => k.toLowerCase() === "authorization" && typeof v === "string" && v.toLowerCase().startsWith("bearer "),
	)
}

function ingest(
	into: Record<string, ServerEntry>,
	block: unknown,
	transform: AgentDefinition["transformServer"],
): void {
	if (!block || typeof block !== "object" || Array.isArray(block)) return
	let entries: Record<string, unknown>
	let meta: unknown
	const maybeWrapped = block as { entries?: unknown; meta?: unknown }
	if (
		maybeWrapped.entries !== undefined &&
		typeof maybeWrapped.entries === "object" &&
		maybeWrapped.entries !== null &&
		!Array.isArray(maybeWrapped.entries)
	) {
		entries = maybeWrapped.entries as Record<string, unknown>
		meta = maybeWrapped.meta
	} else {
		entries = block as Record<string, unknown>
		meta = undefined
	}
	for (const [name, raw] of Object.entries(entries)) {
		if (into[name]) continue
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue
		const entry = transform(raw, name, meta)
		if (entry) into[name] = entry
	}
}

export type DiscoveryScope = "all" | "home"

export interface DiscoverAgentOptions {
	/**
	 * `"home"` restricts discovery to home-level roots by dropping
	 * project-relative candidates entirely. Used by the ACP import_discover
	 * handler: onboarding runs before any workspace exists, and a harness
	 * spawned by a desktop app inherits a working directory (often `/`) that
	 * would make project-relative probes meaningless and risk an OS permission
	 * prompt. Defaults to `"all"`, which preserves the terminal wizard's
	 * behaviour unchanged.
	 */
	readonly scope?: DiscoveryScope
	/**
	 * Working directory project-relative candidates resolve against. Defaults
	 * to `process.cwd()` — read at call time, never at module load, so a
	 * long-lived process sees the caller's current directory.
	 */
	readonly cwd?: string
}

/** Resolve a candidate list to absolute directories against the given cwd. */
export function resolveDirCandidates(candidates: readonly DirCandidate[], cwd: string): string[] {
	return candidates.map((c) => {
		if (typeof c !== "string") return join(cwd, c.projectRelative)
		if (!isAbsolute(c)) {
			// Plain strings are a documented home-level-absolute convention. A
			// relative one would silently resolve against the ambient cwd inside
			// existsSync — cwd-dependent behaviour that survives even under the
			// explicit `cwd` option and "home" scope. Flag it rather than
			// resolving it implicitly.
			console.warn(
				`Non-absolute directory candidate "${c}" in agent discovery resolves against the current working directory; use an absolute path or a { projectRelative } candidate`,
			)
		}
		return c
	})
}

/** Drop project-relative candidates when discovery is scoped to home roots. */
export function selectDirCandidates(
	candidates: readonly DirCandidate[],
	scope: DiscoveryScope,
): readonly DirCandidate[] {
	return scope === "home" ? candidates.filter((c) => typeof c === "string") : candidates
}

/**
 * Enumerate the skills in a resolved skills directory via pi's loader, which
 * omits a skill whose SKILL.md cannot be read or parsed (emitting a diagnostic)
 * instead of failing the whole pass.
 */
function enumerateSkills(skillsDir: string): DiscoveredSkill[] {
	try {
		const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDir, source: skillsDir })
		// The loader omits an unreadable/unparseable skill and reports why via
		// diagnostics — surface them, or the skill vanishes from discovery
		// silently and the user has no observable reason why.
		for (const diagnostic of diagnostics) {
			console.warn(
				`Skill discovery in ${skillsDir}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
			)
		}
		return skills.map((s) => ({ name: s.name, description: s.description, path: s.filePath }))
	} catch (err) {
		console.warn(`Failed to enumerate skills in ${skillsDir}: ${msg(err)}`)
		return []
	}
}

export function discoverAgent(def: AgentDefinition, options?: DiscoverAgentOptions): AgentDiscovery {
	const scope = options?.scope ?? "all"
	const cwd = options?.cwd ?? process.cwd()
	const parse = def.parseConfig ?? JSON.parse
	const mcpServers: Record<string, ServerEntry> = {}

	// configPaths are a documented home-level-absolute convention (see
	// AgentDefinition.configPaths). Under "home" scope a relative path would
	// re-introduce exactly the cwd-dependent probe the scope exists to
	// prevent, so drop it with a warning instead of reading it.
	const configPaths =
		scope === "home"
			? def.configPaths.filter((path) => {
					if (isAbsolute(path)) return true
					console.warn(
						`Skipping non-absolute config path "${path}" for ${def.displayName} in home-scoped discovery; config paths must be absolute`,
					)
					return false
				})
			: def.configPaths

	for (const path of configPaths) {
		let raw: string
		try {
			raw = readFileSync(path, "utf-8")
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`Failed to read ${def.displayName} config at ${path}: ${msg(err)}`)
			}
			continue
		}
		let parsed: unknown
		try {
			parsed = parse(raw)
		} catch (err) {
			console.warn(`Failed to parse ${def.displayName} config at ${path}: ${msg(err)}`)
			continue
		}
		const sources = def.extractServerSources(parsed)
		for (const block of sources) ingest(mcpServers, block, def.transformServer)
		// Continue: every readable + parseable file in configPaths contributes
		// its servers. ingest() does first-writer-wins per server name, so if
		// the same name appears in multiple files, the entry from the earlier
		// file in configPaths is kept and later files' duplicates are skipped.
	}

	const skillsDirs = resolveDirCandidates(selectDirCandidates(def.skillsDirs, scope), cwd)
	let skillCount = 0
	let skills: DiscoveredSkill[] = []
	let skillsDir: string | undefined
	for (const dir of skillsDirs) {
		if (existsSync(dir)) {
			skillsDir = dir
			try {
				skillCount = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
			} catch (err) {
				console.warn(`Failed to read ${def.displayName} skills directory at ${dir}: ${msg(err)}`)
			}
			skills = enumerateSkills(dir)
			break
		}
	}

	const commandsDirs = resolveDirCandidates(selectDirCandidates(def.commandsDirs, scope), cwd)
	let commandsCount = 0
	let commandsDir: string | undefined
	for (const dir of commandsDirs) {
		if (existsSync(dir)) {
			commandsDir = dir
			try {
				commandsCount = countMarkdownFiles(dir)
			} catch (err) {
				console.warn(`Failed to read ${def.displayName} commands directory at ${dir}: ${msg(err)}`)
			}
			break
		}
	}

	return {
		id: def.id,
		displayName: def.displayName,
		mcpServers,
		skillCount,
		skills,
		skillsDir,
		commandsCount,
		commandsDir,
	}
}

function countMarkdownFiles(dir: string): number {
	let count = 0
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".md")) {
			count++
		}
	}
	return count
}
