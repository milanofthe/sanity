import { mount } from 'svelte';
import App from './App.svelte';
import './lib/app.css';
import { ui } from '$lib/state/ui.svelte';
import { bridgeErrors } from '$lib/sources/tauri';

// Frontend errors have nowhere to go inside a Tauri window, so they are put
// where a terminal can see them. First, so a failure during startup is caught.
bridgeErrors();

// The theme has to be on <html> before the canvas resolves its palette.
ui.apply();

mount(App, { target: document.getElementById('app')! });
