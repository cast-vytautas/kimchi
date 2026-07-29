/**
 * `kimchi mcp probe` — transient MCP server tool discovery.
 *
 * Reads a {@link ServerEntry} JSON from stdin, connects to the server
 * using a throwaway {@link McpServerManager} connection, calls
 * `tools/list`, prints the result as JSON to stdout, and exits.
 *
 * Used by Kimchi Desktop's MCP server configuration UI to populate a
 * multiselect dropdown of available tools when the user picks
 * "Expose selected tools".
 *
 * Usage:  kimchi mcp probe --json < server-config.json
 * Output: { "tools": [{ "name": "..." }], "needsAuth": false }
 * Exit:   0 on success (including needs-auth), 1 on error
 */
import { randomUUID } from "node:crypto"
import { authenticate, supportsOAuth } from "../extensions/mcp-adapter/mcp-auth-flow.js"
import { McpServerManager } from "../extensions/mcp-adapter/server-manager.js"
import type { McpTool, ServerEntry } from "../extensions/mcp-adapter/types.js"

type ProbeTool = Pick<McpTool, "name" | "title" | "description">

interface ProbeResult {
	tools: ProbeTool[]
	needsAuth: boolean
	error: string | null
}

export async function runMcp(args: string[]): Promise<number | undefined> {
	const subcommand = args[0]

	if (subcommand === "probe") {
		return runProbe(args.slice(1))
	}

	// Future: `kimchi mcp list`, `kimchi mcp status`, etc.
	process.stderr.write(`Unknown mcp subcommand: ${subcommand ?? "(none)"}\n`)
	process.stderr.write("Usage: kimchi mcp probe --json < server-config.json\n")
	return 1
}

async function runProbe(args: string[]): Promise<number> {
	const json = args.includes("--json")

	if (!json) {
		process.stderr.write("Error: --json flag is required\n")
		return 1
	}

	// Read server config from stdin
	let input: string
	try {
		input = await readStdin()
	} catch (err) {
		return emitError("Failed to read stdin", err)
	}

	let definition: ServerEntry
	try {
		definition = JSON.parse(input) as ServerEntry
	} catch (err) {
		return emitError("Failed to parse JSON from stdin", err)
	}

	if (!definition.command && !definition.url) {
		return emitError("Server config must have either 'command' or 'url'", null)
	}

	// Non-OAuth servers: 15 second timeout.
	// OAuth-capable servers that need auth: 60 second timeout (browser redirect + callback).
	const isOAuthCapable = supportsOAuth(definition)
	const timeoutMs = isOAuthCapable ? 60_000 : 15_000
	const timeoutMsg = isOAuthCapable
		? "Probe timed out after 60 seconds (including OAuth flow)"
		: "Probe timed out after 15 seconds"

	const manager = new McpServerManager()
	try {
		let result = await withTimeout(manager.probeTools(definition), timeoutMs, timeoutMsg)

		// If the server needs auth and OAuth is supported, attempt the full
		// OAuth flow (browser redirect + callback) then retry the probe.
		// Use a stable probe name so the OAuth token store (keyed by server
		// name) is shared between authenticate() and the retry probe.
		if (result.needsAuth && isOAuthCapable && definition.url) {
			const probeName = `__probe_${randomUUID()}`
			try {
				await withTimeout(authenticate(probeName, definition.url, definition), timeoutMs, "OAuth flow timed out")
			} catch {
				// Auth failed or timed out — return needsAuth: true, no retry.
				return emitResult({ tools: [], needsAuth: true, error: null })
			}

			// Retry probe after successful auth, reusing the same probe name
			// so the token store has the credentials.
			result = await withTimeout(manager.probeTools(definition, probeName), timeoutMs, timeoutMsg)
		}

		const output: ProbeResult = {
			tools: result.tools.map((t) => ({
				name: t.name,
				title: t.title,
				description: t.description,
			})),
			needsAuth: result.needsAuth,
			error: null,
		}
		return emitResult(output)
	} catch (err) {
		return emitError(err instanceof Error ? err.message : String(err), null)
	} finally {
		await manager.closeAll().catch(() => {})
	}
}

function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = ""
		const onData = (chunk: string) => {
			data += chunk
		}
		const onEnd = () => {
			cleanup()
			resolve(data)
		}
		const onError = (err: Error) => {
			cleanup()
			reject(err)
		}
		const cleanup = () => {
			process.stdin.off("data", onData)
			process.stdin.off("end", onEnd)
			process.stdin.off("error", onError)
		}

		process.stdin.setEncoding("utf8")
		process.stdin.on("data", onData)
		process.stdin.on("end", onEnd)
		process.stdin.on("error", onError)
	})
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timerPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms)
	})
	// Attach a no-op catch to the original promise so that if it rejects
	// after the timer wins the race, the rejection is not unhandled.
	promise.catch(() => {})
	return Promise.race([promise, timerPromise]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

function emitResult(result: ProbeResult): number {
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
	return result.error === null ? 0 : 1
}

function emitError(message: string, err: unknown): number {
	return emitResult({
		tools: [],
		needsAuth: false,
		error: message + (err instanceof Error ? `: ${err.message}` : ""),
	})
}
