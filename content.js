(() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    blockedAuthors: [],
    blockedMods: [],
    blockedKeywords: [],
    blockedTags: [],
    allowedKeywords: [],
    hideMode: "fade",
    debugScanMode: "normal"
  };

  const API_BASE = "https://mods.vintagestory.at/api";
  const ASSET_META_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

  let settings = { ...DEFAULT_SETTINGS };
  let scanTimer = null;
  let isScanning = false;
  let rescanRequested = false;
  let suppressNextBlockedModsFullRescan = false;
  let assetMetaPromise = null;

  const pendingCards = new WeakSet();

  function normalizeText(value) {
    return String(value || "").trim();
  }

  function normalizeForCompare(value) {
    return normalizeText(value).toLowerCase();
  }

  function normalizeTitle(value) {
    return normalizeForCompare(value).replace(/\s+/g, " ").trim();
  }

  function toExactSet(list) {
    return new Set((list || []).map(normalizeForCompare).filter(Boolean));
  }

  function isWordChar(ch) {
    return /[a-zA-Z0-9_]/.test(ch || "");
  }

  function wholePhraseIncludes(textLower, phraseLower) {
    if (!phraseLower) return false;

    let start = 0;
    while (true) {
      const index = textLower.indexOf(phraseLower, start);
      if (index === -1) return false;

      const before = index > 0 ? textLower[index - 1] : "";
      const afterIndex = index + phraseLower.length;
      const after = afterIndex < textLower.length ? textLower[afterIndex] : "";

      if (!isWordChar(before) && !isWordChar(after)) {
        return true;
      }

      start = index + 1;
    }
  }

  function parseKeywordRule(rawRule) {
    const original = normalizeText(rawRule);
    const lower = normalizeForCompare(original);

    if (!lower) {
      return null;
    }

    if (lower.startsWith("word:")) {
      const value = normalizeForCompare(original.slice(5));
      return value ? { type: "word", value, label: original } : null;
    }

    if (
      (original.startsWith('"') && original.endsWith('"') && original.length >= 2) ||
      (original.startsWith("'") && original.endsWith("'") && original.length >= 2)
    ) {
      const value = normalizeForCompare(original.slice(1, -1));
      return value ? { type: "word", value, label: original } : null;
    }

    if (lower.startsWith("regex:")) {
      const pattern = original.slice(6).trim();
      try {
        return { type: "regex", regex: new RegExp(pattern, "i"), label: original };
      } catch {
        console.warn("[VS ModDB Blocker] Invalid regex keyword:", original);
        return null;
      }
    }

    return { type: "contains", value: lower, label: original };
  }

  function matchesKeywordRule(textLower, rawRule) {
    const rule = parseKeywordRule(rawRule);
    if (!rule) return false;

    if (rule.type === "word") {
      return wholePhraseIncludes(textLower, rule.value);
    }

    if (rule.type === "regex") {
      return rule.regex.test(textLower);
    }

    return textLower.includes(rule.value);
  }

  function matchKeywordRules(textLower, rules) {
    for (const rawRule of rules || []) {
      if (matchesKeywordRule(textLower, rawRule)) {
        return rawRule;
      }
    }

    return null;
  }

  function getHideClass() {
    if (settings.hideMode === "blank") return "vsmoddb-blocker-blank";
    if (settings.hideMode === "remove") return "vsmoddb-blocker-remove";
    return "vsmoddb-blocker-faded";
  }

  function clearHideClasses(card) {
    card.classList.remove(
      "vsmoddb-blocker-faded",
      "vsmoddb-blocker-blank",
      "vsmoddb-blocker-remove"
    );
  }

  function hideCard(card, reason) {
    card.classList.remove("vsmoddb-blocker-unscanned");
    clearHideClasses(card);
    card.classList.add(getHideClass());
    card.dataset.vsmoddbBlockerReason = reason || "blocked";
  }

  function unhideCard(card) {
    card.classList.remove("vsmoddb-blocker-unscanned");
    clearHideClasses(card);
    delete card.dataset.vsmoddbBlockerReason;
  }

  async function loadSettings() {
    settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  }

  function getModCards() {
    return Array.from(document.querySelectorAll("div.mod.published"));
  }

  function getAssetIdFromCard(card) {
    const link = card.querySelector('a[href^="/show/mod/"]');
    if (!link) return null;

    const match = link.getAttribute("href").match(/\/show\/mod\/(\d+)/);
    return match ? String(match[1]) : null;
  }

  function getVisibleTitleAndDescription(card) {
    const title = card.querySelector(".moddesc h4")?.textContent || "";
    const description = card.querySelector(".moddesc p")?.textContent || "";

    return {
      title: normalizeText(title),
      titleLower: normalizeForCompare(title),
      normalizedTitle: normalizeTitle(title),
      description: normalizeText(description),
      combinedLower: normalizeForCompare(`${title} ${description}`)
    };
  }

  function matchesVisibleKeywordList(card, list) {
    const { combinedLower } = getVisibleTitleAndDescription(card);
    return matchKeywordRules(combinedLower, list);
  }

  function shouldHideUntilScanned() {
    return settings.debugScanMode !== "debug";
  }

  function markCardAsWaitingForScan(card) {
    if (!shouldHideUntilScanned()) {
      card.classList.remove("vsmoddb-blocker-unscanned");
      return;
    }

    if (card.dataset.vsmoddbBlockerScanned !== "true") {
      card.classList.add("vsmoddb-blocker-unscanned");
    }
  }

  function markCardAsScanned(card) {
    card.dataset.vsmoddbBlockerScanned = "true";
    card.classList.remove("vsmoddb-blocker-unscanned");
  }

  function prepareCardsForScan(cards) {
    for (const card of cards) {
      markCardAsWaitingForScan(card);
    }
  }

  function resetScannedState(cards) {
    for (const card of cards) {
      delete card.dataset.vsmoddbBlockerScanned;
    }
  }

  async function addBlockedModFromCard(card) {
    const visible = getVisibleTitleAndDescription(card);
    const assetId = getAssetIdFromCard(card);

    const valueToAdd = visible.title || assetId;
    if (!valueToAdd) return;

    const data = await chrome.storage.local.get({ blockedMods: [] });
    const current = Array.isArray(data.blockedMods) ? data.blockedMods : [];
    const alreadyExists = current.some(item => normalizeForCompare(item) === normalizeForCompare(valueToAdd));

    if (!alreadyExists) {
      const nextBlockedMods = [...current, valueToAdd];

      suppressNextBlockedModsFullRescan = true;

      settings.blockedMods = nextBlockedMods;

      await chrome.storage.local.set({
        blockedMods: nextBlockedMods
      });
    }

    card.dataset.vsmoddbBlockerScanned = "true";
    hideCard(card, `mod: ${valueToAdd}`);
  }

  function addHideButtonToCard(card) {
    if (card.querySelector(".vsmoddb-blocker-card-actions")) return;

    const actions = document.createElement("div");
    actions.className = "vsmoddb-blocker-card-actions";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "vsmoddb-blocker-hide-button";
    button.textContent = "Hide mod";
    button.title = "Add this mod to blocked individual mods";

    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();

      button.disabled = true;
      button.textContent = "Hidden";

      try {
        await addBlockedModFromCard(card);
      } catch (error) {
        console.warn("[VS ModDB Blocker] Could not add blocked mod:", error);
        button.disabled = false;
        button.textContent = "Hide mod";
      }
    });

    actions.appendChild(button);
    card.appendChild(actions);
  }

  async function getStoredObject(key, fallback) {
    const data = await chrome.storage.local.get({ [key]: fallback });
    return data[key] || fallback;
  }

  async function setStoredObject(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "default"
    });

    if (!response.ok) {
      throw new Error(`Request failed ${response.status}: ${url}`);
    }

    return response.json();
  }

  function extractModsArray(modsApiData) {
    if (Array.isArray(modsApiData)) return modsApiData;
    if (Array.isArray(modsApiData?.mods)) return modsApiData.mods;
    if (Array.isArray(modsApiData?.data)) return modsApiData.data;
    return [];
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
    return "";
  }

  function normalizeMetaFromModsEntry(mod) {
    const assetId = firstString(
      mod.assetid,
      mod.assetId,
      mod.asset_id,
      mod.assetID
    );

    const modId = firstString(
      mod.modid,
      mod.modId,
      mod.mod_id,
      mod.id
    );

    const name = firstString(
      mod.name,
      mod.modname,
      mod.modName,
      mod.title
    );

    const summary = firstString(
      mod.summary,
      mod.description,
      mod.text
    );

    const authorNames = collectPossibleAuthorNames(mod);
    const tags = collectPossibleTags(mod);

    return {
      assetId,
      modId,
      name,
      normalizedName: normalizeTitle(name),
      summary,
      authorNames,
      tags
    };
  }

  async function buildAssetMetaMap() {
    const modsApiData = await fetchJson(`${API_BASE}/mods`);
    const mods = extractModsArray(modsApiData);
    const byAssetId = {};
    const byName = {};

    for (const mod of mods) {
      const meta = normalizeMetaFromModsEntry(mod);

      if (meta.assetId) {
        byAssetId[meta.assetId] = meta;
      }

      if (meta.normalizedName) {
        if (!byName[meta.normalizedName]) byName[meta.normalizedName] = [];
        byName[meta.normalizedName].push(meta);
      }
    }

    const cache = { byAssetId, byName };

    try {
      await chrome.storage.local.set({
        assetMetaCache: cache,
        assetMetaCacheTime: Date.now()
      });
    } catch (error) {
      console.warn("[VS ModDB Blocker] Could not store compact API cache. Continuing without persistent cache.", error);
    }

    return cache;
  }

  async function getAssetMetaMap() {
    if (assetMetaPromise) return assetMetaPromise;

    assetMetaPromise = (async () => {
      const now = Date.now();
      const data = await chrome.storage.local.get({
        assetMetaCache: null,
        assetMetaCacheTime: 0
      });

      if (
        data.assetMetaCache &&
        data.assetMetaCacheTime &&
        now - data.assetMetaCacheTime < ASSET_META_CACHE_MAX_AGE_MS
      ) {
        if (!data.assetMetaCache.byAssetId && !data.assetMetaCache.byName) {
          const oldMap = data.assetMetaCache || {};
          const byName = {};
          for (const meta of Object.values(oldMap)) {
            if (meta?.name) {
              const key = normalizeTitle(meta.name);
              if (!byName[key]) byName[key] = [];
              byName[key].push({
                ...meta,
                normalizedName: key
              });
            }
          }
          return { byAssetId: oldMap, byName };
        }

        return data.assetMetaCache;
      }

      return buildAssetMetaMap();
    })();

    try {
      return await assetMetaPromise;
    } finally {
      assetMetaPromise = null;
    }
  }

  async function getMetaCandidatesForCard(card) {
    const assetId = getAssetIdFromCard(card);
    const visible = getVisibleTitleAndDescription(card);
    const cache = await getAssetMetaMap();

    const candidates = [];
    const seen = new Set();

    const add = meta => {
      if (!meta) return;
      const key = `${meta.assetId || ""}|${meta.modId || ""}|${meta.normalizedName || meta.name || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(meta);
    };

    if (assetId && cache.byAssetId?.[assetId]) {
      add(cache.byAssetId[assetId]);
    }

    if (visible.normalizedTitle && Array.isArray(cache.byName?.[visible.normalizedTitle])) {
      for (const meta of cache.byName[visible.normalizedTitle]) add(meta);
    }

    return { assetId, visible, candidates };
  }

  async function getModDetails(modId) {
    return fetchJson(`${API_BASE}/mod/${encodeURIComponent(modId)}`);
  }

  function unwrapMod(details) {
    return details?.mod && typeof details.mod === "object" ? details.mod : details;
  }

  function collectPossibleAuthorNames(details) {
    const mod = unwrapMod(details || {});
    const names = [];

    const push = value => {
      if (typeof value === "string" && value.trim()) names.push(value.trim());
      if (typeof value === "number") names.push(String(value));
    };

    push(mod.author);
    push(mod.authorname);
    push(mod.authorName);
    push(mod.userid);
    push(mod.userId);
    push(mod.userName);
    push(mod.username);
    push(mod.ownername);
    push(mod.ownerName);

    if (typeof mod.owner === "string") {
      push(mod.owner);
    }

    if (mod.user && typeof mod.user === "object") {
      push(mod.user.name);
      push(mod.user.username);
      push(mod.user.displayname);
      push(mod.user.displayName);
    }

    if (mod.owner && typeof mod.owner === "object") {
      push(mod.owner.name);
      push(mod.owner.username);
      push(mod.owner.displayname);
      push(mod.owner.displayName);
    }

    if (Array.isArray(mod.authors)) {
      for (const author of mod.authors) {
        if (typeof author === "string") {
          push(author);
        } else if (author && typeof author === "object") {
          push(author.name);
          push(author.username);
          push(author.displayname);
          push(author.displayName);
        }
      }
    }

    return [...new Set(names)];
  }

  function collectPossibleTags(details) {
    const mod = unwrapMod(details || {});
    const tags = [];

    const push = value => {
      if (typeof value === "string" && value.trim()) tags.push(value.trim());
    };

    const readTagArray = arr => {
      if (!Array.isArray(arr)) return;

      for (const tag of arr) {
        if (typeof tag === "string") {
          push(tag);
        } else if (tag && typeof tag === "object") {
          push(tag.name);
          push(tag.tag);
          push(tag.title);
        }
      }
    };

    readTagArray(mod.tags);
    readTagArray(mod.tagids);
    readTagArray(mod.tagNames);
    readTagArray(mod.tag_names);

    return [...new Set(tags)];
  }

  function collectApiTextFromMetaAndDetails(candidates, detailsList) {
    const detailParts = [];

    for (const details of detailsList || []) {
      const mod = details ? unwrapMod(details) : {};
      detailParts.push(mod.name, mod.summary, mod.text, mod.description);
    }

    return normalizeForCompare([
      ...(candidates || []).flatMap(meta => [meta?.name, meta?.summary]),
      ...detailParts
    ].join(" "));
  }

  function exactMatchAny(values, exactSet) {
    for (const value of values || []) {
      if (exactSet.has(normalizeForCompare(value))) {
        return value;
      }
    }

    return null;
  }

  function getBlockedModMatch(card, assetId, candidates) {
    const blockedMods = settings.blockedMods || [];
    if (!blockedMods.length) return null;

    const exactSet = toExactSet(blockedMods);
    const visible = getVisibleTitleAndDescription(card);

    const candidateValues = (candidates || []).flatMap(meta => [
      meta.assetId,
      meta.modId,
      meta.name
    ]);

    const values = [
      assetId,
      visible.title,
      ...candidateValues
    ].filter(Boolean);

    return exactMatchAny(values, exactSet);
  }

  async function getDetailsForCandidates(candidates) {
    const detailsList = [];

    for (const meta of candidates || []) {
      if (!meta?.modId) continue;

      try {
        detailsList.push(await getModDetails(meta.modId));
      } catch (error) {
        console.warn("[VS ModDB Blocker] Could not load mod detail:", meta.modId, error);
      }
    }

    return detailsList;
  }

  async function hasAllowedKeyword(card, candidates, detailsList) {
    const visibleAllow = matchesVisibleKeywordList(card, settings.allowedKeywords);
    if (visibleAllow) {
      return visibleAllow;
    }

    if (!settings.allowedKeywords || !settings.allowedKeywords.length) {
      return null;
    }

    const apiText = collectApiTextFromMetaAndDetails(candidates, detailsList);
    return matchKeywordRules(apiText, settings.allowedKeywords);
  }

  async function getBlockReason(card) {
    const { assetId, visible, candidates } = await getMetaCandidatesForCard(card);

    const modMatch = getBlockedModMatch(card, assetId, candidates);
    if (modMatch) {
      return `mod: ${modMatch}`;
    }

    const blockedAuthors = toExactSet(settings.blockedAuthors);
    if (blockedAuthors.size) {
      for (const meta of candidates) {
        const match = exactMatchAny(meta.authorNames || [], blockedAuthors);
        if (match) {
          return `author: ${match}`;
        }
      }
    }

    const authorStillNeedsDetails =
      blockedAuthors.size &&
      candidates.some(meta => !meta.authorNames || !meta.authorNames.length);

    const needsDetails =
      authorStillNeedsDetails ||
      (settings.blockedTags && settings.blockedTags.length) ||
      (settings.blockedKeywords && settings.blockedKeywords.length) ||
      (settings.allowedKeywords && settings.allowedKeywords.length);

    const detailsList = needsDetails ? await getDetailsForCandidates(candidates) : [];

    if (blockedAuthors.size) {
      for (const details of detailsList) {
        const match = exactMatchAny(collectPossibleAuthorNames(details), blockedAuthors);
        if (match) {
          return `author: ${match}`;
        }
      }
    }

    const blockedTags = toExactSet(settings.blockedTags);
    if (blockedTags.size) {
      for (const meta of candidates) {
        const match = exactMatchAny(meta.tags || [], blockedTags);
        if (match) {
          return `tag: ${match}`;
        }
      }

      for (const details of detailsList) {
        const match = exactMatchAny(collectPossibleTags(details), blockedTags);
        if (match) {
          return `tag: ${match}`;
        }
      }
    }

    const allowedKeyword = await hasAllowedKeyword(card, candidates, detailsList);
    if (!allowedKeyword) {
      const visibleKeyword = matchKeywordRules(visible.combinedLower, settings.blockedKeywords);
      if (visibleKeyword) {
        return `keyword: ${visibleKeyword}`;
      }

      const apiText = collectApiTextFromMetaAndDetails(candidates, detailsList);
      const apiKeyword = matchKeywordRules(apiText, settings.blockedKeywords);
      if (apiKeyword) {
        return `keyword: ${apiKeyword}`;
      }
    }

    return null;
  }

  async function processCard(card) {
    if (pendingCards.has(card)) return;
    pendingCards.add(card);

    try {
      const blockReason = await getBlockReason(card);

      if (blockReason) {
        hideCard(card, blockReason);
        return;
      }

      unhideCard(card);
    } catch (error) {
      console.warn("[VS ModDB Blocker] Failed to process card:", error);
    } finally {
      markCardAsScanned(card);
      pendingCards.delete(card);
    }
  }

  async function scanPage() {
    if (isScanning) {
      rescanRequested = true;
      return;
    }

    isScanning = true;

    try {
      await loadSettings();
      const cards = getModCards();

      prepareCardsForScan(cards);

      for (const card of cards) {
        addHideButtonToCard(card);
      }

      const cardsToScan = cards.filter(card => card.dataset.vsmoddbBlockerScanned !== "true");

      for (const card of cardsToScan) {
        processCard(card);
      }
    } finally {
      isScanning = false;

      if (rescanRequested) {
        rescanRequested = false;
        scheduleScan(75);
      }
    }
  }

  function scheduleScan(delay = 250) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, delay);
  }

  function startObserver() {
    const observer = new MutationObserver(mutations => {
      let shouldScan = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes && mutation.addedNodes.length) {
          shouldScan = true;
          break;
        }
      }

      if (shouldScan) {
        loadSettings()
          .then(() => prepareCardsForScan(getModCards()))
          .catch(error => console.warn("[VS ModDB Blocker] Could not prepare new cards:", error));

        scheduleScan(25);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    const onlyBlockedModsChanged =
      Boolean(changes.blockedMods) &&
      !changes.blockedAuthors &&
      !changes.blockedKeywords &&
      !changes.blockedTags &&
      !changes.allowedKeywords &&
      !changes.hideMode &&
      !changes.debugScanMode;

    if (onlyBlockedModsChanged && suppressNextBlockedModsFullRescan) {
      suppressNextBlockedModsFullRescan = false;

      if (changes.blockedMods.newValue) {
        settings.blockedMods = changes.blockedMods.newValue;
      }

      return;
    }

    if (
      changes.blockedAuthors ||
      changes.blockedMods ||
      changes.blockedKeywords ||
      changes.blockedTags ||
      changes.allowedKeywords ||
      changes.hideMode ||
      changes.debugScanMode
    ) {
      resetScannedState(getModCards());
      scheduleScan(25);
    }
  });

  loadSettings()
    .then(() => {
      scanPage();
      startObserver();
      window.addEventListener("scroll", () => scheduleScan(75), { passive: true });
    })
    .catch(error => {
      console.warn("[VS ModDB Blocker] Startup failed:", error);
    });
})();
