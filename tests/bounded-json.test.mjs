import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedJson, createRequestBudget, HttpError } from "../server/account-http.mjs";

const request = (body) => new Request("https://quill.example/api/recovery-session", {
  method: "POST", headers: { "content-type": "application/json" }, body,
});

test("account JSON rejects duplicate root, nested and escaped-equivalent keys", async () => {
  for (const body of [
    '{"accountId":"first","accountId":"second","recoveryCode":"code"}',
    '{"response":{"accepted":true,"accepted":false}}',
    '{"accountId":"first","\\u0061ccountId":"second","recoveryCode":"code"}',
    '{"response":{"counter":1e9999}}',
  ]) {
    await assert.rejects(
      boundedJson(request(body), ["accountId", "recoveryCode", "response"], []),
      (error) => error instanceof HttpError && error.status === 400 && error.code === "INVALID_JSON",
    );
  }
});

test("account JSON retains valid nested responses and rejects malformed input", async () => {
  const body = '{"response":{"accepted":true,"credential":{"id":"test"}}}';
  assert.deepEqual(await boundedJson(request(body), ["response"]), {
    response: { accepted: true, credential: { id: "test" } },
  });
  await assert.rejects(boundedJson(request('{"response":1,}'), ["response"]),
    (error) => error instanceof HttpError && error.code === "INVALID_JSON");
  await assert.rejects(boundedJson(request("[".repeat(80) + "0" + "]".repeat(80)),
    ["response"]), (error) => error instanceof HttpError && error.code === "INVALID_JSON");
});

test("identity request budget cannot be disabled by invalid policy or clock", () => {
  for (const policy of [{ perPeer: 0 }, { globalLimit: Infinity },
                        { maxKeys: -1 }, { windowMs: 0 }, { clock: null }])
    assert.throws(() => createRequestBudget(policy));
  const budget = createRequestBudget({ clock: () => NaN });
  assert.throws(() => budget("peer"),
    (error) => error instanceof HttpError && error.code === "CLOCK_UNAVAILABLE");
});
