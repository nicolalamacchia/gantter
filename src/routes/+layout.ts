// Pure client-side app: all state lives in the browser (localStorage),
// so SSR/prerender are disabled and adapter-static serves an SPA fallback.
export const ssr = false;
export const prerender = false;
export const csr = true;
