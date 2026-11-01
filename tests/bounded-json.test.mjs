import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedJson, HttpError } from "../server/account-http.mjs";

const request = (body) => new Request("https://quill.example/api/recovery-session", {
  method: "POST", headers: { "content-type": "application/json" }, body,
});

test("account JSON rejects duplicate root, nested and escaped-equivalent keys", async () => {
  for (const body of [
    '{"accountId":"first","accountId":"second","recoveryCode":"code"}',
    '{"response":{"accepted":true,"accepted":false}}',
    '{"accountId":"first","\\u0061ccountId":"second","recoveryCode":"code"}',
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
});
