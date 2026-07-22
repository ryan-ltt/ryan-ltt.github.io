// Browser UI controller: renders the board, player panels, and log, and drives the game loop.
// Talks to the headless engine (game.js) via the same agent interface bots use; the human
// player's agent is a HumanAgent whose decisions are resolved by button clicks here.

(function () {
	'use strict';

	const Board = window.MonopolyBoard;
	const { MonopolyGame } = window.MonopolyEngine;
	const { makeBotAgent, BEST_GENOME } = window.MonopolyStrategy;
	const { HumanAgent } = window.MonopolyHumanAgent;

	const PLAYER_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a'];
	const GROUP_COLORS = {
		brown: '#8d5524', lightblue: '#a2d2ff', pink: '#ffafcc', orange: '#ff9f1c',
		red: '#e63946', yellow: '#ffd60a', green: '#2a9d8f', darkblue: '#1d3557'
	};
	const TYPE_ICONS = {
		go: 'art/icon-go.png', jail: 'art/icon-jail.png', freeparking: 'art/icon-parking.png',
		gotojail: 'art/icon-gotojail.png', tax: 'art/icon-tax.png', chest: 'art/icon-chest.png',
		fate: 'art/icon-fate.png', rail: 'art/icon-rail.png', utility: 'art/icon-utility.png'
	};

	// Maps board position (0-39) to a {row, col} on an 11x11 grid (standard Monopoly layout,
	// 0 = bottom-right corner = Start, going counter-clockwise).
	function posToGrid(pos) {
		if (pos <= 10) return { row: 10, col: 10 - pos };          // bottom row, right->left
		if (pos <= 20) return { row: 10 - (pos - 10), col: 0 };     // left column, bottom->top
		if (pos <= 30) return { row: 0, col: pos - 20 };            // top row, left->right
		return { row: pos - 30, col: 10 };                          // right column, top->bottom
	}

	const WIN_PROB_ROLLOUTS = 150; // Monte Carlo trials per estimate - enough to be stable, cheap enough to stay smooth
	const WIN_PROB_BATCH_SIZE = 15; // trials per batch between yields to the browser, so a big estimate never blocks input/animation

	class MonopolyUI {
		constructor(rootEl) {
			this.root = rootEl;
			this.game = null;
			this.humanAgent = null;
			this.humanId = 0;
			this.speed = 650; // ms between bot actions, for watchability
			this.paused = false;
			this.winProbs = null; // {playerId: 0..1} from the most recently completed estimate, or null before the first one lands
			this.winProbRunId = 0; // bumped whenever a new estimate starts, so stale/in-flight batches can detect they're outdated and stop early
			this._build();
		}

		_build() {
			this.root.innerHTML = `
				<div class="mono-layout">
					<div class="mono-board-wrap">
						<div id="mono-board" class="mono-board"></div>
					</div>
					<div class="mono-sidebar">
						<div class="mono-dice-area" id="mono-dice-area" style="display:none;">
							<div class="mono-dice-pair" id="mono-dice-pair">
								<img class="mono-die" id="mono-die-1" src="art/dice-1.png" alt="">
								<img class="mono-die" id="mono-die-2" src="art/dice-1.png" alt="">
							</div>
							<button class="mono-btn mono-roll-btn" id="mono-roll-btn">🎲 Roll Dice</button>
						</div>
						<div class="mono-players" id="mono-players"></div>
						<div class="mono-controls" id="mono-controls"></div>
						<div class="mono-log-panel">
							<div class="mono-log-tabs" id="mono-log-tabs"></div>
							<div class="mono-log" id="mono-log"></div>
						</div>
					</div>
				</div>
				<div id="mono-modal-backdrop" class="mono-modal-backdrop" style="display:none;">
					<div id="mono-modal" class="mono-modal"></div>
				</div>
				<div id="mono-props-modal-backdrop" class="mono-modal-backdrop" style="display:none;">
					<div id="mono-props-modal" class="mono-modal"></div>
				</div>
				<div id="mono-event-modal-backdrop" class="mono-modal-backdrop" style="display:none;">
					<div id="mono-event-modal" class="mono-modal mono-event-modal"></div>
				</div>
			`;
			this.boardEl = this.root.querySelector('#mono-board');
			this.playersEl = this.root.querySelector('#mono-players');
			this.controlsEl = this.root.querySelector('#mono-controls');
			this.logTabsEl = this.root.querySelector('#mono-log-tabs');
			this.logEl = this.root.querySelector('#mono-log');
			this.modalBackdrop = this.root.querySelector('#mono-modal-backdrop');
			this.modalEl = this.root.querySelector('#mono-modal');
			this.propsModalBackdrop = this.root.querySelector('#mono-props-modal-backdrop');
			this.propsModalEl = this.root.querySelector('#mono-props-modal');
			this.eventModalBackdrop = this.root.querySelector('#mono-event-modal-backdrop');
			this.eventModalEl = this.root.querySelector('#mono-event-modal');
			this._eventQueue = []; // pending {html} notifications not yet shown
			this._eventShowing = false; // true while a notification is on screen awaiting dismissal
			this.diceAreaEl = this.root.querySelector('#mono-dice-area');
			this.die1El = this.root.querySelector('#mono-die-1');
			this.die2El = this.root.querySelector('#mono-die-2');
			this.rollBtnEl = this.root.querySelector('#mono-roll-btn');
			this.activeLogTab = 'all'; // 'all' or a player id
			this._renderBoardSkeleton();
			this._renderControls();
		}

		_diceSrc(face) {
			const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
			return `art/dice-${isDark ? 'dark-' : ''}${face}.png`;
		}

		/** Re-points any currently-displayed dice faces at the correct theme variant.
		 * Call this after the page theme changes so dice don't stay stuck on the old palette. */
		refreshDiceTheme() {
			if (!this.die1El || this.die1El.src.indexOf('.png') === -1) return;
			const faceOf = (img) => (img.src.match(/dice-(?:dark-)?(\d)\.png/) || [])[1];
			const f1 = faceOf(this.die1El);
			const f2 = faceOf(this.die2El);
			if (f1) this.die1El.src = this._diceSrc(f1);
			if (f2) this.die2El.src = this._diceSrc(f2);
		}

		_renderBoardSkeleton() {
			this.boardEl.innerHTML = '';
			this.cellEls = {};
			for (const space of Board.SPACES) {
				const { row, col } = posToGrid(space.pos);
				const cell = document.createElement('div');
				cell.className = 'mono-cell';
				cell.style.gridRow = (row + 1);
				cell.style.gridColumn = (col + 1);
				cell.dataset.pos = space.pos;
				if (space.group && GROUP_COLORS[space.group]) {
					const bar = document.createElement('div');
					bar.className = 'mono-cell-color';
					bar.style.background = GROUP_COLORS[space.group];
					cell.appendChild(bar);
				}
				if (TYPE_ICONS[space.type]) {
					cell.classList.add('mono-cell-special');
					const icon = document.createElement('img');
					icon.className = 'mono-cell-icon';
					icon.src = TYPE_ICONS[space.type];
					icon.alt = space.type;
					cell.appendChild(icon);
				}
				const label = document.createElement('div');
				label.className = 'mono-cell-label';
				label.textContent = space.name;
				cell.appendChild(label);

				const info = document.createElement('div');
				info.className = 'mono-cell-info';
				cell.appendChild(info);

				cell.addEventListener('click', () => this._onCellClick(space.pos));

				this.boardEl.appendChild(cell);
				this.cellEls[space.pos] = { cell, info };
			}
			const center = document.createElement('div');
			center.className = 'mono-center';
			center.style.gridRow = '2 / 11';
			center.style.gridColumn = '2 / 11';
			center.innerHTML = `<div class="mono-center-title">MONOPOLY<br><span>(clone)</span></div>`;
			this.boardEl.appendChild(center);

			const tokenLayer = document.createElement('div');
			tokenLayer.className = 'mono-token-layer';
			tokenLayer.id = 'mono-token-layer';
			this.boardEl.appendChild(tokenLayer);
			this.tokenLayerEl = tokenLayer;
			this.tokenEls = {}; // playerId -> token div, created lazily in newGame()
		}

		/** Absolute {left, top} of the center of a board cell, relative to .mono-board, in px. */
		_cellCenter(pos) {
			const { cell } = this.cellEls[pos];
			return {
				left: cell.offsetLeft + cell.offsetWidth / 2,
				top: cell.offsetTop + cell.offsetHeight / 2
			};
		}

		/** Slightly offsets each player's token within a shared cell so up to 4 tokens on the
		 * same space don't fully overlap (small fixed offsets in a 2x2 arrangement). */
		_tokenOffset(playerId) {
			const dx = (playerId % 2 === 0) ? -7 : 7;
			const dy = (playerId < 2) ? -7 : 7;
			return { dx, dy };
		}

		_placeTokenInstant(playerId, pos) {
			const token = this.tokenEls[playerId];
			if (!token) return;
			const { left, top } = this._cellCenter(pos);
			const { dx, dy } = this._tokenOffset(playerId);
			token.style.transition = 'none';
			token.style.left = (left + dx) + 'px';
			token.style.top = (top + dy) + 'px';
			// force reflow so the next transitioned move doesn't inherit "transition:none"
			void token.offsetWidth;
			token.style.transition = '';
			token.dataset.renderedPos = String(pos);
		}

		/** Animates a token walking step-by-step from oldPos to newPos around the board
		 * (handling wraparound past Start), pausing briefly on each intermediate space.
		 * @param direction 'forward' (default) or 'backward' - e.g. the "Go Back 3 Spaces" card
		 * moves backward 3 tiles; without this hint the animation would otherwise always step
		 * forward, which for a 3-space retreat means walking almost all the way around the board
		 * and visually crossing Go for no reason.
		 * Returns a Promise that resolves once the token visually arrives at newPos. */
		async _animateTokenMove(playerId, oldPos, newPos, direction) {
			const token = this.tokenEls[playerId];
			if (!token) return;
			const stepDelta = direction === 'backward' ? -1 : 1;
			const steps = [];
			let p = oldPos;
			while (p !== newPos) {
				p = (p + stepDelta + Board.BOARD_SIZE) % Board.BOARD_SIZE;
				steps.push(p);
			}
			if (!steps.length) return;
			const perStep = steps.length > 12 ? 45 : (steps.length > 6 ? 75 : 130);
			for (const stepPos of steps) {
				const { left, top } = this._cellCenter(stepPos);
				const { dx, dy } = this._tokenOffset(playerId);
				token.style.left = (left + dx) + 'px';
				token.style.top = (top + dy) + 'px';
				token.dataset.renderedPos = String(stepPos);
				await this._sleep(perStep);
			}
		}

		newGame(numAIs) {
			numAIs = numAIs || 3;
			this.winProbs = null;
			this.winProbRunId++; // abandon any rollout batches still in flight from a previous game
			this.humanAgent = new HumanAgent((kind, ctx) => this._onHumanDecisionNeeded(kind, ctx));
			const agents = [{ name: 'You', agent: this.humanAgent }];
			for (let i = 0; i < numAIs; i++) {
				agents.push({ name: `AI ${i + 1}`, agent: makeBotAgent(BEST_GENOME) });
			}
			this.humanId = 0;
			this.game = new MonopolyGame(agents, { maxTurns: 600 });
			this.game.verbose = true;
			this._origLog = this.game.logEvent.bind(this.game);
			this.game.logEvent = (msg) => { this._origLog(msg); this._appendLog(msg); };
			this.game.onRoll = (player, d1, d2) => this._onGameRoll(player, d1, d2);
			this.game.onMove = (player, oldPos, newPos, direction) => this._onGameMove(player, oldPos, newPos, direction);
			this.game.onAgentDecision = (player, method, ctx, result) => this._onAgentDecision(player, method, ctx, result);
			this.game.onEvent = (type, data) => this._onGameEvent(type, data);

			// one log buffer for "all events" plus one per player, so each player's actions can
			// be reviewed in isolation; a line is routed to a player's buffer whenever their name
			// appears in it (covers both "actor did X" and "X owes rent to actor" style lines).
			this.logBuffers = { all: [] };
			this.game.players.forEach(p => { this.logBuffers[p.id] = []; });
			this.activeLogTab = 'all';
			this._renderLogTabs();
			this._appendLog('New game started. You are Player 1 (red).');
			this.diceAreaEl.style.display = 'none';

			this.tokenLayerEl.innerHTML = '';
			this.tokenEls = {};
			this.game.players.forEach(p => {
				const token = document.createElement('div');
				token.className = 'mono-token';
				token.style.background = PLAYER_COLORS[p.id];
				token.title = p.name;
				this.tokenLayerEl.appendChild(token);
				this.tokenEls[p.id] = token;
			});

			this._renderAll();
			// place tokens after layout has happened (offsetLeft/Top need real geometry)
			requestAnimationFrame(() => {
				this.game.players.forEach(p => this._placeTokenInstant(p.id, p.pos));
			});

			this._runLoop();
			this._updateWinProbabilities();
		}

		async _onGameMove(player, oldPos, newPos, direction) {
			await this._animateTokenMove(player.id, oldPos, newPos, direction);
		}

		_onGameRoll(player, d1, d2) {
			this.diceAreaEl.style.display = 'flex';
			this.rollBtnEl.style.display = 'none';
			if (player.id === this.humanId) {
				// human's own roll: snap the animated dice to the true result
				this._showFinalRoll(d1, d2);
			} else {
				// AI roll: just show their result directly (no animation needed, keeps games watchable at speed)
				this.die1El.src = this._diceSrc(d1);
				this.die2El.src = this._diceSrc(d2);
			}
		}

		async _runLoop() {
			while (this.game && !this.game.gameOver) {
				if (this.paused) { await this._sleep(200); continue; }
				const wasHumanTurn = this.game.currentPlayerIdx === this.humanId;
				await this.game.playTurn();
				this._renderAll();
				if (this.game.gameOver) break;
				// small delay so AI turns are watchable, skip delay right before human's turn
				const next = this.game.players[this.game.currentPlayerIdx];
				if (next.id !== this.humanId) await this._sleep(this.speed);
				// recompute win% once per full round (right after the human's turn wraps around
				// to the next player) rather than every single turn - a Monte Carlo estimate is
				// too expensive to redo after every bot action, and the odds don't meaningfully
				// shift turn-to-turn anyway.
				if (wasHumanTurn) this._updateWinProbabilities();
			}
			if (this.game && this.game.gameOver) {
				this._appendLog(this.game.winner ? `🏆 ${this.game.winner.name} wins the game!` : 'Game ended in a draw.');
				this._renderControls();
				this.winProbRunId++; // abandon any in-flight estimate - the game is over, no point finishing it
				this.winProbs = {};
				this.game.players.forEach(p => { this.winProbs[p.id] = (this.game.winner && p.id === this.game.winner.id) ? 1 : 0; });
				this._renderPlayers();
			}
		}

		/** Kicks off a fresh Monte Carlo win-probability estimate from the current live game
		 * state, running in small non-blocking batches so it never freezes the UI. Superseded
		 * estimates (a newer one started before this one finished) abandon themselves rather than
		 * overwrite winProbs with stale results. */
		async _updateWinProbabilities() {
			if (!this.game || this.game.gameOver) return;
			const active = this.game.activePlayers();
			if (active.length <= 1) {
				const only = active[0];
				this.winProbs = only ? { [only.id]: 1 } : {};
				this._renderPlayers();
				return;
			}
			const runId = ++this.winProbRunId;
			const snap = this.game.snapshotState();
			const playerMeta = this.game.players.map(p => ({ id: p.id, name: p.name, bankrupt: p.bankrupt }));
			const wins = {};
			playerMeta.forEach(p => { wins[p.id] = 0; });
			let completed = 0;
			let seedCounter = Date.now() % 1000000;

			while (completed < WIN_PROB_ROLLOUTS) {
				if (runId !== this.winProbRunId) return; // a newer estimate has since started - abandon this one
				const batchEnd = Math.min(completed + WIN_PROB_BATCH_SIZE, WIN_PROB_ROLLOUTS);
				for (; completed < batchEnd; completed++) {
					const agents = playerMeta.map(p => ({ name: p.name, agent: makeBotAgent(BEST_GENOME) }));
					const rollout = new MonopolyGame(agents, { seed: seedCounter++, maxTurns: 600 });
					rollout.applySnapshot(snap);
					playerMeta.forEach((p, i) => { rollout.players[i].bankrupt = p.bankrupt; });
					const winner = await rollout.runToCompletion();
					if (winner) wins[winner.id]++;
				}
				// yield to the browser between batches so a ~150-trial estimate never blocks
				// input, animation, or the main game loop's own turn processing
				await this._sleep(0);
			}

			if (runId !== this.winProbRunId) return;
			const probs = {};
			playerMeta.forEach(p => { probs[p.id] = wins[p.id] / WIN_PROB_ROLLOUTS; });
			this.winProbs = probs;
			this._renderPlayers();
		}

		_sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

		_appendLog(msg) {
			if (!this.logBuffers) this.logBuffers = { all: [] }; // before a game exists (e.g. startup message)
			this.logBuffers.all.push(msg);
			let mentionsActiveTabPlayer = false;
			if (this.game) {
				// route to every player whose name is mentioned in this line (covers both
				// "X does something" and "Y owes rent to X" / "X rejects trade from Y" phrasing)
				this.game.players.forEach(p => {
					if (msg.indexOf(p.name) !== -1) {
						this.logBuffers[p.id].push(msg);
						if (String(p.id) === String(this.activeLogTab)) mentionsActiveTabPlayer = true;
					}
				});
			}
			if (this.activeLogTab === 'all' || mentionsActiveTabPlayer) this._appendLogLine(msg);
		}

		_appendLogLine(msg) {
			const line = document.createElement('div');
			line.className = 'mono-log-line';
			line.textContent = msg;
			this.logEl.appendChild(line);
			this.logEl.scrollTop = this.logEl.scrollHeight;
		}

		_renderLogTabs() {
			if (!this.game) { this.logTabsEl.innerHTML = ''; return; }
			this.logTabsEl.innerHTML = '';
			const makeTab = (key, label, color) => {
				const tab = document.createElement('button');
				tab.className = 'mono-log-tab' + (this.activeLogTab === key ? ' active' : '');
				tab.textContent = label;
				if (color) tab.style.setProperty('--tab-color', color);
				tab.onclick = () => this._switchLogTab(key);
				this.logTabsEl.appendChild(tab);
			};
			makeTab('all', 'All');
			this.game.players.forEach(p => makeTab(p.id, p.name, PLAYER_COLORS[p.id]));
		}

		_switchLogTab(key) {
			this.activeLogTab = key;
			this._renderLogTabs();
			this.logEl.innerHTML = '';
			const buffer = this.logBuffers[key] || [];
			buffer.forEach(msg => this._appendLogLine(msg));
		}

		_renderAll() {
			this._renderBoardState();
			this._renderPlayers();
			this._renderControls();
		}

		/** True right now if clicking a property owned by someone else should offer to start a
		 * trade for it: it must be the human's turn, and the engine must currently be waiting on
		 * the human's decideAction (the only decision point a trade proposal can be resolved from -
		 * see handleTradeProposal/postLandingActions in game.js). */
		_canProposeTradeNow() {
			return !!(
				this.game && !this.game.gameOver &&
				this.game.currentPlayerIdx === this.humanId &&
				this.humanAgent && this.humanAgent._pending && this.humanAgent._pending.kind === 'action'
			);
		}

		_onCellClick(pos) {
			if (!this._canProposeTradeNow()) return;
			const prop = this.game.properties[pos];
			if (!prop || prop.owner === null || prop.owner === this.humanId) return;
			const owner = this.game.players[prop.owner];
			if (owner.bankrupt) return;
			const pendingCtx = this.humanAgent._pending.ctx;
			this._modalTradeBuilder(pendingCtx, this.game.activePlayers().filter(p => p.id !== this.humanId), { targetId: owner.id, requestPos: pos });
		}

		_renderBoardState() {
			const tradeable = this._canProposeTradeNow();
			for (const space of Board.SPACES) {
				const { cell, info } = this.cellEls[space.pos];
				info.innerHTML = '';
				if (this.game) {
					const prop = this.game.properties[space.pos];
					if (prop && prop.owner !== null) {
						const owner = this.game.players[prop.owner];
						const chip = document.createElement('div');
						chip.className = 'mono-owner-chip';
						chip.style.background = PLAYER_COLORS[owner.id];
						chip.textContent = prop.mortgaged ? 'M' : (prop.houses >= 5 ? 'H' : (prop.houses > 0 ? String(prop.houses) : ''));
						info.appendChild(chip);
						const canTradeThis = tradeable && owner.id !== this.humanId && !owner.bankrupt;
						cell.classList.toggle('mono-cell-tradeable', canTradeThis);
						cell.title = canTradeThis ? `Click to propose a trade for ${space.name}` : '';
					} else {
						cell.classList.remove('mono-cell-tradeable');
						cell.title = '';
					}
				}
			}
			if (this.game) {
				this.game.players.forEach(p => {
					const token = this.tokenEls[p.id];
					if (!token) return;
					token.style.display = p.bankrupt ? 'none' : 'block';
					// safety net: some engine effects (sent to jail, "advance to X" cards) move a
					// player without going through movePlayer/onMove, so no walking animation fires
					// for those - snap the token straight there if it's showing a stale position.
					if (Number(token.dataset.renderedPos) !== p.pos) {
						this._placeTokenInstant(p.id, p.pos);
						token.dataset.renderedPos = String(p.pos);
					}
				});
			}
		}

		/** Returns [{key, label, color, icon, owned, total, complete}] for every color group plus
		 * rail/utility, for whichever groups this player owns at least one property in - used for
		 * the at-a-glance icon strip on each player card. */
		_ownershipSummary(playerId) {
			const groups = [];
			for (const groupKey of Object.keys(Board.GROUP_MEMBERS)) {
				const members = Board.GROUP_MEMBERS[groupKey];
				const owned = members.filter(pos => this.game.properties[pos].owner === playerId).length;
				if (owned > 0) {
					groups.push({ key: groupKey, label: groupKey, color: GROUP_COLORS[groupKey], icon: null, owned, total: members.length, complete: owned === members.length });
				}
			}
			const railOwned = Board.RAIL_POSITIONS.filter(pos => this.game.properties[pos].owner === playerId).length;
			if (railOwned > 0) {
				groups.push({ key: 'rail', label: 'Rails', color: null, icon: TYPE_ICONS.rail, owned: railOwned, total: Board.RAIL_POSITIONS.length, complete: railOwned === Board.RAIL_POSITIONS.length });
			}
			const utilOwned = Board.UTILITY_POSITIONS.filter(pos => this.game.properties[pos].owner === playerId).length;
			if (utilOwned > 0) {
				groups.push({ key: 'utility', label: 'Utilities', color: null, icon: TYPE_ICONS.utility, owned: utilOwned, total: Board.UTILITY_POSITIONS.length, complete: utilOwned === Board.UTILITY_POSITIONS.length });
			}
			return groups;
		}

		_renderPlayers() {
			if (!this.game) { this.playersEl.innerHTML = ''; return; }
			this.playersEl.innerHTML = '';
			this.game.players.forEach(p => {
				const card = document.createElement('div');
				card.className = 'mono-player-card' + (p.bankrupt ? ' bankrupt' : '') + (this.game.currentPlayerIdx === p.id && !this.game.gameOver ? ' active' : '');
				card.style.borderColor = PLAYER_COLORS[p.id];
				const monopolies = window.MonopolyStrategy.countMonopolies(this.game, p.id);
				const groupSummary = this._ownershipSummary(p.id);
				const groupIcons = groupSummary.map(g => {
					const swatch = g.color
						? `<span class="mono-group-swatch" style="background:${g.color}"></span>`
						: `<img class="mono-group-swatch mono-group-swatch-icon" src="${g.icon}" alt="${g.label}">`;
					return `<span class="mono-group-chip${g.complete ? ' complete' : ''}" title="${g.label}: ${g.owned}/${g.total}">${swatch}<span class="mono-group-frac">${g.owned}/${g.total}</span></span>`;
				}).join('');
				const winPct = this.winProbs && this.winProbs[p.id] != null ? Math.round(this.winProbs[p.id] * 100) : null;
				const winBadge = p.bankrupt
					? ''
					: winPct === null
						? `<span class="mono-winprob mono-winprob-loading" title="Estimating win probability...">&hellip;</span>`
						: `<span class="mono-winprob" title="Estimated chance of winning from here, based on ${WIN_PROB_ROLLOUTS} simulated playouts">${winPct}%</span>`;
				card.innerHTML = `
					<div class="mono-player-card-header">
						<div class="mono-player-name" style="color:${PLAYER_COLORS[p.id]}">${p.name}${p.bankrupt ? ' (out)' : ''}</div>
						${winBadge}
					</div>
					${groupIcons ? `<div class="mono-group-strip">${groupIcons}</div>` : ''}
					<div class="mono-player-stat">Cash: $${p.money}</div>
					<div class="mono-player-stat">Properties: ${p.properties.length} &nbsp; Monopolies: ${monopolies}</div>
					<div class="mono-player-stat">${p.inJail ? '🔒 In Jail' : ''}</div>
					${p.properties.length ? `<button class="mono-btn small mono-view-props-btn" data-player-id="${p.id}">View Properties</button>` : ''}
				`;
				this.playersEl.appendChild(card);
			});
			this.playersEl.querySelectorAll('.mono-view-props-btn').forEach(btn => {
				btn.onclick = () => this._modalPlayerProperties(Number(btn.dataset.playerId));
			});
		}

		_modalPlayerProperties(playerId) {
			const player = this.game.players[playerId];
			const groupsSeen = new Set();
			const rows = player.properties.slice().sort((a, b) => a - b).map(pos => {
				const space = this.game.getSpace(pos);
				const prop = this.game.properties[pos];
				const swatch = space.group && GROUP_COLORS[space.group]
					? `<span class="mono-prop-swatch" style="background:${GROUP_COLORS[space.group]}"></span>`
					: `<span class="mono-prop-swatch" style="background:#999"></span>`;
				let status;
				if (prop.mortgaged) status = 'Mortgaged';
				else if (prop.houses >= 5) status = 'Hotel';
				else if (prop.houses > 0) status = `${prop.houses} house${prop.houses > 1 ? 's' : ''}`;
				else if (space.type === 'property') status = this.game.ownsFullGroup(playerId, space.group) ? 'Full set, no houses' : '';
				else status = '';
				const rent = this.game.calcRent(pos, 7);
				return `<div class="mono-prop-row">${swatch}<span class="mono-prop-name">${space.name}</span><span class="mono-prop-status">${status}</span><span class="mono-prop-rent">$${rent} rent</span></div>`;
			}).join('');
			const title = playerId === this.humanId ? 'Your Properties' : `${player.name}'s Properties`;
			this.propsModalEl.innerHTML = `
				<h3 style="color:${PLAYER_COLORS[playerId]}">${title}</h3>
				<p class="mono-hint">${player.properties.length} propert${player.properties.length === 1 ? 'y' : 'ies'} &middot; Cash: $${player.money}</p>
				<div class="mono-prop-list">${rows || '<p class="mono-hint">No properties owned.</p>'}</div>
				<div class="mono-modal-actions">
					<button class="mono-btn secondary" id="mono-props-close">Close</button>
				</div>
			`;
			this.propsModalBackdrop.style.display = 'flex';
			this.propsModalEl.querySelector('#mono-props-close').onclick = () => {
				this.propsModalBackdrop.style.display = 'none';
			};
		}

		_renderControls() {
			this.controlsEl.innerHTML = '';
			if (!this.game) {
				const btn = document.createElement('button');
				btn.className = 'mono-btn';
				btn.textContent = 'Start New Game';
				btn.onclick = () => this.newGame(3);
				this.controlsEl.appendChild(btn);
				return;
			}
			if (this.game.gameOver) {
				const btn = document.createElement('button');
				btn.className = 'mono-btn';
				btn.textContent = 'Play Again';
				btn.onclick = () => this.newGame(3);
				this.controlsEl.appendChild(btn);
				return;
			}
			const speedRow = document.createElement('div');
			speedRow.className = 'mono-speed-row';
			speedRow.innerHTML = `<label>AI speed: </label>`;
			const select = document.createElement('select');
			[['Fast', 150], ['Normal', 650], ['Slow', 1400]].forEach(([label, val]) => {
				const opt = document.createElement('option');
				opt.value = val; opt.textContent = label;
				if (val === this.speed) opt.selected = true;
				select.appendChild(opt);
			});
			select.onchange = () => { this.speed = Number(select.value); };
			speedRow.appendChild(select);
			this.controlsEl.appendChild(speedRow);
		}

		// ---- AI decision / game event notifications (unified queue, centered modal, click X to
		// dismiss - covers both "an AI decided to do X" and "something automatic just happened,
		// like a rent payment or card draw". Both feed the same queue so they can never overlap
		// on screen, and the game loop pauses on each one until the player dismisses it, so nothing
		// can be missed. ----

		async _onAgentDecision(player, method, ctx, result) {
			this._renderAll(); // the engine already applied this decision's effects (own or AI's) - reflect them now, not at end of turn
			if (player.id === this.humanId) return; // human already sees their own choices live
			// This popup describes a decision the engine has already applied the effects of - a bug
			// in describing/rendering it must never be allowed to kill the game loop. _runLoop has no
			// try/catch around playTurn(), so an uncaught exception here would otherwise propagate all
			// the way up and silently freeze the game (this happened in practice: decideAction's ctx
			// has no `pos`, so referencing it crashed on every AI build/mortgage/sellHouse/unmortgage).
			try {
				const html = this._describeAgentDecision(method, ctx, result, player);
				if (!html) return; // no-op decision (e.g. nothing to build, declined to act) - skip the popup
				await this._queueEventPopup(html, PLAYER_COLORS[player.id]);
			} catch (err) {
				console.error('AI decision popup failed to render (continuing game):', err);
			}
		}

		/** Human-readable "X, Y, $Z" summary of one side of a trade (properties + cash + jail cards).
		 * Shared by the human's own trade-response modal and the AI-decision popups below, so an
		 * AI-to-AI trade shows the same level of detail a human would see if they were the target. */
		_describeTradeSide(props, money, cards) {
			const parts = props.map(pos => this.game.getSpace(pos).name);
			if (money) parts.push(`$${money}`);
			if (cards) parts.push(`${cards}x Get Out of Jail Free`);
			return parts.length ? parts.join(', ') : 'nothing';
		}

		_describeAgentDecision(method, ctx, result, player) {
			const space = ctx.pos !== undefined ? this.game.getSpace(ctx.pos) : null;
			switch (method) {
				case 'decideBuyProperty':
					return result
						? `<h3>${player.name}</h3><p>Buys <b>${space.name}</b> for $${space.price}.</p>`
						: null; // declining just sends it to auction, which gets its own popups
				case 'decideAuctionBid':
					return result > 0
						? `<h3>${player.name}</h3><p>Bids <b>$${result}</b> on ${space.name}.</p>`
						: `<h3>${player.name}</h3><p>Withdraws from the auction for ${space.name}.</p>`;
				case 'decideJail':
					if (result === 'card') return `<h3>${player.name}</h3><p>Uses a Get Out of Jail Free card.</p>`;
					if (result === 'pay') return `<h3>${player.name}</h3><p>Pays $${Board.JAIL_FINE} bail to get out of jail.</p>`;
					return null; // "stay" - the dice roll attempt itself is visible enough
				case 'decideLiquidation':
					if (!result) return null;
					return result.type === 'mortgage'
						? `<h3>${player.name}</h3><p>Mortgages ${this.game.getSpace(result.pos).name} for cash.</p>`
						: `<h3>${player.name}</h3><p>Sells a house on ${this.game.getSpace(result.pos).name} for cash.</p>`;
				case 'decideAction': {
					if (!result || result.type === 'done') return null;
					// unlike other decide* methods, decideAction's ctx has no `pos` - the position
					// (if any) lives on the returned action itself (result.pos)
					const actionSpace = result.pos !== undefined ? this.game.getSpace(result.pos) : null;
					if (result.type === 'build' && actionSpace) return `<h3>${player.name}</h3><p>Builds a house on <b>${actionSpace.name}</b>.</p>`;
					if (result.type === 'sellHouse' && actionSpace) return `<h3>${player.name}</h3><p>Sells a house on ${actionSpace.name}.</p>`;
					if (result.type === 'mortgage' && actionSpace) return `<h3>${player.name}</h3><p>Mortgages ${actionSpace.name}.</p>`;
					if (result.type === 'unmortgage' && actionSpace) return `<h3>${player.name}</h3><p>Unmortgages ${actionSpace.name}.</p>`;
					if (result.type === 'proposeTrade') {
						const trade = result.trade;
						const target = this.game.players[trade.toId];
						if (!target) return null;
						const gives = this._describeTradeSide(trade.offerProps, trade.offerMoney, trade.offerCards);
						const wants = this._describeTradeSide(trade.requestProps, trade.requestMoney, trade.requestCards);
						return `<h3>${player.name}</h3><p>Proposes a trade to ${target.name}:</p><p><b>Offers:</b> ${gives}</p><p><b>Wants:</b> ${wants}</p>`;
					}
					return null;
				}
				case 'decideTradeResponse': {
					const { trade, proposer } = ctx;
					const gets = this._describeTradeSide(trade.offerProps, trade.offerMoney, trade.offerCards);
					const gives = this._describeTradeSide(trade.requestProps, trade.requestMoney, trade.requestCards);
					return `<h3>${player.name}</h3><p>${result ? 'Accepts' : 'Rejects'} the trade offer from ${proposer.name}:</p><p><b>Would receive:</b> ${gets}</p><p><b>Would give up:</b> ${gives}</p>`;
				}
				default:
					return null;
			}
		}

		// ---- Game event notifications (narrates things the engine does automatically - card draws,
		// rent, tax, jail, bankruptcy, auction results, passing Go - that would otherwise only show
		// up as a line in the scrolling log, which is easy to miss and doesn't explain *why* money
		// or position just changed). Feeds the same queue as AI decision popups (below), so the two
		// kinds of notification never fight for the screen. ----

		async _onGameEvent(type, data) {
			const html = this._describeGameEvent(type, data);
			this._renderAll(); // reflect this event's already-applied effects (rent, tax, bankruptcy, etc.) immediately
			if (!html) return;
			await this._queueEventPopup(html, null);
		}

		_describeGameEvent(type, data) {
			const color = (p) => PLAYER_COLORS[p.id];
			switch (type) {
				case 'card': {
					const deckLabel = data.deck === 'chest' ? '🎴 Fortune Chest' : '🎴 Wild Fate';
					return `<div class="mono-event-title">${deckLabel}</div><p><b style="color:${color(data.player)}">${data.player.name}</b> draws: ${data.card.text}</p>`;
				}
				case 'rent':
					return `<div class="mono-event-title">💰 Rent</div><p><b style="color:${color(data.player)}">${data.player.name}</b> pays <b>$${data.amount}</b> to <b style="color:${color(data.owner)}">${data.owner.name}</b> for ${data.spaceName}.</p>`;
				case 'tax':
					return `<div class="mono-event-title">🧾 Tax</div><p><b style="color:${color(data.player)}">${data.player.name}</b> pays <b>$${data.amount}</b> in ${data.spaceName}.</p>`;
				case 'passGo':
					return `<div class="mono-event-title">🏁 Passed Start</div><p><b style="color:${color(data.player)}">${data.player.name}</b> collects $${data.amount}.</p>`;
				case 'gotojail':
					return `<div class="mono-event-title">🚔 Go To Jail</div><p><b style="color:${color(data.player)}">${data.player.name}</b> is sent to jail${data.reason === 'doubles' ? ' (3 doubles in a row)' : ''}.</p>`;
				case 'jailOutcome':
					if (data.outcome === 'rolledDoubles') return `<div class="mono-event-title">🔓 Jail</div><p><b style="color:${color(data.player)}">${data.player.name}</b> rolls doubles and gets out of jail free.</p>`;
					if (data.outcome === 'forcedBail') return `<div class="mono-event-title">🔓 Jail</div><p><b style="color:${color(data.player)}">${data.player.name}</b> failed 3 rolls and is forced to pay bail.</p>`;
					return null;
				case 'bankruptcy':
					return `<div class="mono-event-title">💥 Bankrupt</div><p><b style="color:${color(data.player)}">${data.player.name}</b> is bankrupt${data.creditor ? `, assets go to <b style="color:${color(data.creditor)}">${data.creditor.name}</b>` : ' and is out of the game'}.</p>`;
				case 'auctionResult':
					return data.winner
						? `<div class="mono-event-title">🔨 Auction</div><p><b style="color:${color(data.winner)}">${data.winner.name}</b> wins ${data.spaceName} for <b>$${data.amount}</b>.</p>`
						: `<div class="mono-event-title">🔨 Auction</div><p>No bids for ${data.spaceName} — stays with the bank.</p>`;
				default:
					return null;
			}
		}

		/** Queues a centered notification popup (AI decision or automatic game event) and returns a
		 * Promise that resolves once the player dismisses it (clicking "X" or the backdrop). Only
		 * one notification is ever on screen at a time; if another is already showing, this one
		 * waits in _eventQueue and the game loop is effectively paused until it's shown and
		 * dismissed - the caller in game.js awaits this (via onAgentDecision/onEvent), so nothing
		 * else in the turn proceeds until the player has acknowledged it. */
		_queueEventPopup(html, borderColor) {
			return new Promise(resolve => {
				this._eventQueue.push({ html, borderColor, resolve });
				this._drainEventQueue();
			});
		}

		_drainEventQueue() {
			if (this._eventShowing || !this._eventQueue.length) return;
			this._eventShowing = true;
			const { html, borderColor, resolve } = this._eventQueue.shift();
			this.eventModalEl.style.borderColor = borderColor || '';
			this.eventModalEl.innerHTML = `${html}<button class="mono-event-close-btn" id="mono-event-close" title="Dismiss" aria-label="Dismiss">&times;</button>`;
			this.eventModalBackdrop.style.display = 'flex';
			const dismiss = () => {
				this.eventModalBackdrop.style.display = 'none';
				this.eventModalEl.innerHTML = '';
				this.eventModalEl.style.borderColor = '';
				this._eventShowing = false;
				resolve();
				this._drainEventQueue(); // show the next queued notification, if any
			};
			this.eventModalEl.querySelector('#mono-event-close').onclick = dismiss;
			this.eventModalBackdrop.onclick = (e) => { if (e.target === this.eventModalBackdrop) dismiss(); };
		}

		// ---- Human decision handling ----

		_onHumanDecisionNeeded(kind, ctx) {
			const player = this.game.players[this.humanId];
			switch (kind) {
				case 'roll': return this._showRollButton(ctx);
				case 'buyProperty': return this._modalBuyProperty(ctx);
				case 'auctionBid': return this._modalAuctionBid(ctx);
				case 'jail': return this._modalJail(ctx);
				case 'liquidation': return this._modalLiquidation(ctx);
				case 'action': return this._modalAction(ctx);
				case 'tradeResponse': return this._modalTradeResponse(ctx);
			}
		}

		// ---- Dice roll ----

		_showRollButton(ctx) {
			this.diceAreaEl.style.display = 'flex';
			this.rollBtnEl.style.display = 'inline-block';
			this.rollBtnEl.disabled = false;
			this.rollBtnEl.textContent = '🎲 Roll Dice';
			this.rollBtnEl.onclick = () => this._animateRoll();
		}

		async _animateRoll() {
			this.rollBtnEl.disabled = true;
			this.rollBtnEl.textContent = 'Rolling...';
			this.die1El.classList.add('mono-die-rolling');
			this.die2El.classList.add('mono-die-rolling');

			// cycle through random faces for a short flurry before settling, so it reads as a
			// real roll rather than an instant number appearing
			const cycles = 8;
			for (let i = 0; i < cycles; i++) {
				this.die1El.src = this._diceSrc(1 + Math.floor(Math.random() * 6));
				this.die2El.src = this._diceSrc(1 + Math.floor(Math.random() * 6));
				await this._sleep(60 + i * 8); // ease out - slows down near the end
			}

			this.die1El.classList.remove('mono-die-rolling');
			this.die2El.classList.remove('mono-die-rolling');
			this.rollBtnEl.style.display = 'none';

			// resolving lets the engine's real (seeded) rollDice() run; we don't know the actual
			// result yet, so leave the dice on the last random frame until the log/board update
			// shows the true roll, then snap the dice to match it.
			this.humanAgent.resolve('roll', true);
		}

		/** Called after the engine's real roll happens, once we know the true face values,
		 * so the displayed dice always end up showing the actual result (never a random one). */
		_showFinalRoll(d1, d2) {
			this.die1El.src = this._diceSrc(d1);
			this.die2El.src = this._diceSrc(d2);
			this.die1El.classList.add('mono-die-land');
			this.die2El.classList.add('mono-die-land');
			setTimeout(() => {
				this.die1El.classList.remove('mono-die-land');
				this.die2El.classList.remove('mono-die-land');
			}, 300);
		}

		_showModal(html) {
			this.modalEl.innerHTML = html;
			this.modalBackdrop.style.display = 'flex';
		}

		_hideModal() {
			this.modalBackdrop.style.display = 'none';
			this.modalEl.innerHTML = '';
		}

		_modalBuyProperty(ctx) {
			const space = this.game.getSpace(ctx.pos);
			this._showModal(`
				<h3>${space.name}</h3>
				<p>Price: $${space.price} &nbsp; Your cash: $${ctx.player.money}</p>
				<p class="mono-hint">Rent: ${space.rent ? space.rent.join(' / ') : 'varies'}</p>
				<div class="mono-modal-actions">
					<button class="mono-btn" id="mono-buy-yes">Buy for $${space.price}</button>
					<button class="mono-btn secondary" id="mono-buy-no">Pass (go to auction)</button>
				</div>
			`);
			this.modalEl.querySelector('#mono-buy-yes').onclick = () => { this._hideModal(); this.humanAgent.resolve('buyProperty', true); };
			this.modalEl.querySelector('#mono-buy-no').onclick = () => { this._hideModal(); this.humanAgent.resolve('buyProperty', false); };
		}

		_modalAuctionBid(ctx) {
			const space = this.game.getSpace(ctx.pos);
			const minBid = ctx.highBid + 5;
			this._showModal(`
				<h3>Auction: ${space.name}</h3>
				<p>Current high bid: $${ctx.highBid} ${ctx.highBidder !== null ? '(' + this.game.players[ctx.highBidder].name + ')' : ''}</p>
				<p>Your cash: $${ctx.player.money}</p>
				<input type="number" id="mono-bid-input" min="${minBid}" max="${ctx.player.money}" value="${minBid}" class="mono-input" />
				<div class="mono-modal-actions">
					<button class="mono-btn" id="mono-bid-go">Bid</button>
					<button class="mono-btn secondary" id="mono-bid-out">Withdraw</button>
				</div>
			`);
			this.modalEl.querySelector('#mono-bid-go').onclick = () => {
				const val = Number(this.modalEl.querySelector('#mono-bid-input').value);
				this._hideModal();
				this.humanAgent.resolve('auctionBid', val);
			};
			this.modalEl.querySelector('#mono-bid-out').onclick = () => { this._hideModal(); this.humanAgent.resolve('auctionBid', 0); };
		}

		_modalJail(ctx) {
			const canCard = ctx.player.getOutOfJailFree > 0;
			const canPay = ctx.player.money >= Board.JAIL_FINE;
			this._showModal(`
				<h3>You're in Jail</h3>
				<p>Attempt ${ctx.player.jailTurns + 1} of 3</p>
				<div class="mono-modal-actions">
					${canCard ? '<button class="mono-btn" id="mono-jail-card">Use Get Out of Jail Free</button>' : ''}
					${canPay ? `<button class="mono-btn" id="mono-jail-pay">Pay $${Board.JAIL_FINE} Bail</button>` : ''}
					<button class="mono-btn secondary" id="mono-jail-stay">Try to Roll Doubles</button>
				</div>
			`);
			if (canCard) this.modalEl.querySelector('#mono-jail-card').onclick = () => { this._hideModal(); this.humanAgent.resolve('jail', 'card'); };
			if (canPay) this.modalEl.querySelector('#mono-jail-pay').onclick = () => { this._hideModal(); this.humanAgent.resolve('jail', 'pay'); };
			this.modalEl.querySelector('#mono-jail-stay').onclick = () => { this._hideModal(); this.humanAgent.resolve('jail', 'stay'); };
		}

		_modalLiquidation(ctx) {
			const rows = ctx.sellable.map((s, i) => {
				const space = this.game.getSpace(s.pos);
				const label = s.type === 'mortgage' ? `Mortgage ${space.name}` : `Sell house on ${space.name}`;
				return `<button class="mono-btn small" data-idx="${i}">${label} (+$${s.value})</button>`;
			}).join('');
			this._showModal(`
				<h3>Need $${ctx.amountNeeded} — raise cash</h3>
				<p>Your cash: $${ctx.player.money}</p>
				<div class="mono-modal-actions vertical">${rows}
					<button class="mono-btn secondary" id="mono-liq-stop">Stop (risk bankruptcy)</button>
				</div>
			`);
			ctx.sellable.forEach((s, i) => {
				const btn = this.modalEl.querySelector(`[data-idx="${i}"]`);
				if (btn) btn.onclick = () => { this._hideModal(); this.humanAgent.resolve('liquidation', s); };
			});
			this.modalEl.querySelector('#mono-liq-stop').onclick = () => { this._hideModal(); this.humanAgent.resolve('liquidation', null); };
		}

		_modalAction(ctx) {
			const player = ctx.player;
			const buildable = player.properties.filter(pos => this.game.canBuildOn(player, pos));
			const sellableHouses = player.properties.filter(pos => this.game.properties[pos].houses > 0);
			const mortgageable = player.properties.filter(pos => !this.game.properties[pos].mortgaged && this.game.properties[pos].houses === 0);
			const unmortgageable = player.properties.filter(pos => this.game.properties[pos].mortgaged);
			const otherPlayers = this.game.activePlayers().filter(p => p.id !== player.id);

			let html = `<h3>Your turn — choose an action</h3><div class="mono-modal-actions vertical">`;
			buildable.forEach(pos => {
				const space = this.game.getSpace(pos);
				html += `<button class="mono-btn small" data-action="build" data-pos="${pos}">Build on ${space.name} ($${space.houseCost})</button>`;
			});
			sellableHouses.forEach(pos => {
				const space = this.game.getSpace(pos);
				html += `<button class="mono-btn small" data-action="sellHouse" data-pos="${pos}">Sell house on ${space.name}</button>`;
			});
			mortgageable.forEach(pos => {
				const space = this.game.getSpace(pos);
				html += `<button class="mono-btn small" data-action="mortgage" data-pos="${pos}">Mortgage ${space.name} (+$${Math.floor(space.price / 2)})</button>`;
			});
			unmortgageable.forEach(pos => {
				const space = this.game.getSpace(pos);
				const cost = Math.ceil(space.price / 2 * 1.1);
				html += `<button class="mono-btn small" data-action="unmortgage" data-pos="${pos}">Unmortgage ${space.name} (-$${cost})</button>`;
			});
			if (otherPlayers.length) {
				html += `<button class="mono-btn small" id="mono-act-trade">Propose a Trade...</button>`;
			}
			html += `<button class="mono-btn" data-action="done">End Turn</button></div>`;
			this._showModal(html);

			this.modalEl.querySelectorAll('[data-action]').forEach(btn => {
				btn.onclick = () => {
					const action = btn.dataset.action;
					const pos = btn.dataset.pos !== undefined ? Number(btn.dataset.pos) : undefined;
					this._hideModal();
					this.humanAgent.resolve('action', { type: action, pos });
				};
			});
			const tradeBtn = this.modalEl.querySelector('#mono-act-trade');
			if (tradeBtn) tradeBtn.onclick = () => this._modalTradeBuilder(ctx, otherPlayers);
		}

		/** @param prefill optional {targetId, requestPos} - used when the builder is opened by
		 * clicking a property directly on the board rather than via the "Propose a Trade..."
		 * button, to jump straight to that owner with the clicked property pre-checked. */
		_modalTradeBuilder(ctx, otherPlayers, prefill) {
			const player = ctx.player;
			let targetId = (prefill && prefill.targetId !== undefined) ? prefill.targetId : otherPlayers[0].id;
			const openedFromBoardClick = !!prefill;
			const renderBuilder = () => {
				const target = this.game.players[targetId];
				const myProps = player.properties;
				const theirProps = target.properties;
				const propCheckboxes = (props, prefix) => props.map(pos => {
					const space = this.game.getSpace(pos);
					const preChecked = prefill && prefix === 'request' && pos === prefill.requestPos;
					return `<label class="mono-checkbox-row"><input type="checkbox" data-group="${prefix}" value="${pos}" ${preChecked ? 'checked' : ''}> ${space.name}</label>`;
				}).join('') || '<p class="mono-hint">none</p>';

				this._showModal(`
					<h3>Propose Trade</h3>
					<label>Trade with: </label>
					<select id="mono-trade-target">
						${otherPlayers.map(p => `<option value="${p.id}" ${p.id === targetId ? 'selected' : ''}>${p.name}</option>`).join('')}
					</select>
					<div class="mono-trade-cols">
						<div>
							<h4>You give</h4>
							${propCheckboxes(myProps, 'offer')}
							<label>Cash: <input type="number" id="mono-trade-offer-money" value="0" min="0" max="${player.money}" class="mono-input small"></label>
							<label class="mono-checkbox-row"><input type="checkbox" id="mono-trade-offer-card" ${player.getOutOfJailFree > 0 ? '' : 'disabled'}> Get Out of Jail Free card</label>
						</div>
						<div>
							<h4>You get</h4>
							${propCheckboxes(theirProps, 'request')}
							<label>Cash: <input type="number" id="mono-trade-request-money" value="0" min="0" max="${target.money}" class="mono-input small"></label>
							<label class="mono-checkbox-row"><input type="checkbox" id="mono-trade-request-card" ${target.getOutOfJailFree > 0 ? '' : 'disabled'}> Get Out of Jail Free card</label>
						</div>
					</div>
					<div class="mono-modal-actions">
						<button class="mono-btn" id="mono-trade-send">Send Offer</button>
						<button class="mono-btn secondary" id="mono-trade-cancel">Cancel</button>
					</div>
				`);
				this.modalEl.querySelector('#mono-trade-target').onchange = (e) => { targetId = Number(e.target.value); renderBuilder(); };
				this.modalEl.querySelector('#mono-trade-send').onclick = () => {
					const offerProps = [...this.modalEl.querySelectorAll('[data-group="offer"]:checked')].map(el => Number(el.value));
					const requestProps = [...this.modalEl.querySelectorAll('[data-group="request"]:checked')].map(el => Number(el.value));
					const offerMoney = Number(this.modalEl.querySelector('#mono-trade-offer-money').value) || 0;
					const requestMoney = Number(this.modalEl.querySelector('#mono-trade-request-money').value) || 0;
					const offerCards = this.modalEl.querySelector('#mono-trade-offer-card').checked ? 1 : 0;
					const requestCards = this.modalEl.querySelector('#mono-trade-request-card').checked ? 1 : 0;
					this._hideModal();
					this.humanAgent.resolve('action', {
						type: 'proposeTrade',
						trade: { toId: targetId, offerProps, requestProps, offerMoney, requestMoney, offerCards, requestCards }
					});
				};
				this.modalEl.querySelector('#mono-trade-cancel').onclick = () => {
					this._hideModal();
					if (openedFromBoardClick) {
						// came straight from clicking the board, not from the action menu - cancelling
						// should return to the action menu, not silently end the turn
						this._modalAction(ctx);
					} else {
						this.humanAgent.resolve('action', { type: 'done' });
					}
				};
			};
			renderBuilder();
		}

		_modalTradeResponse(ctx) {
			const { trade, proposer } = ctx;
			this._showModal(`
				<h3>${proposer.name} offers a trade</h3>
				<p><b>They give you:</b> ${this._describeTradeSide(trade.offerProps, trade.offerMoney, trade.offerCards)}</p>
				<p><b>They want:</b> ${this._describeTradeSide(trade.requestProps, trade.requestMoney, trade.requestCards)}</p>
				<div class="mono-modal-actions">
					<button class="mono-btn" id="mono-trade-accept">Accept</button>
					<button class="mono-btn secondary" id="mono-trade-reject">Reject</button>
				</div>
			`);
			this.modalEl.querySelector('#mono-trade-accept').onclick = () => { this._hideModal(); this.humanAgent.resolve('tradeResponse', true); };
			this.modalEl.querySelector('#mono-trade-reject').onclick = () => { this._hideModal(); this.humanAgent.resolve('tradeResponse', false); };
		}
	}

	window.MonopolyUI = { MonopolyUI };
})();
