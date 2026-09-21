import { mount } from 'svelte';
import App from './App.svelte';
import './lib/app.css';
import { ui } from '$lib/state/ui.svelte';

// The theme has to be on <html> before the canvas resolves its palette.
ui.apply();

mount(App, { target: document.getElementById('app')! });
