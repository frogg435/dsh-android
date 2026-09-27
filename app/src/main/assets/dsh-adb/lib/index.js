/**
 * `dsh-adb` — semantic Android device control over ADB for the DeepSeek Harness.
 *
 * The model works the device the way a person describes it: read the screen as
 * a node-addressed view hierarchy (`android_ui`), then address elements by the
 * node id it just read, or by stable selectors (resource-id / text /
 * content-description) that survive re-dumps (`android_action`). Pixels are a
 * last resort, and the raw `adb` round trips, XML parsing, selector matching,
 * and shell quoting all live in this plugin.
 *
 * The functional plugin contract is the loader's: `name` + `inject` describe
 * the module and its required services, `Config` validates the deployment's
 * config, and `apply(ctx, config)` registers the tools.
 *
 * @module dsh-adb
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Loader identity for this plugin. */
export const name = 'dsh-adb'
/** Tool registry only; the prompt section below degrades gracefully without systemPrompt. */
export const inject = ['tools']

/** Deployment defaults; `cordis.patch.yml` restates them for readability. */
const DEFAULTS = {
	adbPath: 'adb',
	serial: '',
	adbHome: '',
	timeoutMs: 20000,
	dumpTimeoutMs: 40000,
	maxOutputChars: 8000,
	maxNodes: 400,
	shotDir: '',
	enableShell: true,
	guidance: true
}

/** Schemastery config schema; every field carries its default, so `{}` is valid. */
export const Config = z.object({
	adbPath: z.string().default(DEFAULTS.adbPath),
	serial: z.string().default(DEFAULTS.serial),
	adbHome: z.string().default(DEFAULTS.adbHome),
	timeoutMs: z.number().step(1).min(1000).default(DEFAULTS.timeoutMs),
	dumpTimeoutMs: z.number().step(1).min(1000).default(DEFAULTS.dumpTimeoutMs),
	maxOutputChars: z.number().step(1).min(500).default(DEFAULTS.maxOutputChars),
	maxNodes: z.number().step(1).min(10).default(DEFAULTS.maxNodes),
	shotDir: z.string().default(DEFAULTS.shotDir),
	enableShell: z.boolean().default(DEFAULTS.enableShell),
	guidance: z.boolean().default(DEFAULTS.guidance)
})

/** Loose object root for tool outputs: structure is documented, not brittle. */
const ANY_OBJECT = { type: 'object', additionalProperties: true }

/** The `text` action types into the field it focuses first; `clear` wipes it. */
const ACTIONS = ['tap', 'long_press', 'swipe', 'text', 'clear', 'key', 'back', 'home', 'recents']
/** Finger-movement directions for `swipe` (NOT content movement). */
const DIRECTIONS = ['up', 'down', 'left', 'right']
/** `android_app` verbs. */
const APP_ACTIONS = ['current', 'launch', 'stop', 'list', 'info']

/**
 * Drop `undefined` entries recursively. Tool results must be lossless JSON, so
 * an absent field has to be absent rather than present-and-undefined.
 * @param value - candidate tool value.
 * @returns the same structure with every `undefined` removed.
 */
function compact(value) {
	if (Array.isArray(value)) return value.map(compact)
	if (value === null || typeof value !== 'object') return value
	const out = {}
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) out[key] = compact(entry)
	}
	return out
}

/**
 * Clip model-visible text to the configured budget with an explicit marker.
 * @param text - candidate output.
 * @param max - character budget.
 * @returns the text, possibly clipped with a trailing notice.
 */
function clip(text, max) {
	const clean = text.replace(/\s+$/, '')
	if (clean.length <= max) return clean
	return `${clean.slice(0, max)}\n… [truncated ${clean.length - max} of ${clean.length} chars]`
}

/**
 * Resolve the directory adb should treat as HOME, i.e. where `.android/adbkey`
 * lives. On this deployment `/system/bin/adb` is a shim that exports
 * `HOME=$PWD`, so the adb identity follows the *process working directory* —
 * a session workspace change would silently swap the key and drop every
 * wireless-debugging pairing. Pinning one directory keeps the identity stable.
 *
 * The default keeps the key store that already works (a directory that holds a
 * generated `.android/adbkey`), and only falls back to a fresh
 * `$DSH_HOME/adb-home` when none exists yet.
 * @param config - validated plugin config.
 * @returns the absolute adb home directory.
 */
function resolveAdbHome(config) {
	const configured = config.adbHome.trim()
	if (configured !== '') return configured
	const candidates = [process.env.PWD, process.env.HOME, process.cwd(), process.env.DSH_HOME]
	for (const dir of candidates) {
		if (dir !== undefined && dir !== '' && existsSync(join(dir, '.android', 'adbkey'))) return dir
	}
	const fallback = process.env.DSH_HOME ?? process.env.HOME ?? process.cwd()
	return join(fallback, 'adb-home')
}

/**
 * Parse `adb devices -l` into rows.
 * @param text - the command's stdout.
 * @returns rows of `{ serial, state, product, model, device, transportId }`.
 */
function parseDevices(text) {
	const rows = []
	for (const line of text.split('\n').slice(1)) {
		const trimmed = line.trim()
		// A daemon banner is not a device row.
		if (trimmed === '' || trimmed.startsWith('*')) continue
		const [serial, state, ...rest] = trimmed.split(/\s+/)
		if (serial === undefined || state === undefined) continue
		const row = { serial, state }
		for (const token of rest) {
			const colon = token.indexOf(':')
			if (colon < 0) continue
			const key = token.slice(0, colon)
			const value = token.slice(colon + 1)
			if (key === 'product') row.product = value
			else if (key === 'model') row.model = value
			else if (key === 'device') row.device = value
			else if (key === 'transport_id') row.transportId = Number(value)
		}
		rows.push(row)
	}
	return rows
}

/**
 * Spawn a command and capture its output under a cooperative deadline.
 * @param command - executable to spawn.
 * @param args - argv, verbatim (never a shell string on the host).
 * @param options - timeout, caller signal, output cap, and spawn cwd/env.
 * @returns exit metadata plus raw stdout bytes and stderr text.
 */
function run(command, args, { timeoutMs = 20000, signal, maxBytes = 16 * 1024 * 1024, cwd, env } = {}) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('aborted before dispatch'))
			return
		}
		let child
		try {
			child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, env })
		} catch (error) {
			reject(error)
			return
		}
		const out = []
		const err = []
		let outBytes = 0
		let errBytes = 0
		let reason = null
		let settled = false
		const timer = setTimeout(() => {
			reason = 'timeout'
			child.kill('SIGKILL')
		}, timeoutMs)
		const onAbort = () => {
			reason ??= 'aborted'
			child.kill('SIGKILL')
		}
		signal?.addEventListener('abort', onAbort, { once: true })
		const settle = (finish, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			finish(value)
		}
		child.stdout.on('data', (chunk) => {
			outBytes += chunk.length
			if (outBytes > maxBytes) {
				reason ??= 'output'
				child.kill('SIGKILL')
				return
			}
			out.push(chunk)
		})
		child.stderr.on('data', (chunk) => {
			errBytes += chunk.length
			if (errBytes > maxBytes) return
			err.push(chunk)
		})
		child.on('error', (error) => settle(reject, error))
		child.on('close', (code, sig) => settle(resolve, {
			code,
			sig,
			stdout: Buffer.concat(out),
			stderr: Buffer.concat(err).toString('utf8'),
			reason,
			truncated: reason === 'output',
			timedOut: reason === 'timeout'
		}))
	})
}

/** Errors that mean "the picked device went away"; they retry one re-pick. */
const DEVICE_GONE = /device offline|device .* not found|no devices\/emulators found|device still authorizing|device unauthorized|device .* is offline/i

/**
 * One adb client: serial selection, retries, host-argv execution, and the
 * device-side shell entry points every tool builds on.
 */
class Adb {
	/**
	 * @param config - validated plugin config.
	 * @param serial - the serial this client is pinned to, or `''` to auto-pick.
	 * @param spawnBase - `{ cwd, env }` pinning adb's HOME (and therefore its keys).
	 */
	constructor(config, serial, spawnBase) {
		this.config = config
		/** Resolved serial, or null until the first pick. */
		this.serial = (serial ?? '').trim() || null
		/**
		 * Whether the caller named this serial. A pinned client never re-picks:
		 * silently retargeting an explicitly named device would be worse than
		 * reporting that it is gone.
		 */
		this.pinned = this.serial !== null
		/** In-flight pick, so parallel first calls share one `adb devices`. */
		this.picking = null
		/** Pinned cwd/env for every adb spawn from this client. */
		this.spawnBase = spawnBase
	}

	/**
	 * Spawn one adb argv with this client's pinned working directory.
	 * @param argv - arguments after the binary.
	 * @param options - timeout, signal, output cap.
	 * @returns the raw capture.
	 */
	runAdb(argv, options = {}) {
		return run(this.config.adbPath, argv, { ...options, ...this.spawnBase })
	}

