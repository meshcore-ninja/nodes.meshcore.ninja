import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Absolute deploy base path (e.g. "" for a root site, "/nodes.meshcore.ninja" for a
// GitHub-Pages project site). svelte.config.js reads the same BASE_PATH env var.
const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');

// VITE_API_BASE / VITE_CATALOG_ORIGIN are read from the environment / .env files
// via import.meta.env — see src/lib/api.js. Set them in .env.local for dev or in
// the deploy workflow.
export default defineConfig({
  base: BASE_PATH ? `${BASE_PATH}/` : '/',
  plugins: [tailwindcss(), sveltekit()]
});
