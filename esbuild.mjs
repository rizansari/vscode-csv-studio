import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

/** sql.js loads sql-wasm.wasm from the directory of the running script, i.e. dist/. */
const copySqlWasm = {
  name: 'copy-sql-wasm',
  setup(build) {
    build.onEnd(() => {
      mkdirSync('dist', { recursive: true });
      copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // Prefer ESM builds: jsonc-parser's UMD build uses dynamic requires esbuild cannot follow.
  mainFields: ['module', 'main'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  plugins: [copySqlWasm],
});

if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
