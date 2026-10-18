import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkLocalEndpoint } from "./endpoint.ts";

describe("checkLocalEndpoint", () => {
  test("本机地址通过，返回 origin", () => {
    assert.deepEqual(checkLocalEndpoint("http://127.0.0.1:8791"), { ok: true, base: "http://127.0.0.1:8791" });
    assert.deepEqual(checkLocalEndpoint(" http://localhost:8791/ "), { ok: true, base: "http://localhost:8791" });
    assert.deepEqual(checkLocalEndpoint("http://LOCALHOST:8791/v1"), { ok: true, base: "http://localhost:8791" });
    assert.deepEqual(checkLocalEndpoint("http://[::1]:8791"), { ok: true, base: "http://[::1]:8791" });
  });

  test("非本机地址一律拒绝", () => {
    for (const url of [
      "http://192.168.1.10:8791",
      "https://index-translate.bilibili.com/v1",
      "http://127.0.0.1.evil.com:8791",
      "http://localhost.evil.com",
      "http://user@evil.com",
    ]) {
      const r = checkLocalEndpoint(url);
      assert.equal(r.ok, false, url);
    }
  });

  test("格式不对、协议不对拒绝", () => {
    assert.equal(checkLocalEndpoint("127.0.0.1:8791").ok, false);
    assert.equal(checkLocalEndpoint("not a url").ok, false);
    assert.equal(checkLocalEndpoint("ftp://127.0.0.1").ok, false);
  });
});
