import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/extension.js",
  sourcemap: true,
  external: ["vscode"],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[build] watching…");
} else {
  await esbuild.build(options);
  console.log("[build] done");
}

