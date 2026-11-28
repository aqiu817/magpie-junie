// 凭据读取：Windows DPAPI 已有真机验证；这里补 Linux 的 secure_credentials.json 通道与统一入口。
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readSecureCredentials, readAnyCredentials, authFromAccount } from "../lib/credentials.mjs"

async function withTempCredFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "junie-creds-"))
  const path = join(dir, "secure_credentials.json")
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf8")
  // 必须 await fn：同步 finally 会在 Promise resolve 前就把目录删掉
  try { return await fn(path) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test("authFromAccount prefers id_token for the Bearer and keeps both tokens", () => {
  const auth = authFromAccount({
    access_token: "AT", refresh_token: "RT", expires_in: 3600, id_token: "IDT", email: "a@b", name: "N",
  })
  assert.equal(auth.access, "IDT")
  assert.equal(auth.accessToken, "AT")
  assert.equal(auth.idToken, "IDT")
  assert.equal(auth.refresh, "RT")
  assert.equal(auth.accountId, "a@b")
})

test("readSecureCredentials parses the jb-account-stored entry (Linux layout)", async () => {
  const result = await withTempCredFile({
    secrets: [
      // 非 JSON 的其它 secret 必须被跳过，不能让整次读取失败
      { key: "junie-env-encryption-key", secret: "not-json" },
      {
        key: "jb-account-stored",
        secret: JSON.stringify({
          jbAccount: { access_token: "AT", refresh_token: "RT", expires_in: 3600, id_token: "IDT", email: "a@b", name: "N" },
        }),
      },
    ],
  }, (path) => readSecureCredentials({ path }))
  assert.equal(result.ok, true)
  assert.equal(result.auth.access, "IDT")
  assert.equal(result.auth.refresh, "RT")
  assert.equal(result.auth.email, "a@b")
  assert.equal(result.auth.metadata.source, "junie-cli")
})

test("readSecureCredentials reports a clear reason when the file is missing", () => {
  const r = readSecureCredentials({ path: "Z:/does-not-exist.json" })
  assert.equal(r.ok, false)
  assert.equal(r.reason, "no-secure-credentials")
})

test("readSecureCredentials survives malformed content", async () => {
  const r = await withTempCredFile("{ not json", (path) => readSecureCredentials({ path }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /secure-parse-failed/)
})

test("readAnyCredentials falls back to secure credentials when DPAPI is unavailable", async () => {
  const result = await withTempCredFile({
    secrets: [{
      key: "jb-account-stored",
      secret: JSON.stringify({ jbAccount: { access_token: "AT", refresh_token: "RT", id_token: "IDT", expires_in: 3600 } }),
    }],
  }, (path) => readAnyCredentials({ credentialsDir: "Z:/no-dpapi", path }))
  assert.equal(result.ok, true)
  assert.equal(result.auth.access, "IDT")
})

test("readAnyCredentials merges both failure reasons", async () => {
  const r = await readAnyCredentials({ credentialsDir: "Z:/no-dpapi", path: "Z:/no-secure.json" })
  assert.equal(r.ok, false)
  assert.match(r.reason, /dpapi:cli-not-installed/)
  assert.match(r.reason, /secure:no-secure-credentials/)
})
