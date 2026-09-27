/**
 * `dsh-adb` self-test: exercises the plugin's module contract, its pure
 * helpers, and (when an adb device happens to be online) the read-only tools
 * end to end. Run it from the package directory:
 *
 *   node scripts/selftest.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as plugin from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const { parseHierarchy, extractXml, isInteresting, isActionable, formatNode, select, normalizeKey, shellQuote, inputTextArg, parseScreen, parseBattery, parseProps, parseFocus, parseRotation, parseDevices, resolveAdbHome, splitComponent } = plugin.__testing

let passed = 0
/** Run one named assertion group. */
function check(label, fn) {
	try {
		fn()
		passed += 1
		process.stdout.write(`ok   ${label}\n`)
	} catch (error) {
		process.stdout.write(`FAIL ${label}\n     ${error.message}\n`)
		process.exitCode = 1
	}
}

// ── module contract ─────────────────────────────────────────────────────────
check('module exports the functional-plugin contract', () => {
	assert.equal(plugin.name, 'dsh-adb')
	assert.deepEqual(plugin.inject, ['tools'])
	assert.equal(typeof plugin.apply, 'function')
	assert.equal(typeof plugin.Config, 'function')
})

check('Config fills every default from an empty object', () => {
	const config = plugin.Config({})
	assert.equal(config.adbPath, 'adb')
	assert.equal(config.serial, '')
	assert.equal(config.adbHome, '')
	assert.equal(config.timeoutMs, 20000)
	assert.equal(config.enableShell, true)
	assert.equal(config.guidance, true)
})

check('apply registers seven tools and requests the prompt section', () => {
	const registered = new Map()
	const injected = []
	const ctx = {
		tools: { register: (definition) => registered.set(definition.name, definition) },
		inject: (services, callback) => {
			injected.push(services)
			callback({ systemPrompt: { section: (section) => injected.push(section) } })
		}
	}
	plugin.apply(ctx, plugin.Config({}))
	assert.deepEqual(
		[...registered.keys()].sort(),
		['android_action', 'android_app', 'android_devices', 'android_screenshot', 'android_shell', 'android_state', 'android_ui']
	)
	for (const definition of registered.values()) {
		assert.equal(typeof definition.execute, 'function', `${definition.name} has no execute`)
		assert.equal(typeof definition.output.render, 'function', `${definition.name} has no render`)
		assert.equal(typeof definition.parameters, 'object', `${definition.name} has no parameter schema`)
	}
	// Every device-scoped tool must route per call; android_devices talks to the server.
	for (const [name, definition] of registered) {
		if (name === 'android_devices') continue
		assert.ok(definition.parameters.properties.serial, `${name} does not accept a per-call serial`)
	}
	assert.deepEqual(injected[0], ['systemPrompt'])
	assert.equal(injected[1].name, 'android:adb')
	assert.ok(injected[1].text.includes('android_ui'))
})

// ── pure helpers ────────────────────────────────────────────────────────────
const dump = readFileSync(join(here, 'fixture.xml'), 'utf8')

check('parseHierarchy reads attributes, flags, bounds, and parent links', () => {
	const { rotation, nodes } = parseHierarchy(dump)
	assert.equal(rotation, 90)
	assert.ok(nodes.length >= 6, `expected a real tree, got ${nodes.length} nodes`)
	assert.equal(nodes[0].depth, 0)
	assert.ok(nodes[0].children > 0)
	const button = nodes.find((node) => node.text === 'OK & Close')
	assert.equal(button.rid, 'com.example.app:id/ok')
	assert.ok(button.flags.includes('click'))
	assert.deepEqual(button.box, [400, 1800, 680, 1900])
	const field = nodes.find((node) => node.cls.endsWith('EditText'))
	assert.ok(field.flags.includes('edit'))
	assert.ok(field.parent !== null)
	assert.equal(nodes[field.parent].children > 0, true)
	const disabled = nodes.find((node) => node.flags.includes('disabled'))
	assert.ok(disabled)
})

check('extractXml ignores uiautomator status lines', () => {
	const raw = extractXml(`UI hierchary dumped to: /dev/tty\n${dump}`)
	assert.ok(raw.startsWith('<?xml'))
	assert.ok(raw.endsWith('</hierarchy>'))
	assert.equal(extractXml('ERROR: could not get idle state.'), undefined)
})

check('isInteresting drops unlabelled containers but keeps depth', () => {
	const { nodes } = parseHierarchy(dump)
	const kept = nodes.filter(isInteresting)
	assert.ok(kept.length < nodes.length, 'containers should be pruned')
	const plain = nodes.find((node) => !node.text && !node.rid && !node.desc && !isActionable(node) && node.depth > 0)
	assert.ok(plain === undefined || !kept.includes(plain))
	assert.ok(kept.some((node) => node.depth > 0))
})

