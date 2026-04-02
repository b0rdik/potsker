const poker = require('../lib/poker');

function card(rank, suit) {
  const values = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
  return { rank, suit, value: values[rank] };
}

describe('poker.evaluateHand', () => {
  test('detects royal flush', () => {
    const cards = [
      card('A', 'hearts'),
      card('K', 'hearts'),
      card('Q', 'hearts'),
      card('J', 'hearts'),
      card('10', 'hearts'),
      card('2', 'clubs'),
      card('3', 'spades'),
    ];
    const best = poker.evaluateHand(cards);
    expect(best.name).toBe('royal-flush');
  });

  test('detects low straight (A-2-3-4-5)', () => {
    const cards = [
      card('A', 'spades'),
      card('2', 'hearts'),
      card('3', 'clubs'),
      card('4', 'diamonds'),
      card('5', 'spades'),
      card('K', 'hearts'),
      card('9', 'clubs'),
    ];
    const best = poker.evaluateHand(cards);
    expect(best.name).toBe('straight');
    expect(best.score).toBeGreaterThanOrEqual(4000000 + 5);
  });
});

describe('poker.buildSidePots', () => {
  test('single pot when no all-ins', () => {
    const room = {
      pot: 300,
      players: [
        { sittingOut: false, folded: false, allIn: false, totalBet: 100 },
        { sittingOut: false, folded: false, allIn: false, totalBet: 100 },
        { sittingOut: false, folded: true, allIn: false, totalBet: 100 },
      ],
    };
    const pots = poker.buildSidePots(room);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligible).toHaveLength(2);
  });

  test('builds main + side pot with one all-in', () => {
    const room = {
      pot: 400,
      players: [
        { sittingOut: false, folded: false, allIn: true, totalBet: 100 }, // all-in
        { sittingOut: false, folded: false, allIn: false, totalBet: 200 },
        { sittingOut: false, folded: false, allIn: false, totalBet: 100 },
      ],
    };
    const pots = poker.buildSidePots(room);
    // Level 100: contributes min(100, bet) from each -> 100+100+100 = 300, eligible are players with totalBet >= 100 (all 3)
    // Level 200: contributes remaining above 100 -> 0+100+0 = 100, eligible are players with totalBet >= 200 (only player[1])
    expect(pots).toHaveLength(2);
    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligible).toHaveLength(3);
    expect(pots[1].amount).toBe(100);
    expect(pots[1].eligible).toHaveLength(1);
  });

  test('supports multiple all-in levels and folded bettors', () => {
    const room = {
      pot: 0,
      players: [
        { sittingOut: false, folded: false, allIn: true, totalBet: 50 }, // all-in 50
        { sittingOut: false, folded: false, allIn: true, totalBet: 100 }, // all-in 100
        { sittingOut: false, folded: false, allIn: false, totalBet: 200 }, // covers
        { sittingOut: false, folded: true, allIn: false, totalBet: 200 }, // folded but bet
      ],
    };

    // Total pot would be 50+100+200+200 = 550, but buildSidePots derives pot from totals, not room.pot.
    const pots = poker.buildSidePots(room);

    // Levels: 50, 100, 200
    // Pot@50: 50*4 = 200, eligible totalBet>=50 & not folded => players 0,1,2 (folded excluded)
    // Pot@100: (100-50)=50 from players with >=100 => p1,p2,p3 => 50*3=150, eligible totalBet>=100 & not folded => players 1,2
    // Pot@200: (200-100)=100 from players with >=200 => p2,p3 => 200, eligible totalBet>=200 & not folded => player 2
    expect(pots).toHaveLength(3);
    expect(pots[0].amount).toBe(200);
    expect(pots[0].eligible).toHaveLength(3);
    expect(pots[1].amount).toBe(150);
    expect(pots[1].eligible).toHaveLength(2);
    expect(pots[2].amount).toBe(200);
    expect(pots[2].eligible).toHaveLength(1);
  });
});

