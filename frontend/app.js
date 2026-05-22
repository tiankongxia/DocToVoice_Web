const form = document.querySelector("#jobForm");
const primary = document.querySelector("#submitButton");
const cancelButton = document.querySelector("#cancelButton");
const urlInput = document.querySelector("#url");
const clearUrlButton = document.querySelector("#clearUrlButton");
const jobMessage = document.querySelector("#jobMessage");
const results = document.querySelector("#results");
const infoModal = document.querySelector("#infoModal");
const infoGrid = document.querySelector("#infoGrid");
const infoClose = document.querySelector("#infoClose");
const deleteModal = document.querySelector("#deleteModal");
const deleteClose = document.querySelector("#deleteClose");
const deleteCancel = document.querySelector("#deleteCancel");
const deleteConfirm = document.querySelector("#deleteConfirm");
const deleteFileName = document.querySelector("#deleteFileName");
const API_BASE = window.API_BASE_URL || "";
const EASTERN_TIME_ZONE = "America/New_York";
let activeJobId = null;
let activeSource = null;
let pendingDeleteFile = null;
let currentAudio = null;
const defaults = {
  voice: "zh-CN-YunjianNeural",
  rate: "-5%",
  pause_ms: "1000",
};

function getSettings() {
  const saved = JSON.parse(localStorage.getItem("docToVoiceSettings") || "{}");
  return { ...defaults, ...saved };
}

function applySettingsToForm() {
  const settings = getSettings();
  form.elements.voice.value = settings.voice;
  form.elements.rate.value = settings.rate;
  form.elements.pause_ms.value = settings.pause_ms;
}

