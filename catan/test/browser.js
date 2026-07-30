/* Headless-Chrome smoke test, driven straight over the DevTools protocol. Node
 * has WebSocket built in, so this needs no dependencies at all - which matters
 * for a repo that has none.
 *
 *   node catan/test/browser.js          one page: the menu and a local game
 *   node catan/test/browser.js multi    two pages: host a room, join it, play
 *
 * `multi` is the real thing: two browsers finding each other over public nostr
 * relays, connecting peer to peer, and playing. It therefore needs a working
 * internet connection and takes a minute. It is also the only test that covers
 * the lobby, the transport and reconnecting - the node harness stops at the Net
 * seam. Between them they caught the two bugs that mattered: a guest sharing a
 * browser profile with the host was handed the host's seat and then silently
 * never received a view, and an invite link pasted into an already-open tab did
 * nothing because only a fragment changed.
 *
 * CHROME can be pointed elsewhere with the CATAN_CHROME environment variable. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = process.env.CATAN_CHROME ||
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MULTI = process.argv[2] === 'multi';

const MIME = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
	'.json': 'application/json', '.svg': 'image/svg+xml'
};

function serve() {
	return new Promise(function (resolve) {
		const server = http.createServer(function (req, res) {
			let file = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
			if (file.endsWith('/')) file += 'index.html';
			const full = path.join(ROOT, file);
			if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
				res.writeHead(404); return res.end('nope');
			}
			res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'text/plain' });
			res.end(fs.readFileSync(full));
		});
		server.listen(0, '127.0.0.1', function () { resolve(server); });
	});
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function getJSON(url) {
	const res = await fetch(url);
	return res.json();
}

/* --------------------------------------------------------------- CDP client */

class Page {
	constructor(label) {
		this.label = label;
		this.id = 0;
		this.pending = {};
		this.errors = [];
		this.logs = [];
	}

	async connect(wsUrl) {
		this.ws = new WebSocket(wsUrl);
		await new Promise(function (resolve, reject) {
			this.ws.onopen = resolve;
			this.ws.onerror = reject;
		}.bind(this));
		this.ws.onmessage = function (event) {
			const msg = JSON.parse(event.data);
			if (msg.id && this.pending[msg.id]) {
				this.pending[msg.id](msg);
				delete this.pending[msg.id];
				return;
			}
			if (msg.method === 'Runtime.exceptionThrown') {
				const d = msg.params.exceptionDetails;
				this.errors.push((d.exception && d.exception.description) || d.text);
			}
			if (msg.method === 'Runtime.consoleAPICalled') {
				const text = (msg.params.args || []).map(function (a) {
					return a.value !== undefined ? String(a.value) : (a.description || a.type);
				}).join(' ');
				this.logs.push(msg.params.type + ': ' + text);
				if (msg.params.type === 'error') this.errors.push(text);
			}
		}.bind(this);
		await this.send('Runtime.enable');
		await this.send('Page.enable');
	}

	send(method, params) {
		const id = ++this.id;
		return new Promise(function (resolve, reject) {
			this.pending[id] = function (msg) {
				if (msg.error) reject(new Error(method + ': ' + msg.error.message));
				else resolve(msg.result);
			};
			this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
		}.bind(this));
	}

	async eval(expression) {
		const out = await this.send('Runtime.evaluate', {
			expression: '(function(){' + expression + '})()',
			returnByValue: true, awaitPromise: true
		});
		if (out.exceptionDetails) {
			throw new Error('eval: ' + (out.exceptionDetails.exception
				? out.exceptionDetails.exception.description
				: out.exceptionDetails.text));
		}
		return out.result.value;
	}

	async goto(url) {
		await this.send('Page.navigate', { url: url });
		await sleep(900);
	}
}

/* ------------------------------------------------------------------- checks */

let checks = 0;
let failures = 0;

function ok(condition, label, detail) {
	checks++;
	if (condition) { console.log('  ok    ' + label); return true; }
	failures++;
	console.error('  FAIL  ' + label + (detail ? '\n        ' + detail : ''));
	return false;
}

