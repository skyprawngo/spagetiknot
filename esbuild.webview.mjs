import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const watch = process.argv.includes('--watch');

// Copy CSS to out/webview/
const cssSource = path.join('src', 'webview', 'styles.css');
const cssTarget = path.join('out', 'webview', 'styles.css');
fs.mkdirSync(path.dirname(cssTarget), { recursive: true });
fs.copyFileSync(cssSource, cssTarget);

const buildOptions = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'out/webview/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  minify: false,
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[esbuild] watching webview...');
} else {
  await esbuild.build(buildOptions);
  console.log('[esbuild] webview built.');
}
