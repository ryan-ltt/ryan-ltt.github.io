// Browser UI controller: renders the board, player panels, and log, and drives the game loop.
// Talks to the headless engine (game.js) via the same agent interface bots use; the human
// player's agent is a HumanAgent whose decisions are resolved by button clicks here.

(function () {
	'use strict';

	const Board = window.MonopolyBoard;
	const { MonopolyGame } = window.MonopolyEngine;
	const { makeBotAgent, BEST_GENOME, estimateAssetValue, propertyValue, evaluateTrade } = window.MonopolyStrategy;
	const { HumanAgent } = window.MonopolyHumanAgent;

	const PLAYER_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a'];
	// Distinct game-piece per seat (still color-ringed via PLAYER_COLORS) so tokens are easy to tell
	// apart at a glance rather than four near-identical colored dots.
	const PLAYER_TOKENS = ['🎩', '🚗', '🐕', '🚢'];
	// Kept in sync with the --group-* tokens in monopoly.css (tuned for consistent saturation +
	// AA contrast on the tile face). These drive board color bars, owner chips, mini deed cards,
	// and flying-property cards, so they must match the CSS the tiles use.
	const GROUP_COLORS = {
		brown: '#955436', lightblue: '#7cc4e8', pink: '#d955a3', orange: '#e8811f',
		red: '#d92d3a', yellow: '#f2c018', green: '#1f9d63', darkblue: '#2555c7'
	};
	const TYPE_ICONS = {
		go: 'art/icon-go.png', jail: 'art/icon-jail.png', freeparking: 'art/icon-parking.png',
		gotojail: 'art/icon-gotojail.png', tax: 'art/icon-tax.png', chest: 'art/icon-chest.png',
		fate: 'art/icon-fate.png', rail: 'art/icon-rail.png', utility: 'art/icon-utility.png'
	};
	// Seat-facing rotation for each dock slot's property row AND cash pile row: top faces the human
	// straight across the board (180deg); left/right get a quarter turn each, in opposite
	// directions, so text/bills face toward that seat rather than away from it - the standard
	// tabletop convention for cards/money dealt to a side seat. Bottom (human) stays upright. `dir`
	// (0/180/90/-90) drives which generic rotate-* class gets applied, shared by both element kinds.
	const DOCK_ROTATE = {
		top: { dir: 180, propClass: 'mono-prop-row-rotate-180', cashClass: 'mono-rotate-180' },
		left: { dir: 90, propClass: 'mono-prop-row-rotate-left', cashClass: 'mono-rotate-left' },
		right: { dir: -90, propClass: 'mono-prop-row-rotate-right', cashClass: 'mono-rotate-right' },
		bottom: { dir: 0, propClass: '', cashClass: '' }
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
			// {fromId, toId, offerProps, requestProps, offerMoney, requestMoney, offerCards,
			// requestCards} while the trade builder is open, so the board/player panels can preview
			// what the in-progress (not-yet-sent) offer would do - see _tradePreviewOwner/
			// _tradePreviewCash and _modalTradeBuilder's live-updating listeners. Never mutates real
			// game state; null whenever no trade builder is open.
			this._tradePreview = null;
			// pos -> playerId|null (bank), overriding _previewOwner's displayed owner while a
			// _flyProperty animation for that pos is mid-flight - see _previewOwner's comment.
			this._pendingPropertyDisplay = new Map();
			this._build();
		}

		_build() {
			this.root.innerHTML = `
				<div class="mono-table">
					<div class="mono-board-wrap">
						<div id="mono-board" class="mono-board"></div>
						<div class="mono-dock mono-dock-top" id="mono-dock-top"></div>
						<div class="mono-dock mono-dock-left" id="mono-dock-left"></div>
						<div class="mono-dock mono-dock-right" id="mono-dock-right"></div>
					</div>
					<div class="mono-dock mono-dock-bottom" id="mono-dock-bottom">
						<div id="mono-human-dock-card"></div>
						<div class="mono-controls" id="mono-controls"></div>
					</div>
				</div>
				<div class="mono-toggle-row">
					<button class="mono-log-toggle" id="mono-about-toggle" title="About this game">ℹ️ Read more</button>
					<button class="mono-log-toggle" id="mono-log-toggle" title="Show event log">📜 Log</button>
					<button class="mono-log-toggle mono-log-toggle-icon" id="mono-debug-toggle" title="Show animation debug log" aria-label="Animation debug log">🐞</button>
				</div>
				<div class="mono-log-panel collapsed" id="mono-about-panel">
					<div class="mono-log-panel-head">
						<div class="mono-about-body" id="mono-about-body"></div>
						<button class="mono-log-close" id="mono-about-close" title="Hide" aria-label="Hide">&times;</button>
					</div>
				</div>
				<div class="mono-log-panel collapsed" id="mono-log-panel">
					<div class="mono-log-panel-head">
						<div class="mono-log-tabs" id="mono-log-tabs"></div>
						<button class="mono-log-close" id="mono-log-close" title="Hide log" aria-label="Hide log">&times;</button>
					</div>
					<div class="mono-log" id="mono-log"></div>
				</div>
				<div class="mono-log-panel collapsed" id="mono-debug-panel">
					<div class="mono-log-panel-head">
						<span style="font-size:11px;font-weight:bold;flex:1;">Animation debug log</span>
						<button class="mono-log-close" id="mono-debug-clear" title="Clear" aria-label="Clear" style="font-size:11px;width:auto;padding:2px 8px;">Clear</button>
						<button class="mono-log-close" id="mono-debug-copy" title="Copy to clipboard" aria-label="Copy" style="font-size:11px;width:auto;padding:2px 8px;">Copy</button>
						<button class="mono-log-close" id="mono-debug-close" title="Hide" aria-label="Hide">&times;</button>
					</div>
					<textarea class="mono-debug-text" id="mono-debug-text" readonly wrap="off"></textarea>
				</div>
				<div id="mono-modal-backdrop" class="mono-modal-backdrop" style="display:none;">
					<div id="mono-modal" class="mono-modal"></div>
				</div>
				<div id="mono-props-modal-backdrop" class="mono-modal-backdrop" style="display:none;">
					<div id="mono-props-modal" class="mono-modal"></div>
				</div>
				<div id="mono-fx-layer" class="mono-fx-layer"></div>
				<div id="mono-auction-backdrop" class="mono-modal-backdrop" style="display:none;">
					<div id="mono-auction-room" class="mono-auction-room"></div>
				</div>
				<div id="mono-deed-tip" class="mono-deed-tip" style="display:none;"></div>
				<div id="mono-tour" class="mono-tour" style="display:none;">
					<div class="mono-tour-spotlight" id="mono-tour-spotlight"></div>
					<div class="mono-tour-card" id="mono-tour-card">
						<div class="mono-tour-text" id="mono-tour-text"></div>
						<div class="mono-tour-foot">
							<span class="mono-tour-progress" id="mono-tour-progress"></span>
							<span class="mono-tour-btns">
								<button class="mono-btn secondary" id="mono-tour-skip">Skip</button>
								<button class="mono-btn" id="mono-tour-next">Next</button>
							</span>
						</div>
					</div>
				</div>
			`;
			this.boardEl = this.root.querySelector('#mono-board');
			this.dockEls = {
				top: this.root.querySelector('#mono-dock-top'),
				left: this.root.querySelector('#mono-dock-left'),
				right: this.root.querySelector('#mono-dock-right'),
				bottom: this.root.querySelector('#mono-human-dock-card')
			};
			this.controlsEl = this.root.querySelector('#mono-controls');
			this.logPanelEl = this.root.querySelector('#mono-log-panel');
			this.logToggleEl = this.root.querySelector('#mono-log-toggle');
			this.logTabsEl = this.root.querySelector('#mono-log-tabs');
			this.logEl = this.root.querySelector('#mono-log');
			this.aboutPanelEl = this.root.querySelector('#mono-about-panel');
			this.aboutToggleEl = this.root.querySelector('#mono-about-toggle');
			this.debugPanelEl = this.root.querySelector('#mono-debug-panel');
			this.debugToggleEl = this.root.querySelector('#mono-debug-toggle');
			this.debugTextEl = this.root.querySelector('#mono-debug-text');
			this._debugLog = []; // ring buffer of log lines - see _dlog
			this.modalBackdrop = this.root.querySelector('#mono-modal-backdrop');
			this.modalEl = this.root.querySelector('#mono-modal');
			this.propsModalBackdrop = this.root.querySelector('#mono-props-modal-backdrop');
			this.propsModalEl = this.root.querySelector('#mono-props-modal');
			this.fxLayerEl = this.root.querySelector('#mono-fx-layer');
			this.deedTipEl = this.root.querySelector('#mono-deed-tip');
			this.auctionBackdrop = this.root.querySelector('#mono-auction-backdrop');
			this.auctionRoomEl = this.root.querySelector('#mono-auction-room');
			this.tourEl = this.root.querySelector('#mono-tour');
			this._eventQueue = []; // pending {html} notifications not yet shown
			this._eventShowing = false; // true while a notification is on screen awaiting its auto-dismiss timer
			this._eventDismissTimer = null; // setTimeout handle for the currently-showing notice's auto-dismiss
			this.activeLogTab = 'all'; // 'all' or a player id
			this.logToggleEl.onclick = () => { this._toggleAboutPanel(false); this._toggleLogPanel(true); };
			this.root.querySelector('#mono-log-close').onclick = () => this._toggleLogPanel(false);
			const aboutTemplate = document.getElementById('mono-about-text');
			if (aboutTemplate) this.root.querySelector('#mono-about-body').appendChild(aboutTemplate.content.cloneNode(true));
			this.aboutToggleEl.onclick = () => { this._toggleLogPanel(false); this._toggleAboutPanel(true); };
			this.root.querySelector('#mono-about-close').onclick = () => this._toggleAboutPanel(false);
			this.debugToggleEl.onclick = () => { this._toggleLogPanel(false); this._toggleAboutPanel(false); this._toggleDebugPanel(true); };
			this.root.querySelector('#mono-debug-close').onclick = () => this._toggleDebugPanel(false);
			this.root.querySelector('#mono-debug-clear').onclick = () => { this._debugLog = []; this._renderDebugLog(); };
			this.root.querySelector('#mono-debug-copy').onclick = () => this._copyDebugLog();
			this._renderBoardSkeleton();
			// dice area is built as part of the board skeleton (it lives in .mono-center, overlaid on
			// the board itself), so these queries must happen after _renderBoardSkeleton(), not before
			this.diceAreaEl = this.root.querySelector('#mono-dice-area');
			this.die1El = this.root.querySelector('#mono-die-1');
			this.die2El = this.root.querySelector('#mono-die-2');
			this.rollBtnEl = this.root.querySelector('#mono-roll-btn');
			this.bankEl = this.root.querySelector('#mono-bank');
			this.eventNoticeEl = this.root.querySelector('#mono-event-notice');
			this._renderControls();
		}

		_toggleLogPanel(open) {
			this.logPanelEl.classList.toggle('collapsed', !open);
			this.logToggleEl.classList.toggle('active', open);
		}

		_toggleAboutPanel(open) {
			this.aboutPanelEl.classList.toggle('collapsed', !open);
			this.aboutToggleEl.classList.toggle('active', open);
		}

		_toggleDebugPanel(open) {
			this.debugPanelEl.classList.toggle('collapsed', !open);
			this.debugToggleEl.classList.toggle('active', open);
			if (open) this._renderDebugLog();
		}

		/** Appends one timestamped line to the animation debug ring buffer (capped at 500 lines, oldest
		 * dropped first) - temporary instrumentation for diagnosing why a flying-bill/property
		 * animation didn't show up for a given transaction. Cheap no-op when the panel is closed
		 * (only re-renders the textarea while it's open); safe to call from hot paths like
		 * _diffAndAnimate/_flyBills without needing to gate every call site on a debug flag. */
		_dlog(...parts) {
			const t = (performance.now() / 1000).toFixed(3);
			this._debugLog.push(`[${t}] ${parts.map(p => typeof p === 'object' ? JSON.stringify(p) : String(p)).join(' ')}`);
			if (this._debugLog.length > 500) this._debugLog.shift();
			if (!this.debugPanelEl.classList.contains('collapsed')) this._renderDebugLog();
		}

		_renderDebugLog() {
			this.debugTextEl.value = this._debugLog.join('\n');
			this.debugTextEl.scrollTop = this.debugTextEl.scrollHeight;
		}

		async _copyDebugLog() {
			const text = this._debugLog.join('\n');
			try {
				await navigator.clipboard.writeText(text);
				const btn = this.root.querySelector('#mono-debug-copy');
				const orig = btn.textContent;
				btn.textContent = 'Copied!';
				setTimeout(() => { btn.textContent = orig; }, 1200);
			} catch (err) {
				// clipboard API can be blocked (permissions, insecure context) - fall back to a
				// select-all on the textarea so the user can still Ctrl+C manually
				this.debugTextEl.focus();
				this.debugTextEl.select();
			}
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
				// The four corners (Start/Jail/Free Parking/Go-To-Jail) get a distinct larger treatment
				// so they anchor the board's corners visually (see .mono-cell-corner).
				if (space.pos === 0 || space.pos === 10 || space.pos === 20 || space.pos === 30) {
					cell.classList.add('mono-cell-corner');
				}
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
				// Hover title-deed tooltip: any purchasable space (property/rail/utility) shows its full
				// rent ladder, costs, and current owner on hover, so the rules are discoverable without
				// landing on it or opening a modal. Non-purchasable spaces (Go, tax, cards...) have none.
				cell.addEventListener('mouseenter', () => this._showDeedTip(space.pos, cell));
				cell.addEventListener('mouseleave', () => this._hideDeedTip());

				this.boardEl.appendChild(cell);
				this.cellEls[space.pos] = { cell, info };
			}
			const center = document.createElement('div');
			center.className = 'mono-center';
			center.style.gridRow = '2 / 11';
			center.style.gridColumn = '2 / 11';
			center.innerHTML = `
				<div class="mono-center-title" id="mono-center-title">MONOPOLY<br><span>(clone)</span></div>
				<div class="mono-event-notice" id="mono-event-notice" style="display:none;"></div>
				<div class="mono-dice-area" id="mono-dice-area" style="display:none;">
					<div class="mono-dice-pair" id="mono-dice-pair">
						<img class="mono-die" id="mono-die-1" src="art/dice-1.png" alt="">
						<img class="mono-die" id="mono-die-2" src="art/dice-1.png" alt="">
					</div>
					<button class="mono-btn mono-roll-btn" id="mono-roll-btn">🎲 Roll Dice</button>
				</div>
				<div class="mono-bank" id="mono-bank" title="The Bank">
					<div class="mono-bank-label">🏦 Bank</div>
					<div class="mono-bank-deck" id="mono-bank-deck">
						<div class="mono-mini-prop mono-deck-card"></div>
						<div class="mono-mini-prop mono-deck-card"></div>
						<div class="mono-mini-prop mono-deck-card"></div>
					</div>
				</div>
			`;
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
			this._lastTradeAttempt = null;
			this._pendingTradeRejection = null;
			this.game = new MonopolyGame(agents, { maxTurns: 600 });
			// baseline for the diff-based flying-money/property detector (see _diffAndAnimate) - set
			// BEFORE the first _renderAll() below, so starting cash/no-ownership isn't misread as a
			// pile of transactions to animate on game start.
			this._txHint = null;
			this._snapshotState();
			this.game.verbose = true;
			this._origLog = this.game.logEvent.bind(this.game);
			this.game.logEvent = (msg) => { this._origLog(msg); this._appendLog(msg); };
			this.game.onRoll = (player, d1, d2) => this._onGameRoll(player, d1, d2);
			this.game.onMove = (player, oldPos, newPos, direction) => this._onGameMove(player, oldPos, newPos, direction);
			this.game.onAgentDecision = (player, method, ctx, result) => this._onAgentDecision(player, method, ctx, result);
			this.game.onEvent = (type, data) => this._onGameEvent(type, data);
			this.game.onAuctionStart = (data) => this._onAuctionStart(data);
			this.game.onAuctionBid = (data) => this._onAuctionBid(data);

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
				token.style.borderColor = PLAYER_COLORS[p.id];
				token.style.setProperty('--token-color', PLAYER_COLORS[p.id]);
				token.textContent = PLAYER_TOKENS[p.id] || '●';
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
			this._maybeStartTour();
		}

		async _onGameMove(player, oldPos, newPos, direction) {
			await this._animateTokenMove(player.id, oldPos, newPos, direction);
			this._pulseLandedCell(newPos);
		}

		/** Briefly glows the tile a token just landed on so the eye follows the action. Re-triggering
		 * the CSS animation requires removing the class and forcing a reflow before re-adding it, so
		 * two landings on the same tile still each flash. */
		_pulseLandedCell(pos) {
			const entry = this.cellEls[pos];
			if (!entry) return;
			const { cell } = entry;
			cell.classList.remove('mono-cell-landed');
			void cell.offsetWidth;
			cell.classList.add('mono-cell-landed');
		}

		_onGameRoll(player, d1, d2) {
			this._positionDiceForCurrentPlayer();
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
				// Fallback checkpoint: catches any leftover diff from a turn that produced no notice/
				// modal at all (e.g. a silent no-op decision, or the last mutation before the turn
				// just ended) - see _renderAll's comment for why this isn't folded into every render.
				this._diffAndAnimate('endOfTurn');
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

		/** Updates every visual (board, docks, controls, dice) from live game state immediately -
		 * deliberately does NOT fire the flying-bill/property animation (see _diffAndAnimate), which
		 * is instead triggered separately at natural "screen is clear" checkpoints: when the AI
		 * board notice fades (_drainEventQueue's dismiss) or a human decision modal closes
		 * (_hideModal), plus a fallback after every full turn in _runLoop. Calling _renderAll()
		 * itself mid-turn (e.g. once per postLandingActions loop iteration) is common and must stay
		 * cheap/side-effect-free for the animation layer - triggering a flight from an arbitrary,
		 * possibly mid-popup moment is what used to make bills fly while still hidden behind a
		 * notice, or skip over transactions the diff was still waiting to pair up (see git history:
		 * this used to call _diffAndAnimate() on every render, which raced with the popup/notice
		 * queue in exactly this way). */
		_renderAll() {
			this._renderBoardState();
			this._renderPlayers();
			this._renderControls();
			this._positionDiceForCurrentPlayer();
		}

		/** Slides/rotates the dice area (which lives centered on the board, see .mono-center in
		 * _renderBoardSkeleton) toward whichever seat's turn it currently is, so the dice visually sit
		 * "in front of" that player rather than always defaulting to the human's own seat. Uses the
		 * same slot->rotation convention as the player docks (DOCK_ROTATE) so the dice face that seat
		 * the same way property/cash rows do. */
		_positionDiceForCurrentPlayer() {
			if (!this.game || !this.diceAreaEl) return;
			const assignments = this._dockAssignments();
			let slot = 'bottom';
			for (const key of Object.keys(assignments)) {
				if (assignments[key].id === this.game.currentPlayerIdx) { slot = key; break; }
			}
			this.diceAreaEl.className = 'mono-dice-area mono-dice-area-' + slot;
		}

		/** Effective owner of `pos` to DISPLAY (docks/board), accounting for two independent
		 * overrides on top of the real game-state owner:
		 *  1. this._tradePreview - the in-progress, not-yet-sent offer in the trade builder.
		 *  2. this._pendingPropertyDisplay - a property currently mid-flight in _flyProperty's
		 *     animation (see _diffAndAnimate). Without this, _renderPlayers() would show the
		 *     property in its new owner's dock the instant the decision resolves, several ms BEFORE
		 *     the flying deed-card animation even starts - so by the time the card visually arrives,
		 *     the destination already displayed it, making the flight look like a no-op. Holding the
		 *     display at the OLD owner until the flight actually lands (cleared in _flyProperty's
		 *     removal timeout) gives the animation a real before/after to bridge, the same way a cash
		 *     pile's dollar total stays visibly different until its bill flight completes.
		 * Trade preview takes priority since it's an explicit, real-time user action (dragging
		 * properties into an offer) - it should never be masked by a leftover flight override from
		 * some earlier, unrelated transaction. */
		_previewOwner(pos) {
			const real = this.game.properties[pos].owner;
			const pv = this._tradePreview;
			if (pv) {
				if (pv.offerProps.includes(pos)) return pv.toId;
				if (pv.requestProps.includes(pos)) return pv.fromId;
			}
			if (this._pendingPropertyDisplay && this._pendingPropertyDisplay.has(pos)) {
				return this._pendingPropertyDisplay.get(pos);
			}
			return real;
		}

		/** Effective cash for player `id` accounting for this._tradePreview, same non-mutating
		 * preview as _previewOwner. Card counts intentionally aren't previewed on the board/player
		 * cards (no on-board representation for jail cards to update). */
		_previewCash(id) {
			const real = this.game.players[id].money;
			const pv = this._tradePreview;
			if (!pv) return real;
			if (id === pv.fromId) return real - (pv.offerMoney || 0) + (pv.requestMoney || 0);
			if (id === pv.toId) return real + (pv.offerMoney || 0) - (pv.requestMoney || 0);
			return real;
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

		/** Builds the inner HTML for the hover title-deed tooltip of a purchasable space (property/
		 * rail/utility). Returns null for non-purchasable spaces (Go, jail, tax, cards, parking), which
		 * get no tooltip. Reads live game state for the current owner/houses/mortgage status. */
		_deedTipHtml(pos) {
			const space = this.game ? this.game.getSpace(pos) : Board.SPACES.find(s => s.pos === pos);
			if (!space || (space.type !== 'property' && space.type !== 'rail' && space.type !== 'utility')) return null;
			const prop = this.game ? this.game.properties[pos] : null;
			const barColor = (space.group && GROUP_COLORS[space.group]) || (space.type === 'rail' ? '#555' : (space.type === 'utility' ? '#888' : '#999'));
			let ownerLine = '<span class="mono-hint">Unowned — bank</span>';
			if (prop && prop.owner !== null) {
				const owner = this.game.players[prop.owner];
				const status = prop.mortgaged ? ' (mortgaged)' : (prop.houses >= 5 ? ' · Hotel' : (prop.houses > 0 ? ` · ${prop.houses} house${prop.houses > 1 ? 's' : ''}` : ''));
				ownerLine = `Owned by <b style="color:${PLAYER_COLORS[owner.id]}">${owner.name}</b>${status}`;
			}
			let rentRows = '';
			if (space.type === 'property') {
				const labels = ['Base rent', '1 house', '2 houses', '3 houses', '4 houses', 'Hotel'];
				const liveTier = prop && !prop.mortgaged ? (prop.houses >= 5 ? 5 : prop.houses) : -1;
				rentRows = space.rent.map((r, i) =>
					`<div class="mono-deed-rent-row${i === liveTier ? ' current' : ''}"><span>${labels[i]}</span><span>$${r}</span></div>`
				).join('');
				rentRows += `<div class="mono-deed-rent-row sub"><span>House cost</span><span>$${space.houseCost} each</span></div>`;
			} else if (space.type === 'rail') {
				const labels = ['1 owned', '2 owned', '3 owned', '4 owned'];
				rentRows = space.rent.map((r, i) => `<div class="mono-deed-rent-row"><span>${labels[i]}</span><span>$${r}</span></div>`).join('');
			} else {
				rentRows = `<div class="mono-deed-rent-row"><span>1 owned</span><span>4× dice</span></div>`
					+ `<div class="mono-deed-rent-row"><span>2 owned</span><span>10× dice</span></div>`;
			}
			return `
				<div class="mono-deed-bar" style="background:${barColor}"></div>
				<div class="mono-deed-body">
					<div class="mono-deed-name">${space.name}</div>
					<div class="mono-deed-meta">Price $${space.price} · Mortgage $${Math.floor(space.price / 2)}</div>
					<div class="mono-deed-owner">${ownerLine}</div>
					<div class="mono-deed-rents">${rentRows}</div>
				</div>
			`;
		}

		_showDeedTip(pos, cell) {
			const html = this._deedTipHtml(pos);
			if (!html) { this._hideDeedTip(); return; }
			this.deedTipEl.innerHTML = html;
			this.deedTipEl.style.display = 'block';
			// position near the cell but clamped to the viewport so edge/corner tiles don't push it
			// off-screen (measured after it's visible so offsetWidth/Height are real)
			const r = cell.getBoundingClientRect();
			const tw = this.deedTipEl.offsetWidth, th = this.deedTipEl.offsetHeight;
			let left = r.right + 8;
			if (left + tw > window.innerWidth - 6) left = r.left - tw - 8;   // flip to the left side
			if (left < 6) left = Math.min(Math.max(6, r.left), window.innerWidth - tw - 6);
			let top = r.top;
			if (top + th > window.innerHeight - 6) top = window.innerHeight - th - 6;
			if (top < 6) top = 6;
			this.deedTipEl.style.left = left + 'px';
			this.deedTipEl.style.top = top + 'px';
		}

		_hideDeedTip() {
			if (this.deedTipEl) this.deedTipEl.style.display = 'none';
		}

		_renderBoardState() {
			const tradeable = this._canProposeTradeNow();
			for (const space of Board.SPACES) {
				const { cell, info } = this.cellEls[space.pos];
				info.innerHTML = '';
				if (this.game) {
					const prop = this.game.properties[space.pos];
					// chip reflects the PREVIEW owner (what an in-progress trade would result in, or -
					// see _previewOwner - a property mid-flight in _flyProperty still displaying its OLD
					// owner until the animation lands), but clickability/title stay keyed off the real
					// owner - the trade builder must always be opened against actual game state, not a
					// hypothetical mid-edit. previewOwnerId can be null even when prop.owner isn't (a
					// fresh bank purchase still displaying as unowned until its flight lands), so the
					// chip itself is gated on the PREVIEW owner, not the real one.
					const previewOwnerId = prop ? this._previewOwner(space.pos) : null;
					if (prop && prop.owner !== null && previewOwnerId !== null) {
						const owner = this.game.players[previewOwnerId];
						const chip = document.createElement('div');
						chip.className = 'mono-owner-chip' + (previewOwnerId !== prop.owner ? ' mono-owner-chip-preview' : '');
						chip.style.background = PLAYER_COLORS[owner.id];
						// chip carries only the mortgage flag now; houses/hotel show as visual pips
						// alongside it (clearer at a glance than a bare digit)
						chip.textContent = prop.mortgaged ? 'M' : '';
						info.appendChild(chip);
						if (!prop.mortgaged && prop.houses > 0) {
							const pips = document.createElement('div');
							pips.className = 'mono-cell-pips';
							if (prop.houses >= 5) {
								pips.innerHTML = '<div class="mono-pip-hotel" title="Hotel"></div>';
							} else {
								pips.innerHTML = Array.from({ length: prop.houses }, () => '<div class="mono-pip-house"></div>').join('');
								pips.title = `${prop.houses} house${prop.houses > 1 ? 's' : ''}`;
							}
							info.appendChild(pips);
						}
						const realOwner = this.game.players[prop.owner];
						const canTradeThis = tradeable && realOwner.id !== this.humanId && !realOwner.bankrupt;
						cell.classList.toggle('mono-cell-tradeable', canTradeThis);
						cell.title = canTradeThis ? `Click to propose a trade for ${space.name}` : '';
					} else {
						cell.classList.remove('mono-cell-tradeable');
						cell.title = '';
						// Not owned (or its purchase flight hasn't landed yet - see previewOwnerId above)
						// - show the bank's asking price right on the tile instead of an owner chip, so
						// the cost to buy is visible without having to land on it or open a modal.
						if (prop) {
							const priceTag = document.createElement('div');
							priceTag.className = 'mono-cell-price';
							priceTag.textContent = `$${space.price}`;
							info.appendChild(priceTag);
						}
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

		/** Transparent, engine-independent net-worth estimate for the HUD: cash + full price of each
		 * owned property (half-price when mortgaged) + resale value of houses/hotels (houses sell back
		 * at half the house cost, per standard rules). Deliberately simpler than strategy.js's
		 * genome-weighted estimateAssetValue - this is a display figure a human can reason about ("what
		 * could I liquidate to"), not a strategic valuation, so it needs no genome and stays stable. */
		_netWorth(playerId) {
			const p = this.game.players[playerId];
			let total = p.money;
			for (const pos of p.properties) {
				const space = this.game.getSpace(pos);
				const prop = this.game.properties[pos];
				total += prop.mortgaged ? Math.floor(space.price / 2) : space.price;
				if (prop.houses > 0 && space.houseCost) {
					total += prop.houses * Math.floor(space.houseCost / 2);
				}
			}
			return total;
		}


		// ---- First-run coach-mark tour (dismissible, remembered in localStorage). Points at the few
		// non-obvious things a new player needs: the win bar, click-to-trade, the dice, and the AI
		// speed control. Each step spotlights a target element and anchors a text card near it. ----

		_maybeStartTour() {
			let seen = false;
			try { seen = localStorage.getItem('monopoly-tour-done') === '1'; } catch (e) { /* storage blocked - just show it */ }
			if (seen) return;
			// let the board/HUD lay out first so target rects are real
			requestAnimationFrame(() => requestAnimationFrame(() => this._startTour()));
		}

		_startTour() {
			this._tourSteps = [
				{ sel: '#mono-human-dock-card', text: '<b>This is you.</b> Each player\'s label — around all four edges of the board — shows their <b>live win odds</b> (re-estimated from thousands of simulated games each round) and net worth, right above their cash.' },
				{ sel: '#mono-board', text: '<b>Hover any property</b> to see its full rent ladder and owner. <b>Click a rival\'s property</b> (on your turn) to propose a trade for it.' },
				{ sel: '#mono-dice-area', text: '<b>Roll here on your turn.</b> Buying, building, and trading all happen through prompts as you play.' },
				{ sel: '#mono-controls', text: '<b>Set the AI speed</b> here if the opponents move too fast or slow. That\'s it — good luck!' }
			];
			this._tourIdx = 0;
			this.tourEl.style.display = 'block';
			this.root.querySelector('#mono-tour-next').onclick = () => this._tourAdvance(1);
			this.root.querySelector('#mono-tour-skip').onclick = () => this._endTour();
			this._showTourStep();
			// reposition on resize/scroll while the tour is open
			this._tourReposition = () => this._showTourStep();
			window.addEventListener('resize', this._tourReposition);
			window.addEventListener('scroll', this._tourReposition, true);
		}

		_tourAdvance(dir) {
			this._tourIdx += dir;
			if (this._tourIdx >= this._tourSteps.length) { this._endTour(); return; }
			this._showTourStep();
		}

		_showTourStep() {
			const step = this._tourSteps[this._tourIdx];
			const target = this.root.querySelector(step.sel);
			const spot = this.root.querySelector('#mono-tour-spotlight');
			const card = this.root.querySelector('#mono-tour-card');
			this.root.querySelector('#mono-tour-text').innerHTML = step.text;
			this.root.querySelector('#mono-tour-progress').textContent = `${this._tourIdx + 1} / ${this._tourSteps.length}`;
			this.root.querySelector('#mono-tour-next').textContent = this._tourIdx === this._tourSteps.length - 1 ? 'Done' : 'Next';
			const r = target ? target.getBoundingClientRect() : null;
			if (!r || (!r.width && !r.height)) {
				// target not visible (e.g. dice hidden before first roll) - center the card, no spotlight
				spot.style.display = 'none';
				card.style.left = '50%'; card.style.top = '50%'; card.style.transform = 'translate(-50%, -50%)';
				return;
			}
			const pad = 6;
			spot.style.display = 'block';
			spot.style.left = (r.left - pad) + 'px';
			spot.style.top = (r.top - pad) + 'px';
			spot.style.width = (r.width + pad * 2) + 'px';
			spot.style.height = (r.height + pad * 2) + 'px';
			// place the card below the target if there's room, else above; clamp horizontally
			card.style.transform = 'none';
			const cardW = 280;
			let left = r.left + r.width / 2 - cardW / 2;
			left = Math.max(10, Math.min(left, window.innerWidth - cardW - 10));
			card.style.left = left + 'px';
			card.style.width = cardW + 'px';
			const below = r.bottom + 12;
			if (below + 130 < window.innerHeight) card.style.top = below + 'px';
			else card.style.top = Math.max(10, r.top - 142) + 'px';
		}

		_endTour() {
			this.tourEl.style.display = 'none';
			try { localStorage.setItem('monopoly-tour-done', '1'); } catch (e) { /* ignore */ }
			if (this._tourReposition) {
				window.removeEventListener('resize', this._tourReposition);
				window.removeEventListener('scroll', this._tourReposition, true);
				this._tourReposition = null;
			}
		}

		/** Returns [{key, label, color, icon, owned, total, complete}] for every color group plus
		 * rail/utility, for whichever groups this player owns at least one property in - used for
		 * the at-a-glance icon strip on each player card. */
		_ownershipSummary(playerId) {
			const groups = [];
			for (const groupKey of Object.keys(Board.GROUP_MEMBERS)) {
				const members = Board.GROUP_MEMBERS[groupKey];
				const owned = members.filter(pos => this._previewOwner(pos) === playerId).length;
				if (owned > 0) {
					groups.push({ key: groupKey, label: groupKey, color: GROUP_COLORS[groupKey], icon: null, owned, total: members.length, complete: owned === members.length });
				}
			}
			const railOwned = Board.RAIL_POSITIONS.filter(pos => this._previewOwner(pos) === playerId).length;
			if (railOwned > 0) {
				groups.push({ key: 'rail', label: 'Rails', color: null, icon: TYPE_ICONS.rail, owned: railOwned, total: Board.RAIL_POSITIONS.length, complete: railOwned === Board.RAIL_POSITIONS.length });
			}
			const utilOwned = Board.UTILITY_POSITIONS.filter(pos => this._previewOwner(pos) === playerId).length;
			if (utilOwned > 0) {
				groups.push({ key: 'utility', label: 'Utilities', color: null, icon: TYPE_ICONS.utility, owned: utilOwned, total: Board.UTILITY_POSITIONS.length, complete: utilOwned === Board.UTILITY_POSITIONS.length });
			}
			return groups;
		}

		/** Preview-aware property count and monopoly count for playerId, honoring this._tradePreview
		 * the same way _previewOwner does (see _renderPlayers). Kept local to ui.js rather than
		 * touching strategy.js's countMonopolies/game.js's ownsFullGroup, since those are read by
		 * bots/sims against real state and must stay untouched by a display-only concern. */
		_previewPropertyStats(playerId) {
			let propertyCount = 0, monopolies = 0;
			for (const posStr of Object.keys(this.game.properties)) {
				if (this._previewOwner(Number(posStr)) === playerId) propertyCount++;
			}
			for (const groupKey of Object.keys(Board.GROUP_MEMBERS)) {
				const members = Board.GROUP_MEMBERS[groupKey];
				if (members.every(pos => this._previewOwner(pos) === playerId)) monopolies++;
			}
			return { propertyCount, monopolies };
		}

		// The real Monopoly bank hands each player this exact bill breakdown at game start (not the
		// generic greedy change-making below, which would give 3x$500 for $1500 - see
		// _denominateCash), per the standard rulebook: 2x$500, 4x$100, 1x$50, 1x$20, 2x$10, 1x$5,
		// 5x$1 = $1500.
		static get STARTING_CASH_PILES() {
			return [
				{ value: 500, count: 2 }, { value: 100, count: 4 }, { value: 50, count: 1 },
				{ value: 20, count: 1 }, { value: 10, count: 2 }, { value: 5, count: 1 }, { value: 1, count: 5 }
			];
		}

		/** Breaks `amount` into standard Monopoly bank denominations for display. At exactly $1500
		 * (every player's starting cash, the amount most commonly shown) this uses the canonical
		 * starting-bank breakdown above rather than pure greedy change-making, since that's the actual
		 * physical stack a real Monopoly bank hands out - not an arbitrary "fewest bills" reduction.
		 * Any other amount falls back to real greedy change-making (largest first, as many of each as
		 * needed) - unlike an earlier version of this that capped at one bill per denomination, this
		 * must actually sum to `amount`: showing bill faces that don't add up to the printed total
		 * next to them reads as broken bookkeeping, not stylization.
		 * Returns [{value, count}, ...] (one entry per denomination actually used) so the caller can
		 * render a single pile per denomination with a "xN" count badge instead of N separate bill
		 * divs - keeps the DOM small even for a large stack that's mostly $500s. */
		_denominateCash(amount) {
			if (amount === 1500) return MonopolyUI.STARTING_CASH_PILES;
			const DENOMS = [500, 100, 50, 20, 10, 5, 1];
			let remaining = Math.max(0, Math.floor(amount));
			const piles = [];
			for (const d of DENOMS) {
				const count = Math.floor(remaining / d);
				if (count > 0) {
					piles.push({ value: d, count });
					remaining -= count * d;
				}
			}
			if (!piles.length) piles.push({ value: 1, count: 0 });
			return piles;
		}

		/** Flat list of individual bill values for `amount` (e.g. 1400 -> [500,500,100,100,100,100,50,50]),
		 * uncapped - one entry per real physical bill, unlike _cashStackHtml's MAX_STACKED=3 display cap.
		 * The user explicitly asked for every individual bill to fly, no cap, so this reuses
		 * _denominateCash's breakdown (which already sums exactly to amount) but expands each
		 * {value,count} pile into `count` separate entries. */
		_billList(amount) {
			const piles = this._denominateCash(amount);
			const bills = [];
			piles.forEach(({ value, count }) => { for (let i = 0; i < count; i++) bills.push(value); });
			return bills;
		}

		/** Center-point {x, y} of `el` in viewport coordinates (getBoundingClientRect), or null if the
		 * element doesn't exist/isn't laid out - callers must treat null as "skip the animation",
		 * never throw, since this runs on every money/property change and a missing dock (fast
		 * resize, mid-render edge case) must never freeze the game loop. */
		_elCenter(el) {
			if (!el || !el.getBoundingClientRect) return null;
			const r = el.getBoundingClientRect();
			if (!r.width && !r.height) return null;
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		}

		/** The on-screen anchor point for player `id`'s dock - bottom uses the human's dock card,
		 * others use their assigned slot's dock element. Returns null (not throw) if a dock can't be
		 * resolved (e.g. mid-layout), matching _elCenter's defensive contract. */
		_dockAnchor(playerId) {
			if (!this.game) return null;
			const assignments = this._dockAssignments();
			for (const slot of Object.keys(assignments)) {
				if (assignments[slot] && assignments[slot].id === playerId) return this._elCenter(this.dockEls[slot]);
			}
			return null;
		}

		_bankAnchor() {
			return this._elCenter(this.bankEl);
		}

		/** Fires-and-forgets a flurry of individual flying `.mono-bill` divs from `from` to `to`
		 * (viewport {x,y} points) for `amount` - one real bill per _billList entry, staggered a few
		 * ms apart so a multi-bill payment reads as a small flurry rather than a teleport, but never
		 * awaited by callers (transactions can be frequent; the game loop must not slow down for a
		 * cosmetic flourish). No-ops quietly if either endpoint is missing or amount is 0 - a
		 * rendering hiccup here must never affect the actual game state. */
		_flyBills(amount, from, to, label) {
			if (!amount || !from || !to || !this.fxLayerEl) {
				this._dlog('    _flyBills ABORT', label || '', 'amount=', amount, 'from=', from, 'to=', to, 'fxLayerEl=', !!this.fxLayerEl);
				return;
			}
			const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			const bills = this._billList(amount);
			const stagger = reduceMotion ? 0 : 80;
			const duration = reduceMotion ? 1 : 850;
			this._dlog('    _flyBills', label || '', 'amount=', amount, 'bills=', bills, 'from=', from, 'to=', to, 'totalStaggerSpan=', (bills.length - 1) * stagger + 'ms', 'reduceMotion=', reduceMotion);
			bills.forEach((value, i) => {
				setTimeout(() => {
					const el = document.createElement('div');
					el.className = `mono-bill mono-fly-bill mono-bill-${value}`;
					el.textContent = String(value);
					el.style.left = from.x + 'px';
					el.style.top = from.y + 'px';
					this.fxLayerEl.appendChild(el);
					this._dlog('      bill#' + i, label || '', '$' + value, 'appended, connected=', el.isConnected, 'rect=', el.getBoundingClientRect ? JSON.stringify(el.getBoundingClientRect()) : 'n/a', 'computedDisplay=', getComputedStyle(el).display, 'computedVisibility=', getComputedStyle(el).visibility, 'computedZIndex=', getComputedStyle(el).zIndex, 'computedBg=', getComputedStyle(el).backgroundImage.slice(0, 40));
					requestAnimationFrame(() => {
						el.style.transitionDuration = duration + 'ms';
						el.style.left = to.x + 'px';
						el.style.top = to.y + 'px';
						el.style.opacity = '0';
						this._dlog('      bill#' + i, label || '', '$' + value, 'rAF fired: left=', el.style.left, 'top=', el.style.top);
					});
					setTimeout(() => {
						this._dlog('      bill#' + i, label || '', '$' + value, 'removed after', duration + 60, 'ms, wasConnected=', el.isConnected);
						el.remove();
					}, duration + 60);
				}, i * stagger);
			});
		}

		/** Fire-and-forget flying deed-card animation for a single property ownership change, from
		 * `from` to `to` (viewport {x,y} points) - mirrors _flyBills but for one card, used for
		 * bank<->player and player<->player property transfers (see _diffAndAnimate).
		 * @param expectedDisplayOwner the value the caller just wrote into
		 * this._pendingPropertyDisplay.set(pos, ...) for this specific flight - must be cleared once
		 * the flight is done (lands, or aborts early for a missing anchor/game) so the dock display
		 * can catch up to the real owner (see _previewOwner's comment). Checked-and-cleared rather
		 * than blindly deleted, in case a second flight for the same pos started (and overwrote the
		 * map entry) before this one's timer fired - that would otherwise let this call's landing
		 * incorrectly release the OTHER flight's still-pending override. */
		_flyProperty(pos, from, to, expectedDisplayOwner) {
			const releasePendingDisplay = () => {
				if (this._pendingPropertyDisplay.get(pos) === expectedDisplayOwner) {
					this._pendingPropertyDisplay.delete(pos);
					// both surfaces read _previewOwner (see its comment) and must stay in sync -
					// _renderPlayers for the dock's property list, _renderBoardState for the board
					// tile's owner chip.
					this._renderPlayers();
					this._renderBoardState();
				}
			};
			if (!from || !to || !this.fxLayerEl || !this.game) {
				this._dlog('    _flyProperty ABORT pos=', pos, 'from=', from, 'to=', to, 'fxLayerEl=', !!this.fxLayerEl, 'game=', !!this.game);
				releasePendingDisplay();
				return;
			}
			const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			const duration = reduceMotion ? 1 : 900;
			const space = this.game.getSpace(pos);
			const barColor = (space.group && GROUP_COLORS[space.group]) || '#999';
			const el = document.createElement('div');
			el.className = 'mono-mini-prop mono-fly-prop';
			el.innerHTML = `<div class="mono-mini-prop-bar" style="background:${barColor}"></div><div class="mono-mini-prop-name">${space.name}</div>`;
			el.style.left = from.x + 'px';
			el.style.top = from.y + 'px';
			this.fxLayerEl.appendChild(el);
			this._dlog('    _flyProperty', space.name, 'from=', from, 'to=', to, 'sameSpot=', (from.x === to.x && from.y === to.y), 'duration=', duration, 'connected=', el.isConnected, 'rect=', el.getBoundingClientRect ? JSON.stringify(el.getBoundingClientRect()) : 'n/a');
			requestAnimationFrame(() => {
				el.style.transitionDuration = duration + 'ms';
				el.style.left = to.x + 'px';
				el.style.top = to.y + 'px';
				el.style.opacity = '0';
				this._dlog('    _flyProperty', space.name, 'rAF fired: computedOpacity=', getComputedStyle(el).opacity, 'computedLeft=', el.style.left, 'computedTop=', el.style.top);
			});
			setTimeout(() => {
				this._dlog('    _flyProperty', space.name, 'landed after', duration + 60, 'ms, wasConnected=', el.isConnected, '- releasing pending-display override');
				el.remove();
				releasePendingDisplay();
			}, duration + 60);
		}

		/** Diffs this._prevMoney/_prevProperties (snapshotted after the previous render pass) against
		 * live game state and fires flying-bill/flying-property animations for whatever changed -
		 * the generic mechanism that covers rent, tax, salary, buying, mortgaging, building,
		 * card effects, auctions, and trades without bespoke per-event-type wiring (see class-level
		 * comment in newGame() for why). Only called at a handful of deliberate "screen is clear"
		 * checkpoints - a board notice finishing its dismiss (_drainEventQueue), a human decision
		 * modal closing (_hideModal), and a fallback after every full turn in _runLoop - never as
		 * part of _renderAll's own immediate visual refresh, so it always sees the FULL diff
		 * accumulated since the last checkpoint in one shot, regardless of how many intermediate
		 * decide-then-mutate steps happened in between (a liquidation loop mortgaging several
		 * properties to cover rent, for instance). this._txHint, when set by the caller just before
		 * the event/decision that will need a checkpoint to actually show its effect (see
		 * _onGameEvent/_onAgentDecision), disambiguates player-to-player vs bank-involved for the
		 * cases where the callback itself already knows unambiguously (rent's owner, a resolved
		 * trade's two sides, bankruptcy's creditor) - pure diffing alone can't always tell "A lost $X,
		 * B gained $X" apart from "A lost $X to the bank" + "B separately gained $X from the bank in
		 * the same pass" (rare, but e.g. simultaneous rent+card in one pass could coincide). Falls
		 * back to pure diffing whenever no hint matches or a checkpoint's diff doesn't have the right
		 * shape to be it (exactly one gainer, one loser, matching amounts) - a stale hint just sits
		 * unused until either consumed or overwritten by the next one, no arbitrary expiry needed now
		 * that checkpoints are sparse and deliberate rather than firing on every micro-mutation. */
		/** Sets the current player-to-player transaction hint. Before replacing an existing hint, it
		 * flushes any money diff accumulated so far against the OLD hint (via _diffAndAnimate) - so a
		 * still-unsettled hint (common for rent, which game.js emits before actually moving the money)
		 * is always resolved against its own transaction before a newer event can overwrite it. Without
		 * this, back-to-back money events in one turn would leave the earlier hint stale, and its cash
		 * would fall back to bank legs instead of flying player-to-player. */
		_setTxHint(hint) {
			if (this._txHint && this._prevMoney) {
				// give the old hint a chance to claim whatever's moved since it was set
				this._diffAndAnimate('preHintFlush');
			}
			this._txHint = hint;
			this._dlog('  set txHint:', hint);
		}

		/** If `hint` names a from/to pair, tries to pull a matching player-to-player leg out of the
		 * accumulated gained/lost lists: the named payer must have lost at least `amt` and the named
		 * payee gained at least `amt`, where `amt` is the hint's own amount if known, else the smaller
		 * of the two sides. Mutates gained/lost in place (subtracting the matched amount, dropping
		 * zeroed entries) and returns the matched {fromId, toId, amount} or null. Robust to OTHER
		 * simultaneous bank transactions in the same diff (e.g. rent paid after a liquidation that
		 * mortgaged properties) - only the matched pair flies player-to-player; the remainder still
		 * routes through the bank below. */
		_matchHintPair(hint, gained, lost) {
			if (!hint || (hint.type !== 'rent' && hint.type !== 'trade' && hint.type !== 'bankruptcyCreditor')) return null;
			// a trade can net either direction depending on the offer, so accept both orderings;
			// rent/bankruptcy always flow payer(from)->payee(to)
			const orderings = hint.type === 'trade'
				? [[hint.fromId, hint.toId], [hint.toId, hint.fromId]]
				: [[hint.fromId, hint.toId]];
			for (const [payerId, payeeId] of orderings) {
				const loser = lost.find(l => l.id === payerId);
				const gainer = gained.find(g => g.id === payeeId);
				if (!loser || !gainer) continue;
				// prefer the hint's declared amount when it's actually present on both sides; otherwise
				// take whatever overlaps (the smaller of the two deltas)
				let amt = Math.min(loser.delta, gainer.delta);
				if (hint.amount && hint.amount <= loser.delta && hint.amount <= gainer.delta) amt = hint.amount;
				if (amt <= 0) continue;
				loser.delta -= amt;
				gainer.delta -= amt;
				if (loser.delta === 0) lost.splice(lost.indexOf(loser), 1);
				if (gainer.delta === 0) gained.splice(gained.indexOf(gainer), 1);
				return { fromId: payerId, toId: payeeId, amount: amt };
			}
			return null;
		}

		_diffAndAnimate(source) {
			if (!this.game || !this._prevMoney) { this._dlog('diffAndAnimate SKIP', source || '?', 'no game/prevMoney yet'); return; }
			const hint = this._txHint;
			const active = this.game.players;
			const bank = this._bankAnchor();
			this._dlog('diffAndAnimate START', source || '?', 'hint=', hint, 'bankAnchor=', bank ? 'ok' : 'NULL');

			// ---- money diffs ----
			const gained = []; // {id, delta}
			const lost = [];
			active.forEach(p => {
				const delta = p.money - this._prevMoney[p.id];
				if (delta > 0) gained.push({ id: p.id, delta });
				else if (delta < 0) lost.push({ id: p.id, delta: -delta });
			});
			this._dlog('  money diff: prevMoney=', this._prevMoney, 'liveMoney=', Object.fromEntries(active.map(p => [p.id, p.money])), 'gained=', gained, 'lost=', lost);
			if (gained.length || lost.length) {
				// First, pull out a hinted player-to-player leg (rent/trade/bankruptcy) if the diff
				// contains one - this flies directly dock-to-dock and is removed from the lists so it
				// isn't double-counted. Only consume (null) the hint once its pair actually appears in
				// the diff; a hint set before its money has moved (rent - see _onGameEvent) simply
				// survives to the next checkpoint where the money is finally present.
				const matched = this._matchHintPair(hint, gained, lost);
				if (matched) {
					this._txHint = null; // consumed - its transaction has now been animated
					const fromAnchor = this._dockAnchor(matched.fromId);
					const toAnchor = this._dockAnchor(matched.toId);
					this._dlog('  -> HINT-PAIR flight: player', matched.fromId, '-> player', matched.toId, 'amount=', matched.amount, 'fromAnchor=', fromAnchor ? 'ok' : 'NULL', 'toAnchor=', toAnchor ? 'ok' : 'NULL');
					this._flyBills(matched.amount, fromAnchor, toAnchor, `p${matched.fromId}->p${matched.toId}`);
				}
				// Whatever remains after the hinted pair is bank-involved: each gain flies from the bank
				// to that player, each loss flies from that player to the bank - independent flurries,
				// not paired up, since e.g. "collect $10 from every player" is 3 separate player->bank
				// legs into one implicit collector (the hinted single-recipient case is handled above).
				gained.forEach(g => {
					const toAnchor = this._dockAnchor(g.id);
					this._dlog('  -> BANK->player flight: bank -> player', g.id, 'amount=', g.delta, 'bankAnchor=', bank ? 'ok' : 'NULL', 'toAnchor=', toAnchor ? 'ok' : 'NULL');
					this._flyBills(g.delta, bank, toAnchor, `bank->p${g.id}`);
				});
				lost.forEach(l => {
					const fromAnchor = this._dockAnchor(l.id);
					this._dlog('  -> player->BANK flight: player', l.id, '-> bank amount=', l.delta, 'fromAnchor=', fromAnchor ? 'ok' : 'NULL', 'bankAnchor=', bank ? 'ok' : 'NULL');
					this._flyBills(l.delta, fromAnchor, bank, `p${l.id}->bank`);
				});
			} else {
				this._dlog('  -> no money diff this pass');
			}

			// ---- property owner diffs ----
			let propChanges = 0;
			Object.keys(this.game.properties).forEach(posStr => {
				const pos = Number(posStr);
				const prop = this.game.properties[pos];
				const prevOwner = this._prevProperties[pos];
				if (prevOwner === prop.owner) return;
				propChanges++;
				const toAnchor = prop.owner !== null ? this._dockAnchor(prop.owner) : bank;
				const fromAnchor = (prevOwner !== null && prevOwner !== undefined) ? this._dockAnchor(prevOwner) : bank;
				this._dlog('  -> property flight: pos', pos, this.game.getSpace(pos).name, 'owner', prevOwner, '->', prop.owner, 'fromAnchor=', fromAnchor ? 'ok' : 'NULL', 'toAnchor=', toAnchor ? 'ok' : 'NULL');
				// Hold the dock display at the OLD owner until this flight lands - see
				// _previewOwner's comment for why (otherwise the destination dock already shows the
				// property before the card even starts flying, and the flight looks like a no-op).
				const displayOwner = prevOwner === undefined ? null : prevOwner;
				this._pendingPropertyDisplay.set(pos, displayOwner);
				this._flyProperty(pos, fromAnchor, toAnchor, displayOwner);
			});
			if (propChanges) {
				// The docks/board were already rendered with the NEW owner (by whatever _renderAll()
				// call happened right after the decision resolved, before this checkpoint) - re-render
				// now so the pending-display overrides just set above actually take effect, rolling the
				// display back to the old owner for the duration of each flight.
				this._renderPlayers();
				this._renderBoardState();
			} else {
				this._dlog('  -> no property diff this pass');
			}

			this._snapshotState();
			this._dlog('diffAndAnimate END', source || '?');
		}

		/** Captures current money/property-owner state for the next _diffAndAnimate() call to diff
		 * against - see newGame() for initialization and _diffAndAnimate() for consumption. */
		_snapshotState() {
			if (!this.game) return;
			this._prevMoney = {};
			this.game.players.forEach(p => { this._prevMoney[p.id] = p.money; });
			this._prevProperties = {};
			Object.keys(this.game.properties).forEach(posStr => {
				this._prevProperties[Number(posStr)] = this.game.properties[Number(posStr)].owner;
			});
		}

		/** Renders one clean (non-fanned, non-rotated) pile per denomination present, side by side,
		 * like real bank stacks laid out at a seat - one pile per denomination _denominateCash actually
		 * used, with a "xN" badge when a pile represents more than one bill of that denomination
		 * (capped at MAX_STACKED bill divs tall for visual sanity - the badge is what keeps the true
		 * count honest, not the div count). Sized to be a prominent centerpiece (see .mono-cash-piles
		 * CSS - each row targets about half the board's own side length), tucked partly under the
		 * board panel's edge - the printed $ total is always the real, exact figure, and now so is
		 * every individual pile (this used to show a fixed one-of-each-denomination set that didn't
		 * actually sum to the displayed total).
		 * `slot` drives seat-facing rotation (see DOCK_ROTATE) same as _propertyRowHtml: top/left/right
		 * rotate to face that seat, bottom (human) stays upright. Rotated piles are wrapped in a
		 * fixed-size viewport (like the property row) since a transform doesn't change the element's
		 * reserved layout box. */
		_cashStackHtml(amount, slot) {
			const MAX_STACKED = 3; // bill divs drawn per pile, regardless of true count
			const denoms = this._denominateCash(amount);
			const piles = denoms.map(({ value, count }) => {
				const shown = Math.min(count, MAX_STACKED);
				const billDivs = Array.from({ length: shown }, () => `<div class="mono-bill mono-bill-${value}">${value}</div>`).join('');
				// the count badge sits OUTSIDE the bill stack itself (its own row below), not as the
				// last item in the same bottom-aligned flex column - otherwise a pile with a badge has
				// one more flex child than a pile without one, so their bill stacks' bottom edges (the
				// actual bills, which is what should visually line up across piles) end up at
				// different heights depending on whether that pile happens to need a badge.
				const badge = count > 1 ? `&times;${count}` : '&nbsp;';
				return `<div class="mono-bill-pile"><div class="mono-bill-stack">${billDivs}</div><div class="mono-bill-count">${badge}</div></div>`;
			}).join('');
			const rotate = DOCK_ROTATE[slot] || DOCK_ROTATE.bottom;
			const cashClass = rotate.cashClass;
			// the dollar total counter-rotates against the pile's own rotation (see
			// .mono-cash-amount's per-rotation override) so it's always upright/legible, even though
			// the bills themselves are fine rotated (their printed denomination isn't meant to be
			// read from any particular angle, unlike the $ total which is the actual source of truth)
			const piles_ = `<div class="mono-cash-piles${cashClass ? ' ' + cashClass : ''}"><div class="mono-cash-pile-row">${piles}</div><span class="mono-cash-amount">$${amount}</span></div>`;
			// only left/right (90deg turns) need the fixed-size clipping viewport - a 180deg turn
			// (top) doesn't swap width/height, so wrapping it would just needlessly constrain it
			const needsViewport = rotate.dir === 90 || rotate.dir === -90;
			return needsViewport ? `<div class="mono-cash-piles-viewport">${piles_}</div>` : piles_;
		}

		/** Groups a player's properties by color group / rail / utility (reusing _ownershipSummary's
		 * grouping logic but needing the actual member positions, not just counts), for the grouped
		 * side-by-side property row rendered directly on each dock. Returns
		 * [{key, color, icon, positions: [pos,...]}] in board order, omitting groups with no owned
		 * members. */
		_groupedOwnedProperties(playerId) {
			const groups = [];
			for (const groupKey of Object.keys(Board.GROUP_MEMBERS)) {
				const members = Board.GROUP_MEMBERS[groupKey];
				const owned = members.filter(pos => this._previewOwner(pos) === playerId);
				if (owned.length) groups.push({ key: groupKey, color: GROUP_COLORS[groupKey], icon: null, positions: owned });
			}
			const railOwned = Board.RAIL_POSITIONS.filter(pos => this._previewOwner(pos) === playerId);
			if (railOwned.length) groups.push({ key: 'rail', color: null, icon: TYPE_ICONS.rail, positions: railOwned });
			const utilOwned = Board.UTILITY_POSITIONS.filter(pos => this._previewOwner(pos) === playerId);
			if (utilOwned.length) groups.push({ key: 'utility', color: null, icon: TYPE_ICONS.utility, positions: utilOwned });
			return groups;
		}

		/** One small title-deed-style card (color bar + name, no fan/overlap) for a single owned
		 * property - the compact sibling of _modalPlayerProperties' larger detail cards, sized to fit
		 * several per row directly on a dock. */
		_miniPropCardHtml(pos) {
			const space = this.game.getSpace(pos);
			const prop = this.game.properties[pos];
			const barColor = (space.group && GROUP_COLORS[space.group]) || '#999';
			let mark = '';
			if (prop.mortgaged) mark = 'M';
			else if (prop.houses >= 5) mark = 'H';
			else if (prop.houses > 0) mark = String(prop.houses);
			return `
				<div class="mono-mini-prop${prop.mortgaged ? ' mortgaged' : ''}" title="${space.name}">
					<div class="mono-mini-prop-bar" style="background:${barColor}"></div>
					<div class="mono-mini-prop-name">${space.name}</div>
					${mark ? `<div class="mono-mini-prop-mark">${mark}</div>` : ''}
				</div>
			`;
		}

		/** Grouped, non-fanned, side-by-side property card row for a player's dock - clusters cards by
		 * color group/rail/utility (small gap between clusters), replacing the old "click to open a
		 * modal" as the primary at-a-glance view. `slot` applies the seat-facing rotation for
		 * top/left/right docks (see DOCK_ROTATE / .mono-prop-row-rotate-* CSS); bottom (human) gets
		 * none. The rotated row is wrapped in a fixed-size "viewport" div with overflow:hidden - a
		 * transform doesn't change the element's reserved layout box, so without this wrapper a
		 * rotated row's true (wide) footprint would still reserve/spill into that width, pushing into
		 * the name label above it. The wrapper's own box is sized for the POST-rotation footprint
		 * instead. */
		_propertyRowHtml(playerId, slot) {
			const groups = this._groupedOwnedProperties(playerId);
			if (!groups.length) return '';
			const clusters = groups.map(g => `
				<div class="mono-prop-cluster">
					${g.positions.map(pos => this._miniPropCardHtml(pos)).join('')}
				</div>
			`).join('');
			const rotate = DOCK_ROTATE[slot] || DOCK_ROTATE.bottom;
			const rotateClass = rotate.propClass;
			const row = `<div class="mono-prop-row${rotateClass ? ' ' + rotateClass : ''}">${clusters}</div>`;
			// only left/right (90deg turns) need the fixed-size clipping viewport - a 180deg turn
			// (top) doesn't swap width/height, so wrapping it would just needlessly constrain it
			const needsViewport = rotate.dir === 90 || rotate.dir === -90;
			return needsViewport ? `<div class="mono-prop-row-viewport">${row}</div>` : row;
		}

		/** Assigns each active dock slot (top/left/right = the 3 AI opponents, bottom = the human) a
		 * player id, in table order starting just after the human - keeps the AI arrangement stable
		 * around the board regardless of turn order, rather than reshuffling docks every turn. */
		_dockAssignments() {
			const order = ['bottom', 'left', 'top', 'right'];
			const assignments = {};
			this.game.players.forEach(p => { assignments[order[p.id % order.length]] = p; });
			return assignments;
		}

/** Gutted dock: no boxed "player card" anymore - just a small name label (+ turn dot / jail flag),
		 * with the cash piles and property clusters rendered as bare, unboxed elements tucked right
		 * under/against the board's own frame on that side (see .mono-dock-* CSS - the whole dock is
		 * a thin strip hugging the board edge, not a card floating off of it). */
		_renderPlayerCardHtml(p, slot) {
			const previewed = !!this._tradePreview && (p.id === this._tradePreview.fromId || p.id === this._tradePreview.toId);
			const isHuman = p.id === this.humanId;
			const classes = 'mono-player-dock' + (p.bankrupt ? ' bankrupt' : '')
				+ (this.game.currentPlayerIdx === p.id && !this.game.gameOver ? ' active' : '')
				+ (previewed ? ' mono-player-dock-preview' : '')
				+ (isHuman ? '' : (this._canProposeTradeNow() && !p.bankrupt ? ' mono-dock-tradeable' : ''));
			// Win% + net worth used to live in the top HUD scoreboard; they're folded into each dock
			// label now (see _renderPlayers / _updateWinProbabilities, which re-render docks when a
			// fresh estimate lands). Win% shows a dash until the first Monte-Carlo estimate completes.
			const worth = this._netWorth(p.id);
			const winPct = (this.winProbs && this.winProbs[p.id] != null) ? Math.round(this.winProbs[p.id] * 100) + '%' : '—';
			return `
				<div class="${classes}" data-player-id="${p.id}" title="${!isHuman && this._canProposeTradeNow() && !p.bankrupt ? `Click to propose a trade with ${p.name}` : ''}">
					<div class="mono-player-label">
						<span class="mono-player-name" style="color:${PLAYER_COLORS[p.id]}">${p.name}${p.bankrupt ? ' (out)' : ''}</span>
						${this.game.currentPlayerIdx === p.id && !this.game.gameOver ? '<span class="mono-turn-dot" title="Current turn"></span>' : ''}
						${p.inJail ? '<span class="mono-jail-indicator" title="In Jail">🔒</span>' : ''}
					</div>
					<div class="mono-player-stats">
						<span class="mono-player-win" style="color:${PLAYER_COLORS[p.id]}" title="Live win probability (Monte-Carlo estimate)">${p.bankrupt ? '—' : winPct}</span>
						<span class="mono-player-worth" title="Net worth (cash + property + houses)">≈$${worth}</span>
					</div>
					${this._cashStackHtml(this._previewCash(p.id), slot)}
					${this._propertyRowHtml(p.id, slot)}
				</div>
			`;
		}

		_renderPlayers() {
			if (!this.game) {
				Object.values(this.dockEls).forEach(el => { el.innerHTML = ''; });
				return;
			}
			const assignments = this._dockAssignments();
			Object.keys(this.dockEls).forEach(slot => {
				const p = assignments[slot];
				this.dockEls[slot].innerHTML = p ? this._renderPlayerCardHtml(p, slot) : '';
			});
			this.root.querySelectorAll('.mono-player-dock').forEach(dock => {
				const pid = Number(dock.dataset.playerId);
				if (pid === this.humanId) {
					// human's own dock isn't a trade target - clicking it instead opens the full
					// properties list, since the always-visible row can't show rent/mortgage detail
					dock.addEventListener('click', () => this._modalPlayerProperties(pid));
				} else {
					// clicking anywhere on an opponent's dock proposes a trade with them, mirroring
					// _onCellClick's board-click trade entry point; also doubles as their properties
					// detail view when a trade can't currently be proposed
					dock.addEventListener('click', () => {
						if (this._canProposeTradeNow()) this._onDockClick(pid);
						else this._modalPlayerProperties(pid);
					});
				}
			});
		}

		/** Mirrors _onCellClick but targets a player directly rather than a specific property -
		 * opens the trade builder pre-targeted at whichever opponent's dock was clicked. */
		_onDockClick(playerId) {
			if (!this._canProposeTradeNow()) return;
			const target = this.game.players[playerId];
			if (!target || target.bankrupt) return;
			const pendingCtx = this.humanAgent._pending.ctx;
			this._modalTradeBuilder(pendingCtx, this.game.activePlayers().filter(p => p.id !== this.humanId), { targetId: target.id });
		}

		_modalPlayerProperties(playerId) {
			const player = this.game.players[playerId];
			const rows = player.properties.slice().sort((a, b) => a - b).map(pos => {
				const space = this.game.getSpace(pos);
				const prop = this.game.properties[pos];
				const barColor = (space.group && GROUP_COLORS[space.group]) || '#999';
				let status;
				if (prop.mortgaged) status = 'Mortgaged';
				else if (prop.houses >= 5) status = 'Hotel';
				else if (prop.houses > 0) status = `${prop.houses} house${prop.houses > 1 ? 's' : ''}`;
				else if (space.type === 'property') status = this.game.ownsFullGroup(playerId, space.group) ? 'Full set, no houses' : '';
				else status = '';
				const rent = this.game.calcRent(pos, 7);
				return `
					<div class="mono-prop-card${prop.mortgaged ? ' mortgaged' : ''}">
						<div class="mono-prop-card-bar" style="background:${barColor}"></div>
						<div class="mono-prop-card-body">
							<div class="mono-prop-card-name">${space.name}</div>
							<div class="mono-prop-card-row">
								<span class="mono-prop-status">${status}</span>
								<span class="mono-prop-rent">$${rent} rent &middot; $${space.price} price</span>
							</div>
						</div>
					</div>
				`;
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
			this._dlog('onAgentDecision:', method, 'player=', player.id, 'result=', result, 'money(all)=', Object.fromEntries(this.game.players.map(p => [p.id, p.money])));
			// A resolved (accepted) trade is a direct player-to-player transfer of money/properties -
			// applyTradeEffects has already run by the time this callback fires (see game.js's
			// callAgent/handleTradeProposal), so tell _diffAndAnimate to fly bills/cards directly
			// between these two docks rather than routing through the bank. Both directions are
			// tagged (proposer<->target) since a trade can net either way depending on the offer.
			if (method === 'decideTradeResponse' && result) {
				this._setTxHint({ type: 'trade', fromId: ctx.proposer.id, toId: player.id });
			}
			this._renderAll(); // reflect this decision's already-applied effects (own or AI's) in dock numbers/board immediately - NOT the flying-bill animation itself, which waits for a checkpoint (see _renderAll's comment)
			// Detect an AI rejecting the HUMAN's own trade proposal (player here is the AI target,
			// so this doesn't hit the early-return below) - stash it so the next 'action' decision
			// reopens the trade builder prefilled with the rejected offer instead of the bare
			// action menu, per _onHumanDecisionNeeded's handling of _pendingTradeRejection.
			if (method === 'decideTradeResponse' && ctx.proposer && ctx.proposer.id === this.humanId && !result) {
				this._pendingTradeRejection = this._lastTradeAttempt;
			}
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

		/** Read-only "what would this AI roughly want for pos" estimate for the trade builder's
		 * "Ask their price" hint - never touches the engine's decide* pipeline or consumes a turn
		 * action, just replays the same math evaluateTrade/composeCounterOffer use (the target's own
		 * genome valuation x tradeFairnessMargin) so the number reflects what would actually clear
		 * their acceptance threshold. Only meaningful for AI targets; the human trade-response modal
		 * is how a human target communicates their own price. */
		_estimateAskingPrice(target, pos) {
			if (!target.agent || !target.agent.genome) return null;
			const genome = target.agent.genome;
			return Math.round(estimateAssetValue(this.game, target.id, pos, genome) * genome.tradeFairnessMargin);
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
			// Auction result: the live auction room is showing this deal, so present the outcome INSIDE
			// the room (winner banner) and close it, rather than firing the generic center-notice. The
			// money/property diff (winner pays the bank, gets the deed) still animates via the normal
			// checkpoint at the end of the turn / next notice.
			if (type === 'auctionResult' && this._auction) {
				this._renderAll();
				await this._showAuctionResult(data);
				return;
			}
			const html = this._describeGameEvent(type, data);
			this._dlog('onGameEvent:', type, 'player=', data.player ? data.player.id : undefined, 'amount=', data.amount, 'money(all)=', Object.fromEntries(this.game.players.map(p => [p.id, p.money])));
			// Unambiguous player-to-player cases the callback data already tells us directly, so
			// _diffAndAnimate doesn't have to guess from the money diff alone - see that method's
			// comment on why pure diffing can occasionally be ambiguous. Both rent and a
			// creditor-bankruptcy are payer->payee with an explicit named counterpart.
			// A rent event is emitted by game.js BEFORE the money actually moves (emitEvent then
			// payMoney - see game.js resolveSpace/card handlers), and payMoney can itself trigger
			// liquidation notices in between, so the payer->owner cash diff often isn't flushed until a
			// LATER checkpoint with other transactions mixed in. So the hint carries fromId/toId (and
			// the expected amount) and _diffAndAnimate pairs that specific pair out of the accumulated
			// diff rather than requiring the whole diff to be one clean pair - see _matchHintPair.
			if (type === 'rent') { this._setTxHint({ type: 'rent', fromId: data.player.id, toId: data.owner.id, amount: data.amount }); }
			else if (type === 'bankruptcy' && data.creditor) { this._setTxHint({ type: 'bankruptcyCreditor', fromId: data.player.id, toId: data.creditor.id }); }
			this._renderAll(); // reflect this event's already-applied effects (rent, tax, bankruptcy, etc.) in dock numbers/board immediately - flying-bill animation itself waits for a checkpoint (see _renderAll's comment)
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

		/** Queues a notification (AI decision or automatic game event), shown in a spot on the board
		 * itself (.mono-event-notice, overlaid on the center logo - see _renderBoardSkeleton) rather
		 * than a blocking centered popup, and returns a Promise that resolves once it's cleared. Only
		 * one notification is ever on screen at a time; if another is already showing, this one waits
		 * in _eventQueue. Each notice auto-dismisses after a short delay (scaled by the same "AI
		 * speed" setting that paces bot turns, so slowing that down also gives more time to read
		 * notices) rather than requiring a click - clicking it just skips the wait early. The caller
		 * in game.js awaits this (via onAgentDecision/onEvent), so nothing else in the turn proceeds
		 * until the notice has cleared. */
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
			const noticeText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
			this._dlog('notice SHOW:', noticeText);
			this.eventNoticeEl.style.borderColor = borderColor || '';
			this.eventNoticeEl.innerHTML = html;
			this.eventNoticeEl.style.display = 'block';
			this._centerTitleEl().style.display = 'none';
			const dismiss = () => {
				this._dlog('notice DISMISS:', noticeText);
				if (this._eventDismissTimer) { clearTimeout(this._eventDismissTimer); this._eventDismissTimer = null; }
				this.eventNoticeEl.style.display = 'none';
				this.eventNoticeEl.innerHTML = '';
				this.eventNoticeEl.style.borderColor = '';
				this.eventNoticeEl.onclick = null;
				this._centerTitleEl().style.display = '';
				this._eventShowing = false;
				// The board is clear again right here - the one moment guaranteed not to be mid-popup
				// or mid-liquidation-loop, so this is where the flying-bill/property animation for
				// whatever changed while this notice was up (and anything that happened right before
				// it, still unanimated) actually fires. See _renderAll's comment for why this can't
				// just live there instead.
				this._diffAndAnimate('noticeDismiss:' + noticeText.slice(0, 40));
				resolve();
				this._drainEventQueue(); // show the next queued notification, if any
			};
			this.eventNoticeEl.onclick = dismiss; // click to skip the wait
			// same 150/650/1400ms tiers as the bot-action pacing (this.speed), floored so even "Fast"
			// leaves a notice on screen long enough to register rather than flickering
			this._eventDismissTimer = setTimeout(dismiss, Math.max(500, this.speed * 2));
		}

		_centerTitleEl() {
			return this.root.querySelector('#mono-center-title');
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
				case 'action': {
					// if the last thing that happened was an AI rejecting the trade THIS decideAction
					// call is following up on, reopen the trade builder prefilled with that rejected
					// offer (see _onAgentDecision) instead of the bare action menu, so counteroffers
					// don't mean starting over from scratch each round
					if (this._pendingTradeRejection) {
						const rejected = this._pendingTradeRejection;
						this._pendingTradeRejection = null;
						const otherPlayers = this.game.activePlayers().filter(p => p.id !== player.id);
						return this._modalTradeBuilder(ctx, otherPlayers, Object.assign({ rejected: true }, rejected));
					}
					return this._modalAction(ctx);
				}
				case 'tradeResponse': return this._modalTradeResponse(ctx);
			}
		}

		// ---- Dice roll ----

		_showRollButton(ctx) {
			this._positionDiceForCurrentPlayer();
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

		/** @param deferCheckpoint - true for the one case (buying a property) where closing the modal
		 * happens BEFORE resolve() unblocks game.js to actually apply the mutation (see
		 * _modalBuyProperty), so animating here would still see pre-purchase state. In that case the
		 * caller queues _diffAndAnimate() as a macrotask instead (setTimeout 0), which runs after the
		 * resolve() continuation's mutation has had a chance to complete synchronously. */
		_hideModal(deferCheckpoint) {
			this.modalBackdrop.style.display = 'none';
			this.modalEl.innerHTML = '';
			// Mirrors _drainEventQueue's dismiss() for the human's own decisions (buy/jail/action/
			// trade/auction) - the modal closing is this path's "board is clear again" checkpoint, so
			// the flying-bill/property animation for whatever the human's choice just changed fires
			// here rather than inside _renderAll (see its comment for why).
			if (deferCheckpoint) setTimeout(() => this._diffAndAnimate('hideModal(deferred)'), 0);
			else this._diffAndAnimate('hideModal');
		}

		/** How many of a purchasable space's "set" the player would own after acquiring `pos`, and the
		 * set size - drives the buy modal's "completes a set / N of M" callout. Works for color groups,
		 * rails, and utilities. Returns null for non-set spaces. */
		_setProgressAfterBuy(playerId, pos) {
			const space = this.game.getSpace(pos);
			let members;
			let label;
			if (space.type === 'property') { members = Board.GROUP_MEMBERS[space.group]; label = `${space.group} set`; }
			else if (space.type === 'rail') { members = Board.RAIL_POSITIONS; label = 'stations'; }
			else if (space.type === 'utility') { members = Board.UTILITY_POSITIONS; label = 'utilities'; }
			else return null;
			const ownedNow = members.filter(m => this.game.properties[m].owner === playerId).length;
			return { owned: ownedNow + 1, total: members.length, label };
		}

		_modalBuyProperty(ctx) {
			const space = this.game.getSpace(ctx.pos);
			const afford = ctx.player.money >= space.price;
			const prog = this._setProgressAfterBuy(ctx.player.id, ctx.pos);
			let setCallout = '';
			if (prog) {
				const completes = prog.owned === prog.total;
				setCallout = `<div class="mono-buy-callout${completes ? ' complete' : ''}">${completes ? '🎉 Completes your ' + prog.label + '!' : `You'd own ${prog.owned} of ${prog.total} ${prog.label}`}</div>`;
			}
			this._showModal(`
				<h3>Buy this property?</h3>
				<div class="mono-deed-card">${this._deedTipHtml(ctx.pos)}</div>
				${setCallout}
				<p class="mono-buy-cash">Your cash: <b>$${ctx.player.money}</b> → <b>$${ctx.player.money - space.price}</b> after buying</p>
				<div class="mono-modal-actions">
					<button class="mono-btn" id="mono-buy-yes" ${afford ? '' : 'disabled title="Not enough cash"'}>Buy for $${space.price}</button>
					<button class="mono-btn secondary" id="mono-buy-no">Pass (go to auction)</button>
				</div>
			`);
			// Buying is resolved by the human clicking here, but the actual money/property mutation
			// only happens back in game.js's offerPurchaseOrAuction AFTER resolve() unblocks it - so
			// unlike every other human decision modal, _hideModal() here would checkpoint too early
			// (same gap decideBuyProperty has for AI, see callAgent's comment). Defer the checkpoint
			// one tick via resolve()'s continuation instead of firing it inside _hideModal.
			this.modalEl.querySelector('#mono-buy-yes').onclick = () => { this._hideModal(true); this.humanAgent.resolve('buyProperty', true); };
			this.modalEl.querySelector('#mono-buy-no').onclick = () => { this._hideModal(); this.humanAgent.resolve('buyProperty', false); };
		}

		// ---- Live auction room ----
		// Driven by three engine hooks: onAuctionStart (open the room), onAuctionBid (a bid/pass just
		// happened - update the board + history, pace AI raises), and the human's own decideAuctionBid
		// (enable the human's bid controls in the already-open room and wait). auctionResult (via
		// _onGameEvent) then shows the winner and closes it. this._auction holds live room state.

		_onAuctionStart(data) {
			this._auction = {
				pos: data.pos,
				spaceName: data.spaceName,
				highBid: 0,
				highBidder: null,
				history: [],           // [{playerId, outcome:'raise'|'pass', bid}]
				out: new Set()         // ids that have withdrawn
			};
			this.auctionBackdrop.style.display = 'flex';
			this._renderAuctionRoom(null);
		}

		async _onAuctionBid(data) {
			if (!this._auction) return;
			this._auction.highBid = data.highBid;
			this._auction.highBidder = data.highBidder;
			if (data.outcome === 'pass') this._auction.out.add(data.playerId);
			this._auction.history.push({ playerId: data.playerId, outcome: data.outcome, bid: data.bid });
			this._renderAuctionRoom(data.playerId);
			// pace AI raises so the room reads as a live back-and-forth rather than instant; the human's
			// own bids were already resolved interactively so they don't need an extra pause here
			if (data.playerId !== this.humanId) await this._sleep(Math.max(250, this.speed * 0.6));
		}

		/** @param activeId the player whose bid/pass just landed (for a brief highlight), or null. */
		_renderAuctionRoom(activeId) {
			if (!this._auction) return;
			const a = this._auction;
			const minBid = a.highBid + 5;
			const seats = this.game.players.map(p => {
				const isOut = a.out.has(p.id) || p.bankrupt;
				const isHigh = a.highBidder === p.id;
				const cls = 'mono-auc-seat' + (isOut ? ' out' : '') + (isHigh ? ' high' : '') + (activeId === p.id ? ' pinged' : '') + (p.id === this.humanId ? ' you' : '');
				const status = p.bankrupt ? 'bankrupt' : (isOut ? 'withdrew' : (isHigh ? `$${a.highBid}` : 'in'));
				return `<div class="${cls}">
					<span class="mono-auc-token">${PLAYER_TOKENS[p.id] || '●'}</span>
					<span class="mono-auc-name" style="color:${PLAYER_COLORS[p.id]}">${p.name}</span>
					<span class="mono-auc-status">${status}</span>
					<span class="mono-auc-cash">$${p.money}</span>
				</div>`;
			}).join('');
			const historyHtml = a.history.slice(-6).map(h => {
				const name = this.game.players[h.playerId].name;
				return h.outcome === 'raise'
					? `<div class="mono-auc-hist-line"><b style="color:${PLAYER_COLORS[h.playerId]}">${name}</b> bids $${h.bid}</div>`
					: `<div class="mono-auc-hist-line mono-hint">${name} withdraws</div>`;
			}).join('') || '<div class="mono-hint">No bids yet.</div>';
			const highName = a.highBidder !== null ? this.game.players[a.highBidder].name : null;

			// human's controls (only interactive while it's the human's turn to bid - see _modalAuctionBid
			// which flips this._auction.humanTurn on and wires the buttons; otherwise they're disabled)
			const human = this.game.players[this.humanId];
			const canBid = !!a.humanTurn && !a.out.has(this.humanId) && !human.bankrupt;
			const quick = [10, 50, 100];
			const quickBtns = quick.map(inc => {
				const amt = minBid - 5 + inc; // relative to current high bid
				const afford = amt <= human.money;
				return `<button class="mono-btn mono-auc-quick" data-bid="${amt}" ${canBid && afford ? '' : 'disabled'}>+$${inc}</button>`;
			}).join('');

			this.auctionRoomEl.innerHTML = `
				<h3>🔨 Auction</h3>
				<div class="mono-deed-card">${this._deedTipHtml(a.pos)}</div>
				<div class="mono-auc-high">High bid: <b>$${a.highBid}</b> ${highName ? `<span style="color:${PLAYER_COLORS[a.highBidder]}">(${highName})</span>` : '<span class="mono-hint">— no bids</span>'}</div>
				<div class="mono-auc-seats">${seats}</div>
				<div class="mono-auc-history">${historyHtml}</div>
				<div class="mono-auc-controls">
					<div class="mono-auc-quickrow">${quickBtns}</div>
					<div class="mono-auc-customrow">
						<input type="number" id="mono-auc-input" min="${minBid}" max="${human.money}" value="${Math.min(minBid, human.money)}" class="mono-input" ${canBid ? '' : 'disabled'}>
						<button class="mono-btn" id="mono-auc-bid" ${canBid ? '' : 'disabled'}>Bid</button>
						<button class="mono-btn secondary" id="mono-auc-pass" ${canBid ? '' : 'disabled'}>Withdraw</button>
					</div>
					<div class="mono-auc-prompt">${canBid ? `Your turn — min bid $${minBid}` : (a.humanTurn ? '' : 'Waiting for other bidders…')}</div>
				</div>
			`;

			if (canBid) {
				const submit = (val) => {
					a.humanTurn = false;
					this.humanAgent.resolve('auctionBid', val);
				};
				this.auctionRoomEl.querySelectorAll('.mono-auc-quick').forEach(btn => {
					btn.onclick = () => submit(Number(btn.dataset.bid));
				});
				this.auctionRoomEl.querySelector('#mono-auc-bid').onclick = () => {
					submit(Number(this.auctionRoomEl.querySelector('#mono-auc-input').value) || 0);
				};
				this.auctionRoomEl.querySelector('#mono-auc-pass').onclick = () => submit(0);
			}
		}

		_modalAuctionBid(ctx) {
			// The engine is asking the human for a bid. The room is already open (onAuctionStart fired
			// first); just flip on the human's controls and re-render - the promise resolves when they
			// click a bid/withdraw button (wired in _renderAuctionRoom).
			if (!this._auction) { this._onAuctionStart({ pos: ctx.pos, spaceName: this.game.getSpace(ctx.pos).name, bidders: [] }); }
			this._auction.highBid = ctx.highBid;
			this._auction.highBidder = ctx.highBidder;
			this._auction.humanTurn = true;
			this._renderAuctionRoom(null);
		}

		/** Shows the auction outcome inside the room (winner banner or "no sale"), waits briefly so the
		 * player can register it, then closes the room. Clickable to dismiss early. Awaited by the
		 * engine (via onEvent) so the turn doesn't continue until the room clears. */
		_showAuctionResult(data) {
			return new Promise(resolve => {
				const banner = data.winner
					? `<div class="mono-auc-result win">🔨 <b style="color:${PLAYER_COLORS[data.winner.id]}">${data.winner.name}</b> wins ${data.spaceName} for <b>$${data.amount}</b>!</div>`
					: `<div class="mono-auc-result">No bids — ${data.spaceName} stays with the bank.</div>`;
				const bannerEl = document.createElement('div');
				bannerEl.innerHTML = banner;
				this.auctionRoomEl.insertBefore(bannerEl.firstChild, this.auctionRoomEl.firstChild);
				// disable any lingering controls
				this.auctionRoomEl.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					this._closeAuctionRoom();
					resolve();
				};
				const timer = setTimeout(finish, Math.max(1200, this.speed * 2));
				this.auctionBackdrop.onclick = (e) => { if (e.target === this.auctionBackdrop || this.auctionRoomEl.contains(e.target)) finish(); };
			});
		}

		_closeAuctionRoom() {
			this.auctionBackdrop.style.display = 'none';
			this.auctionBackdrop.onclick = null;
			this.auctionRoomEl.innerHTML = '';
			this._auction = null;
		}

		_modalJail(ctx) {
			const canCard = ctx.player.getOutOfJailFree > 0;
			const canPay = ctx.player.money >= Board.JAIL_FINE;
			const attemptsLeft = 3 - ctx.player.jailTurns;
			this._showModal(`
				<h3>🔒 You're in Jail</h3>
				<p>Roll attempt <b>${ctx.player.jailTurns + 1} of 3</b> — ${attemptsLeft} left. Roll doubles to get out free, or buy your way out now.</p>
				<div class="mono-modal-actions vertical">
					${canCard ? '<button class="mono-btn" id="mono-jail-card">🎟️ Use Get Out of Jail Free card</button>' : ''}
					${canPay ? `<button class="mono-btn" id="mono-jail-pay">💵 Pay $${Board.JAIL_FINE} bail</button>` : ''}
					<button class="mono-btn secondary" id="mono-jail-stay">🎲 Try to roll doubles</button>
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
				<h3>⚠️ Raise cash</h3>
				<p>You need <b>$${ctx.amountNeeded}</b> but only have <b>$${ctx.player.money}</b>. Sell houses or mortgage properties to cover it, or risk bankruptcy.</p>
				<div class="mono-modal-actions vertical">${rows}
					<button class="mono-btn danger" id="mono-liq-stop">Stop (risk bankruptcy)</button>
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

			// Grouped into labeled sections (Build / Manage / Trade) instead of one flat list, so a
			// player with many properties can scan by category; each build button disables-with-reason
			// (rather than vanishing) when its house cost isn't currently affordable, keeping the option
			// discoverable. A section is omitted entirely only when it has no candidate spaces at all.
			const section = (title, inner) => inner ? `<div class="mono-action-section"><div class="mono-action-heading">${title}</div>${inner}</div>` : '';

			const buildBtns = buildable.map(pos => {
				const space = this.game.getSpace(pos);
				const afford = player.money >= space.houseCost;
				const isHotel = this.game.properties[pos].houses === 4;
				return `<button class="mono-btn small" data-action="build" data-pos="${pos}" ${afford ? '' : 'disabled title="Need $' + space.houseCost + '"'}>🏠 ${isHotel ? 'Build hotel' : 'Build house'} on ${space.name} <span class="mono-action-cost">$${space.houseCost}</span></button>`;
			}).join('');

			const manageBtns = [
				...sellableHouses.map(pos => {
					const space = this.game.getSpace(pos);
					return `<button class="mono-btn small" data-action="sellHouse" data-pos="${pos}">🔻 Sell house on ${space.name}</button>`;
				}),
				...mortgageable.map(pos => {
					const space = this.game.getSpace(pos);
					return `<button class="mono-btn small" data-action="mortgage" data-pos="${pos}">🏦 Mortgage ${space.name} <span class="mono-action-cost">+$${Math.floor(space.price / 2)}</span></button>`;
				}),
				...unmortgageable.map(pos => {
					const space = this.game.getSpace(pos);
					const cost = Math.ceil(space.price / 2 * 1.1);
					const afford = player.money >= cost;
					return `<button class="mono-btn small" data-action="unmortgage" data-pos="${pos}" ${afford ? '' : 'disabled title="Need $' + cost + '"'}>🔓 Unmortgage ${space.name} <span class="mono-action-cost">-$${cost}</span></button>`;
				})
			].join('');

			const tradeBtns = otherPlayers.length ? `<button class="mono-btn small" id="mono-act-trade">🤝 Propose a trade…</button>` : '';

			let html = `<h3>Your turn — choose an action</h3>`;
			html += section('Build', buildBtns);
			html += section('Manage properties', manageBtns);
			html += section('Trade', tradeBtns);
			if (!buildBtns && !manageBtns && !tradeBtns) {
				html += `<p class="mono-hint">No property actions available right now.</p>`;
			}
			html += `<div class="mono-modal-actions"><button class="mono-btn" data-action="done">End Turn ▶</button></div>`;
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

		/** @param prefill optional. Two uses:
		 *   - {targetId, requestPos}: opened by clicking a property directly on the board rather
		 *     than via the "Propose a Trade..." button - jumps straight to that owner with the
		 *     clicked property pre-checked.
		 *   - {targetId, offerProps, requestProps, offerMoney, requestMoney, offerCards,
		 *     requestCards, rejected}: reopened automatically after an AI rejects the human's own
		 *     proposal (see _onAgentDecision's tradeResponse handling below) - restores the exact
		 *     offer that was just turned down, with a banner, so adjusting it doesn't mean
		 *     rebuilding from scratch every round of back-and-forth.
		 */
		/** Live "will they accept?" meter for the trade builder, from the AI target's own valuation
		 * (the same estimateAssetValue + tradeFairnessMargin math evaluateTrade uses), so the readout
		 * reflects what would actually clear their acceptance threshold. Values what the target would
		 * RECEIVE vs GIVE UP, both priced from the target's perspective; a non-negative net (after their
		 * fairness margin) reads as likely-accept. No-ops for a human target (no genome to estimate). */
		_updateTradeFairness(targetId, state) {
			const el = this.modalEl.querySelector('#mono-trade-fairness');
			if (!el) return;
			const target = this.game.players[targetId];
			const empty = !state.offerProps.length && !state.requestProps.length && !state.offerMoney && !state.requestMoney && !state.offerCards && !state.requestCards;
			if (empty) { el.className = 'mono-trade-fairness'; el.innerHTML = '<span class="mono-hint">Build an offer to see if they\'ll accept.</span>'; return; }
			if (!target.agent || !target.agent.genome) { el.className = 'mono-trade-fairness'; el.innerHTML = ''; return; }
			const genome = target.agent.genome;
			const CARD_VAL = 60; // same flat jail-card value strategy.js uses in trade evaluation
			// value what the TARGET would receive (my offer) and give up (my request), from their view
			const theyGet = state.offerProps.reduce((s, pos) => s + estimateAssetValue(this.game, targetId, pos, genome), 0)
				+ (state.offerMoney || 0) + (state.offerCards || 0) * CARD_VAL;
			const theyGive = state.requestProps.reduce((s, pos) => s + estimateAssetValue(this.game, targetId, pos, genome), 0)
				+ (state.requestMoney || 0) + (state.requestCards || 0) * CARD_VAL;
			// they accept when what they get covers what they give up, padded by their fairness margin
			const required = theyGive * (genome.tradeFairnessMargin || 1);
			const surplus = theyGet - required;
			let cls, label;
			if (surplus >= 0) { cls = 'good'; label = '👍 Likely to accept'; }
			else if (surplus >= -required * 0.2) { cls = 'close'; label = '🤔 Borderline — sweeten it a little'; }
			else { cls = 'bad'; label = '👎 Unlikely to accept'; }
			el.className = 'mono-trade-fairness ' + cls;
			el.innerHTML = `<div class="mono-fairness-label">${label}</div>`
				+ `<div class="mono-fairness-detail">They receive ≈$${Math.round(theyGet)} · give up ≈$${Math.round(theyGive)}</div>`;
		}

		_modalTradeBuilder(ctx, otherPlayers, prefill) {
			const player = ctx.player;
			let targetId = (prefill && prefill.targetId !== undefined) ? prefill.targetId : otherPlayers[0].id;
			const openedFromBoardClick = !!prefill && !prefill.rejected;
			// carries the in-progress offer across re-renders (target switch, "ask price" clicks)
			// within this one builder session, seeded from prefill on first open
			const state = {
				offerProps: (prefill && prefill.offerProps) || [],
				requestProps: (prefill && prefill.requestPos !== undefined) ? [prefill.requestPos] : ((prefill && prefill.requestProps) || []),
				offerMoney: (prefill && prefill.offerMoney) || 0,
				requestMoney: (prefill && prefill.requestMoney) || 0,
				offerCards: (prefill && prefill.offerCards) || 0,
				requestCards: (prefill && prefill.requestCards) || 0
			};
			const readState = () => {
				state.offerProps = [...this.modalEl.querySelectorAll('[data-group="offer"]:checked')].map(el => Number(el.value));
				state.requestProps = [...this.modalEl.querySelectorAll('[data-group="request"]:checked')].map(el => Number(el.value));
				state.offerMoney = Number(this.modalEl.querySelector('#mono-trade-offer-money').value) || 0;
				state.requestMoney = Number(this.modalEl.querySelector('#mono-trade-request-money').value) || 0;
				state.offerCards = this.modalEl.querySelector('#mono-trade-offer-card').checked ? 1 : 0;
				state.requestCards = this.modalEl.querySelector('#mono-trade-request-card').checked ? 1 : 0;
			};
			// Live-updates the board/player panels to preview what THIS in-progress (not yet sent)
			// offer would do, without touching the modal itself - re-rendering the modal on every
			// keystroke/checkbox click would blow away focus/cursor position mid-edit. Reads the DOM
			// into `state` first so the preview always reflects exactly what's currently checked/typed.
			const updatePreview = () => {
				readState();
				this._tradePreview = {
					fromId: player.id, toId: targetId,
					offerProps: state.offerProps, requestProps: state.requestProps,
					offerMoney: state.offerMoney, requestMoney: state.requestMoney,
					offerCards: state.offerCards, requestCards: state.requestCards
				};
				this._renderBoardState();
				this._renderPlayers();
				this._updateTradeFairness(targetId, state);
			};
			const renderBuilder = () => {
				const target = this.game.players[targetId];
				const myProps = player.properties;
				const theirProps = target.properties;
				const propCheckboxes = (props, prefix) => props.map(pos => {
					const space = this.game.getSpace(pos);
					const preChecked = (prefix === 'offer' ? state.offerProps : state.requestProps).includes(pos);
					const askBtn = prefix === 'request' && target.agent
						? ` <button type="button" class="mono-btn small secondary mono-ask-price" data-pos="${pos}">Ask price</button><span class="mono-hint mono-ask-result" data-pos="${pos}"></span>`
						: '';
					return `<label class="mono-checkbox-row"><input type="checkbox" data-group="${prefix}" value="${pos}" ${preChecked ? 'checked' : ''}> ${space.name}</label>${askBtn}`;
				}).join('') || '<p class="mono-hint">none</p>';

				this._showModal(`
					<h3>Propose Trade</h3>
					${prefill && prefill.rejected ? `<p class="mono-hint" style="color:var(--accent-red,#e63946)">${target.name} rejected your last offer - adjust it and resend.</p>` : ''}
					<label>Trade with: </label>
					<select id="mono-trade-target">
						${otherPlayers.map(p => `<option value="${p.id}" ${p.id === targetId ? 'selected' : ''}>${p.name}</option>`).join('')}
					</select>
					<div class="mono-trade-cols">
						<div>
							<h4>You give</h4>
							${propCheckboxes(myProps, 'offer')}
							<label>Cash: <input type="number" id="mono-trade-offer-money" value="${state.offerMoney}" min="0" max="${player.money}" class="mono-input small"></label>
							<label class="mono-checkbox-row"><input type="checkbox" id="mono-trade-offer-card" ${state.offerCards ? 'checked' : ''} ${player.getOutOfJailFree > 0 ? '' : 'disabled'}> Get Out of Jail Free card</label>
						</div>
						<div>
							<h4>You get</h4>
							${propCheckboxes(theirProps, 'request')}
							<label>Cash: <input type="number" id="mono-trade-request-money" value="${state.requestMoney}" min="0" max="${target.money}" class="mono-input small"></label>
							<label class="mono-checkbox-row"><input type="checkbox" id="mono-trade-request-card" ${state.requestCards ? 'checked' : ''} ${target.getOutOfJailFree > 0 ? '' : 'disabled'}> Get Out of Jail Free card</label>
						</div>
					</div>
					<div class="mono-trade-fairness" id="mono-trade-fairness"></div>
					<div class="mono-modal-actions">
						<button class="mono-btn" id="mono-trade-send">Send Offer</button>
						<button class="mono-btn secondary" id="mono-trade-cancel">Cancel</button>
					</div>
				`);
				this.modalEl.querySelector('#mono-trade-target').onchange = (e) => {
					readState();
					state.requestProps = []; // switching targets invalidates any "you get" picks from the old target
					state.requestMoney = 0;
					state.requestCards = 0;
					targetId = Number(e.target.value);
					renderBuilder();
				};
				this.modalEl.querySelectorAll('.mono-ask-price').forEach(btn => {
					btn.onclick = () => {
						const pos = Number(btn.dataset.pos);
						const estimate = this._estimateAskingPrice(target, pos);
						const resultEl = this.modalEl.querySelector(`.mono-ask-result[data-pos="${pos}"]`);
						if (resultEl) resultEl.textContent = estimate != null ? `≈ $${estimate} (or equivalent value in cash/properties/cards)` : '';
					};
				});
				// live board/player preview: update on every checkbox toggle and as cash amounts are
				// typed (input, not just change/blur, so the board reflects each keystroke)
				this.modalEl.querySelectorAll('[data-group]').forEach(cb => { cb.onchange = updatePreview; });
				this.modalEl.querySelector('#mono-trade-offer-money').oninput = updatePreview;
				this.modalEl.querySelector('#mono-trade-request-money').oninput = updatePreview;
				this.modalEl.querySelector('#mono-trade-offer-card').onchange = updatePreview;
				this.modalEl.querySelector('#mono-trade-request-card').onchange = updatePreview;
				updatePreview(); // reflect this render's starting state (including target switches and prefilled reopens) immediately
				this.modalEl.querySelector('#mono-trade-send').onclick = () => {
					readState();
					this._lastTradeAttempt = { targetId, offerProps: state.offerProps, requestProps: state.requestProps, offerMoney: state.offerMoney, requestMoney: state.requestMoney, offerCards: state.offerCards, requestCards: state.requestCards };
					this._tradePreview = null;
					this._renderBoardState();
					this._renderPlayers();
					this._hideModal();
					this.humanAgent.resolve('action', {
						type: 'proposeTrade',
						trade: { toId: targetId, offerProps: state.offerProps, requestProps: state.requestProps, offerMoney: state.offerMoney, requestMoney: state.requestMoney, offerCards: state.offerCards, requestCards: state.requestCards }
					});
				};
				this.modalEl.querySelector('#mono-trade-cancel').onclick = () => {
					this._lastTradeAttempt = null;
					this._tradePreview = null;
					this._renderBoardState();
					this._renderPlayers();
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

		// ---- Trade response with counteroffers ----
		// The trade object is always proposer-framed: offer* = what the PROPOSER gives (the human
		// responder receives); request* = what the PROPOSER wants (the human responder gives up). The
		// counter builder below lets the human edit BOTH sides and send it back; the AI proposer then
		// evaluates the counter (via strategy.js's evaluateTrade, the same math its own decideTradeResponse
		// uses) and either accepts it, or re-counters with a small adjustment toward what it would accept,
		// up to a fixed number of rounds. An accepted counter is applied by mutating ctx.trade in place
		// (so the engine's applyTradeEffects uses the agreed terms) then resolving true.

		_modalTradeResponse(ctx) {
			this._negotiationRound = 0;
			this._showTradeOffer(ctx, ctx.trade, 'initial');
		}

		/** Human-readable value (to `pid`) of one proposer-framed trade, used for the negotiation
		 * fairness readouts. Prices properties from pid's own perspective + cash + cards. */
		_tradeSideValue(pid, props, money, cards, genome) {
			let v = (money || 0) + (cards || 0) * 60;
			for (const pos of props) v += estimateAssetValue(this.game, pid, pos, genome || BEST_GENOME);
			return Math.round(v);
		}

		/** Shows the current offer on the table to the human, with Accept / Counter / Reject.
		 * @param source 'initial' (AI's first offer) or 'aiCounter' (AI's re-counter after the human's
		 * counter was declined) - only affects the header wording. */
		_showTradeOffer(ctx, trade, source) {
			const proposer = ctx.proposer;
			const roundNote = this._negotiationRound > 0
				? `<p class="mono-hint">Negotiation round ${this._negotiationRound} of ${MonopolyUI.MAX_COUNTER_ROUNDS}</p>` : '';
			const header = source === 'aiCounter'
				? `🤝 ${proposer.name} counters with:`
				: `🤝 ${proposer.name} offers a trade`;
			this._showModal(`
				<h3>${header}</h3>
				${roundNote}
				<div class="mono-trade-response">
					<div class="mono-trade-side get">
						<div class="mono-trade-side-head">You receive</div>
						<div>${this._describeTradeSide(trade.offerProps, trade.offerMoney, trade.offerCards)}</div>
					</div>
					<div class="mono-trade-side give">
						<div class="mono-trade-side-head">You give up</div>
						<div>${this._describeTradeSide(trade.requestProps, trade.requestMoney, trade.requestCards)}</div>
					</div>
				</div>
				<div class="mono-modal-actions">
					<button class="mono-btn" id="mono-trade-accept">Accept</button>
					<button class="mono-btn secondary" id="mono-trade-counter">Counter…</button>
					<button class="mono-btn secondary" id="mono-trade-reject">Reject</button>
				</div>
			`);
			this.modalEl.querySelector('#mono-trade-accept').onclick = () => {
				// accept the CURRENT terms on the table (may be the AI's re-counter, not ctx.trade's
				// original) - write them back into ctx.trade so the engine applies exactly these.
				this._commitTradeTerms(ctx.trade, trade);
				this._hideModal();
				this.humanAgent.resolve('tradeResponse', true);
			};
			this.modalEl.querySelector('#mono-trade-reject').onclick = () => { this._hideModal(); this.humanAgent.resolve('tradeResponse', false); };
			this.modalEl.querySelector('#mono-trade-counter').onclick = () => this._modalCounterBuilder(ctx, trade);
		}

		/** Copies proposer-framed terms from `src` into `dest` (both proposer-framed), so an accepted
		 * counter/re-counter applies the agreed-on terms rather than the original offer. */
		_commitTradeTerms(dest, src) {
			dest.offerProps = src.offerProps.slice();
			dest.requestProps = src.requestProps.slice();
			dest.offerMoney = src.offerMoney || 0;
			dest.requestMoney = src.requestMoney || 0;
			dest.offerCards = src.offerCards || 0;
			dest.requestCards = src.requestCards || 0;
		}

		/** Counter builder: the human edits both sides of the deal (still proposer-framed under the
		 * hood, but labeled from the human's own perspective). On send, the AI proposer evaluates the
		 * counter; accepts it (deal done on the counter terms), or - if rounds remain - re-counters with
		 * a nudge toward its own acceptance threshold. */
		_modalCounterBuilder(ctx, baseTrade) {
			const proposer = ctx.proposer;   // the AI
			const me = ctx.player;            // the human responder
			// working copy, proposer-framed. "You receive" = proposer's offer* side (proposer gives);
			// "You give up" = proposer's request* side (proposer wants).
			const state = {
				offerProps: (baseTrade.offerProps || []).slice(),     // proposer gives -> I receive
				requestProps: (baseTrade.requestProps || []).slice(), // proposer wants -> I give
				offerMoney: baseTrade.offerMoney || 0,
				requestMoney: baseTrade.requestMoney || 0,
				offerCards: baseTrade.offerCards || 0,
				requestCards: baseTrade.requestCards || 0
			};
			const readState = () => {
				state.offerProps = [...this.modalEl.querySelectorAll('[data-cgroup="receive"]:checked')].map(el => Number(el.value));
				state.requestProps = [...this.modalEl.querySelectorAll('[data-cgroup="give"]:checked')].map(el => Number(el.value));
				state.offerMoney = Number(this.modalEl.querySelector('#mono-counter-receive-money').value) || 0;
				state.requestMoney = Number(this.modalEl.querySelector('#mono-counter-give-money').value) || 0;
				state.offerCards = this.modalEl.querySelector('#mono-counter-receive-card').checked ? 1 : 0;
				state.requestCards = this.modalEl.querySelector('#mono-counter-give-card').checked ? 1 : 0;
			};
			const propRow = (props, cgroup, checkedList) => props.map(pos => {
				const space = this.game.getSpace(pos);
				return `<label class="mono-checkbox-row"><input type="checkbox" data-cgroup="${cgroup}" value="${pos}" ${checkedList.includes(pos) ? 'checked' : ''}> ${space.name}</label>`;
			}).join('') || '<p class="mono-hint">none</p>';
			const render = () => {
				this._showModal(`
					<h3>Counter ${proposer.name}'s offer</h3>
					<p class="mono-hint">Adjust the deal and send it back. They'll accept, decline, or counter.</p>
					<div class="mono-trade-cols">
						<div>
							<h4>You receive</h4>
							${propRow(proposer.properties, 'receive', state.offerProps)}
							<label>Cash: <input type="number" id="mono-counter-receive-money" value="${state.offerMoney}" min="0" max="${proposer.money}" class="mono-input small"></label>
							<label class="mono-checkbox-row"><input type="checkbox" id="mono-counter-receive-card" ${state.offerCards ? 'checked' : ''} ${proposer.getOutOfJailFree > 0 ? '' : 'disabled'}> Get Out of Jail Free card</label>
						</div>
						<div>
							<h4>You give up</h4>
							${propRow(me.properties, 'give', state.requestProps)}
							<label>Cash: <input type="number" id="mono-counter-give-money" value="${state.requestMoney}" min="0" max="${me.money}" class="mono-input small"></label>
							<label class="mono-checkbox-row"><input type="checkbox" id="mono-counter-give-card" ${state.requestCards ? 'checked' : ''} ${me.getOutOfJailFree > 0 ? '' : 'disabled'}> Get Out of Jail Free card</label>
						</div>
					</div>
					<div class="mono-trade-fairness" id="mono-counter-fairness"></div>
					<div class="mono-modal-actions">
						<button class="mono-btn" id="mono-counter-send">Send counter</button>
						<button class="mono-btn secondary" id="mono-counter-back">Back</button>
					</div>
				`);
				const updateFairness = () => {
					readState();
					this._updateCounterFairness(ctx, state);
				};
				this.modalEl.querySelectorAll('[data-cgroup]').forEach(cb => cb.onchange = updateFairness);
				this.modalEl.querySelector('#mono-counter-receive-money').oninput = updateFairness;
				this.modalEl.querySelector('#mono-counter-give-money').oninput = updateFairness;
				this.modalEl.querySelector('#mono-counter-receive-card').onchange = updateFairness;
				this.modalEl.querySelector('#mono-counter-give-card').onchange = updateFairness;
				updateFairness();
				this.modalEl.querySelector('#mono-counter-back').onclick = () => this._showTradeOffer(ctx, baseTrade, this._negotiationRound > 0 ? 'aiCounter' : 'initial');
				this.modalEl.querySelector('#mono-counter-send').onclick = () => {
					readState();
					this._submitCounter(ctx, {
						toId: me.id,
						offerProps: state.offerProps, requestProps: state.requestProps,
						offerMoney: state.offerMoney, requestMoney: state.requestMoney,
						offerCards: state.offerCards, requestCards: state.requestCards
					});
				};
			};
			render();
		}

		/** Live "will they accept your counter?" readout, from the AI proposer's own evaluateTrade. */
		_updateCounterFairness(ctx, state) {
			const el = this.modalEl.querySelector('#mono-counter-fairness');
			if (!el) return;
			const proposer = ctx.proposer;
			if (!proposer.agent || !proposer.agent.genome) { el.className = 'mono-trade-fairness'; el.innerHTML = ''; return; }
			const counter = this._proposerFramedFromState(ctx, state);
			const accepts = this._aiWouldAccept(proposer, counter);
			el.className = 'mono-trade-fairness ' + (accepts ? 'good' : 'bad');
			el.innerHTML = `<div class="mono-fairness-label">${accepts ? '👍 They\'d likely accept this' : '👎 They\'d likely decline this'}</div>`;
		}

		/** Builds a proposer-framed trade object from the human's counter-builder state (which is
		 * already proposer-framed - offer* = proposer gives, request* = proposer wants). */
		_proposerFramedFromState(ctx, state) {
			return {
				toId: ctx.player.id,
				offerProps: state.offerProps.slice(), requestProps: state.requestProps.slice(),
				offerMoney: state.offerMoney, requestMoney: state.requestMoney,
				offerCards: state.offerCards, requestCards: state.requestCards
			};
		}

		/** Does the AI proposer accept `counter` (proposer-framed)? evaluateTrade always scores from the
		 * TARGET's perspective, so to ask "would the proposer accept", we flip the trade to the
		 * proposer-as-responder framing and evaluate it as them. */
		_aiWouldAccept(proposer, counter) {
			// flip: what the proposer would "receive" is the counter's request* side (what they asked
			// for), what they'd "give" is the counter's offer* side.
			const flipped = {
				toId: proposer.id,
				offerProps: counter.requestProps.slice(), offerMoney: counter.requestMoney, offerCards: counter.requestCards,
				requestProps: counter.offerProps.slice(), requestMoney: counter.offerMoney, requestCards: counter.offerCards
			};
			try {
				return !!evaluateTrade(this.game, proposer, flipped, proposer.agent.genome);
			} catch (e) {
				return false;
			}
		}

		/** Handles the human's submitted counter: validate affordability, then let the AI proposer
		 * respond. If they accept, apply the counter terms and resolve true. Otherwise, if rounds
		 * remain, the AI re-counters with a nudge toward its threshold; else the negotiation ends and
		 * the human is asked one more time to accept the AI's last word or walk away. */
		_submitCounter(ctx, counter) {
			const proposer = ctx.proposer;
			const me = ctx.player;
			// basic validation - can't offer money/props you don't have
			if (counter.requestMoney > me.money) counter.requestMoney = me.money;
			if (counter.offerMoney > proposer.money) counter.offerMoney = proposer.money;
			this._negotiationRound++;
			if (this._aiWouldAccept(proposer, counter)) {
				this._commitTradeTerms(ctx.trade, counter);
				this._hideModal();
				this._queueEventPopup(`<h3>${proposer.name}</h3><p>Accepts your counteroffer.</p>`, PLAYER_COLORS[proposer.id]);
				this.humanAgent.resolve('tradeResponse', true);
				return;
			}
			// AI declines. If we've hit the round cap, present the human's own counter back as a final
			// take-it-or-leave-it (they can still Accept their own terms won't apply - so just reject).
			if (this._negotiationRound >= MonopolyUI.MAX_COUNTER_ROUNDS) {
				this._hideModal();
				this._queueEventPopup(`<h3>${proposer.name}</h3><p>Rejects your counteroffer — negotiation over.</p>`, PLAYER_COLORS[proposer.id]).then(() => {
					this.humanAgent.resolve('tradeResponse', false);
				});
				return;
			}
			// AI re-counters: nudge toward what it would accept (a cash midpoint), then show it.
			const reCounter = this._aiReCounter(ctx, counter);
			if (!reCounter) {
				this._hideModal();
				this._queueEventPopup(`<h3>${proposer.name}</h3><p>Can't find a deal — negotiation over.</p>`, PLAYER_COLORS[proposer.id]).then(() => {
					this.humanAgent.resolve('tradeResponse', false);
				});
				return;
			}
			this._showTradeOffer(ctx, reCounter, 'aiCounter');
		}

		/** Produces the AI proposer's re-counter to the human's declined counter: keeps the same
		 * PROPERTIES/CARDS on each side (those are what the two sides actually want) and only adjusts a
		 * single NET cash figure to a fair middle ground between the human's offer and the AI's own
		 * break-even price.
		 *
		 * The cash is always expressed net - it lives on exactly one side, so you never see the
		 * nonsensical "give up a property AND pay cash, to receive less cash" that a naive
		 * inflate-one-side search produces. Concretely:
		 *   - value everything non-cash from the AI's perspective (what it gives vs gets),
		 *   - the AI's break-even net cash is how much cash must flow to the AI to make getValue meet
		 *     giveValue * fairnessMargin,
		 *   - the human's counter already implies some net cash; the re-counter meets in the MIDDLE of
		 *     those two, so it's a genuine compromise, not a shakedown,
		 *   - clamp to what the human can actually pay.
		 * Returns a proposer-framed trade, or null if even a fair midpoint can't be represented (e.g.
		 * the human can't afford the AI's minimum). */
		_aiReCounter(ctx, humanCounter) {
			const proposer = ctx.proposer;
			const me = ctx.player;
			const genome = proposer.agent && proposer.agent.genome;
			if (!genome) return null;
			const margin = genome.tradeFairnessMargin || 1;

			// Value the NON-CASH items from the AI (proposer) perspective. In proposer framing:
			//   offerProps/offerCards  = what the AI GIVES  (proposer gives)
			//   requestProps/requestCards = what the AI GETS (proposer wants)
			const CARD = 60;
			const aiGivesNonCash = humanCounter.offerProps.reduce((s, pos) => s + estimateAssetValue(this.game, proposer.id, pos, genome), 0) + (humanCounter.offerCards || 0) * CARD;
			const aiGetsNonCash = humanCounter.requestProps.reduce((s, pos) => s + estimateAssetValue(this.game, proposer.id, pos, genome), 0) + (humanCounter.requestCards || 0) * CARD;

			// "net cash to the AI" convention: positive means cash flows human->AI (AI's requestMoney),
			// negative means AI->human (AI's offerMoney). The AI accepts when:
			//   aiGetsNonCash + netToAI >= (aiGivesNonCash - min(netToAI,0)... ) - simpler: accepts when
			//   getValue >= giveValue*margin, where getValue = aiGetsNonCash + max(netToAI,0) + (cash it
			//   receives) and giveValue = aiGivesNonCash + max(-netToAI,0). We solve for the break-even
			//   single net figure directly instead of per-side.
			// Break-even (margin applied to the AI's give side): the AI needs
			//   aiGetsNonCash + netToAI >= aiGivesNonCash * margin   =>   netToAI >= aiGivesNonCash*margin - aiGetsNonCash
			const aiBreakEvenNet = Math.ceil(aiGivesNonCash * margin - aiGetsNonCash);

			// the human's own counter, as a single net-to-AI figure
			const humanNet = (humanCounter.requestMoney || 0) - (humanCounter.offerMoney || 0);

			// If the AI's break-even is at or below the human's offer, the AI should just accept - but
			// we only get here after a rejection, so treat that as "meet slightly above the human" to
			// avoid a degenerate no-op. Otherwise meet in the middle of humanNet and break-even.
			let targetNet = Math.round((humanNet + Math.max(aiBreakEvenNet, humanNet)) / 2);
			// never demand more net cash from the human than they can pay (their cash on hand, minus
			// any the AI is also handing over doesn't apply here since net is one-directional)
			if (targetNet > me.money) targetNet = me.money;

			// Re-express the single net figure back onto exactly one side.
			const reCounter = Object.assign({}, humanCounter);
			if (targetNet >= 0) { reCounter.requestMoney = targetNet; reCounter.offerMoney = 0; }
			else { reCounter.requestMoney = 0; reCounter.offerMoney = Math.min(-targetNet, proposer.money); }

			// Sanity: only return it if it's actually different from the human's offer AND the AI would
			// in fact accept it (the valuation heuristic and evaluateTrade agree closely, but clamp/
			// rounding could leave it just short - if so, nudge once toward the AI by $1 increments up
			// to a small cap, else give up).
			const differs = reCounter.requestMoney !== (humanCounter.requestMoney || 0) || reCounter.offerMoney !== (humanCounter.offerMoney || 0);
			if (!differs) return null;
			if (this._aiWouldAccept(proposer, reCounter)) return reCounter;
			// small corrective nudge (raise net-to-AI a little) in case rounding left it under threshold
			for (let bump = 5; bump <= 60; bump += 5) {
				let net = targetNet + bump;
				if (net > me.money) break;
				const t = Object.assign({}, humanCounter);
				if (net >= 0) { t.requestMoney = net; t.offerMoney = 0; } else { t.requestMoney = 0; t.offerMoney = Math.min(-net, proposer.money); }
				if (this._aiWouldAccept(proposer, t)) return t;
			}
			return null;
		}

		static get MAX_COUNTER_ROUNDS() { return 3; }
	}

	window.MonopolyUI = { MonopolyUI };
})();