	/** @returns adb's leading argv for the current serial. */
	baseArgs() {
		return this.serial === null ? [] : ['-s', this.serial]
	}

	/**
	 * List attached devices and their states.
	 * @param options - dispatch options.
	 * @returns state rows: `{ serial, state, ... }`.
	 */
	async listDevices(options = {}) {
		const res = await this.runAdb(['devices', '-l'], options)
		if (res.reason === 'timeout') throw new Error(`adb devices timed out after ${this.config.timeoutMs}ms`)
		return parseDevices(res.stdout.toString('utf8'))
	}

	/**
	 * Pick the device to talk to: the configured serial, or the single online one.
	 * Concurrent first calls share one resolution, because a just-started adb
	 * server briefly reports rows whose state has not settled yet.
	 * @param options - dispatch options.
	 * @returns the chosen serial.
	 */
	async pickSerial(options = {}) {
		if (this.serial !== null) {
			// A named serial is trusted only once: `-s` on a device that is not
			// attached makes every later command answer with an empty result, so
			// the failure has to surface here instead of as a blank tool value.
			if (this.verified !== true) {
				await this.verifySerial(options)
				this.verified = true
			}
			return this.serial
		}
		if (this.picking !== null) return this.picking
		this.picking = this.resolveSerial(options)
		try {
			return await this.picking
		} finally {
			this.picking = null
		}
	}

	/**
	 * Confirm a named device is attached and usable.
	 * @param options - dispatch options.
	 * @returns nothing; throws with adb's own words when the device is unusable.
	 */
	async verifySerial(options = {}) {
		const res = await this.runAdb([...this.baseArgs(), 'get-state'], options)
		const text = `${res.stdout.toString('utf8')}${res.stderr}`.trim()
		if (res.code !== 0 || !/^device$/m.test(text)) {
			throw new Error(
				`device ${JSON.stringify(this.serial)} is not attached or not usable: ${text || `adb exited ${res.code}`} — ` +
				'run android_devices { action: "list" } to see what is attached, then connect or pair it first'
			)
		}
	}

	/**
	 * Resolve the serial, waiting out a device list that has not settled: a
	 * freshly started adb server can answer with no rows at all before it
	 * enumerates, and a device can still be `authorizing`/`offline`.
	 * @param options - dispatch options.
	 * @returns the chosen serial.
	 */
	async resolveSerial(options = {}) {
		let rows = await this.listDevices(options)
		// More than one online device is a stable, user-owned ambiguity: fail at
		// once and name the choices instead of retrying a deterministic answer.
		for (let attempt = 0; attempt < 5 && rows.filter((row) => row.state === 'device').length === 0; attempt += 1) {
			if (options.signal?.aborted) break
			await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 300))
			rows = await this.listDevices(options)
		}
		const online = rows.filter((row) => row.state === 'device')
		if (online.length === 1) {
			this.serial = online[0].serial
			return this.serial
		}
		const rendered = rows.length === 0 ? 'none' : rows.map((row) => `${row.serial} (${row.state})`).join(', ')
		const hint = online.length === 0
			? 'no device is online — check the USB/wireless debugging authorization on the device'
			: `set \`serial\` in the dsh-adb config to exactly one of: ${online.map((row) => row.serial).join(', ')}`
		throw new Error(`cannot select an adb device: attached devices: ${rendered}; ${hint}`)
	}

	/**
	 * Run one adb argv against the selected device, re-picking once when the
	 * device it had chosen disappeared.
	 * @param argv - arguments after the binary (serial args are prepended).
	 * @param options - timeout, caller signal, output cap.
	 * @returns the raw capture.
	 */
	async exec(argv, options = {}) {
		const timeoutMs = options.timeoutMs ?? this.config.timeoutMs
		await this.pickSerial({ timeoutMs, signal: options.signal })
		let res = await this.runAdb([...this.baseArgs(), ...argv], { ...options, timeoutMs })
		const text = `${res.stdout.toString('utf8')}\n${res.stderr}`
		if (DEVICE_GONE.test(text)) {
			this.verified = false
			if (this.pinned) throw new Error(`device ${JSON.stringify(this.serial)} disappeared mid-call: ${text.trim().slice(0, 200)}`)
			this.serial = null
			await this.pickSerial({ timeoutMs, signal: options.signal })
			res = await this.runAdb([...this.baseArgs(), ...argv], { ...options, timeoutMs })
		}
		return res
	}

	/**
	 * Run a device-side shell script (the string is authored here, never model input).
	 * @param script - shell text executed by the device's shell.
	 * @param options - dispatch options.
	 * @returns `{ code, stdout, stderr, timedOut }` with stdout/stderr as text.
	 */
	async shell(script, options = {}) {
		const res = await this.exec(['shell', script], options)
		if (res.reason === 'timeout') throw new Error(`adb shell timed out after ${options.timeoutMs ?? this.config.timeoutMs}ms: ${script.slice(0, 120)}`)
		return {
			code: res.code ?? -1,
			stdout: res.stdout.toString('utf8'),
			stderr: res.stderr,
			timedOut: res.timedOut === true
		}
	}

	/**
	 * Run a device-side command with raw (binary-safe) stdout, via `exec-out`.
	 * @param argv - device command argv.
	 * @param options - dispatch options.
	 * @returns the raw capture.
	 */
	async execOut(argv, options = {}) {
		const res = await this.exec(['exec-out', ...argv], options)
		if (res.reason === 'timeout') throw new Error(`adb exec-out timed out: ${argv.join(' ')}`)
		return res
	}

	/**
	 * Focus and rotation from ONE `dumpsys window` pass: the same grep carries
	 * `mCurrentFocus`/`mFocusedApp` and the display rotation.
	 * @param options - dispatch options.
	 * @returns `{ focus, rotation }`, each absent when this Android build omits it.
	 */
	async windowState(options = {}) {
		const res = await this.shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp|mRotation="', options)
		const state = { focus: parseFocus(res.stdout), rotation: parseRotation(res.stdout) }
		if (state.rotation === undefined) {
			// Pre-Android-13 builds expose it through the input manager instead.
			const input = await this.shell('dumpsys input | grep -m1 SurfaceOrientation', options).catch(() => ({ stdout: '' }))
			const legacy = /SurfaceOrientation:\s*(\d+)/.exec(input.stdout)
			if (legacy) state.rotation = Number(legacy[1]) * 90
		}
		return state
	}

	/**
	 * The focused window's component, e.g. `com.example/.MainActivity`.
	 * @param options - dispatch options.
	 * @returns the component string, or undefined when dumpsys has no focus row.
	 */
	async focus(options = {}) {
		return (await this.windowState(options)).focus
	}
}

/**
 * Read the focused component out of `dumpsys window` text.
 * @param text - grepped dumpsys rows.
 * @returns the component, or undefined.
 */
function parseFocus(text) {
	const current = /mCurrentFocus=Window\{[^}]*?\s([^}\s]+)\}/.exec(text)
	if (current) return current[1]
	const focused = /mFocusedApp=.*?([A-Za-z0-9_.]+\/[A-Za-z0-9_.]+)/.exec(text)
	return focused ? focused[1] : undefined
}

/**
 * Read the display rotation in degrees out of `dumpsys window` text. Android 13
 * and later print `mRotation=ROTATION_0` (or a bare index) instead of the old
 * `SurfaceOrientation` row.
 * @param text - grepped dumpsys rows.
 * @returns rotation in degrees, or undefined.
 */
function parseRotation(text) {
	const match = /mRotation=(?:ROTATION_)?(\d)/.exec(text)
	return match === null ? undefined : Number(match[1]) * 90
}

/**
 * Decode the XML entities uiautomator writes into attribute values.
 * @param value - raw attribute text.
 * @returns the decoded string.
 */
function unescapeXml(value) {
	return value.replace(/&(#[xX]?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity) => {
		switch (entity) {
			case 'amp': return '&'
			case 'lt': return '<'
			case 'gt': return '>'
			case 'quot': return '"'
			case 'apos': return '\''
			default: {
				const code = entity[0] === '#'
					? (entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10))
					: Number.NaN
				return Number.isFinite(code) ? String.fromCodePoint(code) : whole
			}
		}
	})
}

/** Widget classes that hold editable text; they carry the `edit` flag. */
const EDITABLE_CLASS = /(EditText|AutoCompleteTextView|MultiAutoCompleteTextView|SearchView|TextInputEditText)$/

/**
 * Parse `[l,t][r,b]` into a bounds array.
 * @param raw - uiautomator bounds attribute.
 * @returns `[left, top, right, bottom]`, or undefined.
 */
function parseBounds(raw) {
	const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(raw ?? '')
	return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] : undefined
}

/**
 * Parse a uiautomator hierarchy XML into a flat, parent-linked node list.
 * Nodes carry our own document-order `id`, which is what the model addresses.
 * @param xml - the dump document.
 * @returns `{ rotation, nodes }` where every node has `parent`/`children` links.
 */
