import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.tsx'], bundle: true, outdir: 'dist', minify: true,
  sourcemap: false, target: ['es2022'], define: { 'process.env.NODE_ENV': '"production"' }
});
await copyFile('src/sw.js', 'dist/sw.js');
await writeFile('dist/index.html', `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#153d3a"><title>Samford | Workflow lab</title><link rel="stylesheet" href="/main.css"></head>
<body><div id="root"></div><script src="/main.js" defer></script></body></html>`);
console.log('Built production frontend.');