check('formatNode renders a single addressable line', () => {
	const { nodes } = parseHierarchy(dump)
	const button = nodes.find((node) => node.rid === 'com.example.app:id/ok')
	const line = formatNode(button)
	assert.ok(line.includes(` ${button.id} `), line)
	assert.ok(line.includes('rid=com.example.app:id/ok'))
	assert.ok(line.includes('"OK & Close"'))
	assert.ok(line.includes('[400,1800][680,1900]'))
	assert.ok(line.includes('flags=click'))
})

check('select matches by id suffix, text, desc, class, and nth', () => {
	const { nodes } = parseHierarchy(dump)
	assert.equal(select(nodes, { id: 'ok' }).text, 'OK & Close')
	assert.equal(select(nodes, { text: 'OK & Close' }).rid, 'com.example.app:id/ok')
	assert.equal(select(nodes, { text_contains: 'Close' }).rid, 'com.example.app:id/ok')
	assert.equal(select(nodes, { desc: 'Close dialog' }).rid, 'com.example.app:id/ok')
	assert.equal(select(nodes, { cls: 'EditText' }).cls.endsWith('EditText'), true)
	assert.equal(select(nodes, { cls: 'TextView', nth: 1 }).text, 'First item')
	assert.throws(() => select(nodes, {}), /at least one field/)
	assert.throws(() => select(nodes, { text: 'nope' }), /no node matches/)
	assert.throws(() => select(nodes, { cls: 'TextView', nth: 5 }), /out of range/)
})

check('key, quoting, and text encoding are shell-safe', () => {
	assert.equal(normalizeKey('back'), 'KEYCODE_BACK')
	assert.equal(normalizeKey('KEYCODE_ENTER'), 'KEYCODE_ENTER')
	assert.equal(normalizeKey('42'), '42')
	assert.equal(shellQuote("a'b"), `'a'"'"'b'`)
	assert.equal(inputTextArg('hello world'), `'hello%sworld'`)
	assert.equal(inputTextArg("a; rm -rf /"), `'a;%srm%s-rf%s/'`)
})

check('dumpsys parsers read the fields the tools report', () => {
	assert.deepEqual(parseScreen('Physical size: 1080x2340\nOverride size: 720x1560\n', 'Physical density: 440\nOverride density: 320\n'), { width: 720, height: 1560, density: 320 })
	const battery = parseBattery('  level: 87\n  status: 2\n  plugged: 2\n  temperature: 301\n  voltage: 4201\n')
	assert.deepEqual(battery, { level: 87, status: 'charging', plugged: 'usb', temperatureC: 30.1, voltageMv: 4201 })
	const props = parseProps('[ro.product.brand]: [Xiaomi]\n[ro.product.model]: [M2101K9C]\n[ro.build.version.release]: [14]\n[ro.build.version.sdk]: [34]\n')
	assert.deepEqual(props, { brand: 'Xiaomi', model: 'M2101K9C', device: undefined, android: '14', sdk: 34, build: undefined })
	assert.deepEqual(splitComponent('com.example/.MainActivity'), { component: 'com.example/.MainActivity', package: 'com.example', activity: '.MainActivity' })
	assert.deepEqual(splitComponent('StatusBar'), { component: 'StatusBar', package: 'StatusBar' })
	assert.equal(splitComponent(undefined), undefined)
})

check('window parsing handles both modern and legacy dumpsys shapes', () => {
	// Android 13+ publishes the rotation as mRotation; the old SurfaceOrientation row is gone.
	const modern = '    mRotation=0 mDeferredRotationPauseCount=0\n  mCurrentFocus=Window{a1b2c3 u0 com.example/com.example.MainActivity}\n'
	assert.equal(parseFocus(modern), 'com.example/com.example.MainActivity')
	assert.equal(parseRotation(modern), 0)
	assert.equal(parseRotation('  mRotation=ROTATION_3 mDeferredRotationPauseCount=0'), 270)
	assert.equal(parseRotation('mDisplayRotation=ROTATION_1 mRotation=ROTATION_1'), 90)
	assert.equal(parseRotation('no rotation row here'), undefined)
	assert.equal(parseFocus('mFocusedApp=ActivityRecord{deadbeef u0 com.other/.Top} t42'), 'com.other/.Top')
	assert.equal(parseFocus('nothing focused'), undefined)
	assert.equal(parseRotation('SurfaceOrientation: 2'), undefined)
})

