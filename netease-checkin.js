const ACCOUNTS_KEY = "netease_music_accounts";
const LAST_CAPTURE_KEY = "netease_music_last_capture";
const LAST_RESULT_KEY = "netease_music_last_result";
const CAPTURE_COMPLETE_KEY = "netease_music_capture_complete";
const CAPTURE_LOCK_KEY = "netease_music_capture_in_progress";
const ACCOUNT_URL = "https://music.163.com/api/nuser/account/get";
const SIGN_URL = "https://music.163.com/api/point/dailyTask";
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

function getHeader(headers, name) {
  if (!headers) return "";
  return headers.get?.(name) || headers.get?.(name.toLowerCase()) || headers[name] || headers[name.toLowerCase()] || "";
}

function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function fingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function headers(cookie, form = false) {
  return {
    Accept: "application/json, text/plain, */*",
    Cookie: cookie,
    Referer: "https://music.163.com/",
    "User-Agent": USER_AGENT,
    ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
  };
}

async function requestJson(ctx, url, options = {}) {
  const response = options.method === "POST"
    ? await ctx.http.post(url, { timeout: 20000, policy: "DIRECT", headers: options.headers, body: options.body || "" })
    : await ctx.http.get(url, { timeout: 20000, policy: "DIRECT", headers: options.headers });
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function accountInfo(ctx, cookie) {
  const data = await requestJson(ctx, ACCOUNT_URL, { headers: headers(cookie) });
  const profile = data?.profile || data?.account || {};
  const id = String(profile.userId || profile.id || "");
  if (data?.code !== 200 || !id) throw new Error(data?.msg || "Cookie 已失效");
  return { id, name: String(profile.nickname || id) };
}

async function captureCookie(ctx) {
  if (ctx.storage.get(CAPTURE_COMPLETE_KEY) === "true") return;
  if (ctx.storage.get(CAPTURE_LOCK_KEY) === "true") return;
  ctx.storage.set(CAPTURE_LOCK_KEY, "true");
  try {
    const cookie = getHeader(ctx.request?.headers, "cookie").trim();
    if (!/(?:^|;\s*)MUSIC_U=/i.test(cookie)) return;
    let account;
    try {
      account = await accountInfo(ctx, cookie);
    } catch (error) {
      console.log(`网易云 Cookie 校验失败：${error.message || error}`);
      return;
    }
    const accounts = ctx.storage.getJSON(ACCOUNTS_KEY) || {};
    const previous = accounts[account.id]?.cookie || "";
    accounts[account.id] = { cookie, name: account.name };
    ctx.storage.setJSON(ACCOUNTS_KEY, accounts);

    const captured = ctx.storage.getJSON(LAST_CAPTURE_KEY) || {};
    captured[account.id] = fingerprint(cookie);
    ctx.storage.setJSON(LAST_CAPTURE_KEY, captured);
    const captureResult = {
      day: today(), time: new Date().toISOString(), accounts: Object.keys(accounts).length,
      success: 1, failed: 0, message: `Cookie 已验证：${account.name}`,
    };
    ctx.storage.setJSON(LAST_RESULT_KEY, captureResult);
    ctx.storage.set(CAPTURE_COMPLETE_KEY, "true");
    console.log(`网易云账号 ${account.name} Cookie ${previous === cookie ? "无变化" : "已保存"}，后续抓取已静默跳过，当前共 ${captureResult.accounts} 个账号`);
  } finally {
    ctx.storage.remove(CAPTURE_LOCK_KEY);
  }
}

// 每日签到：调用 dailyTask 接口（type=0 移动端签到），成功/重复均视为完成
async function signAccount(ctx, id, item) {
  const account = await accountInfo(ctx, item.cookie);
  const data = await requestJson(ctx, `${SIGN_URL}?type=0`, {
    method: "POST", headers: headers(item.cookie, true), body: "type=0",
  });
  const message = String(data?.message || data?.msg || "签到成功");
  const ok = data?.code === 200 || /成功|已签到|重复/.test(message);
  return { id, name: account.name, ok, message };
}

async function runSign(ctx) {
  const accounts = ctx.storage.getJSON(ACCOUNTS_KEY) || {};
  const entries = Object.entries(accounts);
  if (!entries.length) {
    const result = { day: today(), accounts: 0, success: 0, failed: 1, message: "没有 Cookie，请打开网易云音乐触发抓取" };
    ctx.storage.setJSON(LAST_RESULT_KEY, result);
    ctx.notify({ title: "网易云音乐签到失败", body: result.message, sound: true, duration: 6 });
    return;
  }
  const reports = [];
  for (const [id, item] of entries) {
    try { reports.push(await signAccount(ctx, id, item)); }
    catch (error) { reports.push({ id, name: item.name || id, error: error.message || String(error) }); }
  }
  const success = reports.filter(r => !r.error && r.ok).length;
  const failures = reports.filter(r => r.error || !r.ok);
  const lines = reports.map(r => r.error
    ? `${r.name}：${r.error}`
    : `${r.name}：${r.message}`);
  const result = { day: today(), accounts: reports.length, success, failed: failures.length, message: lines.join("\n") };
  ctx.storage.setJSON(LAST_RESULT_KEY, result);
  ctx.notify({
    title: failures.length ? "网易云音乐签到部分失败" : "网易云音乐签到完成",
    body: [`账号：${reports.length}`, `成功：${success}`, `失败：${failures.length}`, "", ...lines.slice(0, 5)].join("\n"),
    sound: true, duration: 8,
  });
}

export default async function (ctx) {
  try {
    if (ctx.request?.url) return await captureCookie(ctx);
    await runSign(ctx);
  } catch (error) {
    console.log(`网易云签到异常：${error.stack || error.message || error}`);
    ctx.notify({ title: "网易云音乐签到异常", body: error.message || String(error), sound: true, duration: 6 });
  }
}
