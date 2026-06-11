import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * CORS proxy for Jira Cloud: Atlassian's REST API does not allow browser
 * requests with Basic auth, so the SPA sends its credentials per-request in
 * headers and this route forwards the call server-side. Credentials are never
 * stored on the server. Targets are restricted to Atlassian Cloud hosts to
 * avoid this becoming an open proxy.
 */
const handler: RequestHandler = async ({ params, request, url }) => {
	const baseUrl = request.headers.get('x-jira-base-url');
	const email = request.headers.get('x-jira-email');
	const token = request.headers.get('x-jira-token');
	if (!baseUrl || !email || !token) {
		return json(
			{ error: 'Missing Jira credentials (configure them in Settings)' },
			{ status: 400 }
		);
	}
	let target: URL;
	try {
		target = new URL(`${baseUrl.replace(/\/+$/, '')}/rest/${params.path}`);
	} catch {
		return json({ error: 'Invalid Jira base URL' }, { status: 400 });
	}
	if (target.protocol !== 'https:' || !target.hostname.endsWith('.atlassian.net')) {
		return json({ error: 'Base URL must be a https://*.atlassian.net address' }, { status: 400 });
	}
	url.searchParams.forEach((value, key) => target.searchParams.append(key, value));

	const auth = Buffer.from(`${email}:${token}`).toString('base64');
	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method: request.method,
			headers: {
				Authorization: `Basic ${auth}`,
				Accept: 'application/json',
				...(request.method === 'GET' ? {} : { 'Content-Type': 'application/json' })
			},
			body: request.method === 'GET' ? undefined : await request.text()
		});
	} catch {
		return json({ error: 'Could not reach Jira' }, { status: 502 });
	}
	return new Response(await upstream.text(), {
		status: upstream.status,
		headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }
	});
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