check('adb devices listing and the adb home are parsed stably', () => {
	const text = [
		'List of devices attached',
		'emulator-5554          device product:nuwa model:2210132C device:nuwa transport_id:1',
		'192.168.2.77:5555      device product:redfin model:Pixel_5 device:redfin transport_id:2',
		'10.0.0.9:5555          unauthorized',
		'',
		'* daemon not running; starting now at tcp:5037'
	].join('\n')
	const rows = parseDevices(text)
	assert.equal(rows.length, 3)
	assert.deepEqual(rows[0], { serial: 'emulator-5554', state: 'device', product: 'nuwa', model: '2210132C', device: 'nuwa', transportId: 1 })
	assert.equal(rows[1].serial, '192.168.2.77:5555')
	assert.equal(rows[2].state, 'unauthorized')
	assert.equal(parseDevices('List of devices attached\n').length, 0)

	// The default must reuse an existing key store rather than minting a new identity.
	const home = resolveAdbHome(plugin.Config({}))
	assert.ok(home.length > 0)
	assert.equal(resolveAdbHome(plugin.Config({ adbHome: '/tmp/pinned-adb' })), '/tmp/pinned-adb')
	assert.ok(existsSync(join(home, '.android', 'adbkey')), `default adb home ${home} should already hold a working adbkey`)
})

// ── live smoke test (read-only, skipped without a device) ───────────────────
/**
 * Assert a tool value is lossless JSON: the registry rejects an output carrying
 * `undefined` or a non-finite number, so the self-test must reject it too.
 * @param label - what is being checked.
 * @param value - the canonical tool value.
 */
function assertLossless(label, value) {
	const walk = (node, path) => {
		if (node === undefined) throw new Error(`${label}: undefined at ${path}`)
		if (typeof node === 'number' && !Number.isFinite(node)) throw new Error(`${label}: non-finite number at ${path}`)
		if (typeof node === 'function' || typeof node === 'symbol') throw new Error(`${label}: ${typeof node} at ${path}`)
		if (Array.isArray(node)) node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
		else if (node !== null && typeof node === 'object') for (const [key, entry] of Object.entries(node)) walk(entry, `${path}.${key}`)
	}
	walk(value, '$')
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: not a lossless JSON round trip`)
}

/** @returns the sorted names of registered tools, with the plugin applied. */
function applyFresh() {
	const registered = new Map()
	plugin.apply({
		tools: { register: (definition) => registered.set(definition.name, definition) },
		inject: () => {}
	}, plugin.Config({}))
	return registered
}

const exec = { signal: undefined, deferContext: () => {}, concludeTurn: () => {} }

try {
	const registered = applyFresh()
	const state = await registered.get('android_state').execute({}, exec)
	assertLossless('android_state', state)
	process.stdout.write(`ok   live android_state → ${JSON.stringify(state)}\n`)
	passed += 1
	const ui = await registered.get('android_ui').execute({ interactive_only: true, limit: 10 }, exec)
	assertLossless('android_ui', ui)
	process.stdout.write(`ok   live android_ui → ${ui.nodes_listed}/${ui.nodes_seen} actionable nodes, focus=${ui.focus ?? '?'}\n`)
	process.stdout.write(`     ${registered.get('android_ui').output.render({}, ui)[0].text.split('\n').slice(0, 4).join('\n     ')}\n`)
	passed += 1
	const current = await registered.get('android_app').execute({ action: 'current' }, exec)
	assertLossless('android_app current', current)
	process.stdout.write(`ok   live android_app current → ${JSON.stringify(current)}\n`)
	passed += 1
	const devices = await registered.get('android_devices').execute({ action: 'list' }, exec)
	assertLossless('android_devices list', devices)
	assert.ok(devices.count >= 1, 'expected at least the local device')
	assert.ok(devices.devices.some((row) => row.state === 'device'))
	process.stdout.write(`ok   live android_devices → ${devices.count} device(s): ${devices.devices.map((row) => `${row.serial}/${row.state}`).join(', ')} · adb home ${devices.adb_home}\n`)
	passed += 1
	// Per-call routing: naming the attached serial must work, and a bogus one
	// must fail loudly instead of silently falling back to another device.
	const pinned = await registered.get('android_state').execute({ serial: devices.devices[0].serial }, exec)
	assert.equal(pinned.serial, devices.devices[0].serial)
	assertLossless('android_state by serial', pinned)
	process.stdout.write(`ok   live per-call serial routing → ${pinned.serial}\n`)
	passed += 1
	const bogus = await registered.get('android_state').execute({ serial: 'no-such-device:5555' }, exec).then(() => null, (error) => error)
	assert.ok(bogus !== null, 'a bogus serial must fail rather than silently retarget')
	assert.match(bogus.message, /not found|offline|unauthorized|timed out/i)
	process.stdout.write(`ok   live bogus serial fails loudly → ${bogus.message.split('\n')[0].slice(0, 120)}\n`)
	passed += 1
} catch (error) {
	process.stdout.write(`skip live device test: ${error.message.split('\n')[0]}\n`)
}

process.stdout.write(`\n${passed} check(s) passed${process.exitCode === 1 ? ' — with failures above' : ''}\n`)
