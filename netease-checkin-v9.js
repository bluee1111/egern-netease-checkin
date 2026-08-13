const ACCOUNTS_KEY = "netease_music_accounts";
const LAST_CAPTURE_KEY = "netease_music_last_capture";
const LAST_RESULT_KEY = "netease_music_last_result";
const CAPTURE_COMPLETE_KEY = "netease_music_capture_complete";
const CAPTURE_LOCK_KEY = "netease_music_capture_in_progress";
const ACCOUNT_URL = "https://music.163.com/api/nuser/account/get";
const SIGN_URL = "https://music.163.com/api/point/dailyTask";
const YUNBEI_SIGN_URL = "https://music.163.com/api/pointmall/user/sign";
const VIP_TASK_LIST_URL = "https://music.163.com/api/vipnewcenter/app/level/task/list";
const VIP_TASK_REWARD_URL = "https://music.163.com/api/vipnewcenter/app/level/task/reward/get";
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
// env 检查宽容：只有明确 "false" 才禁用；{{{...}}} 字面量/空值按开启处理
function envEnabled(ctx, key) {
  const raw = String(ctx.env?.[key] ?? "");
  if (raw === "" || raw.includes("{{{")) return true;
  return raw === "true";
}

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
// v13: 修复假成功——code200但msg含"暂不支持/未登录/失效"不再判成功；成长值任务列表接口异常/为空不再误报ok
// v12: 无变化但当天未确认时也发「Cookie 已确认」通知（一天一次）；诊断日志保留
async function captureCookie(ctx) {
  try {
    if (!envEnabled(ctx, "ENABLE_CAPTURE")) {
      return;
    }
    if (ctx.storage.get(CAPTURE_COMPLETE_KEY) === today()) return;
    if (ctx.storage.get(CAPTURE_LOCK_KEY) === "true") return;
    ctx.storage.set(CAPTURE_LOCK_KEY, "true");
    try {
      const cookie = getHeader(ctx.request?.headers, "cookie").trim();
      const reqUrl = (() => { try { return new URL(ctx.request.url).pathname; } catch (_) { return String(ctx.request?.url || "").slice(0, 120); } })();
      if (!cookie) {
        console.log(`网易云捕获诊断：${reqUrl} 无 Cookie 头`);
        return;
      }
      if (!/(?:^|;\s*)MUSIC_U=/i.test(cookie)) {
        console.log(`网易云捕获诊断：${reqUrl} 有 Cookie 但无 MUSIC_U（len=${cookie.length}）`);
        return;
      }
      console.log(`网易云捕获诊断：${reqUrl} 命中 MUSIC_U（len=${cookie.length}）`);

      const fp = fingerprint(cookie);
      const accounts = safeGetJSON(ctx, ACCOUNTS_KEY);
      const stored = ctx.storage.getJSON(LAST_CAPTURE_KEY) || {};
      const prevFp = stored["last"] || "";
      const existing = Object.entries(accounts).find(([, v]) => fingerprint(v.cookie) === fp);

      if (!existing) {
        accounts[fp] = { cookie, name: `账号${Object.keys(accounts).length + 1}` };
        ctx.storage.setJSON(ACCOUNTS_KEY, accounts);
        stored["last"] = fp;
        ctx.storage.setJSON(LAST_CAPTURE_KEY, stored);
        ctx.storage.set(CAPTURE_COMPLETE_KEY, today());
        ctx.notify({ title: "网易云音乐签到", body: "Cookie 已保存\n每日 00:10 自动签到", sound: true, duration: 5 });
        console.log(`网易云新账号 ${fp} Cookie 已保存，共 ${Object.keys(accounts).length} 个账号`);
      } else if (existing[1].cookie !== cookie) {
        accounts[existing[0]].cookie = cookie;
        ctx.storage.setJSON(ACCOUNTS_KEY, accounts);
        stored["last"] = fp;
        ctx.storage.setJSON(LAST_CAPTURE_KEY, stored);
        ctx.storage.set(CAPTURE_COMPLETE_KEY, today());
        ctx.notify({ title: "网易云音乐签到", body: "Cookie 已更新\n每日 00:10 自动签到", sound: true, duration: 5 });
        console.log(`网易云账号 ${existing[0]} Cookie 已更新`);
      } else {
        ctx.storage.set(CAPTURE_COMPLETE_KEY, today());
        ctx.notify({ title: "网易云音乐签到", body: "Cookie 已确认\n每日 00:10 自动签到", sound: true, duration: 5 });
        console.log(`网易云账号 ${fp} Cookie 无变化，已发确认通知`);
      }
    } finally {
      ctx.storage.set(CAPTURE_LOCK_KEY, "");
    }
  } catch (error) {
    console.log(`网易云捕获钩子异常（不通知）：${translateHttpError(error).message}`);
  }
}

