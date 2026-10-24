const API = "http://localhost:3000/api";
const $ = (id) => document.getElementById(id);

const userId = getUserId();

let currentError = "";
let currentCode = "";
let currentLanguage = "Auto-detect";
let previousAnswer = "";
let isAnalyzing = false;

const defaultPreferences = {
  answerStyle: "short",
  explanationLevel: "beginner",
  language: "Auto-detect"
};

let preferences = loadLocalPreferences();

function getUserId() {
  let id = localStorage.getItem("errorBuddyUserId");

  if (!id) {
    id = "user-" + crypto.randomUUID();
    localStorage.setItem("errorBuddyUserId", id);
  }

  return id;
}

function loadLocalPreferences() {
  try {
    return {
      ...defaultPreferences,
      ...JSON.parse(
        localStorage.getItem("errorBuddyPreferences") || "{}"
      )
    };
  } catch {
    return { ...defaultPreferences };
  }
}

async function apiRequest(url, options = {}) {
  const response = await fetch(API + url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.message || "Request failed.");
  }

  return data;
}

function showStatus(message, isError = false) {
  const status = $("status");

  if (!status) return;

  status.textContent = message;
  status.style.color = isError ? "#FF8A8A" : "";
}

function showSettingsStatus(message, isError = false) {
  const status = $("settingsStatus");

  if (!status) return;

  status.textContent = message;
  status.style.color = isError ? "#FF8A8A" : "";
}

function showPanel(panelId) {
  ["workspace", "settingsPanel", "historyPanel"].forEach(id => {
    $(id)?.classList.toggle("hidden", id !== panelId);
  });

  showStatus("");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// Render simple Markdown safely.
function formatAnswer(value) {
  let text = escapeHTML(value);

  text = text.replace(/```(?:[\w#+.-]+)?\s*\n?([\s\S]*?)```/g,
    (_, code) => `<pre><code>${code.trim()}</code></pre>`
  );

  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\n/g, "<br>");

  return text;
}

function setBadge(id, label, level = "") {
  const element = $(id);

  if (!element) return;

  element.textContent = label;

  if (level) {
    element.dataset.level = level;
  } else {
    delete element.dataset.level;
  }
}

function detectSeverity(error) {
  const text = error.toLowerCase();

  if (/security breach|data loss|production down|fatal error/.test(text)) {
    return "critical";
  }

  if (/uncaught exception|segmentation fault|fatal|crash/.test(text)) {
    return "high";
  }

  if (/typeerror|referenceerror|syntaxerror|exception|failed/.test(text)) {
    return "medium";
  }

  return "low";
}

function updateAnswerUI(data, isFollowUp = false) {
  const answer =
    data.answer ??
    data.response ??
    data.analysis ??
    data.message ??
    (typeof data === "string" ? data : "");

  if (!answer) {
    throw new Error("The server returned an empty answer.");
  }

  previousAnswer = answer;

  $("answer").innerHTML = formatAnswer(answer);
  $("answerSection").classList.remove("hidden");

  const severity = String(
    data.severity || detectSeverity(currentError)
  ).toLowerCase();

  const validLevels = ["critical", "high", "medium", "low"];
  const safeSeverity = validLevels.includes(severity)
    ? severity
    : "medium";

  setBadge(
    "severityBadge",
    "Severity: " + safeSeverity.toUpperCase(),
    safeSeverity
  );

  // Only display a confidence score if the backend actually supplies one.
  const confidence = data.confidence;

  if (confidence !== undefined && confidence !== null) {
    let confidenceText;

    if (typeof confidence === "number") {
      confidenceText =
        Math.round(confidence <= 1 ? confidence * 100 : confidence) + "%";
    } else {
      confidenceText = String(confidence);
    }

    setBadge("confidenceBadge", "Confidence: " + confidenceText);
  } else {
    setBadge("confidenceBadge", "Confidence: Not provided");
  }

  $("answerMeta").textContent =
    `${preferences.answerStyle === "short" ? "Short answer" : "Detailed answer"} · ` +
    `${preferences.explanationLevel === "beginner" ? "Beginner-friendly" : "Technical"} · ` +
    currentLanguage;

  $("preventionTip").textContent =
    data.preventionTip ||
    data.prevention ||
    "Check the cause of the error and test your code after applying the fix.";

  showStatus(isFollowUp ? "Follow-up answered." : "Analysis complete.");
}

function getSelectedPreferences() {
  return {
    answerStyle: $("answerStyle").value,
    explanationLevel: $("explanationLevel").value,
    language: $("language").value
  };
}

