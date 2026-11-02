import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const outdir = resolve('dist-candidate');
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ['src/main.tsx'], bundle: true, outdir, minify: true,
  external: ['/fonts/NotoSansDevanagari.ttf'],
  sourcemap: false, target: ['es2022'], define: { 'process.env.NODE_ENV': '"production"' }
});
await copyFile('src/sw.js', join(outdir, 'sw.js'));
await mkdir(join(outdir, 'fonts'), { recursive: true });
for (const name of ['NotoSansDevanagari.ttf', 'OFL.txt']) await copyFile(join('assets', 'fonts', name), join(outdir, 'fonts', name));
await writeFile(join(outdir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#153d3a"><title>Samford | Workflow lab</title><link rel="stylesheet" href="/main.css"></head>
<body><div id="root"></div><script src="/main.js" defer></script></body></html>`);
await writeFile(join(outdir, 'build.json'), JSON.stringify({ version: '0.2.0', builtAt: new Date().toISOString() }));
console.log('Built candidate frontend in dist-candidate. The running dist directory was not changed.');
