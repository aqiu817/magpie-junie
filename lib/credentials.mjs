// 复用本机 Junie CLI 的登录态。
//
// 凭据位置：~/.junie/dpapi_credentials/*.dpapi
// 文件内容 = DPAPI blob 的 base64 文本；解密（CryptUnprotectData CurrentUser）后是 JSON：
//   { jbAccount: { access_token, refresh_token, expires_in: 3600, name, email, id_token } }
//
// 文件名是哈希，不依赖命名规则：遍历全部 .dpapi，逐个解密，取含 jbAccount 的。
// DPAPI 用 PowerShell 子进程（Windows 自带），与 magpie-capy/src/creds.mjs 同款做法；
// Node/Bun 没有原生绑定。密钥/token 只在内存流转，绝不写日志。

import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const JUNIE_HOME = join(homedir(), ".junie")
export const CREDENTIALS_DIR = join(JUNIE_HOME, "dpapi_credentials")
export const SECURE_CREDENTIALS_PATH = join(JUNIE_HOME, "secure_credentials.json")

/** DPAPI 解一块字节，返回明文 Buffer。 */
export async function dpapiUnprotect(bytes) {
  const b64 = Buffer.from(bytes).toString("base64")
  const script = [
    "Add-Type -AssemblyName System.Security | Out-Null",
    `$b = [Convert]::FromBase64String('${b64}')`,
    "$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($p)",
  ].join("; ")
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 15000, windowsHide: true },
  )
  return Buffer.from(stdout.trim(), "base64")
}

/** JWT exp（秒）→ 毫秒时间戳；非 JWT 或无 exp 返回 null。 */
export function jwtExpiresAt(token) {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    while (payload.length % 4) payload += "="
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
    return typeof claims.exp === "number" ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * 账号对象 → 统一 auth 形状。两个来源共用：
 * - DPAPI 解出的 jbAccount 是 camelCase（access_token / refresh_token / id_token）
 * - secure_credentials.json 里是同样字段名（Kotlin @SerialName 序列化成 snake_case）
 * access 字段放 id_token：Ingrazzio 的 Bearer 要 id_token，access_token 只用于 userinfo。
 */
export function authFromAccount(acct) {
  return {
    type: "oauth",
    access: acct.id_token ?? acct.access_token,
    accessToken: acct.access_token,
    idToken: acct.id_token,
    refresh: acct.refresh_token,
    expires: jwtExpiresAt(acct.id_token ?? acct.access_token) ?? (acct.expires_in ? Date.now() + acct.expires_in * 1000 : 0),
    accountId: acct.email || acct.name || "",
    email: acct.email,
    name: acct.name,
    metadata: { source: "junie-cli", freeGoogleApi: true, license: "free" },
  }
}

/**
 * 读取 CLI 登录态。
 * @returns {Promise<{ok:true, auth:{type:"oauth", access, refresh, expires, accountId, email, name}}
 *                  |{ok:false, reason:string}>}>}
 */
export async function readCliCredentials({ credentialsDir = CREDENTIALS_DIR } = {}) {
  if (!existsSync(credentialsDir)) return { ok: false, reason: "cli-not-installed" }
  let files
  try {
    files = readdirSync(credentialsDir).filter((f) => f.endsWith(".dpapi"))
  } catch (err) {
    return { ok: false, reason: `read-dir-failed: ${err?.message ?? err}` }
  }
  if (!files.length) return { ok: false, reason: "no-credentials" }

  const errors = []
  for (const file of files) {
    try {
      const text = readFileSync(join(credentialsDir, file), "utf8").trim()
      const blob = Buffer.from(text, "base64")
      const plain = await dpapiUnprotect(blob)
      const obj = JSON.parse(plain.toString("utf8"))
      const acct = obj?.jbAccount
      if (!acct?.access_token) continue
      return { ok: true, auth: authFromAccount(acct) }
    } catch (err) {
      errors.push(`${file}: ${err?.message ?? err}`)
    }
  }
  return { ok: false, reason: `no-usable-account${errors.length ? `: ${errors[0]}` : ""}` }
}

/**
 * Linux/服务器（无 DPAPI）：CLI 把账号存在 ~/.junie/secure_credentials.json（权限 600 明文）。
 * 结构 `{ secrets:[ { key:"jb-account-stored", secret:"<json 字符串>" } ] }`，
 * secret 内是 `{ jbAccount: { access_token, refresh_token, expires_in, id_token, email, name } }`。
 */
export function readSecureCredentials({ path = SECURE_CREDENTIALS_PATH } = {}) {
  if (!existsSync(path)) return { ok: false, reason: "no-secure-credentials" }
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"))
    for (const entry of (Array.isArray(doc?.secrets) ? doc.secrets : [])) {
      if (entry?.key !== "jb-account-stored" || typeof entry?.secret !== "string") continue
      const inner = JSON.parse(entry.secret)
      const acct = inner?.jbAccount
      if (!acct?.access_token && !acct?.id_token) continue
      return { ok: true, auth: authFromAccount(acct) }
    }
    return { ok: false, reason: "no-jb-account" }
  } catch (err) {
    return { ok: false, reason: `secure-parse-failed: ${err?.message ?? err}` }
  }
}

/** 跨平台读取：Windows DPAPI 优先，失败回退 secure_credentials.json（Linux/服务器）。 */
export async function readAnyCredentials(opts = {}) {
  const dpapi = await readCliCredentials(opts)
  if (dpapi.ok) return dpapi
  const secure = readSecureCredentials(opts)
  if (secure.ok) return secure
  return { ok: false, reason: `dpapi:${dpapi.reason} secure:${secure.reason}` }
}

export const _internal = { dpapiUnprotect, jwtExpiresAt, CREDENTIALS_DIR }
