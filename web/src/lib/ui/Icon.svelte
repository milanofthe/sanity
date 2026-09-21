<script lang="ts">
	// The icon set, as stroked SVG paths in currentColor.
	//
	// SVG rather than text glyphs: a chevron as a character is sized by the
	// font metrics, so it came out a few pixels tall next to a 12 pixel label
	// and could not be made bigger without moving the baseline. A path scales
	// to whatever the caller asks for and inherits the text colour.
	//
	// One 16 unit grid for every icon, stroked rather than filled, so the
	// weight matches the one pixel borders used everywhere else.

	export type IconName =
		| 'chevron-down'
		| 'chevron-right'
		| 'fit'
		| 'external'
		| 'copy'
		| 'folder'
		| 'search'
		| 'check';

	const paths: Record<IconName, string> = {
		'chevron-down': 'M4 6.5 8 10.5 12 6.5',
		'chevron-right': 'M6.5 4 10.5 8 6.5 12',
		// A frame with corner marks: fit to view.
		fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
		external: 'M9 2.5h4.5V7M13 3 7.5 8.5M11.5 10v3.5H2.5V4.5H6',
		copy: 'M5.5 5.5V2.5h8v8h-3M2.5 5.5h8v8h-8z',
		folder: 'M1.5 3.5h4l1.5 2h7.5v8h-13z',
		// A circle and a handle, on the same 16 unit grid as the rest.
		search: 'M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM9.5 9.5 14 14',
		check: 'M3 8.5 6.5 12 13 4.5'
	};

	let {
		name,
		size = 14,
		width = 1.6
	}: { name: IconName; size?: number; width?: number } = $props();
</script>

<svg
	viewBox="0 0 16 16"
	style:width={`${size}px`}
	style:height={`${size}px`}
	style:stroke-width={width}
	aria-hidden="true"
>
	<path d={paths[name]} />
</svg>

<style>
	svg {
		display: block;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