async function savePreferences() {
  preferences = getSelectedPreferences();

  localStorage.setItem(
    "errorBuddyPreferences",
    JSON.stringify(preferences)
  );

  try {
    await apiRequest(`/preferences/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify(preferences)
    });

    showSettingsStatus("Preferences saved!");
  } catch (error) {
    // Local preferences still work if the database is unavailable.
    showSettingsStatus(
      "Saved on this browser. Server sync unavailable.",
      false
    );
  }

  currentLanguage = preferences.language;
}

async function loadPreferences() {
  $("answerStyle").value = preferences.answerStyle;
  $("explanationLevel").value = preferences.explanationLevel;
  $("language").value = preferences.language;

  try {
    const data = await apiRequest(
      `/preferences/${encodeURIComponent(userId)}`
    );

    const saved = data.preferences || data;

    preferences = {
      ...preferences,
      ...(saved.answerStyle ? { answerStyle: saved.answerStyle } : {}),
      ...(saved.explanationLevel
        ? { explanationLevel: saved.explanationLevel }
        : {}),
      ...(saved.language ? { language: saved.language } : {})
    };

    localStorage.setItem(
      "errorBuddyPreferences",
      JSON.stringify(preferences)
    );
  } catch {
    // Use local preferences when the server or database is unavailable.
  }

  $("answerStyle").value = preferences.answerStyle;
  $("explanationLevel").value = preferences.explanationLevel;
  $("language").value = preferences.language;
}

async function analyzeError(event) {
  event?.preventDefault();

  if (isAnalyzing) return;

  const error = $("errorText").value.trim();

  if (!error) {
    showStatus("Please paste an error first.", true);
    $("errorText").focus();
    return;
  }

  currentError = error;
  currentCode = $("codeText").value.trim();
  currentLanguage = $("analysisLanguage").value;

  if (currentLanguage === "Auto-detect") {
    currentLanguage = preferences.language;
  }

  previousAnswer = "";
  isAnalyzing = true;

  $("analyzeBtn").disabled = true;
  $("analyzeBtn").textContent = "Analyzing...";
  $("answerSection").classList.remove("hidden");

  $("answer").textContent = "Gemma is analyzing your error...";
  setBadge("severityBadge", "Severity: Analyzing");
  setBadge("confidenceBadge", "Confidence: Pending");
  showStatus("Analyzing your error...");

  try {
    const data = await apiRequest("/analyze", {
      method: "POST",
      body: JSON.stringify({
        userId,
        error: currentError,
        code: currentCode,
        language: currentLanguage,
        preferences,
        answerStyle: preferences.answerStyle,
        explanationLevel: preferences.explanationLevel
      })
    });

    updateAnswerUI(data);
  } catch (error) {
    $("answer").textContent = "";
    $("answerSection").classList.add("hidden");
    showStatus(error.message || "Could not analyze the error.", true);
  } finally {
    isAnalyzing = false;
    $("analyzeBtn").disabled = false;
    $("analyzeBtn").textContent = "Explain error ↗";
  }
}

async function askFollowUp(event) {
  event.preventDefault();

  const question = $("followUpInput").value.trim();

  if (!question) return;

  if (!currentError) {
    showStatus("Analyze an error before asking a follow-up.", true);
    return;
  }

  if (isAnalyzing) return;

  isAnalyzing = true;
  $("followUpBtn").disabled = true;
  $("followUpBtn").textContent = "Thinking...";

  showStatus("Thinking about your follow-up...");

  try {
    const data = await apiRequest("/analyze", {
      method: "POST",
      body: JSON.stringify({
        userId,
        error: currentError,
        code: currentCode,
        language: currentLanguage,
        preferences,
        answerStyle: preferences.answerStyle,
        explanationLevel: preferences.explanationLevel,
        followUp: question,
        previousAnswer
      })
    });

    updateAnswerUI(data, true);
    $("followUpInput").value = "";
  } catch (error) {
    showStatus(error.message || "Could not answer the follow-up.", true);
  } finally {
    isAnalyzing = false;
    $("followUpBtn").disabled = false;
    $("followUpBtn").textContent = "Ask ↗";
  }
}

function clearAnalysis() {
  currentError = "";
  currentCode = "";
  currentLanguage = preferences.language;
  previousAnswer = "";

  $("errorText").value = "";
  $("codeText").value = "";
  $("followUpInput").value = "";

  $("answerSection").classList.add("hidden");

  showStatus("");
  $("errorText").focus();
  updateErrorCount();
}

function updateErrorCount() {
  $("errorCount").textContent =
    `${$("errorText").value.length} / 12000`;
}

async function pasteError() {
  try {
    const text = await navigator.clipboard.readText();

    if (!text) {
      showStatus("Your clipboard is empty.");
      return;
    }

    $("errorText").value = text.slice(0, 12000);
    updateErrorCount();
    $("errorText").focus();

    showStatus("Error pasted from clipboard.");
  } catch {
    showStatus(
      "Clipboard access was blocked. Click the error box and press Ctrl+V.",
      true
    );
    $("errorText").focus();
  }
}

async function copyAnswer() {
  const text = $("answer").innerText.trim();

  if (!text) {
    showStatus("There is no answer to copy.", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showStatus("Answer copied!");
  } catch {
    showStatus("Copy failed. Select the answer and copy it manually.", true);
  }
}

async function loadHistory() {
  const list = $("historyList");
  list.replaceChildren();

  const loading = document.createElement("p");
  loading.className = "muted";
  loading.textContent = "Loading recent errors...";
  list.appendChild(loading);

  try {
    const data = await apiRequest(
      `/history/${encodeURIComponent(userId)}`
    );

    const history = Array.isArray(data)
      ? data
      : data.history || data.errors || [];

    list.replaceChildren();

    if (!history.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No saved errors yet.";
      list.appendChild(empty);
      return;
    }

    history.forEach(item => {
      const container = document.createElement("div");
      container.className = "history-item";

      const title = document.createElement("h3");
      title.textContent = item.error || item.title || "Previous error";

      const preview = document.createElement("p");
      preview.textContent = item.answer || item.response || "";

      const reopen = document.createElement("button");
      reopen.type = "button";
      reopen.className = "secondary";
      reopen.textContent = "Reopen error";

      reopen.addEventListener("click", () => {
        $("errorText").value = item.error || "";
        $("codeText").value = item.code || "";
        $("analysisLanguage").value = item.language || "Auto-detect";

        currentError = item.error || "";
        currentCode = item.code || "";
        currentLanguage = item.language || "Auto-detect";
        previousAnswer = item.answer || item.response || "";

        if (previousAnswer) {
          updateAnswerUI({
            answer: previousAnswer,
            severity: item.severity,
            confidence: item.confidence,
            preventionTip: item.preventionTip
          });
        }

        updateErrorCount();
        showPanel("workspace");
      });

      container.append(title, preview, reopen);
      list.appendChild(container);
    });
  } catch {
    list.replaceChildren();

    const message = document.createElement("p");
    message.className = "muted";
    message.textContent =
      "Could not load history. Check your server and database connection.";

    list.appendChild(message);
  }
}

// Navigation
$("newChatBtn").addEventListener("click", () => {
  clearAnalysis();
  showPanel("workspace");
});

$("historyBtn").addEventListener("click", async () => {
  showPanel("historyPanel");
  await loadHistory();
});

$("settingsBtn").addEventListener("click", () => {
  showPanel("settingsPanel");
  showSettingsStatus("");
});

$("backBtn").addEventListener("click", () => showPanel("workspace"));
$("historyBackBtn").addEventListener("click", () => showPanel("workspace"));

// Forms and buttons
$("analyzeForm").addEventListener("submit", analyzeError);
$("followUpForm").addEventListener("submit", askFollowUp);
$("saveSettingsBtn").addEventListener("click", savePreferences);
$("pasteErrorBtn").addEventListener("click", pasteError);
$("clearAnalysisBtn").addEventListener("click", clearAnalysis);
$("copyAnswerBtn").addEventListener("click", copyAnswer);

$("errorText").addEventListener("input", updateErrorCount);

// Keyboard shortcuts
document.addEventListener("keydown", event => {
  const active = document.activeElement;
  const typingInInput =
    active &&
    ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);

  if (
    event.ctrlKey &&
    !event.shiftKey &&
    event.key === "Enter"
  ) {
    event.preventDefault();

    if (!$("workspace").classList.contains("hidden")) {
      analyzeError(event);
    }
  }

  if (
    event.ctrlKey &&
    event.shiftKey &&
    event.key.toLowerCase() === "v"
  ) {
    event.preventDefault();
    pasteError();
  }

  if (
    event.key === "Escape" &&
    active === $("followUpInput")
  ) {
    $("followUpInput").value = "";
    showStatus("");
  }
});

// Keep the language selector and saved preference in sync.
$("language").addEventListener("change", () => {
  preferences.language = $("language").value;
  localStorage.setItem(
    "errorBuddyPreferences",
    JSON.stringify(preferences)
  );
});

$("analysisLanguage").addEventListener("change", () => {
  currentLanguage = $("analysisLanguage").value;
});

// Initialize
(async function init() {
  updateErrorCount();
  await loadPreferences();

  $("analysisLanguage").value = preferences.language;

  showPanel("workspace");
})();
