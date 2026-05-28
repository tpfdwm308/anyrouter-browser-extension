importScripts("usage.js");

const DEFAULT_REFRESH_MINUTES = 1;
const FETCH_TIMEOUT_MS = 12000;
const ALARM_NAME = "anyrouter-quota-refresh";

const TONE_COLORS = {
  good: "#0f9f6e",
  warn: "#d97706",
  danger: "#dc2626",
  unknown: "#64748b",
  error: "#b91c1c",
  stale: "#92400e",
  idle: "#475569",
  loading: "#2563eb",
};

const storageGet = (keys) =>
  new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });

const storageSet = (items) =>
  new Promise((resolve) => {
    chrome.storage.local.set(items, resolve);
  });

const getConfig = async () => {
  const result = await storageGet(UsageQuota.CONFIG_KEY);
  return result[UsageQuota.CONFIG_KEY] || {};
};

const getSnapshot = async () => {
  const result = await storageGet(UsageQuota.SNAPSHOT_KEY);
  return result[UsageQuota.SNAPSHOT_KEY] || null;
};

const setSnapshot = async (snapshot) => {
  await storageSet({ [UsageQuota.SNAPSHOT_KEY]: snapshot });
  await renderAction(snapshot);
  return snapshot;
};

const scheduleRefresh = async () => {
  const config = await getConfig();
  const refreshMinutes = Math.max(Number(config.refreshMinutes) || DEFAULT_REFRESH_MINUTES, 1);
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: refreshMinutes,
    delayInMinutes: 0.1,
  });
};

