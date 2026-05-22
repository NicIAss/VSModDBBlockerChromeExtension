const DEFAULT_SETTINGS = {
  blockedAuthors: [],
  blockedMods: [],
  blockedKeywords: [],
  blockedTags: [],
  allowedKeywords: [],
  hideMode: "fade",
  debugScanMode: "normal"
};

function linesToList(value) {
  return value
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

function listToLines(list) {
  return Array.isArray(list) ? list.join("\n") : "";
}

function showStatus(message) {
  const status = document.getElementById("status");
  status.textContent = message;
  setTimeout(() => {
    status.textContent = "";
  }, 2200);
}

async function loadSettings() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);

  document.getElementById("authors").value = listToLines(data.blockedAuthors);
  document.getElementById("mods").value = listToLines(data.blockedMods);
  document.getElementById("keywords").value = listToLines(data.blockedKeywords);
  document.getElementById("tags").value = listToLines(data.blockedTags);
  document.getElementById("allowedKeywords").value = listToLines(data.allowedKeywords);
  document.getElementById("hideMode").value = data.hideMode || "fade";
  document.getElementById("debugScanMode").value = data.debugScanMode || "normal";
}

async function saveSettings() {
  const settings = {
    blockedAuthors: linesToList(document.getElementById("authors").value),
    blockedMods: linesToList(document.getElementById("mods").value),
    blockedKeywords: linesToList(document.getElementById("keywords").value),
    blockedTags: linesToList(document.getElementById("tags").value),
    allowedKeywords: linesToList(document.getElementById("allowedKeywords").value),
    hideMode: document.getElementById("hideMode").value,
    debugScanMode: document.getElementById("debugScanMode").value
  };

  await chrome.storage.local.set(settings);
  showStatus("Saved. The open ModDB page should update automatically.");
}

async function clearApiCache() {
  await chrome.storage.local.remove([
    "assetMetaCache",
    "assetMetaCacheTime",
    "assetToModIdCache",
    "assetToModIdCacheTime",
    "modDetailsCache",
    "commentTextCache",
    "allowedAuthors",
    "allowedTags"
  ]);

  showStatus("API cache cleared.");
}

document.addEventListener("DOMContentLoaded", loadSettings);
document.getElementById("save").addEventListener("click", saveSettings);
document.getElementById("clearCache").addEventListener("click", clearApiCache);
