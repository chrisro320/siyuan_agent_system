import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["web/main.ts"],
  outdir: "dist",
  target: "browser",
  minify: true,
  naming: "main.js",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await Promise.all([
  copyFile("web/index.html", "dist/index.html"),
  copyFile("web/style.css", "dist/style.css"),
]);
console.info("Built control panel: dist/");
