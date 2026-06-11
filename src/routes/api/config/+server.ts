import { json } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';

/**
 * Serves the optional server-provisioned config (team, board defaults,
 * integration credentials, lock flag). Place `gantter.config.json` next to
 * where the server starts, or point GANTTER_CONFIG at a path.
 */
export function GET() {
	try {
		const path = process.env.GANTTER_CONFIG ?? 'gantter.config.json';
		return json(JSON.parse(readFileSync(path, 'utf8')));
	} catch {
		return json(null);
	}
}
