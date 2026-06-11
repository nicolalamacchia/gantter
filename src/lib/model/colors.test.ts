import { describe, expect, it } from 'vitest';
import { PALETTE, bestTextOn, nextColor } from './colors';

describe('PALETTE', () => {
	it('has 12 distinct colors', () => {
		expect(PALETTE).toHaveLength(12);
		expect(new Set(PALETTE).size).toBe(12);
	});

	it('nextColor skips used colors and cycles when exhausted', () => {
		expect(nextColor([])).toBe(PALETTE[0]);
		expect(nextColor([PALETTE[0]])).toBe(PALETTE[1]);
		expect(nextColor([...PALETTE])).toBe(PALETTE[0]);
	});
});

describe('bestTextOn', () => {
	it('uses dark text on light backgrounds and white on dark ones', () => {
		expect(bestTextOn('#ffe119')).toBe('#0f172a'); // yellow
		expect(bestTextOn('#fabed4')).toBe('#0f172a'); // pink
		expect(bestTextOn('#911eb4')).toBe('#ffffff'); // purple
		expect(bestTextOn('#4363d8')).toBe('#ffffff'); // blue
		expect(bestTextOn('#e6194b')).toBe('#ffffff'); // red
	});

	it('falls back to dark text for malformed values', () => {
		expect(bestTextOn('tomato')).toBe('#0f172a');
	});
});
