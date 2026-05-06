const form = document.querySelector("#jobForm");
const primary = document.querySelector(".primary");
const pasteButton = document.querySelector("#pasteButton");
const urlInput = document.querySelector("#url");
const serverState = document.querySelector("#serverState");
const jobTitle = document.querySelector("#jobTitle");
const jobMessage = document.querySelector("#jobMessage");
const progressText = document.querySelector("#progressText");
const progressBar = document.querySelector("#progressBar");
const results = document.querySelector("#results");
const API_BASE = window.API_BASE_URL || "";
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

function setProgress(value) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  progressText.textContent = `${Math.round(safe)}%`;
  progressBar.style.width = `${safe}%`;
}

function renderFiles(files) {
  results.innerHTML = "";
  for (const file of files || []) {
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

    if (file.type === "audio") {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = file.url.startsWith("/") ? `${API_BASE}${file.url}` : file.url;
      item.append(audio);
    }

    results.append(item);
  }
}

pasteButton.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text.trim();
    urlInput.focus();
  } catch {
    urlInput.focus();
    jobMessage.textContent = "浏览器没有允许读取剪贴板，请手动粘贴。";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  applySettingsToForm();
  results.innerHTML = "";
  setProgress(0);
  serverState.textContent = "提交中";
  jobTitle.textContent = "正在创建任务";
  jobMessage.textContent = "稍等一下。";
  primary.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/api/jobs`, {
      method: "POST",
      body: new FormData(form),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "任务创建失败");
    }

    serverState.textContent = "生成中";
    const source = new EventSource(`${API_BASE}/api/jobs/${payload.id}/events`);
    source.onmessage = (message) => {
      const data = JSON.parse(message.data);
      jobTitle.textContent = data.title || "朗读";
      jobMessage.textContent = data.error || data.message || "";
      jobMessage.classList.toggle("error", data.status === "error");
      setProgress(data.progress);
      if (data.files?.length) {
        renderFiles(data.files);
      }
      if (data.status === "done" || data.status === "error") {
        serverState.textContent = data.status === "done" ? "完成" : "出错";
        primary.disabled = false;
        source.close();
      }
    };
    source.onerror = () => {
      jobMessage.textContent = "连接中断，可以刷新后重新查看。";
      serverState.textContent = "连接中断";
      primary.disabled = false;
      source.close();
    };
  } catch (error) {
    jobMessage.textContent = error.message;
    jobMessage.classList.add("error");
    serverState.textContent = "出错";
    primary.disabled = false;
  }
});