function parseHierarchy(xml) {
	const rotation = /<hierarchy\b[^>]*\brotation="(\d+)"/.exec(xml)
	const nodes = []
	const stack = []
	const tokenRe = /<node\b[^>]*?\/>|<node\b[^>]*>|<\/node>/g
	let token
	while ((token = tokenRe.exec(xml)) !== null) {
		const text = token[0]
		if (text.startsWith('</')) {
			stack.pop()
			continue
		}
		const selfClosing = text.endsWith('/>')
		const attrs = {}
		const attrRe = /([A-Za-z][\w-]*)="([^"]*)"/g
		let attr
		while ((attr = attrRe.exec(text)) !== null) attrs[attr[1]] = unescapeXml(attr[2])
		const parent = stack.length > 0 ? stack[stack.length - 1] : null
		const box = parseBounds(attrs.bounds)
		const cls = attrs.class ?? ''
		const flags = []
		if (attrs.clickable === 'true') flags.push('click')
		if (attrs['long-clickable'] === 'true') flags.push('long')
		if (attrs.scrollable === 'true') flags.push('scroll')
		if (attrs.focusable === 'true') flags.push('focus')
		if (attrs.focused === 'true') flags.push('focused')
		if (EDITABLE_CLASS.test(cls)) flags.push('edit')
		if (attrs.checkable === 'true') flags.push('check')
		if (attrs.checked === 'true') flags.push('checked')
		if (attrs.selected === 'true') flags.push('selected')
		if (attrs.enabled === 'false') flags.push('disabled')
		const node = {
			id: nodes.length,
			parent: parent === null ? null : parent.id,
			children: 0,
			depth: stack.length,
			cls,
			text: attrs.text || undefined,
			rid: attrs['resource-id'] || undefined,
			desc: attrs['content-desc'] || undefined,
			pkg: attrs.package || undefined,
			box,
			flags
		}
		if (parent !== null) parent.children += 1
		nodes.push(node)
		if (!selfClosing) stack.push(node)
	}
	return {
		rotation: rotation === null ? undefined : Number(rotation[1]) * 90,
		nodes
	}
}

/**
 * Whether a node carries anything the model could act on or read.
 * Unlabelled layout containers are dropped: their children still show, with
 * depth preserved, which is what keeps one screen small enough to read whole.
 * @param node - parsed node.
 * @returns true when the node should appear in a dump result.
 */
function isInteresting(node) {
	return Boolean(
		node.text || node.rid || node.desc ||
		node.flags.includes('click') || node.flags.includes('long') ||
		node.flags.includes('scroll') || node.flags.includes('edit') ||
		node.flags.includes('check') || node.flags.includes('checked') ||
		node.flags.includes('selected') || node.flags.includes('focused') ||
		node.depth === 0
	)
}

/**
 * Whether a node is itself actionable (taps should land on one of these).
 * @param node - parsed node.
 * @returns true for click/long/scroll/edit/check nodes.
 */
function isActionable(node) {
	return node.flags.some((flag) => flag === 'click' || flag === 'long' || flag === 'scroll' || flag === 'edit' || flag === 'check')
}

/**
 * Format one node as a single model-facing line. Accepts both a parsed node
 * (flags array) and a wire node from a tool result (flags string).
 * @param node - parsed or wire node.
 * @returns the line, indent-guided by depth (capped so deep trees stay short).
 */
function formatNode(node) {
	const parts = [`${node.id}`, `d${node.depth}`, node.cls || '?']
	if (node.text) parts.push(JSON.stringify(node.text))
	if (node.rid) parts.push(`rid=${node.rid}`)
	if (node.desc) parts.push(`desc=${JSON.stringify(node.desc)}`)
	if (node.box) parts.push(`[${node.box[0]},${node.box[1]}][${node.box[2]},${node.box[3]}]`)
	const flags = Array.isArray(node.flags) ? node.flags.join(' ') : node.flags
	if (flags) parts.push(`flags=${flags}`)
	return `${'  '.repeat(Math.min(node.depth, 6))}${parts.join(' ')}`
}

/**
 * Split a focus component into package and activity.
 * @param component - `pkg/activity` or a bare package/window name.
 * @returns `{ component, package, activity? }`.
 */
function splitComponent(component) {
	if (component === undefined) return undefined
	const slash = component.indexOf('/')
	return slash < 0
		? { component, package: component }
		: { component, package: component.slice(0, slash), activity: component.slice(slash + 1) }
}

/**
 * Quote a value so the DEVICE-side shell sees exactly one literal argument.
 * @param value - arbitrary text (model input, may contain quotes/metacharacters).
 * @returns a single-quoted shell word.
 */
function shellQuote(value) {
	return `'${String(value).replace(/'/g, '\'\"\'\"\'')}'`
}

/**
 * Encode text for `input text`: `%s` is the input tool's space, then quote for
 * the device shell so metacharacters stay literal.
 * @param value - text to type.
 * @returns a safe `input text` argument.
 */
function inputTextArg(value) {
	return shellQuote(String(value).replace(/ /g, '%s'))
}

/**
 * Extract the first XML document from a dump that may be padded with status lines.
 * @param raw - command stdout.
 * @returns the XML text, or undefined.
 */
function extractXml(raw) {
	const xmlStart = raw.indexOf('<?xml')
	const hierarchyStart = raw.indexOf('<hierarchy')
	const start = [xmlStart, hierarchyStart].filter((index) => index >= 0).sort((a, b) => a - b)[0]
	if (start === undefined) return undefined
	const end = raw.lastIndexOf('</hierarchy>')
	return end > start ? raw.slice(start, end + '</hierarchy>'.length) : raw.slice(start)
}

/**
 * Parse `wm size` / `wm density` output into screen metrics.
 * @param sizeOut - `wm size` text.
 * @param densityOut - `wm density` text.
 * @returns `{ width, height }` and `density`, preferring override values.
 */
function parseScreen(sizeOut, densityOut) {
	// `wm` prints the physical value first and an override second when one is
	// set; the override is what the user actually sees, so it wins.
	const last = (text, pattern) => {
		const re = new RegExp(pattern, 'g')
		let match = null
		let found
		while ((found = re.exec(text)) !== null) match = found
		return match
	}
	const size = last(sizeOut, '(?:Override size|Physical size):\\s*(\\d+)x(\\d+)')
	const density = last(densityOut, '(?:Override density|Physical density):\\s*(\\d+)')
	return {
		width: size === null ? undefined : Number(size[1]),
		height: size === null ? undefined : Number(size[2]),
		density: density === null ? undefined : Number(density[1])
	}
}

/**
 * Parse `dumpsys battery` into the fields worth showing.
 * @param text - dumpsys output.
 * @returns a compact battery object.
 */
function parseBattery(text) {
	const pick = (key) => new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'm').exec(text)
	const level = pick('level')
	const status = pick('status')
	const plugged = pick('plugged')
	const temperature = pick('temperature')
	const voltage = pick('voltage')
	const statusNames = { 1: 'unknown', 2: 'charging', 3: 'discharging', 4: 'not_charging', 5: 'full' }
	const plugNames = { 0: 'none', 1: 'ac', 2: 'usb', 4: 'wireless' }
	const battery = {}
	if (level) battery.level = Number(level[1])
	if (status && statusNames[status[1]]) battery.status = statusNames[status[1]]
	if (plugged && plugNames[plugged[1]]) battery.plugged = plugNames[plugged[1]]
	if (temperature) battery.temperatureC = Number(temperature[1]) / 10
	if (voltage) battery.voltageMv = Number(voltage[1])
	return battery
}

/**
 * Parse `getprop` output for the identity fields the model should know.
 * @param text - full getprop output.
 * @returns device identity, omitting what is absent.
 */
