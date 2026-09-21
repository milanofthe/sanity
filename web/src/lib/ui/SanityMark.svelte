<script lang="ts">
	// The wordmark, from assets/sanity-logo.png. Pure #ff0000 and fixed, which
	// is deliberate: the brand does not follow the theme. The UI accent is the
	// settled red in tokens.css, so the mark stays the one thing on screen at
	// full saturation.
	import logo from '$lib/assets/sanity-logo.png';
	let { height = 15 }: { height?: number } = $props();
</script>

<img src={logo} alt="sanity" style:height={`${height}px`} />

<style>
	img {
		display: block;
		flex: none;
		image-rendering: auto;
	}
</style>
