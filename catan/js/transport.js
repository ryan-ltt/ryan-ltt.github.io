/* The only file that knows how the bytes travel.
 *
 * Trystero over Nostr: peers find each other through public relays, then talk
 * directly over WebRTC data channels. Nothing but SDP offers and ICE candidates
 * ever touches a relay, and `password` AES-encrypts even those - so the room
 * code is both the invite and the key, and a relay operator sees opaque bytes.
 *
 * This is an ES module because Trystero is ESM-only and the rest of the site is
 * plain <script src>. Module scripts are deferred, so window.CatanTransport is
 * in place before DOMContentLoaded and the classic scripts can just read it. If
 * the import fails (offline, blocked, opened over file://) the flag stays false
 * and the lobby says so rather than throwing.
 *
 * Swapping to another bus is a one-line change to the import below plus the
 * matching vendored bundle: BitTorrent, MQTT, IPFS and Supabase all present the
 * same joinRoom/makeAction API. */
import { joinRoom, selfId } from './trystero-nostr.min.js';

const APP_ID = 'ryan-ltt-catan';

/* Trystero action names are capped at 12 bytes. */
const CHANNELS = ['hello', 'roster', 'act', 'view'];

window.CatanTransport = {
	available: true,
	selfId: selfId,

	/* One room per game code. Returns a small façade so nothing else in the app
	 * has to know Trystero's shape. */
	open: function (code) {
		const room = joinRoom({ appId: APP_ID, password: code }, code);
		const actions = {};
		CHANNELS.forEach(function (name) {
			actions[name] = room.makeAction(name);
		});

		return {
			selfId: selfId,

			/* cb(payload, peerId). Note the v0.25 signature: the second argument is
			 * a metadata object, not a bare peer id. */
			on: function (name, cb) {
				actions[name].onMessage = function (payload, meta) {
					cb(payload, meta && meta.peerId);
				};
			},

			/* Targeting is what makes per-seat redaction possible: broadcasting one
			 * view to everyone would hand every player the whole state. */
			send: function (name, payload, target) {
				return actions[name].send(payload, target ? { target: target } : undefined)
					.catch(function (err) {
						console.warn('catan: send failed', name, err);
					});
			},

			onPeerJoin: function (cb) { room.onPeerJoin = cb; },
			onPeerLeave: function (cb) { room.onPeerLeave = cb; },
			peers: function () { return Object.keys(room.getPeers()); },
			leave: function () { room.leave(); }
		};
	}
};

document.dispatchEvent(new CustomEvent('catan-transport-ready'));
