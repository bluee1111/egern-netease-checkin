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

// 安全读取：旧版本可能写入过非 JSON 脏数据，读不出来就当空处理
function safeGetJSON(ctx, key) {
  try {
    const value = ctx.storage.getJSON(key);
    return value && typeof value === "object" ? value : {};
  } catch (_) {
    return {};
  }
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

function translateHttpError(error) {
  const raw = String(error?.message || error || "");
  if (/JSON Parse|Unable to parse JSON|Unexpected identifier|Unexpected token|SyntaxError/i.test(raw)) {
    return new Error("接口返回了非 JSON 内容，可能是风控页、网络劫持或需要重新登录");
  }
  return error instanceof Error ? error : new Error(raw);
}

// 请求封装：ctx.http 内部会自行解析 JSON，非 JSON 内容会抛解析错误，必须整段包住
async function requestJson(ctx, url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const requestOptions = {
    timeout: 20000,
    policy: "DIRECT",
    headers: options.headers,
  };
  if (options.body !== undefined) requestOptions.body = options.body;

  let response;
  try {
    response = method === "POST"
      ? await ctx.http.post(url, requestOptions)
      : await ctx.http.get(url, requestOptions);
  } catch (error) {
    throw translateHttpError(error);
  }

  if (response && typeof response === "object" && typeof response.status === "number") {
    if (response.status < 200 || response.status >= 300) {
      let detail = "";
      try {
        const raw = typeof response.text === "function" ? await response.text() : JSON.stringify(response);
        detail = String(raw || "").replace(/\s+/g, " ").slice(0, 240);
      } catch (_) {}
      const path = (() => { try { return new URL(url).pathname; } catch (_) { return "request"; } })();
      throw new Error(`HTTP ${response.status} ${path}${detail ? `：${detail}` : ""}`);
    }
  }

  // 解析 body：兼容“已解析对象 / Response-like / 字符串”三种形态，失败转可读错误
  try {
    if (response === undefined || response === null) return {};
    if (typeof response === "string") return JSON.parse(response);
    if (typeof response.text === "function") {
      const raw = await response.text();
      if (typeof raw === "string" && raw.trim()) return JSON.parse(raw);
      return {};
    }
    return response;
  } catch (error) {
    throw translateHttpError(error);
  }
}

async function accountInfo(ctx, cookie) {
  const data = await requestJson(ctx, ACCOUNT_URL, { headers: headers(cookie) });
  const profile = data?.profile || data?.account || {};
  const id = String(profile.userId || profile.id || "");
  if (data?.code !== 200 || !id) throw new Error(data?.msg || "Cookie 已失效");
  return { id, name: String(profile.nickname || id) };
}

// 捕获钩子：检测到 MUSIC_U 直接保存（不调 API 验证，避免风控导致静默）
// 按天重置：当天首次保存成功通知一次，当天后续重复静默；次日重新捕获
async function captureCookie(ctx) {
  try {
    if (ctx.storage.get(CAPTURE_COMPLETE_KEY) === today()) return;
    if (ctx.storage.get(CAPTURE_LOCK_KEY) === "true") return;
    ctx.storage.set(CAPTURE_LOCK_KEY, "true");
    try {
      const cookie = getHeader(ctx.request?.headers, "cookie").trim();
      if (!/(?:^|;\s*)MUSIC_U=/i.test(cookie)) return;

      const fp = fingerprint(cookie);
      const accounts = safeGetJSON(ctx, ACCOUNTS_KEY);
      const stored = ctx.storage.getJSON(LAST_CAPTURE_KEY) || {};
      const prevFp = stored["last"] || "";
      const existing = Object.entries(accounts).find(([, v]) => fingerprint(v.cookie) === fp);

      if (!existing) {
        // 新账号
        accounts[fp] = { cookie, name: `账号${Object.keys(accounts).length + 1}` };
        ctx.storage.setJSON(ACCOUNTS_KEY, accounts);
        stored["last"] = fp;
        ctx.storage.setJSON(LAST_CAPTURE_KEY, stored);
        ctx.storage.set(CAPTURE_COMPLETE_KEY, today());
        ctx.notify({ title: "网易云音乐签到", body: "Cookie 已保存\n每日 00:10 自动签到", sound: true, duration: 5 });
        console.log(`网易云新账号 ${fp} Cookie 已保存，共 ${Object.keys(accounts).length} 个账号`);
      } else if (existing[1].cookie !== cookie) {
        // Cookie 更新
        accounts[existing[0]].cookie = cookie;
        ctx.storage.setJSON(ACCOUNTS_KEY, accounts);
        stored["last"] = fp;
        ctx.storage.setJSON(LAST_CAPTURE_KEY, stored);
        ctx.storage.set(CAPTURE_COMPLETE_KEY, today());
        ctx.notify({ title: "网易云音乐签到", body: "Cookie 已更新\n每日 00:10 自动签到", sound: true, duration: 5 });
        console.log(`网易云账号 ${existing[0]} Cookie 已更新`);
      }
      // 无变化：完全静默
    } finally {
      ctx.storage.set(CAPTURE_LOCK_KEY, "");
    }
  } catch (error) {
    console.log(`网易云捕获钩子异常（不通知）：${translateHttpError(error).message}`);
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
  const accounts = safeGetJSON(ctx, ACCOUNTS_KEY);
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
    catch (error) { reports.push({ id, name: item.name || id, error: translateHttpError(error).message }); }
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
    const message = translateHttpError(error).message;
    console.log(`网易云签到异常：${message}`);
    ctx.notify({ title: "网易云音乐签到异常", body: message.slice(0, 180), sound: true, duration: 6 });
  }
}