function setButtonProgress(value) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  primary.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>生成中 ${Math.round(safe)}%</span>`;
}

function renderFiles(files) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  results.innerHTML = "";
  for (const file of (files || []).filter((item) => item.type === "audio")) {
    const item = document.createElement("div");
    item.className = "result-item";

    const main = document.createElement("div");
    main.className = "file-main";

    const name = document.createElement("strong");
    name.className = "file-name";
    name.textContent = file.name;
    name.title = file.name;
    main.append(name);

    if (Number.isFinite(file.modifiedAt)) {
      const timeCode = document.createElement("span");
      timeCode.className = "file-time-code";
      timeCode.textContent = formatDate(file.modifiedAt);
      main.append(timeCode);
    }

    item.append(main);

    const actions = document.createElement("div");
    actions.className = "file-actions";

    const infoButton = document.createElement("button");
    infoButton.className = "icon-button";
    infoButton.type = "button";
    infoButton.title = "文件信息";
    infoButton.setAttribute("aria-label", "文件信息");
    infoButton.dataset.icon = "info";
    infoButton.addEventListener("click", () => showFileInfo(file));
    actions.append(infoButton);

    const downloadButton = document.createElement("button");
    downloadButton.className = "icon-button";
    downloadButton.type = "button";
    downloadButton.title = "下载";
    downloadButton.setAttribute("aria-label", "下载");
    downloadButton.dataset.icon = "download";
    downloadButton.addEventListener("click", () => downloadOrShareAudio(file));
    actions.append(downloadButton);

    if (file.deleteUrl) {
      const deleteButton = document.createElement("button");
      deleteButton.className = "icon-button danger";
      deleteButton.type = "button";
      deleteButton.title = "删除";
      deleteButton.setAttribute("aria-label", "删除");
      deleteButton.dataset.icon = "trash";
      deleteButton.addEventListener("click", () => deleteAudio(file));
      actions.append(deleteButton);
    }

    item.append(actions);

    item.append(createAudioPlayer(file));

    results.append(item);
  }
}

function createAudioPlayer(file) {
  const audio = new Audio(fileUrl(file));
  audio.preload = "metadata";

  const player = document.createElement("div");
  player.className = "audio-player";

  const toggle = document.createElement("button");
  toggle.className = "icon-button player-toggle";
  toggle.type = "button";
  toggle.dataset.icon = "play";
  toggle.title = "播放";
  toggle.setAttribute("aria-label", "播放");

  const progress = document.createElement("input");
  progress.className = "audio-progress";
  progress.type = "range";
  progress.min = "0";
  progress.max = "1000";
  progress.step = "1";
  progress.value = "0";
  progress.setAttribute("aria-label", "播放进度");
  progress.style.setProperty("--progress", "0%");

  const time = document.createElement("span");
  time.className = "audio-time";

  let duration = Number.isFinite(file.duration) ? file.duration : NaN;
  let isSeeking = false;

  function setToggleState(isPlaying) {
    toggle.dataset.icon = isPlaying ? "pause" : "play";
    toggle.title = isPlaying ? "暂停" : "播放";
    toggle.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
  }

  function setProgress(percent) {
    const safe = Math.max(0, Math.min(100, percent || 0));
    progress.value = String(Math.round(safe * 10));
    progress.style.setProperty("--progress", `${safe}%`);
  }

  function setTime(current = audio.currentTime) {
    time.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
  }

  setTime(0);

  toggle.addEventListener("click", async () => {
    if (audio.paused) {
      if (currentAudio && currentAudio !== audio) currentAudio.pause();
      currentAudio = audio;
      try {
        await audio.play();
      } catch {
        setToggleState(false);
      }
      return;
    }
    audio.pause();
  });

  progress.addEventListener("input", () => {
    if (!Number.isFinite(duration) || duration <= 0) return;
    isSeeking = true;
    const percent = Number(progress.value) / 1000;
    const previewTime = duration * percent;
    progress.style.setProperty("--progress", `${percent * 100}%`);
    setTime(previewTime);
  });

  progress.addEventListener("change", () => {
    if (!Number.isFinite(duration) || duration <= 0) return;
    audio.currentTime = duration * (Number(progress.value) / 1000);
    isSeeking = false;
    setTime();
  });

  audio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(audio.duration)) duration = audio.duration;
    setTime();
  });

  audio.addEventListener("timeupdate", () => {
    if (isSeeking) return;
    if (Number.isFinite(duration) && duration > 0) {
      setProgress((audio.currentTime / duration) * 100);
    }
    setTime();
  });

  audio.addEventListener("play", () => setToggleState(true));
  audio.addEventListener("pause", () => setToggleState(false));
  audio.addEventListener("ended", () => {
    setToggleState(false);
    currentAudio = null;
  });
  audio.addEventListener("error", () => {
    jobMessage.textContent = "音频加载失败";
    jobMessage.classList.add("error");
    setToggleState(false);
  });

  player.append(toggle, progress, time);
  return player;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "未知";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(seconds) {
  if (!Number.isFinite(seconds)) return "未知";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(seconds * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} 美东`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "未知";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function showFileInfo(file) {
  const rows = [
    ["文件名", file.name],
    ["生成时间", formatDate(file.modifiedAt)],
    ["文件尺寸", formatFileSize(file.size)],
    ["音频长度", formatDuration(file.duration)],
  ];
  infoGrid.innerHTML = rows
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  infoModal.classList.remove("hidden");
}

