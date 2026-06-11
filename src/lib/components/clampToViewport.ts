/**
 * Svelte action for fixed-position popovers/menus: after render (and on any
 * content resize) it measures the element and shifts it back inside the
 * viewport, so menus never end up below the fold or off the right edge.
 */
export function clampToViewport(node: HTMLElement) {
	const MARGIN = 8;
	const reposition = () => {
		node.style.transform = '';
		const rect = node.getBoundingClientRect();
		const dx = Math.min(0, window.innerWidth - MARGIN - rect.right);
		const dy = Math.min(0, window.innerHeight - MARGIN - rect.bottom);
		if (dx || dy) node.style.transform = `translate(${dx}px, ${dy}px)`;
	};
	reposition();
	const observer = new ResizeObserver(reposition);
	observer.observe(node);
	return {
		destroy() {
			observer.disconnect();
		}
	};
}
