import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /train-map/.
export default defineConfig({ base: './', server: { port: 5190 } });