function parseProps(text) {
	const wanted = ['ro.product.brand', 'ro.product.model', 'ro.product.device', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.display.id']
	const identity = {}
	for (const key of wanted) {
		const match = new RegExp(`\\[${key.replace(/\./g, '\\.')}\\]:\\s*\\[(.*)\\]`).exec(text)
		if (match && match[1] !== '') identity[key] = match[1]
	}
	return {
		brand: identity['ro.product.brand'],
		model: identity['ro.product.model'],
		device: identity['ro.product.device'],
		android: identity['ro.build.version.release'],
		sdk: identity['ro.build.version.sdk'] === undefined ? undefined : Number(identity['ro.build.version.sdk']),
		build: identity['ro.build.display.id']
	}
}

/**
 * Apply a `match` selector to a node list.
 * @param nodes - candidate nodes (usually the full parsed hierarchy).
 * @param selector - the model's `match` object.
 * @returns the selected node.
 */
function select(nodes, selector) {
	if (Object.keys(selector).length === 0) throw new Error('match must name at least one field (id/text/text_contains/desc/desc_contains/cls/pkg/nth)')
	const nth = selector.nth ?? 0
	const idMatches = (node) => node.rid !== undefined && (node.rid === selector.id || node.rid.endsWith(`/${selector.id}`))
	const matches = nodes.filter((node) => {
		if (selector.id !== undefined && !idMatches(node)) return false
		if (selector.text !== undefined && node.text !== selector.text) return false
		if (selector.text_contains !== undefined && !(node.text ?? '').includes(selector.text_contains)) return false
		if (selector.desc !== undefined && node.desc !== selector.desc) return false
		if (selector.desc_contains !== undefined && !(node.desc ?? '').includes(selector.desc_contains)) return false
		if (selector.cls !== undefined && !(node.cls ?? '').includes(selector.cls)) return false
		if (selector.pkg !== undefined && node.pkg !== selector.pkg) return false
		return true
	})
	if (matches.length === 0) {
		const withLabels = nodes.filter((node) => node.text || node.desc || node.rid).slice(0, 8).map((node) => formatNode(node))
		throw new Error(
			`no node matches ${JSON.stringify(selector)}; re-run android_ui — the screen may have changed. ` +
			(withLabels.length > 0 ? `Labelled nodes right now: ${withLabels.join(' | ')}` : 'The screen currently shows no labelled nodes.')
		)
	}
	if (nth >= matches.length) throw new Error(`nth=${nth} is out of range: ${matches.length} node(s) match ${JSON.stringify(selector)}`)
	return matches[nth]
}

/**
 * Require a coordinate for actions that cannot run without one.
 * @param args - validated tool arguments.
 * @param target - resolved target.
 * @returns the tap point.
 */
function requirePoint(args, target) {
	if (target?.point) return target.point
	throw new Error(`action "${args.action}" needs a target: pass node=<id> from android_ui, a match={...} selector, or x/y`)
}

/**
 * Normalize a key spec to an `input keyevent` code.
 * @param key - `BACK`, `KEYCODE_BACK`, `4`, or `42`.
 * @returns the code token.
 */
function normalizeKey(key) {
	if (key === undefined || key === '') throw new Error('key is required for action "key" (e.g. "BACK", "ENTER", "4")')
	const trimmed = String(key).trim()
	if (/^\d+$/.test(trimmed)) return trimmed
	const upper = trimmed.toUpperCase().replace(/\s+/g, '_')
	return upper.startsWith('KEYCODE_') ? upper : `KEYCODE_${upper}`
}

/**
 * Register the six `android_*` tools and the guidance section on the context.
 * @param ctx - registrant context carrying `tools` (and, when present, `systemPrompt`).
 * @param rawConfig - the deployment's config for this entry.
 */
export function apply(ctx, rawConfig) {
	const config = Config(rawConfig ?? {})
	// Pin the adb identity. On this deployment `/system/bin/adb` is a shim that
	// does `export HOME=$PWD`, so both the working directory AND `PWD` have to be
	// pinned or the key store follows the session workspace and every
	// wireless-debugging pairing is lost when the workspace changes.
	const adbHome = resolveAdbHome(config)
	const spawnBase = { cwd: adbHome, env: { ...process.env, HOME: adbHome, PWD: adbHome } }
	try {
		mkdirSync(join(adbHome, '.android'), { recursive: true })
	} catch {
		// adb reports its own failure clearly; a missing home is never silent here.
	}

	/** One client per requested serial (`''` = auto-pick). */
	const clients = new Map()
	/** Latest hierarchy per resolved serial: what `node` targeting reads. */
	const dumps = new Map()
	/** Monotonic screenshot counter within this process. */
	let shots = 0

	/**
	 * Resolve the device one call targets.
	 * @param serial - per-call override; empty uses the configured serial.
	 * @param signal - caller cancellation.
	 * @returns `{ adb, key }`, where `key` is the resolved serial.
	 */
	async function deviceFor(serial, signal) {
		const wanted = ((serial ?? '').trim() !== '' ? serial.trim() : config.serial.trim())
		let client = clients.get(wanted)
		if (client === undefined) {
			client = new Adb(config, wanted, spawnBase)
			clients.set(wanted, client)
		}
		const key = await client.pickSerial({ timeoutMs: config.timeoutMs, signal })
		return { adb: client, key }
	}

	/**
	 * Run a server-level adb verb (devices/connect/pair/disconnect), which must
	 * never carry `-s`: it operates on the adb server, not on one device.
	 * @param argv - arguments after the binary.
	 * @param options - timeout and caller signal.
	 * @returns the raw capture.
	 */
	const adbServer = (argv, options = {}) => run(config.adbPath, argv, { timeoutMs: config.timeoutMs, ...options, ...spawnBase })

	/**
	 * Read the attached-device rows from the adb server.
	 * @param signal - caller cancellation.
	 * @returns parsed `adb devices -l` rows.
	 */
	async function listDeviceRows(signal) {
		const res = await adbServer(['devices', '-l'], { signal })
		return parseDevices(res.stdout.toString('utf8'))
	}

	/**
	 * Register one tool, guaranteeing its canonical value is lossless JSON.
	 * Device reads legitimately have no value for some fields, and an absent
	 * field must be absent rather than present-and-undefined.
	 * @param definition - a `defineTool` definition.
	 * @returns the registry result.
	 */
	const registerTool = (definition) => ctx.tools.register({
		...definition,
		execute: async (args, exec) => compact(await definition.execute(args, exec))
	})

	/** Per-call device selector every device-scoped tool declares. */
	const SERIAL_PARAM = {
		type: 'string',
		description: 'Target device serial (see android_devices). Omit for the configured serial, or the single attached device.'
	}

	/**
	 * Dump the view hierarchy, trying the portable recipes in order.
	 * @param device - resolved `{ adb, key }` target.
	 * @param options - dispatch options (timeout/signal).
	 * @returns the raw XML document.
	 */
	async function dumpXml(device, options) {
		const remote = '/data/local/tmp/dsh-adb-ui.xml'
		// Each recipe removes its own output first, so a failed dump yields no
		// XML at all instead of a stale file from an earlier call.
		const recipes = [
			['shell', `rm -f ${remote}; uiautomator dump ${remote} >/dev/null 2>&1 && cat ${remote}`],
			['shell', 'rm -f /sdcard/dsh-adb-ui.xml; uiautomator dump /sdcard/dsh-adb-ui.xml >/dev/null 2>&1 && cat /sdcard/dsh-adb-ui.xml'],
			['exec-out', 'uiautomator dump', '/dev/tty']
		]
		const failures = []
		for (const recipe of recipes) {
			const res = recipe[0] === 'shell'
				? await device.adb.exec(['shell', recipe[1]], options)
				: await device.adb.execOut(recipe.slice(1), options)
			const raw = res.stdout.toString('utf8')
			const xml = extractXml(raw)
			if (xml !== undefined && xml.includes('<node')) return xml
			failures.push(`${recipe.join(' ')} → ${(raw + res.stderr).trim().slice(0, 300) || '(no output)'}`)
		}
		throw new Error(
			`uiautomator dump failed on every recipe for ${device.key} — the screen is likely off, locked, or already held by another uiautomator session. ` +
			`Attempts: ${failures.join(' | ')}`
		)
	}

	/**
	 * Dump and parse, refreshing this device's cache that `node` targeting reads.
	 * @param device - resolved `{ adb, key }` target.
	 * @param options - dispatch options.
	 * @returns the fresh hierarchy plus its capture time.
	 */
	async function freshDump(device, options = { timeoutMs: config.dumpTimeoutMs }) {
		const xml = await dumpXml(device, options)
		const parsed = parseHierarchy(xml)
		const focus = await device.adb.focus({ timeoutMs: config.timeoutMs, signal: options.signal }).catch(() => undefined)
		const root = parsed.nodes.find((node) => node.depth === 0)
		const cachedNow = {
			at: Date.now(),
			serial: device.key,
			rotation: parsed.rotation,
			nodes: parsed.nodes,
			screen: root?.box ? [root.box[2], root.box[3]] : undefined,
			focus
		}
		dumps.set(device.key, cachedNow)
		return cachedNow
	}

	/**
	 * Screen size for whole-screen gestures, preferring this device's cached dump.
	 * @param device - resolved `{ adb, key }` target.
	 * @param signal - caller cancellation.
	 * @returns `[width, height]`.
	 */
	async function screenSize(device, signal) {
		const cached = dumps.get(device.key)
		if (cached?.screen) return cached.screen
		const res = await device.adb.shell('wm size; wm density', { timeoutMs: config.timeoutMs, signal })
		const parsed = parseScreen(res.stdout, res.stdout)
		if (parsed.width === undefined) throw new Error(`cannot read screen size from 'wm size': ${res.stdout.trim() || res.stderr.trim()}`)
		return [parsed.width, parsed.height]
	}

	/**
	 * Resolve an action's target to a tap point.
	 * Non-actionable matches climb to the nearest actionable ancestor, so tapping
	 * a label lands on the widget that actually handles the gesture.
	 * @param device - resolved `{ adb, key }` target.
	 * @param args - validated tool arguments.
	 * @param signal - caller cancellation.
	 * @returns `{ via, node, from, point }`.
	 */
	async function resolveTarget(device, args, signal) {
		if (args.node !== undefined || args.match !== undefined) {
			let dump = dumps.get(device.key)
			if (args.match !== undefined) dump = await freshDump(device, { timeoutMs: config.dumpTimeoutMs, signal })
			else if (dump === undefined) throw new Error('no cached UI dump: call android_ui first, then address the node id it returned (or use match/x/y instead)')
			const node = args.node !== undefined
				? dump.nodes[args.node]
				: select(dump.nodes, args.match)
			if (node === undefined) throw new Error(`node ${args.node} is not in the cached dump (${dump.nodes.length} nodes, taken ${Math.round((Date.now() - dump.at) / 1000)}s ago): re-run android_ui`)
			let landed = node
			if (args.action === 'tap' || args.action === 'long_press') {
				let cursor = node
				while (cursor !== null && cursor !== undefined && !cursor.flags.includes('click')) cursor = cursor.parent === null ? null : dump.nodes[cursor.parent]
				if (cursor !== null && cursor !== undefined) landed = cursor
			}
			const point = landed.box
				? [Math.round((landed.box[0] + landed.box[2]) / 2), Math.round((landed.box[1] + landed.box[3]) / 2)]
				: node.box
					? [Math.round((node.box[0] + node.box[2]) / 2), Math.round((node.box[1] + node.box[3]) / 2)]
					: undefined
			if (point === undefined) throw new Error(`node ${node.id} (${node.cls}) has no bounds; target it by x/y instead`)
			return { via: args.node !== undefined ? 'node' : 'match', node: landed, from: node, point }
		}
		if (args.x !== undefined && args.y !== undefined) return { via: 'point', node: undefined, from: undefined, point: [args.x, args.y] }
		return null
	}

	/**
	 * Build the device-side commands for one action, in run order.
	 * @param device - resolved `{ adb, key }` target.
	 * @param args - validated tool arguments.
	 * @param target - resolved target, when the action needs one.
	 * @param signal - caller cancellation.
	 * @returns shell words per command (already quoted where needed), in order.
	 */
	async function planAction(device, args, target, signal) {
		switch (args.action) {
			case 'tap':
			case 'long_press': {
				const point = requirePoint(args, target)
				return args.action === 'tap'
					? [['input', 'tap', `${point[0]}`, `${point[1]}`]]
					: [['input', 'swipe', `${point[0]}`, `${point[1]}`, `${point[0]}`, `${point[1]}`, `${args.duration_ms ?? 800}`]]
			}
			case 'swipe': {
				const [width, height] = await screenSize(device, signal)
				const center = target?.point ?? [Math.round(width / 2), Math.round(height / 2)]
				const fraction = args.distance ?? 0.6
				if (fraction <= 0 || fraction > 1) throw new Error(`distance must be in (0, 1] — it is a fraction of the target box (got ${fraction})`)
				const span = args.direction === 'up' || args.direction === 'down' ? height : width
				const reach = Math.round(span * fraction) / 2
				const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[args.direction ?? 'up']
				const from = [Math.round(center[0] - delta[0] * reach), Math.round(center[1] - delta[1] * reach)]
				const to = [Math.round(center[0] + delta[0] * reach), Math.round(center[1] + delta[1] * reach)]
				return [['input', 'swipe', `${from[0]}`, `${from[1]}`, `${to[0]}`, `${to[1]}`, `${args.duration_ms ?? 300}`]]
			}
			case 'text': {
				if (args.text === undefined || args.text === '') throw new Error('text is required for action "text"')
				const focusTap = target === null ? [] : await planAction(device, { ...args, action: 'tap' }, target, signal)
				return [...focusTap, ['input', 'text', inputTextArg(args.text)]]
			}
			case 'clear': {
				const focusTap = target === null ? [] : await planAction(device, { ...args, action: 'tap' }, target, signal)
				// MOVE_END then repeated DEL clears the focused field in one injection.
				const deletes = Array.from({ length: 300 }, () => '67')
				return [...focusTap, ['input', 'keyevent', '123', ...deletes]]
			}
			case 'key': return [['input', 'keyevent', normalizeKey(args.key)]]
			case 'back': return [['input', 'keyevent', '4']]
			case 'home': return [['input', 'keyevent', '3']]
			case 'recents': return [['input', 'keyevent', '187']]
			default: throw new Error(`unknown action ${JSON.stringify(args.action)}`)
		}
	}

	// ── android_ui ────────────────────────────────────────────────────────────
	registerTool(defineTool({
		name: 'android_ui',
		description:
			'Dump the Android screen as a semantic, node-addressed view hierarchy (class, text, resource-id, bounds, action flags) — no screenshot and no pixel guessing. ' +
			'This is the map every android_action call addresses: act on a returned node id, or on a stable selector, never on guessed coordinates. ' +
			'Read it after every screen change; a stale dump points at nodes that are no longer there.',
		parameters: {
			refresh: {
				type: 'boolean',
				description: 'Query the device again (default true). false re-renders the cached dump without touching the device.'
			},
			interactive_only: {
				type: 'boolean',
				description: 'List only actionable nodes (click/long/scroll/edit/check) instead of every readable node.'
			},
			limit: {
				type: 'integer',
				description: `Maximum nodes to list (default ${config.maxNodes}).`
			},
			serial: SERIAL_PARAM
		},
		output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: renderUi(value) }] },
		timeoutMs: config.dumpTimeoutMs + 15000,
		presentCall: () => ({ card: 'generic', title: 'Android: dump UI hierarchy', kind: 'read' }),
		async execute(args, exec) {
			const device = await deviceFor(args.serial, exec.signal)
			const useCache = args.refresh === false
			const cachedDump = dumps.get(device.key)
			if (useCache && cachedDump === undefined) throw new Error(`no cached dump for ${device.key}: run android_ui with refresh=true first`)
			const dump = useCache ? cachedDump : await freshDump(device, { timeoutMs: config.dumpTimeoutMs, signal: exec.signal })
			const limit = args.limit ?? config.maxNodes
			const pool = args.interactive_only ? dump.nodes.filter(isActionable) : dump.nodes.filter(isInteresting)
			const shown = pool.slice(0, Math.max(limit, 1))
			const root = dump.nodes.find((node) => node.depth === 0)
			const focus = dump.focus ?? (await device.adb.focus({ signal: exec.signal }).catch(() => undefined))
			return {
				serial: device.key,
				screen: root?.box ? { width: root.box[2], height: root.box[3] } : undefined,
				rotation: dump.rotation,
				focus,
				nodes_seen: dump.nodes.length,
				nodes_listed: shown.length,
				truncated: shown.length < pool.length,
				cached: useCache,
				nodes: shown.map(toWire)
			}
		}
	}))

	/**
	 * Project one parsed node onto its compact wire shape.
	 * @param node - parsed node.
	 * @returns the model-visible node object.
	 */
	function toWire(node) {
		const wire = { id: node.id, depth: node.depth, cls: node.cls, box: node.box }
		if (node.text !== undefined) wire.text = node.text
		if (node.rid !== undefined) wire.rid = node.rid
		if (node.desc !== undefined) wire.desc = node.desc
		if (node.flags.length > 0) wire.flags = node.flags.join(' ')
		return wire
	}

	/**
	 * Render an `android_ui` value as the model-facing tree.
	 * @param value - the canonical tool value.
	 * @returns text content for the result.
	 */
	function renderUi(value) {
		const lines = []
		const screen = value.screen ? `${value.screen.width}x${value.screen.height}` : 'screen ?'
		lines.push(`${value.serial ?? '?'} · ${screen} rotation=${value.rotation ?? '?'} focus=${value.focus ?? '?'} · ${value.nodes_listed}/${value.nodes_seen} nodes${value.truncated ? ' (raise limit or use interactive_only for more)' : ''}${value.cached ? ' · cached dump' : ''}`)
		lines.push('address nodes with android_action node=<id>, or with match={rid|text|desc} which survives re-dumps; x/y is the last resort:')
		for (const node of value.nodes) lines.push(formatNode(node))
		if (value.nodes.length === 0) lines.push('(no nodes matched — the screen may be empty, off, or covered by a secure/surface view)')
		return clip(lines.join('\n'), config.maxOutputChars * 4)
	}

	// ── android_action ────────────────────────────────────────────────────────
	registerTool(defineTool({
		name: 'android_action',
		description:
			'Perform one Android UI action by ADDRESS, not by guessed pixels: target a node id from the latest android_ui, a stable selector (resource-id/text/content-desc), or explicit x/y. ' +
			'Actions: tap, long_press, swipe (direction + optional distance), text (types into the target, focusing it first), clear, key (keycode name or number), back, home, recents. ' +
			'The result reports the exact command run and the focus before/after, so you can confirm the screen actually changed before reading android_ui again.',
		parameters: {
			action: { type: 'string', enum: ACTIONS, required: true, description: 'What to do.' },
			node: { type: 'integer', description: 'Node id from the latest android_ui dump (resolved against that dump; pass verify=true to re-check it first).' },
			match: {
				type: 'object',
				additionalProperties: false,
				description: 'Selector resolved against a FRESH dump — the robust choice across re-renders. At least one field.',
				properties: {
					id: { type: 'string', description: 'resource-id, exact or bare (matches ".../id_name").' },
					text: { type: 'string', description: 'Exact node text.' },
					text_contains: { type: 'string', description: 'Substring of node text.' },
					desc: { type: 'string', description: 'Exact content-description.' },
					desc_contains: { type: 'string', description: 'Substring of content-description.' },
					cls: { type: 'string', description: 'Substring of the widget class, e.g. "Button".' },
					pkg: { type: 'string', description: 'Exact package name.' },
					nth: { type: 'integer', description: '0-based match index when several nodes match (default 0).' }
				}
			},
			x: { type: 'integer', description: 'Absolute X, only when no node/selector applies.' },
			y: { type: 'integer', description: 'Absolute Y, only when no node/selector applies.' },
			verify: { type: 'boolean', description: 'Re-dump before acting and fail if the UI changed under the node id (default false).' },
			direction: { type: 'string', enum: DIRECTIONS, description: 'Finger direction for swipe: up/down/left/right (default up).' },
			distance: { type: 'number', description: 'Swipe span as a fraction of the target box, (0,1] (default 0.6).' },
			duration_ms: { type: 'integer', description: 'Gesture duration in ms (swipe default 300, long_press default 800).' },
			text: { type: 'string', description: 'Text to type for action=text.' },
			key: { type: 'string', description: 'Keycode for action=key: "BACK", "KEYCODE_ENTER", or a number.' },
			serial: SERIAL_PARAM
		},
		output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: renderAction(value) }] },
		timeoutMs: Math.max(config.timeoutMs, config.dumpTimeoutMs) + 15000,
		presentCall: (args) => ({ card: 'generic', title: `Android: ${args.action ?? 'action'}`, kind: 'execute', rawInput: args }),
		async execute(args, exec) {
			const signal = exec.signal
			const device = await deviceFor(args.serial, signal)
			// `node` addresses the cached dump (what the model just read). An
			// explicit verify re-dumps and requires that id to still describe
			// the same widget, so a re-rendered screen cannot redirect the tap.
			if (args.verify && args.node !== undefined) {
				const cachedDump = dumps.get(device.key)
				if (cachedDump === undefined) throw new Error(`no cached dump for ${device.key}: run android_ui first`)
				const before = cachedDump.nodes[args.node]
				if (before === undefined) throw new Error(`verify failed: node ${args.node} is not in the cached dump — run android_ui again`)
				const fresh = await freshDump(device, { timeoutMs: config.dumpTimeoutMs, signal })
				const after = fresh.nodes[args.node]
				const same = after !== undefined && after.cls === before.cls && String(after.box) === String(before.box)
				if (!same) {
					const nowDescribe = after === undefined ? 'the node is gone' : `node ${args.node} is now ${after.cls} at [${(after.box ?? []).join('][')}]`
					throw new Error(`verify failed: the screen changed under node ${args.node} (${before.cls} at [${(before.box ?? []).join('][')}] → ${nowDescribe}) — run android_ui again`)
				}
			}
			const target = await resolveTarget(device, args, signal)
			const plans = await planAction(device, args, target, signal)
			const focusBefore = await device.adb.focus({ signal }).catch(() => undefined)
			const executed = []
			for (const words of plans) {
				const command = words.join(' ')
				const res = await device.adb.shell(command, { timeoutMs: config.timeoutMs, signal })
				executed.push(command)
				const detail = `${res.stdout}${res.stderr}`.trim()
				if (res.code !== 0 && detail !== '' && !/^OK$/m.test(detail)) throw new Error(`"${command}" failed (exit ${res.code}): ${detail.slice(0, 400)}`)
			}
			const focusAfter = await device.adb.focus({ signal }).catch(() => undefined)
			const result = { serial: device.key, action: args.action, executed }
			if (target) result.target = describeTarget(target)
			if (focusBefore !== undefined) result.focus_before = focusBefore
			if (focusAfter !== undefined) result.focus_after = focusAfter
			if (focusBefore !== undefined && focusAfter !== undefined && focusBefore !== focusAfter) result.screen_changed = true
			return result
		}
	}))

	/**
	 * Describe a resolved target for the result card.
	 * @param target - resolved target.
	 * @returns the wire description.
	 */
	function describeTarget(target) {
		const wire = { via: target.via, point: target.point }
		if (target.node) {
			wire.id = target.node.id
			wire.cls = target.node.cls
			if (target.node.text !== undefined) wire.text = target.node.text
			if (target.node.rid !== undefined) wire.rid = target.node.rid
			if (target.node.desc !== undefined) wire.desc = target.node.desc
			if (target.from && target.from.id !== target.node.id) wire.resolved_to = `clickable ancestor of node ${target.from.id}`
		}
		return wire
	}

	/**
	 * Render an `android_action` value for the model.
	 * @param value - the canonical tool value.
	 * @returns text content for the result.
	 */
	function renderAction(value) {
		const lines = [`action=${value.action}${value.serial ? ` on ${value.serial}` : ''}`]
		for (const command of value.executed) lines.push(`ran: ${command}`)
		if (value.target) {
			const target = value.target
			const label = [
				target.text !== undefined ? JSON.stringify(target.text) : null,
				target.rid ?? null,
				target.desc !== undefined ? JSON.stringify(target.desc) : null,
				target.cls ?? null
			].filter(Boolean).join(' ')
			lines.push(`target via ${target.via}: node ${target.id} ${label} → (${target.point[0]}, ${target.point[1]})${target.resolved_to ? ` (${target.resolved_to})` : ''}`)
		}
		if (value.focus_after !== undefined) lines.push(`focus after: ${value.focus_after}${value.screen_changed ? ' (changed)' : ' (unchanged)'}`)
		else if (value.focus_before !== undefined) lines.push(`focus: ${value.focus_before}`)
		return lines.join('\n')
	}

	// ── android_app ───────────────────────────────────────────────────────────
	registerTool(defineTool({
		name: 'android_app',
		description:
			'Manage installed apps on the device: launch an app by package (resolves its launcher activity for you), stop it, list every launchable app, read its version info, or ask which app is in the foreground. ' +
			'Prefer this over shell strings like `am start` — it resolves components and reports the resulting focus.',
		parameters: {
			action: { type: 'string', enum: APP_ACTIONS, required: true, description: 'current | launch | stop | list | info.' },
			package: { type: 'string', description: 'Package name; required for launch/stop/info, optional filter for list.' },
			activity: { type: 'string', description: 'Explicit activity for launch ("com.x.Y" or ".Main"), overriding launcher resolution.' },
			serial: SERIAL_PARAM
		},
		output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: renderApp(value) }] },
		timeoutMs: config.timeoutMs + 20000,
		presentCall: (args) => ({ card: 'generic', title: `Android: ${args.action ?? 'app'} app`, kind: 'execute', rawInput: args }),
		async execute(args, exec) {
			const signal = exec.signal
			const device = await deviceFor(args.serial, signal)
			const adb = device.adb
			if (args.action === 'current') {
				const focus = await adb.focus({ signal }).catch(() => undefined)
				return { serial: device.key, ...splitComponent(focus) }
			}
			if (args.action === 'list') {
				const recipes = [
					'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER',
					'pm query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER',
					'cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER'
				]
				let text = ''
				for (const recipe of recipes) {
					const res = await adb.shell(recipe, { timeoutMs: config.timeoutMs, signal })
					text = res.stdout
					if (text.includes('/')) break
				}
				const components = []
				const seen = new Set()
				for (const line of text.split('\n')) {
					const trimmed = line.trim()
					const match = /^(?:[0-9a-f]+\s+)?([A-Za-z0-9_.]+)\/([A-Za-z0-9_.]+)\s*$/.exec(trimmed)
					if (!match || seen.has(trimmed)) continue
					seen.add(trimmed)
					components.push({ package: match[1], activity: match[2], component: trimmed })
				}
				const filter = args.package
				const filtered = filter === undefined ? components : components.filter((entry) => entry.component.includes(filter))
				if (components.length === 0) throw new Error(`no launchable activity resolved; device said: ${text.trim().slice(0, 300) || '(empty)'}`)
				return {
					serial: device.key,
					count: filtered.length,
					truncated: false,
					apps: filtered.slice(0, 200)
				}
			}
			const pkg = (args.package ?? '').trim()
			if (pkg === '') throw new Error(`action "${args.action}" requires \`package\``)
			if (args.action === 'stop') {
				const res = await adb.shell(`am force-stop ${shellQuote(pkg)}`, { timeoutMs: config.timeoutMs, signal })
				if (res.code !== 0) throw new Error(`force-stop failed: ${(res.stdout + res.stderr).trim()}`)
				const focus = await adb.focus({ signal }).catch(() => undefined)
				return { serial: device.key, action: 'stop', package: pkg, focus_after: focus }
			}
			if (args.action === 'info') {
				const res = await adb.shell(`dumpsys package ${shellQuote(pkg)}`, { timeoutMs: config.timeoutMs, signal })
				const text = res.stdout
				if (res.code !== 0 || /No such package|Unable to find package/i.test(text + res.stderr)) {
					throw new Error(`package ${pkg} not found on the device: ${(text + res.stderr).trim().slice(0, 300)}`)
				}
				const grab = (pattern) => pattern.exec(text)?.[1]
				const info = { serial: device.key, package: pkg }
				const versionName = grab(/\bversionName=([^\s]+)/)
				const versionCode = grab(/\bversionCode=(\d+)/)
				const targetSdk = grab(/\btargetSdk=(\d+)/)
				const uid = grab(/^\s*userId=(\d+)/m)
				if (versionName) info.versionName = versionName
				if (versionCode) info.versionCode = Number(versionCode)
				if (targetSdk) info.targetSdk = Number(targetSdk)
				if (uid) info.uid = Number(uid)
				info.installed = /\bPackage \[[^\]]+\] \(/.test(text) || /codePath=/.test(text)
				return info
			}
			// launch
			let component = null
			if (args.activity !== undefined) {
				const activity = args.activity
				if (activity.includes('/')) component = activity
				else if (activity.startsWith('.')) component = `${pkg}/${pkg}${activity}`
				else if (activity.includes('.')) component = `${pkg}/${activity}`
				else component = `${pkg}/${pkg}.${activity}`
			} else {
				const recipes = [
					`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${shellQuote(pkg)}`,
					`pm resolve-activity --brief -c android.intent.category.LAUNCHER ${shellQuote(pkg)}`
				]
				for (const recipe of recipes) {
					const res = await adb.shell(recipe, { timeoutMs: config.timeoutMs, signal })
					const line = res.stdout.split('\n').map((row) => row.trim()).filter((row) => row.includes('/')).pop()
					if (line) {
						component = line
						break
					}
				}
			}
			if (component === null) throw new Error(`cannot resolve a launcher activity for ${pkg} — is it installed, and does it export a launcher intent?`)
			const res = await adb.shell(`am start -W -n ${shellQuote(component)}`, { timeoutMs: config.timeoutMs + 10000, signal })
			const output = `${res.stdout}\n${res.stderr}`.trim()
			if (/Error:|Exception|Unable to resolve|Permission Denial/i.test(output)) throw new Error(`am start failed for ${component}: ${output.slice(0, 400)}`)
			const focus = await adb.focus({ signal }).catch(() => undefined)
			const totalTime = /TotalTime:\s*(\d+)/.exec(output)
			return {
				serial: device.key,
				action: 'launch',
				component,
				package: pkg,
				totalTimeMs: totalTime === null ? undefined : Number(totalTime[1]),
				focus_after: focus
			}
		}
	}))

	/**
	 * Render an `android_app` value for the model.
	 * @param value - the canonical tool value.
	 * @returns text content for the result.
	 */
	function renderApp(value) {
		if (value.apps) {
			const lines = [`${value.count} launchable app(s):`]
			for (const app of value.apps) lines.push(`${app.component}`)
			if (value.count > value.apps.length) lines.push(`… [${value.count - value.apps.length} more]`)
			return clip(lines.join('\n'), config.maxOutputChars * 4)
		}
		return Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
			.join('\n')
	}

	// ── android_state ─────────────────────────────────────────────────────────
	registerTool(defineTool({
		name: 'android_state',
		description:
			'Read device state in one call: identity (brand/model/Android/SDK), screen size/density/rotation, battery, screen on/off, and the focused component. ' +
			'Call it first when starting device work, and whenever you need to know which app the device is on.',
		parameters: { serial: SERIAL_PARAM },
		output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: renderState(value) }] },
		timeoutMs: config.timeoutMs + 20000,
		isConcurrencySafe: () => true,
		presentCall: () => ({ card: 'generic', title: 'Android: read device state', kind: 'read' }),
		async execute(args, exec) {
			const signal = exec.signal
			const device = await deviceFor(args.serial, signal)
			const adb = device.adb
			const options = { timeoutMs: config.timeoutMs, signal }
			const [props, screen, battery, power, window] = await Promise.all([
				adb.shell('getprop', options).catch(() => ({ stdout: '' })),
				adb.shell('wm size; wm density', options),
				adb.shell('dumpsys battery', options).catch(() => ({ stdout: '' })),
				adb.shell('dumpsys power | grep -E "mWakefulness="', options).catch(() => ({ stdout: '' })),
				adb.windowState(options).catch(() => ({ focus: undefined, rotation: undefined }))
			])
			const metrics = parseScreen(screen.stdout, screen.stdout)
			const wake = /mWakefulness=(\w+)/.exec(power.stdout)
			const identity = parseProps(props.stdout)
			const component = window.focus === undefined ? undefined : splitComponent(window.focus)
			const state = { serial: device.key }
			if (Object.values(identity).some((value) => value !== undefined)) state.device = identity
			if (metrics.width !== undefined || metrics.density !== undefined) {
				state.screen = {
					width: metrics.width,
					height: metrics.height,
					density: metrics.density,
					rotation: window.rotation
				}
			}
			const batteryValue = parseBattery(battery.stdout)
			if (Object.keys(batteryValue).length > 0) state.battery = batteryValue
			if (wake) state.screenOn = wake[1] === 'Awake'
			if (component) state.focus = component
			return state
		}
	}))

	/**
	 * Render an `android_state` value for the model.
	 * @param value - the canonical tool value.
	 * @returns text content for the result.
	 */
	function renderState(value) {
		const lines = []
		if (value.serial) lines.push(`serial: ${value.serial}`)
		if (value.device) {
			const parts = [value.device.brand, value.device.model, value.device.device].filter(Boolean).join(' ')
			lines.push(`device: ${parts || '(unknown)'} · android ${value.device.android ?? '?'} (sdk ${value.device.sdk ?? '?'}) build ${value.device.build ?? '?'}`)
		}
		if (value.screen) {
			lines.push(`screen: ${value.screen.width ?? '?'}x${value.screen.height ?? '?'} density=${value.screen.density ?? '?'} rotation=${value.screen.rotation ?? '?'}° on=${value.screenOn ?? '?'}`)
		} else if (value.screenOn !== undefined) {
			lines.push(`screen on: ${value.screenOn}`)
		}
		if (value.battery) {
			const battery = value.battery
			lines.push(`battery: ${battery.level ?? '?'}% ${battery.status ?? ''} ${battery.plugged ?? ''} ${battery.temperatureC !== undefined ? `${battery.temperatureC}°C` : ''}`.trim())
		}
		if (value.focus) lines.push(`focus: ${value.focus.component}${value.focus.activity ? ` (${value.focus.activity})` : ''}`)
		return lines.join('\n') || JSON.stringify(value)
	}

	// ── android_screenshot ────────────────────────────────────────────────────
	registerTool(defineTool({
		name: 'android_screenshot',
		description:
			'Capture the screen to a local PNG and return its path. Use it when you truly need pixels (charts, icons, images, layout verification) — for finding WHAT to tap, android_ui is cheaper and exact. ' +
			'Open the returned path with read_image to look at it.',
		parameters: {
			max_width: { type: 'integer', description: 'Preferred maximum width in px; the PNG is only downscaled when the harness supports it (informational today).' },
			serial: SERIAL_PARAM
		},
		output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: renderShot(value) }] },
		timeoutMs: config.timeoutMs + 30000,
		presentCall: () => ({ card: 'generic', title: 'Android: capture screenshot', kind: 'read' }),
		async execute(args, exec) {
			const device = await deviceFor(args.serial, exec.signal)
			const res = await device.adb.execOut(['screencap', '-p'], { timeoutMs: config.timeoutMs + 20000, signal: exec.signal, maxBytes: 64 * 1024 * 1024 })
			const bytes = res.stdout
			if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
				throw new Error(`screencap did not return a PNG (${bytes.length} bytes): ${bytes.toString('utf8').slice(0, 200) || res.stderr.slice(0, 200)}`)
			}
			const dir = config.shotDir.trim() === ''
				? join(process.env.TMPDIR ?? join(process.env.DSH_HOME ?? process.cwd(), 'tmp'), 'dsh-adb')
				: config.shotDir
			await mkdir(dir, { recursive: true })
			shots += 1
			const stamp = new Date().toISOString().replace(/[:.]/g, '-')
			const path = join(dir, `screen-${stamp}-${shots}.png`)
			await writeFile(path, bytes)
			const width = bytes.readUInt32BE(16)
			const height = bytes.readUInt32BE(20)
			return { serial: device.key, path, width, height, bytes: bytes.length, mediaType: 'image/png' }
		}
	}))

	/**
	 * Render an `android_screenshot` value for the model.
	 * @param value - the canonical tool value.
	 * @returns text content for the result.
	 */
	function renderShot(value) {
		return [
			`<path>${value.path}</path>`,
			'<type>image</type>',
			`<content>${value.mediaType} image, ${value.width}x${value.height} px, ${value.bytes} bytes</content>`,
			'Open it with read_image (file_path above) to look at the screen. For locating controls, android_ui is exact and cheaper.'
		].join('\n')
	}

	// ── android_shell (optional) ──────────────────────────────────────────────
	if (config.enableShell) {
		registerTool(defineTool({
			name: 'android_shell',
			description:
				'Run one raw adb shell command and return its output — the escape hatch for diagnostics and anything the structured tools do not cover ' +
				'(dumpsys, pm/list packages, logcat -d, settings, getprop, install/uninstall). ' +
				'Prefer the android_* tools for UI work; this exists for discovery and system-level reads.',
			parameters: {
				command: { type: 'string', required: true, description: 'The device-side shell command, e.g. "dumpsys package com.example".' },
				timeout_ms: { type: 'integer', description: `Command budget in ms (default ${config.timeoutMs}).` },
				serial: SERIAL_PARAM
			},
			output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: renderShell(value) }] },
			timeoutMs: config.timeoutMs + 20000,
			presentCall: (args) => ({ card: 'terminal', title: args.command ?? 'adb shell', description: 'adb shell (Android device)' }),
			async execute(args, exec) {
				const timeoutMs = Math.min(args.timeout_ms ?? config.timeoutMs, 120000)
				const device = await deviceFor(args.serial, exec.signal)
				const res = await device.adb.shell(args.command, { timeoutMs, signal: exec.signal })
				return {
					serial: device.key,
					command: args.command,
					exit: res.code,
					timed_out: res.timedOut,
					stdout: clip(res.stdout, config.maxOutputChars),
					stderr: clip(res.stderr, Math.min(config.maxOutputChars, 2000))
				}
			}
		}))
	}

	/**
	 * Render an `android_shell` value for the model.
	 * @param value - the canonical tool value.
	 * @returns text content for the result.
	 */
	function renderShell(value) {
		const lines = [`$ ${value.command}${value.serial ? `   (on ${value.serial})` : ''}`, `exit ${value.exit}${value.timed_out ? ' (timed out)' : ''}`]
		if (value.stdout !== '') lines.push(value.stdout)
		if (value.stderr !== '') lines.push(`[stderr] ${value.stderr}`)
		return lines.join('\n')
	}

	// ── android_devices ───────────────────────────────────────────────────────
	registerTool(defineTool({
		name: 'android_devices',
		description:
			'Attach and enumerate Android devices for the adb server: list every attached device (serial, state, model), connect to one over TCP/IP, ' +
			'disconnect, or pair with a device that shows a wireless-debugging pairing code. ' +
			'This is how a second device becomes addressable: list to find its serial, then pass that serial to any other android_* tool.',
		parameters: {
			action: { type: 'string', enum: ['list', 'connect', 'disconnect', 'pair'], required: true, description: 'list (default view of attached devices) | connect | disconnect | pair.' },
			host: { type: 'string', description: 'Host and optional port for connect/disconnect/pair, e.g. "192.168.2.77:5555". A bare host uses port 5555.' },
			code: { type: 'string', description: 'The 6-digit pairing code shown by the target device, for action=pair.' }
		},
		output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: renderDevices(value) }] },
		timeoutMs: config.timeoutMs + 45000,
		presentCall: (args) => ({ card: 'generic', title: `Android devices: ${args.action ?? 'list'}`, kind: 'read', rawInput: args }),
		async execute(args, exec) {
			const signal = exec.signal
			if (args.action === 'list') {
				// Same settling rule as device selection: right after an adb
				// server start a row can read `authorizing`/`offline` before it
				// settles, and reporting that as the truth misleads the model
				// into believing the device is unusable.
				let rows = await listDeviceRows(signal)
				for (let attempt = 0; attempt < 5 && rows.length > 0 && rows.every((row) => row.state !== 'device'); attempt += 1) {
					if (signal?.aborted) break
					await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 300))
					rows = await listDeviceRows(signal)
				}
				return {
					adb_home: adbHome,
					configured_serial: config.serial.trim() === '' ? null : config.serial.trim(),
					count: rows.length,
					devices: rows
				}
			}
			const target = (args.host ?? '').trim()
			if (target === '') throw new Error(`action "${args.action}" requires \`host\` (e.g. "192.168.2.77:5555")`)
			if (args.action === 'pair') {
				const code = (args.code ?? '').trim()
				if (code === '') throw new Error('action "pair" requires the 6-digit `code` the target shows in its wireless-debugging pairing dialog')
				const res = await adbServer(['pair', target, code], { signal, timeoutMs: config.timeoutMs + 30000 })
				const output = `${res.stdout.toString('utf8')}\n${res.stderr}`.trim()
				if (/failed|cannot|unable|refused|timed out/i.test(output)) throw new Error(`adb pair failed for ${target}: ${output.slice(0, 400)}`)
				return { action: 'pair', host: target, paired: true, output: clip(output, 1000) }
			}
			const res = await adbServer([args.action, target], { signal, timeoutMs: config.timeoutMs + 20000 })
			const output = `${res.stdout.toString('utf8')}\n${res.stderr}`.trim()
			if (/failed|cannot|unable|refused|timed out|unknown host/i.test(output)) throw new Error(`adb ${args.action} failed for ${target}: ${output.slice(0, 400)}`)
			const after = parseDevices((await adbServer(['devices', '-l'], { signal })).stdout.toString('utf8'))
			return { action: args.action, host: target, output: clip(output, 1000), devices: after }
		}
	}))

	/**
	 * Render an `android_devices` value for the model.
	 * @param value - the canonical tool value.
	 * @returns text content for the result.
	 */
	function renderDevices(value) {
		const lines = []
		if (value.output) lines.push(value.output)
		if (Array.isArray(value.devices)) {
			lines.push(`${value.devices.length} attached device(s):`)
			for (const row of value.devices) {
				lines.push(`${row.serial}\t${row.state}${row.model ? `\t${row.model}` : ''}${row.product ? ` (${row.product})` : ''}`)
			}
			const notReady = value.devices.filter((row) => row.state !== 'device')
			if (notReady.length > 0) lines.push(`not usable yet: ${notReady.map((row) => `${row.serial} (${row.state})`).join(', ')} — authorize on the device, or connect/pair it first`)
			if (value.devices.length === 0) lines.push('(none — check the cable/wireless-debugging authorization, then connect or pair)')
		}
		if (value.adb_home) {
			lines.push(`adb home: ${value.adb_home}${value.configured_serial ? ` · pinned serial: ${value.configured_serial}` : ''}`)
			lines.push('pass a listed serial to any android_* tool (serial=...) to address that device; set `serial` in the plugin config to change the default.')
		}
		return clip(lines.join('\n'), config.maxOutputChars * 2)
	}

	// ── guidance section (optional service) ───────────────────────────────────
	if (config.guidance) {
		ctx.inject(['systemPrompt'], (promptCtx) => {
			promptCtx.systemPrompt.section({
				name: 'android:adb',
				order: 6100,
				text: GUIDANCE
			})
		})
	}
}

