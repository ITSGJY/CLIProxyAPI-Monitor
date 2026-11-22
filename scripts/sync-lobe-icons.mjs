import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

/**
 * OMC v0.4.11's static-icon sync strategy, adapted to this Next.js project.
 * The package's SVG files are copied into public/ so the browser loads local assets,
 * rather than importing thousands of React icon components into the application bundle.
 */
export function syncLobeIcons({ quiet = false } = {}) {
  const packageRoot = path.dirname(require.resolve("@lobehub/icons-static-svg/package.json"));
  const source = path.join(packageRoot, "icons");
  const target = path.join(root, "public", "lobe-icons");
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "lib", "branding", "omc", "lobeIconCatalog.json"), "utf8"));
  const slug = (iconId) => iconId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  if (!fs.existsSync(source)) {
    throw new Error(`static Lobe icon source is missing: ${source}`);
  }

  const staging = `${target}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  let count = 0;
  for (const item of catalog) {
    const names = [`${slug(item.id)}.svg`];
    if (item.hasColor) names.push(`${slug(item.id)}-color.svg`);
    for (const name of names) {
      const sourceFile = path.join(source, name);
      if (!fs.existsSync(sourceFile)) throw new Error(`missing static Lobe icon: ${name}`);
      fs.copyFileSync(sourceFile, path.join(staging, name));
      count += 1;
    }
  }
  fs.copyFileSync(
    path.join(root, "lib", "branding", "omc", "THIRD_PARTY_NOTICES.md"),
    path.join(staging, "THIRD_PARTY_NOTICES.md"),
  );
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);

  if (!quiet) console.log(`synced ${count} OMC Lobe icons to public/lobe-icons`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncLobeIcons();
}
