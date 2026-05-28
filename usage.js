(function (root) {
  const QUOTA_PER_USD = 500000;
  const ANYROUTER_BASE_URL = "https://anyrouter.top";
  const USER_SELF_PATH = "/api/user/self";
  const DATA_SELF_PATH = "/api/data/self";
  const LOG_STAT_PATH = "/api/log/self/stat";
  const SUBSCRIPTION_SELF_PATH = "/api/subscription/self";
  const CONFIG_KEY = "anyrouterQuotaConfig";
  const SNAPSHOT_KEY = "anyrouterQuotaSnapshot";

  const MAX_RANGE_SECONDS = 2592000; // 后端限制最长 30 天

  const toNumberOrNull = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const normalized = value.replace(/[$,\s]/g, "");
      if (!normalized) return null;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const toNumber = (value, fallback = 0) => {
    const parsed = toNumberOrNull(value);
    return parsed === null ? fallback : parsed;
  };

  const quotaToUsd = (quota) => toNumber(quota) / QUOTA_PER_USD;

  const formatUsd = (value) => `$${toNumber(value).toFixed(2)}`;

  const formatCount = (value) => Math.round(toNumber(value)).toLocaleString("zh-CN");

  const formatToken = (value) => {
    const n = Math.round(toNumber(value));
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      const s = m >= 100 ? Math.round(m) : m >= 10 ? m.toFixed(1) : m.toFixed(2);
      return `${s}M`;
    }
    return n.toLocaleString("zh-CN");
  };

  const clamp01 = (value) => Math.min(Math.max(value, 0), 1);

  const normalizeSiteUrl = (siteUrl) => {
    const raw = (typeof siteUrl === "string" ? siteUrl : "").trim();
    if (!raw) return ANYROUTER_BASE_URL;
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`;
    } catch (error) {
      return ANYROUTER_BASE_URL;
    }
  };

  const normalizeAccessToken = (token) => (typeof token === "string" ? token.trim() : "");

  const normalizeUserId = (userId) => {
    const n = toNumberOrNull(userId);
    return n && n > 0 ? Math.floor(n) : null;
  };

  const hasValidConfig = (config) =>
    Boolean(normalizeAccessToken(config?.accessToken)) && Boolean(normalizeUserId(config?.userId));

  const buildAuthHeaders = (config) => ({
    Authorization: normalizeAccessToken(config?.accessToken),
    "New-Api-User": String(normalizeUserId(config?.userId)),
    Accept: "application/json",
  });

  const buildUrl = (config, path, params) => {
    const base = normalizeSiteUrl(config?.siteUrl);
    const url = new URL(path, base);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  };

  const buildUserUrl = (config) => buildUrl(config, USER_SELF_PATH);

  const buildDataUrl = (config, startTs, endTs) =>
    buildUrl(config, DATA_SELF_PATH, {
      start_timestamp: Math.floor(startTs),
      end_timestamp: Math.ceil(endTs),
    });

  const buildLogStatUrl = (config) => buildUrl(config, LOG_STAT_PATH, { type: 0 });

  const buildSubscriptionUrl = (config) => buildUrl(config, SUBSCRIPTION_SELF_PATH);

  // 计算今日 0 点（本地时区）和本周 7 天起点的 unix 秒
  const computeTimestamps = () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const weekStart = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      nowSec,
      todayStart: Math.floor(todayStart),
      weekStart: Math.floor(weekStart),
    };
  };

  // 聚合一段数据看板记录
  const aggregate = (rows, sinceTs) => {
    let count = 0;
    let quota = 0;
    let tokens = 0;
    if (!Array.isArray(rows)) return { count, quota, tokens };
    for (const row of rows) {
      const createdAt = toNumber(row?.created_at);
      if (sinceTs && createdAt < sinceTs) continue;
      count += toNumber(row?.count);
      quota += toNumber(row?.quota);
      tokens += toNumber(row?.token_used);
    }
    return { count, quota, tokens };
  };

  const formatBadgeValue = (value) => {
    const amount = Math.max(toNumber(value), 0);
    if (amount === 0) return "0";
    if (amount < 1) return "<1";
    if (amount < 10) return amount.toFixed(1).replace(/\.0$/, "");
    if (amount < 1000) return `${Math.round(amount)}`;
    if (amount < 10000) return `${(amount / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    if (amount < 1000000) return `${Math.round(amount / 1000)}k`;
    return `${Math.round(amount / 1000000)}m`;
  };

  const getStatus = (remainingUsd, weeklyBudgetUsd) => {
    if (remainingUsd <= 0) {
      return {
        tone: "danger",
        label: "暂无可用额度",
        description: "实时剩余额度为 0，请尽快处理额度。",
        ratio: 0,
      };
    }
    if (weeklyBudgetUsd <= 0) {
      return {
        tone: "good",
        label: "额度可用",
        description: "未检测到订阅周限，按实时剩余额度展示。",
        ratio: null,
      };
    }
    const ratio = remainingUsd / weeklyBudgetUsd;
    if (ratio < 0.1) {
      return {
        tone: "danger",
        label: "额度紧张",
        description: "剩余额度低于周限额度 10%。",
        ratio,
      };
    }
    if (ratio < 0.25) {
      return {
        tone: "warn",
        label: "接近预警",
        description: "剩余额度低于周限额度 25%。",
        ratio,
      };
    }
    return {
      tone: "good",
      label: "额度充足",
      description: "当前剩余额度处于健康区间。",
      ratio,
    };
  };

  const formatUnixDate = (unix) => {
    const n = toNumber(unix);
    if (n <= 0) return "-";
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return "-";
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // 从 /api/subscription/self 提取活跃订阅
  const extractActiveSubscription = (subResponse) => {
    if (!subResponse?.success) return null;
    const payload = subResponse.data || {};
    const active = Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
    const all = Array.isArray(payload.all_subscriptions) ? payload.all_subscriptions : [];
    const list = active.length > 0 ? active : all;
    if (list.length === 0) return null;
    // 选 end_time 最大的一条作为当前订阅
    let pick = null;
    for (const s of list) {
      const sub = s?.subscription || s;
      if (!sub) continue;
      if (!pick || toNumber(sub.end_time) > toNumber(pick.end_time)) pick = sub;
    }
    return pick;
  };

  // 把订阅的 amount_total / reset_period 换算成日限 & 周限
  const computeBudgetsFromSubscription = (sub, planMap) => {
    if (!sub) return { dailyBudgetUsd: 0, weeklyBudgetUsd: 0 };
    const total = toNumber(sub.amount_total);
    const totalUsd = quotaToUsd(total);
    const resetPeriod = (sub.quota_reset_period || sub.reset_period || "").toString().toLowerCase();

    let dailyBudgetUsd = 0;
    let weeklyBudgetUsd = 0;

    if (resetPeriod === "daily" || resetPeriod === "day") {
      dailyBudgetUsd = totalUsd;
      weeklyBudgetUsd = totalUsd * 7;
    } else if (resetPeriod === "weekly" || resetPeriod === "week") {
      weeklyBudgetUsd = totalUsd;
      dailyBudgetUsd = totalUsd / 7;
    } else if (resetPeriod === "monthly" || resetPeriod === "month") {
      weeklyBudgetUsd = totalUsd / 4;
      dailyBudgetUsd = totalUsd / 30;
    } else {
      // 不重置或自定义周期：把订阅期内总额度按天/周分摊
      const start = toNumber(sub.start_time);
      const end = toNumber(sub.end_time);
      const span = Math.max(end - start, 86400);
      const days = Math.max(span / 86400, 1);
      dailyBudgetUsd = totalUsd / days;
      weeklyBudgetUsd = (totalUsd / days) * 7;
    }
    return { dailyBudgetUsd, weeklyBudgetUsd };
  };

  // 整合所有响应得到展示用的 data
  const extractUsage = ({ userResponse, dataResponse, logStatResponse, subscriptionResponse }) => {
    if (!userResponse?.success || !userResponse.data) {
      return {
        isValid: false,
        invalidMessage: userResponse?.message || "无法获取账户信息",
      };
    }

    const user = userResponse.data;
    const remainingUsd = quotaToUsd(user.quota);
    const totalUsedUsd = quotaToUsd(user.used_quota);
    const totalRequests = toNumber(user.request_count);

    const { todayStart, weekStart } = computeTimestamps();

    // 数据看板可能失败，失败时今日/本周回落到 0
    const dataRows = dataResponse?.success ? dataResponse.data : [];
    const todayAgg = aggregate(dataRows, todayStart);
    const weekAgg = aggregate(dataRows, weekStart);
    const totalAggInRange = aggregate(dataRows, 0);

    // log/self/stat 给的是最近的 rpm/tpm
    const rpm = toNumber(logStatResponse?.data?.rpm);
    const tpm = toNumber(logStatResponse?.data?.tpm);

    const subscription = extractActiveSubscription(subscriptionResponse);
    const { dailyBudgetUsd, weeklyBudgetUsd } = computeBudgetsFromSubscription(subscription);

    const todayUsedUsd = quotaToUsd(todayAgg.quota);
    const weekUsedUsd = quotaToUsd(weekAgg.quota);

    const status = getStatus(remainingUsd, weeklyBudgetUsd);

    const subscriptionStart = subscription ? formatUnixDate(subscription.start_time) : "-";
    const subscriptionEnd = subscription ? formatUnixDate(subscription.end_time) : "-";

    return {
      isValid: true,
      planName: "AnyRouter",
      unit: "USD",

      // 主指标
      total: weeklyBudgetUsd,
      used: weekUsedUsd,
      remaining: remainingUsd,

      // 用户信息
      userId: toNumber(user.id),
      username: user.username || "-",
      displayName: user.display_name || user.username || "-",
      group: user.group || "default",

      // 数额
      dailyBudgetUsd,
      weeklyBudgetUsd,
      todayUsedUsd,
      weekUsedUsd,
      totalUsedUsd,
      weekRemainingUsd: remainingUsd,
      todayCalls: todayAgg.count,
      todayTokens: todayAgg.tokens,
      weekCalls: weekAgg.count,
      weekTokens: weekAgg.tokens,
      totalRequests,
      totalTokens: totalAggInRange.tokens, // 近 7 天 token 合计（接口未提供历史总量）
      rpm,
      tpm,
      subscriptionStart,
      subscriptionEnd,

      // 状态
      status,
      badgeText: formatBadgeValue(remainingUsd),
      weekUsedRatio: weeklyBudgetUsd > 0 ? clamp01(weekUsedUsd / weeklyBudgetUsd) : 0,

      formatted: {
        dailyBudget: formatUsd(dailyBudgetUsd),
        weeklyBudget: formatUsd(weeklyBudgetUsd),
        todayUsed: formatUsd(todayUsedUsd),
        weekUsed: formatUsd(weekUsedUsd),
        totalUsed: formatUsd(totalUsedUsd),
        weekRemaining: formatUsd(remainingUsd),
        todayCalls: formatCount(todayAgg.count),
        todayTokens: formatToken(todayAgg.tokens),
        weekCalls: formatCount(weekAgg.count),
        totalRequests: formatCount(totalRequests),
        totalTokens: formatToken(totalAggInRange.tokens),
        rpm: formatCount(rpm),
        tpm: formatToken(tpm),
      },
    };
  };

  root.UsageQuota = {
    ANYROUTER_BASE_URL,
    CONFIG_KEY,
    DATA_SELF_PATH,
    LOG_STAT_PATH,
    SUBSCRIPTION_SELF_PATH,
    QUOTA_PER_USD,
    SNAPSHOT_KEY,
    USER_SELF_PATH,
    MAX_RANGE_SECONDS,
    aggregate,
    buildAuthHeaders,
    buildDataUrl,
    buildLogStatUrl,
    buildSubscriptionUrl,
    buildUserUrl,
    computeTimestamps,
    extractUsage,
    formatBadgeValue,
    formatCount,
    formatToken,
    formatUsd,
    formatUnixDate,
    hasValidConfig,
    normalizeAccessToken,
    normalizeSiteUrl,
    normalizeUserId,
    quotaToUsd,
    toNumber,
    toNumberOrNull,
  };
})(globalThis);
