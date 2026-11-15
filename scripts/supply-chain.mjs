#!/usr/bin/env node
// DCE-036 supply-chain evidence, offline and deterministic:
//   node scripts/supply-chain.mjs check   fail on unpinned/unhashed/unexpected sources
//   node scripts/supply-chain.mjs sbom    write security/sbom.cdx.json (CycloneDX 1.5)
// Inputs are the committed lockfiles only; nothing is downloaded.
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const ALLOWED_NPM_HOSTS = ["registry.npmjs.org"];
// Packages whose install scripts exist upstream; CI and the Dockerfile install
// with --ignore-scripts, so none of them run.
const KNOWN_INSTALL_SCRIPTS = ["node_modules/esbuild"];
const CRATES_INDEX = "registry+https://github.com/rust-lang/crates.io-index";

export async function inventory() {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const npm = Object.entries(lock.packages).filter(([path]) => path).map(([path, v]) => ({
    path, name: v.name ?? path.split("node_modules/").pop(), version: v.version, resolved: v.resolved ?? null,
    integrity: v.integrity ?? null, dev: Boolean(v.dev), optional: Boolean(v.optional), license: v.license ?? null,
    installScript: Boolean(v.hasInstallScript),
  }));
  const cargo = (await readFile(new URL("crypto/mls-endpoint/Cargo.lock", root), "utf8")).split("[[package]]").slice(1).map((block) => ({
    name: /name = "([^"]+)"/.exec(block)?.[1], version: /version = "([^"]+)"/.exec(block)?.[1],
    source: /source = "([^"]+)"/.exec(block)?.[1] ?? null, checksum: /checksum = "([^"]+)"/.exec(block)?.[1] ?? null,
  }));
  return { pkg, lock, npm, cargo };
}

export function supplyChainProblems({ pkg, lock, npm, cargo }) {
  const problems = [];
  if (lock.lockfileVersion !== 3) problems.push("package-lock.json must be lockfile v3");
  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
    if (!/^\d+\.\d+\.\d+$/.test(spec) && !/^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/tar\.gz\/[0-9a-f]{40}$/.test(spec))
      problems.push(`${name}: dependency spec ${spec} is not an exact version or a commit-pinned tarball`);
  for (const p of npm) {
    if (!p.integrity || !/^sha512-/.test(p.integrity)) problems.push(`${p.path}: missing sha512 integrity`);
    if (!p.resolved) problems.push(`${p.path}: missing resolved source`);
    else if (!ALLOWED_NPM_HOSTS.includes(new URL(p.resolved).host)) problems.push(`${p.path}: unexpected source host ${new URL(p.resolved).host}`);
    if (p.installScript && !KNOWN_INSTALL_SCRIPTS.includes(p.path)) problems.push(`${p.path}: new install script`);
  }
  for (const c of cargo) {
    if (!c.name || !c.version) problems.push("Cargo.lock: unparseable package");
    else if (c.source === null) continue; // the workspace crate itself
    else if (/^git\+https:\/\/github\.com\/openmls\/openmls\.git\?rev=([0-9a-f]{40})#\1$/.test(c.source)) continue; // pinned by full commit
    else if (c.source !== CRATES_INDEX) problems.push(`${c.name}: unexpected crate source ${c.source}`);
    else if (!/^[0-9a-f]{64}$/.test(c.checksum ?? "")) problems.push(`${c.name}: missing crate checksum`);
  }
  return problems;
}

const purlNpm = (p) => "pkg:npm/" + (p.name.startsWith("@") ? "%40" + p.name.slice(1) : p.name) + "@" + p.version;
export function sbom({ pkg, npm, cargo }) {
  const components = [
    ...npm.map((p) => ({
      type: "library", name: p.name, version: p.version, purl: purlNpm(p),
      scope: p.dev ? "excluded" : p.optional ? "optional" : "required",
      ...(p.license ? { licenses: [{ license: { id: p.license } }] } : {}),
      hashes: [{ alg: "SHA-512", content: Buffer.from(p.integrity.slice(7), "base64").toString("hex") }],
      ...(p.resolved ? { externalReferences: [{ type: "distribution", url: p.resolved }] } : {}),
    })),
    ...cargo.filter((c) => c.source).map((c) => ({
      type: "library", name: c.name, version: c.version, purl: `pkg:cargo/${c.name}@${c.version}`, scope: "required",
      ...(c.checksum ? { hashes: [{ alg: "SHA-256", content: c.checksum }] } : {}),
      ...(c.source.startsWith("git+") ? { externalReferences: [{ type: "vcs", url: c.source.slice(4) }] } : {}),
    })),
  ].sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
  return {
    bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
    metadata: { component: { type: "application", name: pkg.name, version: pkg.version },
      properties: [{ name: "dge:generator", value: "scripts/supply-chain.mjs from committed lockfiles (no timestamps, deterministic)" }] },
    components,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = await inventory();
  if (process.argv[2] === "sbom") {
    await writeFile(new URL("security/sbom.cdx.json", root), JSON.stringify(sbom(data), null, 2) + "\n");
    console.log(`Wrote security/sbom.cdx.json (${data.npm.length} npm, ${data.cargo.filter((c) => c.source).length} cargo components)`);
  } else {
    const problems = supplyChainProblems(data);
    if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
    console.log(`Supply chain valid: ${data.npm.length} npm packages pinned with sha512 from ${ALLOWED_NPM_HOSTS.join(",")}; ${data.cargo.filter((c) => c.checksum).length} crates with checksums and ${data.cargo.filter((c) => c.source?.startsWith("git+")).length} pinned to a full OpenMLS commit; install scripts never run (--ignore-scripts).`);
  }
}
