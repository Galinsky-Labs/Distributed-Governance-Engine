// Offline verifier for Quill verification packages. With --bitcoin-header-url
// it looks up block merkle roots from an Esplora-compatible explorer you
// choose; otherwise Bitcoin anchors are reported as limited, never assumed.
import { readFile } from "node:fs/promises";
import { verifyPackage } from "../src/verification-package.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
if (!file) {
  console.error("Usage: node scripts/quill-verify.mjs <package.json> [--log-key=<base64>] [--bitcoin-header-url=https://blockstream.info/api]");
  process.exit(2);
}
const headerBase = option("bitcoin-header-url");
if (headerBase && !headerBase.startsWith("https://")) { console.error("Header source must use https"); process.exit(2); }
const bitcoinHeader = headerBase ? async (height) => {
  const hash = (await (await fetch(`${headerBase}/block-height/${height}`, { redirect: "error" })).text()).trim();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Header source returned an invalid block hash");
  const block = await (await fetch(`${headerBase}/block/${hash}`, { redirect: "error" })).json();
  return block.merkle_root;
} : null;
try {
  const source = await readFile(file);
  if (source.length > 50_000_000) throw Error("Package exceeds 50 MB");
  const report = await verifyPackage(JSON.parse(source.toString("utf8")), {
    trustedLogKeys: option("log-key") ? [option("log-key")] : [], bitcoinHeader,
  });
  for (const check of report.checks) console.log(`${check.state.toUpperCase().padEnd(10)} ${check.id}: ${check.detail}`);
  console.log(`\nOverall: ${report.overall}`);
  if (report.overall === "failed") process.exitCode = 1;
} catch (error) {
  console.error("Could not verify the package: " + String(error?.message ?? error).slice(0, 200));
  process.exitCode = 1;
}
