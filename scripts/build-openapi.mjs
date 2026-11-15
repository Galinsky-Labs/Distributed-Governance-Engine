#!/usr/bin/env node
// Writes docs/sdk/openapi.json from src/http-contract.mjs (DCE-038).
import {writeFile} from "node:fs/promises";
import {buildOpenApi} from "../src/http-contract.mjs";
await writeFile(new URL("../docs/sdk/openapi.json",import.meta.url),JSON.stringify(buildOpenApi(),null,2)+"\n");
console.log("Wrote docs/sdk/openapi.json");
