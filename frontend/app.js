const form = document.querySelector("#jobForm");
const primary = document.querySelector("#submitButton");
const cancelButton = document.querySelector("#cancelButton");
const pasteButton = document.querySelector("#pasteButton");
const urlInput = document.querySelector("#url");
const jobMessage = document.querySelector("#jobMessage");
const results = document.querySelector("#results");
const API_BASE = window.API_BASE_URL || "";
let activeJobId = null;
let activeSource = null;
const defaults = {
  voice: "zh-CN-YunjianNeural",
  rate: "-5%",
  pause_ms: "1000",
  split_mode: "none",
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
  form.elements.max_chars.value = settings.split_mode === "auto" ? "5000" : "1000000";
}

function setButtonProgress(value) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  primary.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>生成中 ${Math.round(safe)}%</span>`;
}

function renderFiles(files) {
  results.innerHTML = "";
  for (const file of (files || []).filter((item) => item.type === "audio")) {
    const item = document.createElement("div");
    item.className = "result-item";

    const name = document.createElement("strong");
    name.textContent = file.name;
    item.append(name);

    const link = document.createElement("a");
    link.href = file.url.startsWith("/") ? `${API_BASE}${file.url}` : file.url;
    link.download = file.name;
    link.textContent = "下载";
    item.append(link);

    if (file.deleteUrl) {
      const deleteButton = document.createElement("button");
      deleteButton.className = "delete-button";
      deleteButton.type = "button";
      deleteButton.textContent = "删除";
      deleteButton.addEventListener("click", () => deleteAudio(file));
      item.append(deleteButton);
    }

    if (file.type === "audio") {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = file.url.startsWith("/") ? `${API_BASE}${file.url}` : file.url;
      item.append(audio);
    }

    results.append(item);
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
  try {
    const response = await fetch(`${API_BASE}${file.deleteUrl}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "删除失败");
    }
    renderFiles(payload.files || []);
  } catch (error) {
    jobMessage.textContent = error.message;
    jobMessage.classList.add("error");
  }
}

pasteButton.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text.trim();
    updateSubmitState();
    urlInput.focus();
  } catch {
    urlInput.focus();
    jobMessage.textContent = "浏览器没有允许读取剪贴板，请手动粘贴。";
  }
});

function updateSubmitState() {
  primary.disabled = !urlInput.value.trim() || !!activeJobId;
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!urlInput.value.trim() || activeJobId) return;
  applySettingsToForm();
  results.innerHTML = "";
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
        resetRunState("再生成一次");
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