/** Model-facing operating guidance, registered as a system-prompt section. */
const GUIDANCE = `## Controlling an Android device (adb)

Drive the attached device through the android_* tools. Work semantically — never guess pixel coordinates from a screenshot:

1. Read the screen with \`android_ui\`: it returns node-addressed rows (\`<id> d<depth> <class> "text" rid=... [box] flags=click scroll\`). Call it first, and again after every screen change.
2. Act with \`android_action\`, addressing a target in this order of preference:
   - \`match\` — resource-id/text/content-desc selector, resolved against a fresh dump; robust when the screen re-renders.
   - \`node\` — the id from your latest \`android_ui\`; fastest on a stable screen (use \`verify: true\` when a wrong tap would be costly).
   - \`x\`/\`y\` — last resort, only when nothing is addressable.
3. The action result carries \`focus_before\`/\`focus_after\` and \`screen_changed\`. When the UI is async and focus looks unchanged, wait by re-reading \`android_ui\` before repeating an action.
4. Supporting tools: \`android_app\` (launch/stop/list/info), \`android_state\` (device, screen, battery, focus), \`android_screenshot\` (PNG path — open with read_image), \`android_shell\` (dumpsys/pm/logcat diagnostics).
5. A blank or failed \`android_ui\` usually means the screen is off or locked — wake/unlock it with \`android_action { action: "key", key: "WAKEUP" }\` (then swipe to unlock) and retry.
6. More than one device: \`android_devices\` lists attached devices and can \`connect\`/\`pair\` new ones over TCP/IP. Every android_* tool accepts \`serial\` to address one listed device for that call; without it you get the configured device, or the single attached one.`


/**
 * Pure helpers exposed for the package self-test. Not part of the loader
 * contract and never used by the tools at runtime.
 * @internal
 */
export const __testing = {
	parseHierarchy,
	extractXml,
	unescapeXml,
	isInteresting,
	isActionable,
	formatNode,
	select,
	requirePoint,
	normalizeKey,
	shellQuote,
	inputTextArg,
	parseScreen,
	parseBattery,
	parseProps,
	parseFocus,
	parseRotation,
	parseDevices,
	resolveAdbHome,
	splitComponent
}
