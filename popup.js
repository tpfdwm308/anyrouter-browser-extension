const $ = (id) => document.getElementById(id);

const el = {
  accessTokenInput:  $("accessTokenInput"),
  alertBox:          $("alertBox"),
  badgePreview:      $("badgePreview"),
  cancelKeyBtn:      $("cancelKeyBtn"),
  configForm:        $("configForm"),
  dailyBudget:       $("dailyBudget"),
  emptyState:        $("emptyState"),
  keyModal:          $("keyModal"),
  openKeyBtn:        $("openKeyBtn"),
  refreshButton:     $("refreshButton"),
  remainingValue:    $("remainingValue"),
  rpm:               $("rpm"),
  statusLabel:       $("statusLabel"),
  summaryView:       $("summaryView"),
  todayCalls:        $("todayCalls"),
  todayTokens:       $("todayTokens"),
  todayUsed:         $("todayUsed"),
  totalRequests:     $("totalRequests"),
  totalTokens:       $("totalTokens"),
  totalUsed:         $("totalUsed"),
  updatedAt:         $("updatedAt"),
  usageBar:          $("usageBar"),
  userIdInput:       $("userIdInput"),
  weekBudget:        $("weekBudget"),
  weekCalls:         $("weekCalls"),
  weekPercent:       $("weekPercent"),
  weekUsed:          $("weekUsed"),
};

const storageGet = (keys) =>
  new Promise((resolve) => chrome.storage.local.get(keys, resolve));

const storageSet = (items) =>
  new Promise((resolve) => chrome.storage.local.set(items, resolve));

const sendMessage = (message) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(response);
    });
  });

const set = (element, value) => { element.textContent = value ?? "-"; };

const formatUpdatedAt = (timestamp) => {
  if (!timestamp) return "未刷新";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  });
};

const showAlert = (message) => {
  el.alertBox.hidden = !message;
  el.alertBox.textContent = message || "";
};

const setTone = (tone) => {
  document.body.className = `tone-${tone || "idle"}`;
};

const openKeyModal = async () => {
  const result = await storageGet(UsageQuota.CONFIG_KEY);
  const config = result[UsageQuota.CONFIG_KEY] || {};
  el.userIdInput.value = config.userId ? String(config.userId) : "";
  el.accessTokenInput.value = config.accessToken || "";
  el.keyModal.hidden = false;
  if (!el.userIdInput.value) {
    el.userIdInput.focus();
  } else {
    el.accessTokenInput.focus();
    el.accessTokenInput.select();
  }
};

const closeKeyModal = () => {
  el.keyModal.hidden = true;
};

const renderUnconfigured = (message) => {
  setTone("idle");
  set(el.statusLabel, "未配置");
  el.summaryView.hidden = true;
  el.emptyState.hidden = false;
  showAlert(message || "");
};

const renderSnapshot = (snapshot, config) => {
  if (!UsageQuota.hasValidConfig(config)) {
    renderUnconfigured();
    return;
  }

  if (snapshot?.state === "unconfigured") {
    renderUnconfigured(snapshot.errorMessage || "");
    return;
  }

  el.emptyState.hidden = true;

  if (!snapshot?.data) {
    setTone(snapshot?.state === "error" ? "error" : "idle");
    set(el.statusLabel, snapshot?.state === "error" ? "查询失败" : "等待刷新");
    el.summaryView.hidden = true;
    showAlert(snapshot?.errorMessage || "保存凭据后点击刷新，获取额度数据。");
    return;
  }

  const data = snapshot.data;
  const isStale = snapshot.state === "stale";
  const tone = isStale ? "stale" : data.status.tone;

  setTone(tone);
  set(el.statusLabel, isStale ? "数据过期" : data.status.label);
  showAlert(isStale ? `刷新失败：${snapshot.errorMessage || "请稍后重试"}` : "");

  el.summaryView.hidden = false;

  set(el.remainingValue,    data.formatted.weekRemaining);
  set(el.badgePreview,      data.badgeText);
  set(el.weekUsed,          data.formatted.weekUsed);
  set(el.weekBudget,        data.formatted.weeklyBudget);
  set(el.todayUsed,         data.formatted.todayUsed);
  set(el.todayCalls,        data.formatted.todayCalls);
  set(el.todayTokens,       data.formatted.todayTokens);
  set(el.dailyBudget,       data.formatted.dailyBudget);
  set(el.weekCalls,         data.formatted.weekCalls);
  set(el.totalRequests,     data.formatted.totalRequests);
  set(el.totalUsed,         data.formatted.totalUsed);
  set(el.totalTokens,       data.formatted.totalTokens);
  set(el.rpm,               data.formatted.rpm);
  set(el.updatedAt,         formatUpdatedAt(snapshot.updatedAt));

  const pct = Math.round(data.weekUsedRatio * 100);
  el.usageBar.style.transform = `scaleX(${data.weekUsedRatio})`;
  set(el.weekPercent, `${pct}%`);
};

const loadState = async () => {
  try {
    const state = await sendMessage({ type: "getUsageState" });
    renderSnapshot(state?.snapshot, state?.config || {});
  } catch (error) {
    const result = await storageGet([UsageQuota.CONFIG_KEY, UsageQuota.SNAPSHOT_KEY]);
    const config = result[UsageQuota.CONFIG_KEY] || {};
    renderSnapshot(result[UsageQuota.SNAPSHOT_KEY], config);
    showAlert(error.message || "无法连接后台，请重新打开面板。");
  }
};

const refreshUsage = async () => {
  el.refreshButton.disabled = true;
  el.refreshButton.classList.add("spinning");
  try {
    const snapshot = await sendMessage({ type: "refreshUsage" });
    const result = await storageGet(UsageQuota.CONFIG_KEY);
    renderSnapshot(snapshot, result[UsageQuota.CONFIG_KEY] || {});
  } catch (error) {
    showAlert(error.message || "刷新失败");
  } finally {
    el.refreshButton.disabled = false;
    el.refreshButton.classList.remove("spinning");
  }
};

el.openKeyBtn.addEventListener("click", openKeyModal);
el.cancelKeyBtn.addEventListener("click", closeKeyModal);

el.keyModal.addEventListener("click", (e) => {
  if (e.target === el.keyModal) closeKeyModal();
});

el.configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const userId = UsageQuota.normalizeUserId(el.userIdInput.value);
  const accessToken = UsageQuota.normalizeAccessToken(el.accessTokenInput.value);

  if (!userId) {
    el.userIdInput.focus();
    showAlert("请输入有效的用户 ID");
    return;
  }
  if (!accessToken) {
    el.accessTokenInput.focus();
    showAlert("请输入 Access Token");
    return;
  }

  const config = {
    userId,
    accessToken,
    refreshMinutes: 1,
  };
  await storageSet({ [UsageQuota.CONFIG_KEY]: config });
  closeKeyModal();
  showAlert("");
  await refreshUsage();
});

el.refreshButton.addEventListener("click", refreshUsage);

loadState();