function hideFileInfo() {
  infoModal.classList.add("hidden");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fileUrl(file) {
  return file.url.startsWith("/") ? `${API_BASE}${file.url}` : file.url;
}

function isMobileDevice() {
  return window.matchMedia("(pointer: coarse)").matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

async function downloadOrShareAudio(file) {
  const url = fileUrl(file);
  jobMessage.classList.remove("error");
  jobMessage.textContent = "正在准备音频…";
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("下载失败");
    const blob = await response.blob();
    const audioFile = new File([blob], file.name, { type: "audio/mpeg" });

    if (isMobileDevice() && navigator.canShare?.({ files: [audioFile] })) {
      await navigator.share({
        files: [audioFile],
        title: file.name,
      });
      jobMessage.textContent = "";
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    jobMessage.textContent = "";
  } catch (error) {
    if (error?.name === "AbortError" || /abort/i.test(error?.message || "")) {
      jobMessage.textContent = "";
      jobMessage.classList.remove("error");
      return;
    }
    jobMessage.textContent = error.message || "下载失败";
    jobMessage.classList.add("error");
  }
}

async function loadAudioList() {
  try {
    const response = await fetch(`${API_BASE}/api/audio`);
    const payload = await response.json();
    if (response.ok) {
      renderFiles(payload.files || []);
    }
  } catch {
    // The generator can still work if the list request fails.
  }
}

async function deleteAudio(file) {
  if (!file.deleteUrl) return;
  pendingDeleteFile = file;
  deleteFileName.textContent = file.name;
  deleteModal.classList.remove("hidden");
}

function hideDeleteConfirm() {
  deleteModal.classList.add("hidden");
  pendingDeleteFile = null;
}

async function confirmDeleteAudio() {
  const file = pendingDeleteFile;
  if (!file?.deleteUrl) return;
  deleteConfirm.disabled = true;
  try {
    const response = await fetch(`${API_BASE}${file.deleteUrl}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "删除失败");
    }
    hideDeleteConfirm();
    renderFiles(payload.files || []);
  } catch (error) {
    jobMessage.textContent = error.message;
    jobMessage.classList.add("error");
  } finally {
    deleteConfirm.disabled = false;
  }
}

function updateSubmitState() {
  const hasUrl = !!urlInput.value.trim();
  primary.disabled = !hasUrl || !!activeJobId;
  clearUrlButton.classList.toggle("hidden", !hasUrl);
}

function resetRunState(label = "开始生成") {
  activeJobId = null;
  if (activeSource) {
    activeSource.close();
    activeSource = null;
  }
  primary.textContent = label;
  cancelButton.classList.add("hidden");
  updateSubmitState();
}

urlInput.addEventListener("input", updateSubmitState);

clearUrlButton.addEventListener("click", () => {
  urlInput.value = "";
  updateSubmitState();
  urlInput.focus();
});

cancelButton.addEventListener("click", async () => {
  if (!activeJobId) return;
  const jobId = activeJobId;
  jobMessage.textContent = "正在取消…";
  resetRunState();
  try {
    await fetch(`${API_BASE}/api/jobs/${jobId}/cancel`, { method: "POST" });
  } catch {
    jobMessage.textContent = "已停止等待，后台任务可能稍后结束。";
  }
});

infoClose.addEventListener("click", hideFileInfo);
deleteClose.addEventListener("click", hideDeleteConfirm);
deleteCancel.addEventListener("click", hideDeleteConfirm);
deleteConfirm.addEventListener("click", confirmDeleteAudio);

infoModal.addEventListener("click", (event) => {
  if (event.target === infoModal) {
    hideFileInfo();
  }
});

deleteModal.addEventListener("click", (event) => {
  if (event.target === deleteModal) {
    hideDeleteConfirm();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !infoModal.classList.contains("hidden")) {
    hideFileInfo();
  }
  if (event.key === "Escape" && !deleteModal.classList.contains("hidden")) {
    hideDeleteConfirm();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!urlInput.value.trim() || activeJobId) return;
  applySettingsToForm();
  setButtonProgress(0);
  jobMessage.textContent = "";
  primary.disabled = true;
  cancelButton.classList.remove("hidden");

  try {
    const response = await fetch(`${API_BASE}/api/jobs`, {
      method: "POST",
      body: new FormData(form),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "任务创建失败");
    }

    activeJobId = payload.id;
    const source = new EventSource(`${API_BASE}/api/jobs/${payload.id}/events`);
    activeSource = source;
    source.onmessage = (message) => {
      const data = JSON.parse(message.data);
      jobMessage.textContent = data.error || data.message || "";
      jobMessage.classList.toggle("error", data.status === "error");
      setButtonProgress(data.progress);
      if (data.files?.length) {
        renderFiles(data.files);
      }
      if (data.status === "done") {
        loadAudioList();
        resetRunState();
      } else if (data.status === "error") {
        resetRunState("重新生成");
      } else if (data.status === "cancelled") {
        jobMessage.textContent = "已取消";
        resetRunState();
      }
    };
    source.onerror = () => {
      jobMessage.textContent = "连接中断，可以刷新后重新查看。";
      resetRunState("重新生成");
    };
  } catch (error) {
    jobMessage.textContent = error.message;
    jobMessage.classList.add("error");
    resetRunState("重新生成");
  }
});

updateSubmitState();
loadAudioList();
