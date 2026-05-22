const defaults = {
  voice: "zh-CN-YunjianNeural",
  rate: "-5%",
  pause_ms: "1000",
};

const form = document.querySelector("#settingsForm");

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem("docToVoiceSettings") || "{}");
  return { ...defaults, ...saved };
}

function applySettings() {
  const settings = loadSettings();
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements[key];
    if (field) field.value = value;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const settings = Object.fromEntries(new FormData(form).entries());
  localStorage.setItem("docToVoiceSettings", JSON.stringify(settings));
  window.location.href = "/";
});

applySettings();