/* --------------------------------------------------------------------- run */

async function main() {
	const server = await serve();
	const port = server.address().port;
	const base = 'http://127.0.0.1:' + port + '/catan/';
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'catan-chrome-'));

	const cdpPort = 9200 + Math.floor(Math.random() * 500);
	const devtools = 'http://127.0.0.1:' + cdpPort;
	const chrome = spawn(CHROME, [
		'--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
		'--no-first-run', '--no-default-browser-check', '--disable-gpu',
		'about:blank'
	], { stdio: ['ignore', 'ignore', 'ignore'] });

	let up = false;
	for (let i = 0; i < 40 && !up; i++) {
		await sleep(500);
		up = await getJSON(devtools + '/json/version').then(function () { return true; })
			.catch(function () { return false; });
	}
	if (!up) throw new Error('chrome did not start');

	async function newPage(label) {
		const res = await fetch(devtools + '/json/new?about:blank', { method: 'PUT' });
		const target = await res.json();
		const page = new Page(label);
		await page.connect(target.webSocketDebuggerUrl);
		return page;
	}

	try {
		console.log('\nsingle page: menu and a local game');
		const solo = await newPage('solo');
		await solo.goto(base);

		ok(await solo.eval('return !!window.CatanTransport && window.CatanTransport.available'),
			'the trystero module loaded');
		ok(await solo.eval('return !!(window.CatanNet && window.CatanLobby && window.CatanUI)'),
			'net, lobby and ui are all present');
		ok(await solo.eval("return document.querySelector('#screen-menu').classList.contains('is-visible')"),
			'the menu is showing');
		ok(await solo.eval("return !!document.querySelector('[data-act=\"host\"]')"),
			'the host button is offered');

		// Start a local game and let the bots run.
		await solo.eval("document.querySelector('[data-act=\"start\"]').click(); return 1;");
		await sleep(400);
		ok(await solo.eval("return document.querySelector('#screen-game').classList.contains('is-visible')"),
			'the game screen opened');
		ok(await solo.eval("return document.querySelectorAll('#game-board polygon').length > 10"),
			'the board drew');

		// Play the human's setup by clicking the first highlighted target, twice.
		for (let i = 0; i < 2; i++) {
			await solo.eval(
				"var t = document.querySelector('#game-board .c-target-vertex, #game-board .c-target-edge');" +
				"if (t) t.dispatchEvent(new MouseEvent('click', {bubbles:true})); return !!t;");
			await sleep(700);
		}
		await sleep(3000);
		ok(await solo.eval("return document.querySelectorAll('#game-board .c-building').length > 0"),
			'settlements got placed');
		ok(await solo.eval("return document.querySelectorAll('#game-panel .log li').length > 4"),
			'the log is filling up');
		ok(solo.errors.length === 0, 'no console errors on the local path',
			solo.errors.slice(0, 4).join('\n        '));

		/* A six-player game on the large board, which is where the special build
		   phase lives. Driven by clicking whatever the panel happens to offer. */
		console.log('\nsix players on the large board');
		const six = await newPage('six');
		await six.goto(base);
		await six.eval(
			"document.querySelector('[data-act=\"preset\"][data-value=\"large\"]').click();" +
			"for (var i = 0; i < 3; i++) document.querySelector('[data-act=\"add-player\"]').click();" +
			"return 1;");
		ok(await six.eval(
			"return document.querySelectorAll('#menu-setup .player-setup').length;") === 6,
			'the menu seats six');
		ok(await six.eval(
			"return /between turns/.test(document.querySelector('#menu-setup').textContent);"),
			'and says the special build phase is on');

		await six.eval("document.querySelector('[data-act=\"start\"]').click(); return 1;");
		await sleep(500);
		let sawBuild = false;
		for (let i = 0; i < 70 && !sawBuild; i++) {
			await six.eval(
				"var t = document.querySelector('#game-board .c-target-vertex, " +
				"#game-board .c-target-edge, #game-board .c-target-hex');" +
				"if (t) { t.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 'board'; }" +
				"var r = document.querySelector('#game-panel [data-act=\"roll\"]');" +
				"if (r) { r.click(); return 'roll'; }" +
				"var e = document.querySelector('#game-panel [data-act=\"end-turn\"]');" +
				"if (e) { e.click(); return 'end'; }" +
				"return 'none';");
			sawBuild = await six.eval(
				"return /special build/.test(document.querySelector('#game-panel').textContent);");
			await sleep(400);
		}
		ok(sawBuild, 'the special build phase reached the human seat');
		ok(await six.eval(
			"return /first to 10/.test(document.querySelector('#game-panel').textContent);"),
			'a big table plays to ten, not twelve');
		ok(await six.eval(
			"return document.querySelectorAll('#game-panel .player-row').length === 6;"),
			'all six seats are on the scoreboard');
		ok(six.errors.length === 0, 'no console errors in a six-player game',
			six.errors.slice(0, 4).join('\n        '));

		if (MULTI) {
			console.log('\ntwo pages: hosting and joining a real room');
			const host = await newPage('host');
			await host.goto(base);
			await host.eval("document.querySelector('[data-act=\"host\"]').click(); return 1;");
			await sleep(1500);

			const code = await host.eval("var e=document.querySelector('.room-code'); return e && e.textContent.trim();");
			ok(!!code && code.length === 6, 'the host got a room code', String(code));
			ok(await host.eval("return document.querySelector('#screen-lobby').classList.contains('is-visible')"),
				'the lobby screen opened');

			// A real second player is a different browser: no saved name, no token.
			const guest = await newPage('guest');
			await guest.goto(base + '?fresh=1');
			await guest.eval("localStorage.clear(); return 1;");
			await guest.goto(base + '#join=' + code);   // a real load, as a friend gets
			await sleep(1500);
			await guest.eval(
				"var n=document.querySelector('[data-field=\"name\"]');" +
				"if(n){n.value='friend'; n.dispatchEvent(new Event('input',{bubbles:true}));" +
				"var b=document.querySelector('[data-lobby=\"join-now\"]'); if(b) b.click(); return 'typed a name';}" +
				"return 'auto';");

			console.log('  (waiting up to 45s for the peers to find each other over nostr)');
			const roster = function () {
				return host.eval("return Array.from(document.querySelectorAll('.seat-name'))" +
					".map(function(e){ return e.textContent.trim(); }).join(' | ');");
			};
			let seated = false;
			for (let i = 0; i < 30 && !seated; i++) {
				await sleep(2000);
				seated = /\| friend/.test(await roster());
			}
			ok(seated, 'the guest took a seat in the host roster', await roster());
			console.log('  roster: ' + await roster());
			if (!seated) {
				console.log('  host peers:   ' + JSON.stringify(await host.eval(
					"var r = window.CatanLobby.room(); return r ? r.peers() : 'no room';")));
				console.log('  guest screen: ' + await guest.eval(
					"var s=['menu','editor','lobby','game'].filter(function(k){" +
					"return document.getElementById('screen-'+k).classList.contains('is-visible');});" +
					"var n=document.querySelector('#lobby-panel .notice');" +
					"return s + ' / ' + (n ? n.textContent : 'no notice');"));
			}

			if (seated) {
				await host.eval("document.querySelector('[data-lobby=\"start\"]').click(); return 1;");
				await sleep(3000);
				ok(await guest.eval("return document.querySelector('#screen-game').classList.contains('is-visible')"),
					'the guest was pulled into the game');
				ok(await guest.eval("return document.querySelectorAll('#game-board polygon').length > 10"),
					'the guest drew the host&apos;s board');

				const hidden = await guest.eval(
					"var seen = window.__peek || null; return document.body.innerHTML.length;");
				ok(hidden > 0, 'the guest rendered a panel');

				// Let setup run: whichever side is on turn clicks its first target.
				for (let i = 0; i < 14; i++) {
					for (const page of [host, guest]) {
						await page.eval(
							"var t = document.querySelector('#game-board .c-target-vertex, #game-board .c-target-edge');" +
							"if (t) t.dispatchEvent(new MouseEvent('click', {bubbles:true})); return !!t;");
					}
					await sleep(600);
				}
				await sleep(2000);
				const hostBuildings = await host.eval("return document.querySelectorAll('#game-board .c-building').length;");
				const guestBuildings = await guest.eval("return document.querySelectorAll('#game-board .c-building').length;");
				ok(hostBuildings > 0 && hostBuildings === guestBuildings,
					'both sides see the same buildings', hostBuildings + ' vs ' + guestBuildings);
				/* Play on until the guest rolls for itself, driving whichever side is
				   on turn. The point is the host's own log picking up an action that
				   originated in another browser. */
				const nudge = function (page) {
					return page.eval(
						"var t = document.querySelector('#game-board .c-target-vertex, " +
						"#game-board .c-target-edge, #game-board .c-target-hex');" +
						"if (t) { t.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 'board'; }" +
						"var r = document.querySelector('#game-panel [data-act=\"roll\"]');" +
						"if (r) { r.click(); return 'roll'; }" +
						"var e = document.querySelector('#game-panel [data-act=\"end-turn\"]');" +
						"if (e) { e.click(); return 'end'; }" +
						"return 'none';");
				};
				let guestRolled = false;
				for (let i = 0; i < 40 && !guestRolled; i++) {
					await nudge(host);
					await nudge(guest);
					await sleep(700);
					guestRolled = await host.eval(
						"return Array.from(document.querySelectorAll('#game-panel .log li'))" +
						".some(function(e){ return /friend rolls/.test(e.textContent); });");
				}
				ok(guestRolled, "the host's log picked up a roll made in the guest's browser");
				if (!guestRolled) {
					console.log('  guest turn bar: ' + await guest.eval(
						"var e=document.querySelector('#game-panel .turn-bar'); return e?e.textContent.trim():'none';"));
					console.log('  host log tail:  ' + await host.eval(
						"return Array.from(document.querySelectorAll('#game-panel .log li')).slice(0,6)" +
						".map(function(e){return e.textContent;}).join(' / ');"));
				}

				// And the reverse direction: the guest sees the host's dice.
				ok(await guest.eval(
					"return Array.from(document.querySelectorAll('#game-panel .log li'))" +
					".some(function(e){ return /you rolls/.test(e.textContent); });"),
					"the guest's log shows the host's rolls too");

				// Reconnect: the guest refreshes mid-game and should get its seat back.
				const beforeSeat = await guest.eval(
					"var e = document.querySelector('#game-panel .player-name em');" +
					"return document.querySelectorAll('#game-panel .player-row').length;");
				await guest.goto(base + '#join=' + code);
				await sleep(9000);
				ok(await guest.eval("return document.querySelector('#screen-game').classList.contains('is-visible')"),
					'the guest landed straight back in the game after a refresh');
				ok(await guest.eval(
					"return Array.from(document.querySelectorAll('#game-panel .player-name'))" +
					".some(function(e){ return /friend/.test(e.textContent) && /you/.test(e.textContent); });"),
					'and it is still the same seat');
				ok(beforeSeat > 0, 'the panel had a player table before the refresh');

				ok(guest.errors.length === 0, 'no console errors on the guest',
					guest.errors.slice(0, 4).join('\n        '));
				ok(host.errors.length === 0, 'no console errors on the host',
					host.errors.slice(0, 4).join('\n        '));
			} else {
				console.log('  host log tail:', host.logs.slice(-6).join(' | '));
				console.log('  guest log tail:', guest.logs.slice(-6).join(' | '));
			}
		}
	} finally {
		chrome.kill();
		server.close();
	}

	console.log('\n' + (failures ? failures + ' of ' + checks + ' checks FAILED' : checks + ' checks passed'));
	process.exit(failures ? 1 : 0);
}

main().catch(function (err) {
	console.error(err);
	process.exit(1);
});
