// Engine-only entry point. Applications start the same runtime with their
// own extensions through `@distributed-governance/engine/runtime`.
import { runPlatform } from "./runtime.mjs";

await runPlatform();
