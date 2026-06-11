/**
 * 12 well-contrasted colors: the primaries (red, blue, yellow) and secondaries
 * (green, orange, purple) first, then six more hues picked to stay mutually
 * distinguishable. Any other hex value is accepted too (custom picker, Jira
 * epic colors) — text on top adapts via bestTextOn.
 */
export const PALETTE = [
	'#e6194b', // red
	'#4363d8', // blue
	'#ffe119', // yellow
	'#3cb44b', // green
	'#f58231', // orange
	'#911eb4', // purple
	'#42d4f4', // cyan
	'#f032e6', // magenta
	'#bfef45', // lime
	'#469990', // teal
	'#9a6324', // brown
	'#fabed4' // pink
];

export function nextColor(used: string[]): string {
	return PALETTE.find((c) => !used.includes(c)) ?? PALETTE[used.length % PALETTE.length];
}

/** Readable text color (dark slate or white) for the given background. */
export function bestTextOn(background: string): string {
	const match = /^#([0-9a-f]{6})$/i.exec(background.trim());
	if (!match) return '#0f172a';
	const [r, g, b] = [0, 2, 4].map((i) => {
		const channel = parseInt(match[1].slice(i, i + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > 0.4 ? '#0f172a' : '#ffffff';
}
