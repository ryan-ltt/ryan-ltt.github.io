// Board definition for the Monopoly clone.
// Property names/colors are original (not the trademarked Monopoly names) to avoid IP issues,
// but the position layout, prices, rents and card decks follow the standard public-domain ruleset structure.

(function (root) {
	'use strict';

	const GROUPS = {
		BROWN: 'brown',
		LIGHT_BLUE: 'lightblue',
		PINK: 'pink',
		ORANGE: 'orange',
		RED: 'red',
		YELLOW: 'yellow',
		GREEN: 'green',
		DARK_BLUE: 'darkblue',
		RAIL: 'rail',
		UTILITY: 'utility'
	};

	// rent = [base, 1house, 2house, 3house, 4house, hotel] for property groups
	// for rail: rent by number owned [1,2,3,4]
	// for utility: multiplier by number owned [4x,10x]
	const SPACES = [
		{ pos: 0, type: 'go', name: 'Start' },
		{ pos: 1, type: 'property', name: 'Elm Street', group: GROUPS.BROWN, price: 60, houseCost: 50, rent: [2, 10, 30, 90, 160, 250] },
		{ pos: 2, type: 'chest', name: 'Fortune Chest' },
		{ pos: 3, type: 'property', name: 'Pine Street', group: GROUPS.BROWN, price: 60, houseCost: 50, rent: [4, 20, 60, 180, 320, 450] },
		{ pos: 4, type: 'tax', name: 'Income Tax', amount: 200 },
		{ pos: 5, type: 'rail', name: 'North Station', price: 200, rent: [25, 50, 100, 200] },
		{ pos: 6, type: 'property', name: 'Birch Avenue', group: GROUPS.LIGHT_BLUE, price: 100, houseCost: 50, rent: [6, 30, 90, 270, 400, 550] },
		{ pos: 7, type: 'fate', name: 'Wild Fate' },
		{ pos: 8, type: 'property', name: 'Cedar Avenue', group: GROUPS.LIGHT_BLUE, price: 100, houseCost: 50, rent: [6, 30, 90, 270, 400, 550] },
		{ pos: 9, type: 'property', name: 'Maple Avenue', group: GROUPS.LIGHT_BLUE, price: 120, houseCost: 50, rent: [8, 40, 100, 300, 450, 600] },
		{ pos: 10, type: 'jail', name: 'Jail / Just Visiting' },
		{ pos: 11, type: 'property', name: 'Willow Way', group: GROUPS.PINK, price: 140, houseCost: 100, rent: [10, 50, 150, 450, 625, 750] },
		{ pos: 12, type: 'utility', name: 'Power Co.', price: 150 },
		{ pos: 13, type: 'property', name: 'Chestnut Way', group: GROUPS.PINK, price: 140, houseCost: 100, rent: [10, 50, 150, 450, 625, 750] },
		{ pos: 14, type: 'property', name: 'Aspen Way', group: GROUPS.PINK, price: 160, houseCost: 100, rent: [12, 60, 180, 500, 700, 900] },
		{ pos: 15, type: 'rail', name: 'East Station', price: 200, rent: [25, 50, 100, 200] },
		{ pos: 16, type: 'property', name: 'Sycamore Court', group: GROUPS.ORANGE, price: 180, houseCost: 100, rent: [14, 70, 200, 550, 750, 950] },
		{ pos: 17, type: 'chest', name: 'Fortune Chest' },
		{ pos: 18, type: 'property', name: 'Magnolia Court', group: GROUPS.ORANGE, price: 180, houseCost: 100, rent: [14, 70, 200, 550, 750, 950] },
		{ pos: 19, type: 'property', name: 'Dogwood Court', group: GROUPS.ORANGE, price: 200, houseCost: 100, rent: [16, 80, 220, 600, 800, 1000] },
		{ pos: 20, type: 'freeparking', name: 'Free Parking' },
		{ pos: 21, type: 'property', name: 'Redwood Road', group: GROUPS.RED, price: 220, houseCost: 150, rent: [18, 90, 250, 700, 875, 1050] },
		{ pos: 22, type: 'fate', name: 'Wild Fate' },
		{ pos: 23, type: 'property', name: 'Sequoia Road', group: GROUPS.RED, price: 220, houseCost: 150, rent: [18, 90, 250, 700, 875, 1050] },
		{ pos: 24, type: 'property', name: 'Juniper Road', group: GROUPS.RED, price: 240, houseCost: 150, rent: [20, 100, 300, 750, 925, 1100] },
		{ pos: 25, type: 'rail', name: 'South Station', price: 200, rent: [25, 50, 100, 200] },
		{ pos: 26, type: 'property', name: 'Magnolia Boulevard', group: GROUPS.YELLOW, price: 260, houseCost: 150, rent: [22, 110, 330, 800, 975, 1150] },
		{ pos: 27, type: 'property', name: 'Camellia Boulevard', group: GROUPS.YELLOW, price: 260, houseCost: 150, rent: [22, 110, 330, 800, 975, 1150] },
		{ pos: 28, type: 'utility', name: 'Water Works', price: 150 },
		{ pos: 29, type: 'property', name: 'Orchid Boulevard', group: GROUPS.YELLOW, price: 280, houseCost: 150, rent: [24, 120, 360, 850, 1025, 1200] },
		{ pos: 30, type: 'gotojail', name: 'Go To Jail' },
		{ pos: 31, type: 'property', name: 'Harbor Lane', group: GROUPS.GREEN, price: 300, houseCost: 200, rent: [26, 130, 390, 900, 1100, 1275] },
		{ pos: 32, type: 'property', name: 'Bayview Lane', group: GROUPS.GREEN, price: 300, houseCost: 200, rent: [26, 130, 390, 900, 1100, 1275] },
		{ pos: 33, type: 'chest', name: 'Fortune Chest' },
		{ pos: 34, type: 'property', name: 'Lighthouse Lane', group: GROUPS.GREEN, price: 320, houseCost: 200, rent: [28, 150, 450, 1000, 1200, 1400] },
		{ pos: 35, type: 'rail', name: 'West Station', price: 200, rent: [25, 50, 100, 200] },
		{ pos: 36, type: 'fate', name: 'Wild Fate' },
		{ pos: 37, type: 'property', name: 'Summit Place', group: GROUPS.DARK_BLUE, price: 350, houseCost: 200, rent: [35, 175, 500, 1100, 1300, 1500] },
		{ pos: 38, type: 'tax', name: 'Luxury Tax', amount: 100 },
		{ pos: 39, type: 'property', name: 'Skyline Place', group: GROUPS.DARK_BLUE, price: 400, houseCost: 200, rent: [50, 200, 600, 1400, 1700, 2000] }
	];

	const CHEST_CARDS = [
		{ text: 'Bank error in your favor. Collect $200.', action: 'collect', amount: 200 },
		{ text: 'Doctor fee. Pay $50.', action: 'pay', amount: 50 },
		{ text: 'From sale of stock you get $50.', action: 'collect', amount: 50 },
		{ text: 'Get Out of Jail Free.', action: 'getOutOfJail' },
		{ text: 'Go to Jail.', action: 'gotojail' },
		{ text: 'Holiday fund matures. Collect $100.', action: 'collect', amount: 100 },
		{ text: 'Income tax refund. Collect $20.', action: 'collect', amount: 20 },
		{ text: 'It is your birthday. Collect $10 from every player.', action: 'collectFromEach', amount: 10 },
		{ text: 'Life insurance matures. Collect $100.', action: 'collect', amount: 100 },
		{ text: 'Pay hospital fee of $100.', action: 'pay', amount: 100 },
		{ text: 'Pay school fee of $150.', action: 'pay', amount: 150 },
		{ text: 'Receive $25 consultancy fee.', action: 'collect', amount: 25 },
		{ text: 'Street repairs: pay $40 per house, $115 per hotel.', action: 'repairs', house: 40, hotel: 115 },
		{ text: 'You have won second prize in a contest. Collect $10.', action: 'collect', amount: 10 },
		{ text: 'You inherit $100.', action: 'collect', amount: 100 },
		{ text: 'Advance to Start. Collect $200.', action: 'advanceToGo' }
	];

	const FATE_CARDS = [
		{ text: 'Advance to Start. Collect $200.', action: 'advanceToGo' },
		{ text: 'Advance to Skyline Place.', action: 'advanceTo', pos: 39 },
		{ text: 'Advance to Elm Street. If you pass Start, collect $200.', action: 'advanceTo', pos: 1 },
		{ text: 'Advance to nearest Station and pay double rent.', action: 'advanceToNearestRail' },
		{ text: 'Advance to nearest Utility. Pay 10x dice if owned, else buy.', action: 'advanceToNearestUtility' },
		{ text: 'Bank pays you dividend of $50.', action: 'collect', amount: 50 },
		{ text: 'Get Out of Jail Free.', action: 'getOutOfJail' },
		{ text: 'Go Back 3 Spaces.', action: 'goBack', amount: 3 },
		{ text: 'Go to Jail.', action: 'gotojail' },
		{ text: 'Make general repairs: pay $25 per house, $100 per hotel.', action: 'repairs', house: 25, hotel: 100 },
		{ text: 'Pay poor tax of $15.', action: 'pay', amount: 15 },
		{ text: 'Advance to nearest Station.', action: 'advanceToNearestRail2' },
		{ text: 'Your building loan matures. Collect $150.', action: 'collect', amount: 150 },
		{ text: 'You have been elected Chairperson. Pay each player $50.', action: 'payEach', amount: 50 },
		{ text: 'Your crossword competition win: collect $100.', action: 'collect', amount: 100 },
		{ text: 'Go directly to Jail. Do not pass Start.', action: 'gotojail' }
	];

	const RAIL_POSITIONS = SPACES.filter(s => s.type === 'rail').map(s => s.pos);
	const UTILITY_POSITIONS = SPACES.filter(s => s.type === 'utility').map(s => s.pos);

	const GROUP_MEMBERS = {};
	SPACES.forEach(s => {
		if (s.type === 'property') {
			GROUP_MEMBERS[s.group] = GROUP_MEMBERS[s.group] || [];
			GROUP_MEMBERS[s.group].push(s.pos);
		}
	});

	const board = {
		GROUPS,
		SPACES,
		CHEST_CARDS,
		FATE_CARDS,
		RAIL_POSITIONS,
		UTILITY_POSITIONS,
		GROUP_MEMBERS,
		JAIL_POS: 10,
		GO_TO_JAIL_POS: 30,
		BOARD_SIZE: 40,
		JAIL_FINE: 50,
		GO_SALARY: 200,
		HOUSE_LIMIT: 4, // then hotel
		HOTEL_SUPPLY: 12,
		HOUSE_SUPPLY: 32
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = board;
	} else {
		root.MonopolyBoard = board;
	}
})(typeof window !== 'undefined' ? window : globalThis);