const getActionState = (snapshot) => {
  if (!snapshot || snapshot.state === "unconfigured") {
    return {
      badge: "SET",
      tone: "idle",
      title: "AnyRouter Quota：请先配置 Access Token + 用户 ID",
      ratio: null,
    };
  }

  if (snapshot.state === "loading") {
    return {
      badge: "...",
      tone: "loading",
      title: "AnyRouter Quota：正在刷新额度",
      ratio: null,
    };
  }

  if (snapshot.data) {
    const data = snapshot.data;
    const isStale = snapshot.state === "stale";
    return {
      badge: data.badgeText,
      tone: isStale ? "stale" : data.status.tone,
      title: [
        isStale ? "AnyRouter Quota：显示上次成功数据，刷新失败" : "AnyRouter Quota",
        `实时剩余 ${data.formatted.weekRemaining}`,
        `本周已用 ${data.formatted.weekUsed} / 周限 ${data.formatted.weeklyBudget}`,
        snapshot.updatedAt ? `更新时间 ${new Date(snapshot.updatedAt).toLocaleString("zh-CN")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      ratio: data.status.ratio,
    };
  }

  return {
    badge: "ERR",
    tone: "error",
    title: `AnyRouter Quota：${snapshot.errorMessage || "查询失败"}`,
    ratio: null,
  };
};

const roundRect = (ctx, x, y, width, height, radius) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
};

const drawIcon = (size, tone) => {
  if (typeof OffscreenCanvas === "undefined") return null;

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const scale = size / 32;

  ctx.clearRect(0, 0, size, size);

  // AnyRouter 视觉主色：青绿渐变
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "#22c4a8");
  grad.addColorStop(1, "#0ea5a3");

  const r = 7 * scale;
  roundRect(ctx, 0, 0, size, size, r);
  ctx.fillStyle = grad;
  ctx.fill();

  // 状态色小圆点（右上角）
  const dotColor = TONE_COLORS[tone] || TONE_COLORS.idle;
  if (tone !== "idle" && tone !== "unknown") {
    const dotR = 4.5 * scale;
    const dotX = size - dotR - 1 * scale;
    const dotY = dotR + 1 * scale;
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
};

const renderAction = async (snapshot) => {
  const state = getActionState(snapshot);
  const color = TONE_COLORS[state.tone] || TONE_COLORS.idle;

  await chrome.action.setTitle({ title: state.title });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setBadgeText({ text: state.badge.slice(0, 4) });

  const imageData = {};
  for (const size of [16, 32, 48, 128]) {
    const icon = drawIcon(size, state.tone);
    if (icon) imageData[size] = icon;
  }

  if (Object.keys(imageData).length > 0) {
    await chrome.action.setIcon({ imageData });
  }
};

const fetchJson = async (url, headers, signal) => {
  const response = await fetch(url, {
    method: "GET",
    headers,
    cache: "no-store",
    signal,
  });

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  return { response, body };
};

const isAuthFailure = (response, body) => {
  if (response?.status === 401 || response?.status === 403) return true;
  const message = (body?.message || "").toString();
  return /access\s*token|未登录|登录|无权|user.*id|token.*invalid|mismatch/i.test(message);
};

const fetchUsage = async () => {
  const config = await getConfig();
  const previous = await getSnapshot();

  if (!UsageQuota.hasValidConfig(config)) {
    return setSnapshot({
      state: "unconfigured",
      updatedAt: null,
      errorMessage: "请配置 Access Token 和用户 ID",
    });
  }

  await renderAction({
    state: "loading",
    data: previous?.data || null,
    updatedAt: previous?.updatedAt || null,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = UsageQuota.buildAuthHeaders(config);
    const { todayStart, nowSec, weekStart } = UsageQuota.computeTimestamps();

    const userUrl = UsageQuota.buildUserUrl(config);
    const dataUrl = UsageQuota.buildDataUrl(config, weekStart, nowSec);
    const logStatUrl = UsageQuota.buildLogStatUrl(config);
    const subscriptionUrl = UsageQuota.buildSubscriptionUrl(config);

    // /api/user/self 是关键，先单独发以便处理鉴权失败
    const { response: userRes, body: userBody } = await fetchJson(userUrl, headers, controller.signal);

    if (isAuthFailure(userRes, userBody)) {
      return setSnapshot({
        state: "unconfigured",
        updatedAt: null,
        errorMessage: userBody?.message || "Access Token 或用户 ID 无效",
      });
    }

    if (!userRes.ok || !userBody?.success) {
      throw new Error(userBody?.message || `HTTP ${userRes.status}`);
    }

    // 其他三个接口并发查询，单个失败不致命
    const fetchOptional = async (url) => {
      try {
        const { response, body } = await fetchJson(url, headers, controller.signal);
        if (!response.ok) return null;
        return body;
      } catch (error) {
        return null;
      }
    };

    const [dataBody, logStatBody, subscriptionBody] = await Promise.all([
      fetchOptional(dataUrl),
      fetchOptional(logStatUrl),
      fetchOptional(subscriptionUrl),
    ]);

    const data = UsageQuota.extractUsage({
      userResponse: userBody,
      dataResponse: dataBody,
      logStatResponse: logStatBody,
      subscriptionResponse: subscriptionBody,
    });

    if (!data.isValid) {
      throw new Error(data.invalidMessage);
    }

    return setSnapshot({
      state: "ready",
      updatedAt: Date.now(),
      errorMessage: "",
      data,
    });
  } catch (error) {
    const message =
      error?.name === "AbortError" ? "请求超时，请检查平台地址或网络" : error?.message || "查询失败";
    const staleData = previous?.data || null;

    return setSnapshot({
      state: staleData ? "stale" : "error",
      updatedAt: previous?.updatedAt || null,
      failedAt: Date.now(),
      errorMessage: message,
      data: staleData,
    });
  } finally {
    clearTimeout(timeout);
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleRefresh();
  await fetchUsage();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleRefresh();
  const snapshot = await getSnapshot();
  await renderAction(snapshot);
  await fetchUsage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    fetchUsage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "refreshUsage") {
    fetchUsage().then(sendResponse);
    return true;
  }

  if (message?.type === "getUsageState") {
    Promise.all([getConfig(), getSnapshot()]).then(([config, snapshot]) => {
      sendResponse({ config, snapshot });
    });
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[UsageQuota.CONFIG_KEY]) {
    scheduleRefresh();
  }
});