// 判断响应是否"成功/已做过"：code===200 且无"不支持/未登录/失效"等假成功提示，或关键词命中
function isDone(data, extraKeys = []) {
  const msg = String(data?.message || data?.msg || data?.error || "");
  const fake = /暂不支持|不支持|未登录|请登录|已失效|失败|异常|错误/.test(msg);
  return (!fake && data?.code === 200) || /成功|已签到|已签|重复|已领取|已完成|已打卡|明天再来/.test(msg);
}

// 积分签到（保留原逻辑）
async function signPoint(ctx, cookie) {
  const data = await requestJson(ctx, `${SIGN_URL}?type=0`, {
    method: "POST", headers: headers(cookie, true), body: "type=0",
  });
  const msg = String(data?.message || data?.msg || (data?.code === 200 ? "签到成功" : "未知响应"));
  return { ok: isDone(data), msg };
}

// 云贝签到
async function signYunbei(ctx, cookie) {
  const data = await requestJson(ctx, YUNBEI_SIGN_URL, {
    method: "POST", headers: headers(cookie, true), body: "",
  });
  const msg = String(data?.message || data?.msg || (data?.code === 200 ? "签到成功" : "未知响应"));
  return { ok: isDone(data), msg };
}

// VIP 成长值：先拉任务列表，再领取（乐签打卡）
async function signVipGrowth(ctx, cookie) {
  const list = await requestJson(ctx, VIP_TASK_LIST_URL, {
    method: "POST", headers: headers(cookie, true), body: "",
  });
  // 任务列表里找可领取的任务 id（接口异常时不再假成功）
  const tasks = list?.data?.list || list?.data?.tasks || list?.list || list?.tasks || [];
  const ids = [];
  for (const t of tasks) {
    const tid = t?.id || t?.taskId || t?.task_id || t?.userTaskId;
    const canGet = t?.status === 1 || t?.canReceive || t?.can_receive || t?.rewardStatus === 0 || t?.done === false || t?.finish === true;
    if (tid !== undefined && tid !== null && canGet) ids.push(String(tid));
  }
  if (!ids.length) {
    const listMsg = String(list?.message || list?.msg || "");
    const listFake = /暂不支持|未登录|请登录|已失效|失败|异常/.test(listMsg);
    if (listFake || !list || list.code !== 200) {
      return { ok: false, msg: "成长值任务列表获取失败" + (listMsg ? "：" + listMsg : "") };
    }
    return { ok: true, msg: "成长值任务：无可领取项或已全部完成" };
  }
  const data = await requestJson(ctx, VIP_TASK_REWARD_URL, {
    method: "POST", headers: headers(cookie, true), body: `taskIds=${ids.join(",")}`,
  });
  const msg = String(data?.message || data?.msg || (data?.code === 200 ? "成长值领取成功" : "未知响应"));
  return { ok: isDone(data), msg };
}

async function signAccount(ctx, id, item) {
  const account = await accountInfo(ctx, item.cookie);
  const point = await signPoint(ctx, item.cookie);
  const yunbei = await signYunbei(ctx, item.cookie);
  const vip = await signVipGrowth(ctx, item.cookie);
  return {
    id, name: account.name,
    point, yunbei, vip,
    ok: point.ok || yunbei.ok || vip.ok,
  };
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
  const lines = [];
  for (const r of reports) {
    if (r.error) { lines.push(`${r.name}：${r.error}`); continue; }
    lines.push(`${r.name}：积分${r.point.msg}｜云贝${r.yunbei.msg}｜成长值${r.vip.msg}`);
  }
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