export const EGO_DRIVER_RESULT_PREFIX = "__EGO_CHAT_DRIVER_RESULT__"

async function egoDriverMain() {
  const fs = await import("node:fs/promises")
  const crypto = await import("node:crypto")

  const resultPrefix = "__EGO_CHAT_DRIVER_RESULT__"
  const uid = typeof process.getuid === "function" ? process.getuid() : "user"
  const inputPath = `/tmp/egc-driver-${uid}/input.json`
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"))
  let observedModelPolicy = null

  function emit(value) {
    const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
    cliLog(resultPrefix + encoded)
  }

  function sha256(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex")
  }

  function normalizeUrl(value) {
    const parsed = new URL(value)
    parsed.hash = ""
    parsed.search = ""
    if (parsed.hostname === "www.chatgpt.com") {
      parsed.hostname = "chatgpt.com"
    }
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "")
    }
    return parsed.toString()
  }

  function isChatGptOrigin(value) {
    const parsed = new URL(value)
    return parsed.protocol === "https:"
      && (parsed.hostname === "chatgpt.com" || parsed.hostname === "www.chatgpt.com")
      && parsed.username === ""
      && parsed.password === ""
      && parsed.port === ""
  }

  function isCanonicalConversationUrl(value) {
    return isChatGptOrigin(value)
      && /(?:^|\/)c\/[^/]+(?:\/|$)/.test(new URL(value).pathname)
  }

  function humanRequired(reason, message, evidence) {
    emit({
      evidence: {
        ...(evidence || {}),
        ...(observedModelPolicy ? { modelPolicy: observedModelPolicy } : {}),
      },
      humanRequired: true,
      message,
      ok: false,
      reason,
    })
  }

  async function inspectPage() {
    const info = await pageInfo()
    if (info?.dialog) {
      return {
        accountState: "blocked",
        blockedReason: "native_dialog",
        hasComposer: false,
        info,
        snapshotDigest: null,
        unexpectedDraft: false,
      }
    }

    const snapshot = await snapshotText()
    const normalized = snapshot.toLowerCase()
    const dom = await js(String.raw`(() => {
      const composer = document.querySelector('#prompt-textarea, textarea[placeholder], [contenteditable="true"]')
      const draft = composer
        ? (composer.matches('input, textarea')
            ? composer.value
            : composer.innerText || composer.textContent || '')
        : ''
      return {
        hasComposer: Boolean(composer),
        draft: String(draft || ''),
        hasLoginAction: [...document.querySelectorAll('a, button')].some((element) => {
          const text = String(element.innerText || element.textContent || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
          return text === 'log in' || text === 'sign up'
        }),
      }
    })()`)
    const hasCaptcha = !dom.hasComposer && (
      normalized.includes("captcha")
        || normalized.includes("verify you are human")
        || normalized.includes("checking your browser")
    )
    const accountState = hasCaptcha
      ? "blocked"
      : (dom.hasComposer
          ? "authenticated"
          : (dom.hasLoginAction ? "unauthenticated" : "unknown"))

    return {
      accountState,
      blockedReason: hasCaptcha ? "verification_challenge" : null,
      hasComposer: dom.hasComposer,
      info,
      snapshotDigest: sha256(snapshot),
      unexpectedDraft: dom.draft.trim().length > 0,
    }
  }

  async function readConversationEntries() {
    const messages = await js(String.raw`(() => {
      return [...document.querySelectorAll('[data-message-author-role]')].map((message) => {
        const role = message.getAttribute('data-message-author-role')
        const content = role === 'user'
          ? (message.querySelector('[data-testid="collapsible-user-message-content"]')?.textContent
              ?? message.querySelector('.whitespace-pre-wrap')?.textContent
              ?? message.innerText)
          : (message.querySelector('.markdown')?.innerText ?? message.innerText)
        return {
          messageId: message.getAttribute('data-message-id'),
          role,
          text: String(content || ''),
        }
      })
    })()`)
    return messages.map((message) => ({
      contentDigest: sha256(message.text),
      messageId: message.messageId,
      role: message.role,
      text: message.text,
    }))
  }

  function summarizeConversationHead(entries, logicalMessageCount = undefined) {
    const last = entries.at(-1) ?? null
    return {
      fingerprint: sha256(JSON.stringify(last
        ? {
            contentDigest: last.contentDigest,
            messageId: last.messageId,
            role: last.role,
          }
        : null)),
      fingerprintVersion: "tail-v1",
      lastContentDigest: last?.contentDigest ?? null,
      lastMessageId: last?.messageId ?? null,
      lastRole: last?.role ?? null,
      messageCount: Number.isInteger(logicalMessageCount) ? logicalMessageCount : entries.length,
      renderedMessageCount: entries.length,
    }
  }

  function legacyConversationFingerprint(entries) {
    return sha256(JSON.stringify(entries.map(({ contentDigest, messageId, role }) => ({
      contentDigest,
      messageId,
      role,
    }))))
  }

  function bindingMatchesHead(binding, entries, head) {
    return binding.headFingerprintVersion === "tail-v1"
      ? head.fingerprint === binding.headFingerprint
      : legacyConversationFingerprint(entries) === binding.headFingerprint
  }

  async function readConversationHead(logicalMessageCount = undefined) {
    return summarizeConversationHead(await readConversationEntries(), logicalMessageCount)
  }

  async function selectExactTarget(taskSpace, targetId) {
    const task = await useOrCreateTaskSpace(taskSpace)
    const tabs = await listTabs()
    const tab = tabs.find((candidate) => candidate.targetId === targetId)
    if (!tab) {
      humanRequired("bound_tab_missing", "The exact bound ChatGPT tab is no longer available.", {
        targetId,
        taskSpaceId: task.id,
      })
      return null
    }
    await switchTab(targetId)
    return { tab, targetId: tab.targetId, task }
  }

  function assertReady(inspection, selected) {
    if (!isChatGptOrigin(inspection.info.url)) {
      humanRequired("unexpected_origin", "The selected tab is no longer on ChatGPT.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return false
    }
    if (inspection.accountState !== "authenticated") {
      humanRequired(
        inspection.blockedReason || "authentication_required",
        "ChatGPT requires human authentication or verification.",
        { targetId: selected.targetId, taskSpaceId: selected.task.id },
      )
      return false
    }
    if (inspection.unexpectedDraft) {
      humanRequired("unexpected_draft", "The selected ChatGPT composer contains an unexpected draft.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return false
    }
    return true
  }

  async function inspectModelPolicyMenu() {
    return js(String.raw`(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length > 0)
      const pills = [...document.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]')]
        .filter(visible)
      if (pills.length !== 1) {
        return { ok: false, pillCount: pills.length, reason: 'policy_trigger_count' }
      }

      const pill = pills[0]
      const menuId = pill.getAttribute('aria-controls')
      const menu = menuId ? document.getElementById(menuId) : null
      if (pill.getAttribute('aria-expanded') !== 'true' || !visible(menu)) {
        return { ok: false, reason: 'policy_menu_not_open' }
      }

      const powerItems = [...menu.querySelectorAll('[role="menuitem"][aria-label="Power"]')]
        .filter(visible)
      const slider = powerItems[0]?.querySelector('[role="slider"]')
      const strictInteger = (raw) => {
        if (typeof raw !== 'string') {
          return null
        }
        const normalized = raw.trim()
        if (!normalized || !/^-?(?:0|[1-9]\d*)$/.test(normalized)) {
          return null
        }
        const parsed = Number(normalized)
        return Number.isSafeInteger(parsed) ? parsed : null
      }
      const minimum = strictInteger(slider?.getAttribute('aria-valuemin'))
      const maximum = strictInteger(slider?.getAttribute('aria-valuemax'))
      const current = strictInteger(slider?.getAttribute('aria-valuenow'))
      const rows = [...menu.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')]
        .filter(visible)
        .map((row) => String(row.innerText || row.textContent || '').trim().replace(/\s+/g, ' '))
      const modelRows = rows.filter((row) => row.startsWith('Model '))
      const effortRows = rows.filter((row) => row.startsWith('Effort '))

      if (
        powerItems.length !== 1
        || !slider
        || !Number.isInteger(minimum)
        || !Number.isInteger(maximum)
        || !Number.isInteger(current)
        || minimum < 0
        || current < minimum
        || maximum < current
        || maximum - minimum + 1 > 20
        || modelRows.length !== 1
        || effortRows.length !== 1
      ) {
        return {
          current,
          effortRowCount: effortRows.length,
          maximum,
          minimum,
          modelRowCount: modelRows.length,
          ok: false,
          powerItemCount: powerItems.length,
          reason: 'policy_menu_structure',
        }
      }

      return {
        current,
        effortLabel: effortRows[0].slice('Effort '.length).trim(),
        maximum,
        minimum,
        modelLabel: modelRows[0].slice('Model '.length).trim(),
        ok: true,
        pillLabel: String(pill.innerText || pill.textContent || '').trim().replace(/\s+/g, ' '),
      }
    })()`)
  }

  async function waitForModelPolicyMenu() {
    let inspection
    for (let attempt = 0; attempt < 3; attempt += 1) {
      inspection = await inspectModelPolicyMenu()
      if (inspection.ok) {
        return inspection
      }
      await wait(1)
    }
    return inspection
  }

  async function closeModelPolicyMenu() {
    let dismissalAttempted = false
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const state = await js(String.raw`(() => {
        const pills = [...document.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]')]
          .filter((element) => element.getClientRects().length > 0)
        return {
          composerCount: document.querySelectorAll('#prompt-textarea').length,
          count: pills.length,
          expanded: pills[0]?.getAttribute('aria-expanded'),
        }
      })()`)
      if (state.count !== 1) {
        await wait(1)
        continue
      }
      if (state.expanded === "false") {
        return true
      }
      if (state.expanded !== "true") {
        await wait(1)
        continue
      }
      if (state.composerCount !== 1 || dismissalAttempted) {
        await wait(1)
        continue
      }
      await click('#prompt-textarea', { label: "dismiss ChatGPT policy menu" })
      dismissalAttempted = true
      await wait(1)
    }
    return false
  }

  async function ensureMaximumModelPolicy(selected) {
    const policy = input.modelPolicy
    if (
      !policy
      || policy.key !== "chatgpt-web-default"
      || policy.modelSelection !== "strongest_available"
      || policy.thinkingEffort !== "maximum_available"
      || policy.enforcement !== "repair_then_verify"
    ) {
      humanRequired("model_policy_unsupported", "The broker supplied an unsupported ChatGPT model policy.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    const trigger = await js(String.raw`(() => {
      const pills = [...document.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]')]
        .filter((element) => element.getClientRects().length > 0)
      return {
        count: pills.length,
        expanded: pills[0]?.getAttribute('aria-expanded') === 'true',
      }
    })()`)
    if (trigger.count !== 1) {
      humanRequired("model_policy_ui_unknown", "The ChatGPT maximum-power control could not be identified unambiguously.", {
        pillCount: trigger.count,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }
    if (!trigger.expanded) {
      await click('button.__composer-pill[aria-haspopup="menu"]', { label: "open ChatGPT policy menu" })
      await wait(1)
    }

    const before = await waitForModelPolicyMenu()
    if (!before.ok) {
      await closeModelPolicyMenu()
      humanRequired("model_policy_ui_unknown", "The ChatGPT maximum-power menu did not expose a safe semantic policy control.", {
        reason: before.reason,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    const focused = await js(String.raw`(() => {
      const pill = document.querySelector('button.__composer-pill[aria-haspopup="menu"]')
      const menu = pill?.getAttribute('aria-controls')
        ? document.getElementById(pill.getAttribute('aria-controls'))
        : null
      const powerItems = [...(menu?.querySelectorAll('[role="menuitem"][aria-label="Power"]') || [])]
        .filter((element) => element.getClientRects().length > 0)
      if (powerItems.length !== 1) {
        return false
      }
      powerItems[0].focus()
      return document.activeElement === powerItems[0]
    })()`)
    if (!focused) {
      await closeModelPolicyMenu()
      humanRequired("model_policy_ui_unknown", "The ChatGPT maximum-power control could not receive safe keyboard input.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    const keyPressCount = Math.max(1, before.maximum - before.current)
    for (let step = 0; step < keyPressCount; step += 1) {
      await pressKey("ARROWRIGHT")
    }
    await wait(1)

    const after = await waitForModelPolicyMenu()
    const labelsValid = after.ok
      && after.modelLabel.length <= 120
      && after.effortLabel.length <= 120
      && after.pillLabel.length <= 120
      && !/[\u0000-\u001F\u007F]/.test(`${after.modelLabel}${after.effortLabel}${after.pillLabel}`)
    if (!labelsValid || after.current !== after.maximum) {
      await closeModelPolicyMenu()
      humanRequired("model_policy_mismatch", "ChatGPT did not confirm its strongest available model and maximum thinking setting.", {
        powerLevel: after.ok ? after.current - after.minimum + 1 : null,
        powerMax: after.ok ? after.maximum - after.minimum + 1 : null,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    const closed = await closeModelPolicyMenu()
    if (!closed) {
      humanRequired("model_policy_ui_unknown", "The ChatGPT model policy menu did not close cleanly before composition.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    return {
      adjusted: before.current !== before.maximum,
      effortLabel: after.effortLabel,
      key: policy.key,
      modelLabel: after.modelLabel,
      pillLabel: after.pillLabel,
      powerLevel: after.current - after.minimum + 1,
      powerMax: after.maximum - after.minimum + 1,
    }
  }

  async function verifyExistingMaximumModelPolicy(selected) {
    const policy = input.modelPolicy
    if (
      !policy
      || policy.key !== "chatgpt-web-default"
      || policy.modelSelection !== "strongest_available"
      || policy.thinkingEffort !== "maximum_available"
      || policy.enforcement !== "repair_then_verify"
    ) {
      humanRequired("model_policy_unsupported", "The broker supplied an unsupported ChatGPT model policy.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    const trigger = await js(String.raw`(() => {
      const pills = [...document.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]')]
        .filter((element) => element.getClientRects().length > 0)
      return {
        count: pills.length,
        expanded: pills[0]?.getAttribute('aria-expanded') === 'true',
      }
    })()`)
    if (trigger.count !== 1) {
      humanRequired("model_policy_ui_unknown", "The ChatGPT maximum-power control could not be identified unambiguously.", {
        pillCount: trigger.count,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }
    if (!trigger.expanded) {
      await click('button.__composer-pill[aria-haspopup="menu"]', { label: "inspect ChatGPT policy menu" })
      await wait(1)
    }

    const observed = await waitForModelPolicyMenu()
    const labelsValid = observed.ok
      && observed.modelLabel.length <= 120
      && observed.effortLabel.length <= 120
      && observed.pillLabel.length <= 120
      && !/[\u0000-\u001F\u007F]/.test(`${observed.modelLabel}${observed.effortLabel}${observed.pillLabel}`)
    const closed = await closeModelPolicyMenu()
    if (!labelsValid || !closed) {
      humanRequired("model_policy_ui_unknown", "The ChatGPT maximum-power policy could not be read safely during adoption.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    const powerLevel = observed.current - observed.minimum + 1
    const powerMax = observed.maximum - observed.minimum + 1
    if (observed.current !== observed.maximum) {
      humanRequired("adoption_live_model_not_maximum", "The existing response cannot be adopted because the conversation's live policy is not currently at ChatGPT's maximum setting.", {
        effortLabel: observed.effortLabel,
        modelLabel: observed.modelLabel,
        powerLevel,
        powerMax,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    return {
      adjusted: false,
      effortLabel: observed.effortLabel,
      key: policy.key,
      modelLabel: observed.modelLabel,
      pillLabel: observed.pillLabel,
      powerLevel,
      powerMax,
    }
  }

  async function selectConversation(binding) {
    if (binding.state === "unbound") {
      const selected = await selectExactTarget(binding.taskSpaceId, binding.targetId)
      if (!selected) {
        return null
      }
      const inspection = await inspectPage()
      if (!assertReady(inspection, selected)) {
        return null
      }
      if (normalizeUrl(inspection.info.url) !== normalizeUrl(binding.startUrl)) {
        humanRequired("unbound_start_url_changed", "The create-once tab moved away from its verified starting page.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return null
      }
      if (isCanonicalConversationUrl(inspection.info.url)) {
        humanRequired("unbound_chat_became_conversation", "The create-once tab already became a conversation outside this workflow.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return null
      }
      return { ...selected, inspection }
    }

    const task = await useOrCreateTaskSpace(binding.taskSpaceId)
    const expectedUrl = normalizeUrl(binding.canonicalUrl)
    const tabs = await listTabs()
    const boundTab = tabs.find((candidate) => candidate.targetId === binding.targetId)
    if (boundTab) {
      await switchTab(boundTab.targetId)
      const currentInfo = await pageInfo()
      if (normalizeUrl(currentInfo.url) === expectedUrl) {
        const inspection = await inspectPage()
        const selected = { inspection, tab: boundTab, targetId: boundTab.targetId, task }
        return assertReady(inspection, selected) ? selected : null
      }
    }

    const opened = await openOrReuseTab(expectedUrl, { timeout: 30, wait: true })
    const refreshedTabs = await listTabs()
    const activeTab = refreshedTabs.find((candidate) => candidate.active) || opened
    if (!activeTab?.targetId) {
      humanRequired("bound_conversation_open_failed", "The canonical ChatGPT conversation could not be opened.", {
        taskSpaceId: task.id,
      })
      return null
    }
    await switchTab(activeTab.targetId)
    const inspection = await inspectPage()
    const selected = { inspection, tab: activeTab, targetId: activeTab.targetId, task }
    if (!assertReady(inspection, selected)) {
      return null
    }
    if (normalizeUrl(inspection.info.url) !== expectedUrl) {
      humanRequired("canonical_conversation_redirected", "ChatGPT did not remain on the bound canonical conversation URL.", {
        targetId: selected.targetId,
        taskSpaceId: task.id,
      })
      return null
    }
    return selected
  }

  async function preflight() {
    const task = await useOrCreateTaskSpace(input.taskSpace)
    const opened = await openOrReuseTab("https://chatgpt.com/", { timeout: 30, wait: true })
    const tabs = await listTabs()
    const activeTab = tabs.find((tab) => tab.active) || opened
    const inspection = await inspectPage()
    emit({
      ok: true,
      result: {
        accountState: inspection.accountState,
        blockedReason: inspection.blockedReason,
        hasComposer: inspection.hasComposer,
        snapshotDigest: inspection.snapshotDigest,
        targetId: activeTab.targetId,
        taskSpaceId: task.id,
        unexpectedDraft: inspection.unexpectedDraft,
        url: inspection.info.url,
      },
    })
  }

  async function bind() {
    if (input.bindingMode === "create_once") {
      const selected = await selectExactTarget(input.taskSpace, input.targetId)
      if (!selected) {
        return
      }
      const inspection = await inspectPage()
      if (!assertReady(inspection, selected)) {
        return
      }
      if (normalizeUrl(inspection.info.url) !== normalizeUrl(input.startUrl)) {
        humanRequired("create_once_start_url_mismatch", "The exact create-once tab does not match the requested ChatGPT starting URL.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      if (isCanonicalConversationUrl(inspection.info.url)) {
        humanRequired("create_once_requires_new_chat", "The selected page is already a conversation; bind it in existing mode.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      emit({
        ok: true,
        result: {
          canonicalUrl: null,
          head: await readConversationHead(),
          snapshotDigest: inspection.snapshotDigest,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        },
      })
      return
    }

    const selected = await selectConversation({
      canonicalUrl: input.canonicalUrl,
      startUrl: input.canonicalUrl,
      state: "bound",
      targetId: input.targetId || null,
      taskSpaceId: input.taskSpace,
    })
    if (!selected) {
      return
    }
    const head = await readConversationHead()
    const generationRunning = await js(String.raw`Boolean(
      document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
    )`)
    if (generationRunning) {
      humanRequired("conversation_generation_in_progress", "The canonical conversation is still generating a response.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    emit({
      ok: true,
      result: {
        canonicalUrl: normalizeUrl(selected.inspection.info.url),
        head,
        snapshotDigest: selected.inspection.snapshotDigest,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      },
    })
  }

  async function adopt() {
    const selected = await selectConversation({
      canonicalUrl: input.canonicalUrl,
      startUrl: input.canonicalUrl,
      state: "bound",
      targetId: input.targetId || null,
      taskSpaceId: input.taskSpace,
    })
    if (!selected) {
      return
    }

    const startedAt = Date.now()
    const canonicalUrl = normalizeUrl(input.canonicalUrl)
    const initialEntries = await readConversationEntries()
    let anchorIndex = -1
    for (let index = initialEntries.length - 1; index >= 0; index -= 1) {
      if (initialEntries[index].role === "user") {
        anchorIndex = index
        break
      }
    }
    const anchor = initialEntries[anchorIndex]
    if (!anchor || !anchor.messageId) {
      humanRequired("adoption_anchor_missing", "The conversation has no uniquely identifiable latest user turn to adopt.", {
        renderedMessageCount: initialEntries.length,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const initialPrefixFingerprint = legacyConversationFingerprint(initialEntries.slice(0, anchorIndex + 1))
    const initialTail = initialEntries.slice(anchorIndex + 1)
    if (initialTail.length > 1 || (initialTail[0] && initialTail[0].role !== "assistant")) {
      humanRequired("adoption_tail_interleaved", "The latest user turn is not followed by at most one assistant response.", {
        committedCount: initialTail.length,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const adoptedWhileGenerating = await js(String.raw`Boolean(
      document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
    )`)
    if (!adoptedWhileGenerating && initialTail.length !== 1) {
      humanRequired("adoption_response_missing", "The latest user turn has no assistant response to adopt.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    let stableDigest = null
    let stableHeadFingerprint = null
    let stableCount = 0
    while (Date.now() - startedAt < input.timeoutMs) {
      const info = await pageInfo()
      if (normalizeUrl(info.url) !== canonicalUrl) {
        humanRequired("adoption_url_changed", "The ChatGPT conversation URL changed while adoption was waiting.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }

      const generationRunning = await js(String.raw`Boolean(
        document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
      )`)
      const entries = await readConversationEntries()
      const anchorIndexes = entries
        .map((entry, index) => entry.messageId === anchor.messageId ? index : -1)
        .filter((index) => index >= 0)
      const currentAnchorIndex = anchorIndexes[0] ?? -1
      const currentAnchor = currentAnchorIndex >= 0 ? entries[currentAnchorIndex] : null
      const prefixFingerprint = currentAnchorIndex >= 0
        ? legacyConversationFingerprint(entries.slice(0, currentAnchorIndex + 1))
        : null
      if (
        anchorIndexes.length !== 1
        || currentAnchor?.role !== "user"
        || currentAnchor?.contentDigest !== anchor.contentDigest
        || prefixFingerprint !== initialPrefixFingerprint
      ) {
        humanRequired("adoption_anchor_changed", "The adopted user turn or its preceding conversation changed while waiting.", {
          anchorCount: anchorIndexes.length,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }

      const committed = entries.slice(currentAnchorIndex + 1)
      if (committed.length > 1 || (committed[0] && committed[0].role !== "assistant")) {
        humanRequired("adoption_tail_interleaved", "Another message interleaved with the adopted user/assistant tail.", {
          committedCount: committed.length,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }

      const response = committed[0]
      const head = summarizeConversationHead(entries)
      const terminal = !generationRunning
        && Boolean(response?.messageId)
        && response?.role === "assistant"
        && response.text.trim().length > 0
        && head.lastMessageId === response.messageId
      if (
        terminal
        && response.contentDigest === stableDigest
        && head.fingerprint === stableHeadFingerprint
      ) {
        stableCount += 1
      } else if (terminal) {
        stableDigest = response.contentDigest
        stableHeadFingerprint = head.fingerprint
        stableCount = 1
      } else {
        stableDigest = null
        stableHeadFingerprint = null
        stableCount = 0
      }

      if (stableCount >= 2) {
        const modelPolicy = await verifyExistingMaximumModelPolicy(selected)
        if (!modelPolicy) {
          return
        }
        observedModelPolicy = modelPolicy
        const finalInspection = await inspectPage()
        if (!assertReady(finalInspection, selected)) {
          return
        }
        if (normalizeUrl(finalInspection.info.url) !== canonicalUrl) {
          humanRequired("adoption_url_changed", "The ChatGPT conversation URL changed before adoption completed.", {
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          })
          return
        }
        const finalGenerationRunning = await js(String.raw`Boolean(
          document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
        )`)
        const finalEntries = await readConversationEntries()
        const finalAnchorIndexes = finalEntries
          .map((entry, index) => entry.messageId === anchor.messageId ? index : -1)
          .filter((index) => index >= 0)
        const finalAnchorIndex = finalAnchorIndexes[0] ?? -1
        const finalPrefixFingerprint = finalAnchorIndex >= 0
          ? legacyConversationFingerprint(finalEntries.slice(0, finalAnchorIndex + 1))
          : null
        const finalCommitted = finalAnchorIndex >= 0 ? finalEntries.slice(finalAnchorIndex + 1) : []
        const finalResponse = finalCommitted[0]
        const finalHead = summarizeConversationHead(finalEntries)
        const finalCaptureMatches = !finalGenerationRunning
          && finalAnchorIndexes.length === 1
          && finalPrefixFingerprint === initialPrefixFingerprint
          && finalCommitted.length === 1
          && finalResponse?.role === "assistant"
          && finalResponse?.messageId === response.messageId
          && finalResponse?.contentDigest === response.contentDigest
          && finalHead.fingerprint === head.fingerprint
        if (!finalCaptureMatches) {
          humanRequired("adoption_capture_unstable", "The adopted response changed during the final capture check.", {
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          })
          return
        }
        emit({
          ok: true,
          result: {
            adoptedWhileGenerating,
            anchor: {
              contentDigest: anchor.contentDigest,
              messageId: anchor.messageId,
            },
            canonicalUrl,
            durationMs: Date.now() - startedAt,
            head: finalHead,
            modelPolicy,
            responseDigest: finalResponse.contentDigest,
            responseText: finalResponse.text,
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          },
        })
        return
      }
      await wait(generationRunning ? 5 : 1)
    }

    humanRequired("adoption_timeout", "The adopted ChatGPT response did not become stable before the deadline.", {
      targetId: selected.targetId,
      taskSpaceId: selected.task.id,
    })
  }

  async function reconcile() {
    const selected = await selectExactTarget(input.binding.taskSpaceId, input.binding.targetId)
    if (!selected) {
      return
    }
    const inspection = await inspectPage()
    if (!assertReady(inspection, selected)) {
      return
    }
    if (!isCanonicalConversationUrl(inspection.info.url)) {
      humanRequired("reconciliation_url_not_canonical", "The confirmed send still has no canonical ChatGPT conversation URL.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    const userTextCandidates = await js(String.raw`[...document.querySelectorAll('[data-message-author-role="user"]')]
      .map((message) => [...new Set([
        message.querySelector('[data-testid="collapsible-user-message-content"]')?.textContent,
        message.querySelector('.whitespace-pre-wrap')?.textContent,
        message.innerText,
      ].filter((text) => typeof text === 'string'))])`)
    const matchingTurns = userTextCandidates.filter(
      (candidates) => candidates.some((text) => sha256(text) === input.inputDigest),
    ).length
    if (userTextCandidates.length !== 1 || matchingTurns !== 1) {
      humanRequired("reconciliation_prompt_mismatch", "The canonical conversation does not contain exactly one user turn matching the confirmed send digest.", {
        matchingTurns,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
        userTurnCount: userTextCandidates.length,
      })
      return
    }
    const generationRunning = await js(String.raw`Boolean(
      document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
    )`)
    if (generationRunning) {
      humanRequired("conversation_generation_in_progress", "The confirmed send is still generating a response.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    const head = await readConversationHead()
    if (head.messageCount !== 2 || head.lastRole !== "assistant") {
      humanRequired("reconciliation_head_incomplete", "The reconciled first turn does not have one stable user/assistant pair.", {
        messageCount: head.messageCount,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    emit({
      ok: true,
      result: {
        canonicalUrl: normalizeUrl(inspection.info.url),
        head,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      },
    })
  }

  async function reconcileBound() {
    const selected = await selectExactTarget(input.binding.taskSpaceId, input.binding.targetId)
    if (!selected) {
      return
    }
    const inspection = await inspectPage()
    if (!assertReady(inspection, selected)) {
      return
    }
    if (normalizeUrl(inspection.info.url) !== normalizeUrl(input.binding.canonicalUrl)) {
      humanRequired("reconciliation_url_mismatch", "The late send is not in the bound canonical conversation.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    if (!input.expectedPreviousMessageId || !input.expectedTerminalMarker || !input.turnMarker) {
      humanRequired("reconciliation_metadata_missing", "Bound late-send reconciliation requires the prior head and exact workflow markers.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    const generationRunning = await js(String.raw`Boolean(
      document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
    )`)
    if (generationRunning) {
      humanRequired("conversation_generation_in_progress", "The late accepted send is still generating a response.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const entries = await readConversationEntries()
    const anchorIndexes = entries
      .map((entry, index) => entry.messageId === input.expectedPreviousMessageId ? index : -1)
      .filter((index) => index >= 0)
    const anchorIndex = anchorIndexes[0] ?? -1
    const anchor = anchorIndex >= 0 ? entries[anchorIndex] : null
    const committed = anchorIndex >= 0 ? entries.slice(anchorIndex + 1) : []
    const prompt = committed[0]
    const response = committed[1]
    const anchorDigestMatches = !input.expectedPreviousContentDigest
      || anchor?.contentDigest === input.expectedPreviousContentDigest
    const anchorRoleMatches = !input.binding.headRole || anchor?.role === input.binding.headRole
    const promptDigestMatches = prompt?.contentDigest === input.inputDigest
    const promptMarkerCount = prompt?.text.split(input.turnMarker).length - 1
    const renderedMarkerCount = entries.reduce(
      (count, entry) => count + entry.text.split(input.turnMarker).length - 1,
      0,
    )
    const terminalCount = response?.text.split(input.expectedTerminalMarker).length - 1
    const responseEndsWithTerminal = response?.text.trimEnd().endsWith(input.expectedTerminalMarker) ?? false
    const attributablePair = (
      anchorIndexes.length === 1
      && anchorDigestMatches
      && anchorRoleMatches
      && committed.length === 2
      && prompt?.role === "user"
      && response?.role === "assistant"
      && Boolean(prompt?.messageId)
      && Boolean(response?.messageId)
      && prompt.messageId !== response.messageId
      && promptMarkerCount === 1
      && renderedMarkerCount === 1
      && terminalCount === 1
      && responseEndsWithTerminal
    )
    if (!attributablePair) {
      humanRequired("bound_reconciliation_mismatch", "The browser does not contain exactly one stable late user/assistant pair attributable to that workflow.", {
        anchorCount: anchorIndexes.length,
        anchorDigestMatches,
        anchorRoleMatches,
        committedCount: committed.length,
        promptDigestMatches,
        promptMarkerCount: Number.isInteger(promptMarkerCount) ? promptMarkerCount : null,
        promptRole: prompt?.role ?? null,
        renderedMarkerCount,
        responseEndsWithTerminal,
        responseRole: response?.role ?? null,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
        terminalCount: Number.isInteger(terminalCount) ? terminalCount : null,
      })
      return
    }

    await wait(1)
    const stableEntries = await readConversationEntries()
    const stablePrompt = stableEntries.find((entry) => entry.messageId === prompt.messageId)
    const stablePromptMarkerCount = stablePrompt?.text.split(input.turnMarker).length - 1
    const stableHead = summarizeConversationHead(
      stableEntries,
      Number.isInteger(input.binding.messageCount) ? input.binding.messageCount + 2 : undefined,
    )
    const firstHead = summarizeConversationHead(
      entries,
      Number.isInteger(input.binding.messageCount) ? input.binding.messageCount + 2 : undefined,
    )
    if (
      stableHead.fingerprint !== firstHead.fingerprint
      || stableHead.lastMessageId !== response.messageId
      || stableEntries.length !== entries.length
      || stablePrompt?.role !== "user"
      || stablePromptMarkerCount !== 1
    ) {
      humanRequired("bound_reconciliation_unstable", "The late response head changed while reconciliation was being observed.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    emit({
      ok: true,
      result: {
        canonicalUrl: normalizeUrl(inspection.info.url),
        head: stableHead,
        responseDigest: response.contentDigest,
        responseText: response.text,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
        turnMarker: input.turnMarker,
      },
    })
  }

  async function exchange() {
    const selected = await selectConversation(input.binding)
    if (!selected) {
      return
    }
    const generationRunning = await js(String.raw`Boolean(
      document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
    )`)
    if (generationRunning) {
      humanRequired("conversation_generation_in_progress", "The bound ChatGPT conversation is still generating a response.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    const beforeEntries = await readConversationEntries()
    const beforeHead = summarizeConversationHead(beforeEntries, input.binding.messageCount)
    if (input.binding.state === "unbound" && beforeHead.messageCount !== 0) {
      humanRequired("unbound_conversation_not_empty", "The create-once page already contains conversation messages.", {
        messageCount: beforeHead.messageCount,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    if (input.binding.state === "bound") {
      if (!input.binding.headFingerprint) {
        humanRequired("head_checkpoint_required", "The bound conversation needs an explicit head checkpoint before sending.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      if (!bindingMatchesHead(input.binding, beforeEntries, beforeHead)) {
        humanRequired("conversation_head_changed", "The bound conversation head changed outside the broker workflow.", {
          messageCount: beforeHead.messageCount,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
    }

    const markerLiteral = JSON.stringify(input.turnMarker)
    const beforeCount = await js(String.raw`(() => {
      const rendered = [...document.querySelectorAll('[data-message-author-role]')]
        .map((message) => String(message.innerText || ''))
        .join('\n')
      return rendered.split(${markerLiteral}).length - 1
    })()`)
    if (beforeCount !== 0) {
      humanRequired("turn_marker_already_present", "The outbound turn marker already exists in the bound conversation.", {
        markerCount: beforeCount,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const modelPolicy = await ensureMaximumModelPolicy(selected)
    if (!modelPolicy) {
      return
    }
    observedModelPolicy = modelPolicy
    const preComposeHead = await readConversationHead(input.binding.messageCount)
    if (preComposeHead.fingerprint !== beforeHead.fingerprint) {
      humanRequired("conversation_head_changed", "The bound conversation head changed while the ChatGPT model policy was being verified.", {
        messageCount: preComposeHead.messageCount,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const sendControl = await js(String.raw`(() => {
      const composers = [...document.querySelectorAll('#prompt-textarea')]
      const sendButtons = [...document.querySelectorAll('button[data-testid="send-button"]')]
      return {
        composerCount: composers.length,
        enabledSendCount: sendButtons.filter((button) => !button.disabled).length,
        sendCount: sendButtons.length,
      }
    })()`)
    if (sendControl.composerCount !== 1) {
      humanRequired("unknown_chatgpt_ui", "The ChatGPT composer could not be identified unambiguously.", sendControl)
      return
    }

    async function inspectComposedPrompt() {
      const candidates = await js(String.raw`(() => {
        const composer = document.querySelector('#prompt-textarea')
        if (!composer) {
          return []
        }
        const blockChildren = [...composer.children]
        const blockText = blockChildren.length > 0
          && blockChildren.every((child) => child.tagName === 'P')
          ? blockChildren.map((child) => String(child.textContent || '')).join('\n')
          : null
        const values = composer.matches('input, textarea')
          ? [composer.value]
          : [composer.innerText, composer.textContent, blockText]
        return [...new Set(values.filter((value) => typeof value === 'string'))]
      })()`)
      const expectedDigest = sha256(input.prompt)
      const matchingCandidates = candidates.filter((candidate) => sha256(candidate) === expectedDigest)
      return {
        candidateCount: candidates.length,
        digestMatchCount: matchingCandidates.length,
        markerCount: matchingCandidates[0]?.split(input.turnMarker).length - 1,
      }
    }

    function composedPromptIsExact(inspection) {
      return inspection.digestMatchCount === 1 && inspection.markerCount === 1
    }

    await fillInput("#prompt-textarea", input.prompt)
    const composedPrompt = await inspectComposedPrompt()
    if (!composedPromptIsExact(composedPrompt)) {
      humanRequired("compose_verification_failed", "The exact uniquely marked prompt was not present in the ChatGPT composer.", {
        ...composedPrompt,
        phase: "after_fill",
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    let sendTarget = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      sendTarget = await js(String.raw`(() => {
        const buttons = [...document.querySelectorAll('button[data-testid="send-button"]')]
        if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getClientRects().length === 0) {
          return { ok: false }
        }
        const rect = buttons[0].getBoundingClientRect()
        const x = rect.x + rect.width / 2
        const y = rect.y + rect.height / 2
        const hit = document.elementFromPoint(x, y)
        return {
          height: rect.height,
          hit: Boolean(hit && buttons[0].contains(hit)),
          ok: rect.width > 0 && rect.height > 0,
          width: rect.width,
          x,
          y,
        }
      })()`)
      if (sendTarget.ok && sendTarget.hit) {
        break
      }
      await wait(1)
    }
    if (!sendTarget.ok || !sendTarget.hit) {
      humanRequired("send_control_unavailable", "The ChatGPT send control is unavailable after composing the prompt.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const preClickPrompt = await inspectComposedPrompt()
    if (!composedPromptIsExact(preClickPrompt)) {
      humanRequired("compose_verification_failed", "The exact uniquely marked prompt changed before the ChatGPT send click.", {
        ...preClickPrompt,
        phase: "before_click",
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const sentAt = Date.now()
    // eslint-disable-next-line no-undef -- cdp is injected by the ego-browser runtime.
    await cdp("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      x: sendTarget.x,
      y: sendTarget.y,
    })
    // eslint-disable-next-line no-undef -- cdp is injected by the ego-browser runtime.
    await cdp("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x: sendTarget.x,
      y: sendTarget.y,
    })
    let sendConfirmation = null
    const sendConfirmationDeadline = Date.now() + 30_000
    while (Date.now() < sendConfirmationDeadline) {
      sendConfirmation = await js(String.raw`(() => {
        const messages = [...document.querySelectorAll('[data-message-author-role]')]
        const rendered = messages.map((message) => String(message.innerText || '')).join('\n')
        const userMessages = messages.filter(
          (message) => message.getAttribute('data-message-author-role') === 'user'
        )
        const composer = document.querySelector('#prompt-textarea')
        const draft = composer
          ? (composer.matches('input, textarea')
              ? composer.value
              : composer.innerText || composer.textContent || '')
          : ''
        return {
          draftMarkerCount: String(draft).split(${markerLiteral}).length - 1,
          renderedMarkerCount: rendered.split(${markerLiteral}).length - 1,
          userMarkerCount: userMessages.filter(
            (message) => String(message.innerText || '').includes(${markerLiteral})
          ).length,
        }
      })()`)
      if (
        sendConfirmation.renderedMarkerCount === 1
        && sendConfirmation.userMarkerCount === 1
        && sendConfirmation.draftMarkerCount === 0
      ) {
        break
      }
      if (sendConfirmation.renderedMarkerCount > 1 || sendConfirmation.userMarkerCount > 1) {
        break
      }
      await wait(1)
    }
    if (
      sendConfirmation?.renderedMarkerCount !== 1
      || sendConfirmation.userMarkerCount !== 1
      || sendConfirmation.draftMarkerCount !== 0
    ) {
      humanRequired("send_confirmation_ambiguous", "The send click may have occurred, but the unique turn marker was not confirmed exactly once.", {
        draftMarkerCount: sendConfirmation?.draftMarkerCount ?? null,
        renderedMarkerCount: sendConfirmation?.renderedMarkerCount ?? null,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
        userMarkerCount: sendConfirmation?.userMarkerCount ?? null,
      })
      return
    }
    let postSendInfo = await pageInfo()
    const canonicalDeadline = Math.min(sentAt + input.timeoutMs, Date.now() + 30_000)
    while (!isCanonicalConversationUrl(postSendInfo.url) && Date.now() < canonicalDeadline) {
      await wait(1)
      postSendInfo = await pageInfo()
    }
    if (!isCanonicalConversationUrl(postSendInfo.url)) {
      humanRequired("canonical_conversation_missing", "The marked prompt appeared, but ChatGPT did not expose a canonical conversation URL.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    const canonicalUrl = normalizeUrl(postSendInfo.url)
    if (input.binding.state === "bound" && canonicalUrl !== normalizeUrl(input.binding.canonicalUrl)) {
      humanRequired("canonical_conversation_changed", "The send landed outside the bound canonical ChatGPT conversation.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    let stableText = null
    let stableCount = 0
    while (Date.now() - sentAt < input.timeoutMs) {
      const state = await js(String.raw`(() => {
        const messages = [...document.querySelectorAll('[data-message-author-role]')]
        const marker = ${markerLiteral}
        const markerIndex = messages.findIndex((message) => message.innerText.includes(marker))
        const laterAssistant = markerIndex === -1
          ? []
          : messages.slice(markerIndex + 1).filter(
              (message) => message.getAttribute('data-message-author-role') === 'assistant'
            )
        const lastAssistant = laterAssistant.at(-1)
        const composer = document.querySelector('#prompt-textarea')
        const running = Boolean(
          document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
        )
        return {
          assistantText: lastAssistant ? lastAssistant.innerText.trim() : '',
          composerAvailable: Boolean(composer) && !composer.hasAttribute('disabled'),
          markerCount: messages
            .map((message) => String(message.innerText || ''))
            .join('\n')
            .split(marker).length - 1,
          running,
        }
      })()`)

      if (state.markerCount !== 1) {
        humanRequired("marker_count_changed", "The unique outbound marker no longer appears exactly once.", {
          markerCount: state.markerCount,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }

      const terminal = !state.running
        && state.composerAvailable
        && state.assistantText.includes(input.expectedTerminalMarker)
      if (terminal && state.assistantText === stableText) {
        stableCount += 1
      } else if (terminal) {
        stableText = state.assistantText
        stableCount = 1
      } else {
        stableText = null
        stableCount = 0
      }

      if (stableCount >= 2) {
        const finishedInfo = await pageInfo()
        if (normalizeUrl(finishedInfo.url) !== canonicalUrl) {
          humanRequired("canonical_conversation_changed", "The bound conversation URL changed before capture completed.", {
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          })
          return
        }
        const finishedEntries = await readConversationEntries()
        const anchorIndex = beforeHead.lastMessageId === null
          ? -1
          : finishedEntries.findIndex((entry) => entry.messageId === beforeHead.lastMessageId)
        const committed = beforeHead.lastMessageId === null
          ? finishedEntries
          : finishedEntries.slice(anchorIndex + 1)
        const anchor = anchorIndex === -1 ? null : finishedEntries[anchorIndex]
        const userMarkerCount = committed[0]?.text.split(input.turnMarker).length - 1
        const renderedMarkerCount = finishedEntries.reduce(
          (count, entry) => count + entry.text.split(input.turnMarker).length - 1,
          0,
        )
        const terminalCount = committed[1]?.text.split(input.expectedTerminalMarker).length - 1
        const responseEndsWithTerminal = committed[1]?.text
          .trimEnd()
          .endsWith(input.expectedTerminalMarker) ?? false
        const promptDigestMatches = committed[0]?.contentDigest === sha256(input.prompt)
        const attributablePair = (
          (beforeHead.lastMessageId === null || (
            anchorIndex >= 0
            && anchor?.contentDigest === beforeHead.lastContentDigest
            && anchor?.role === beforeHead.lastRole
          ))
          && committed.length === 2
          && committed[0]?.role === "user"
          && committed[1]?.role === "assistant"
          && Boolean(committed[0]?.messageId)
          && Boolean(committed[1]?.messageId)
          && committed[0].messageId !== committed[1].messageId
          && userMarkerCount === 1
          && renderedMarkerCount === 1
          && terminalCount === 1
          && responseEndsWithTerminal
        )
        const finishedHead = summarizeConversationHead(
          finishedEntries,
          Number.isInteger(input.binding.messageCount) ? input.binding.messageCount + 2 : undefined,
        )
        if (!attributablePair || finishedHead.lastRole !== "assistant") {
          humanRequired("conversation_head_commit_mismatch", "The completed turn did not produce exactly one attributable user/assistant pair.", {
            anchorFound: anchorIndex >= 0,
            committedCount: committed.length,
            promptDigestMatches,
            promptMarkerCount: Number.isInteger(userMarkerCount) ? userMarkerCount : null,
            promptRole: committed[0]?.role ?? null,
            renderedMessageCount: finishedHead.renderedMessageCount,
            renderedMarkerCount,
            responseEndsWithTerminal,
            responseRole: committed[1]?.role ?? null,
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
            terminalCount: Number.isInteger(terminalCount) ? terminalCount : null,
          })
          return
        }
        emit({
          ok: true,
          result: {
            canonicalUrl: normalizeUrl(finishedInfo.url),
            durationMs: Date.now() - sentAt,
            head: finishedHead,
            modelPolicy,
            responseDigest: sha256(stableText),
            responseText: stableText,
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
            turnMarker: input.turnMarker,
          },
        })
        return
      }
      await wait(5)
    }

    humanRequired("completion_timeout_after_confirmed_send", "The prompt was sent once, but a stable terminal response was not captured before the deadline.", {
      targetId: selected.targetId,
      taskSpaceId: selected.task.id,
      turnMarker: input.turnMarker,
    })
  }

  try {
    if (input.mode === "preflight") {
      await preflight()
    } else if (input.mode === "adopt") {
      await adopt()
    } else if (input.mode === "bind") {
      await bind()
    } else if (input.mode === "exchange") {
      await exchange()
    } else if (input.mode === "model_policy") {
      const selected = await selectConversation(input.binding)
      if (!selected) {
        return
      }
      const generationRunning = await js(String.raw`Boolean(
        document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
      )`)
      if (generationRunning) {
        humanRequired("conversation_generation_in_progress", "The bound conversation is still generating a response.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      const modelPolicy = await ensureMaximumModelPolicy(selected)
      if (modelPolicy) {
        emit({ ok: true, result: modelPolicy })
      }
    } else if (input.mode === "reconcile") {
      await reconcile()
    } else if (input.mode === "reconcile_bound") {
      await reconcileBound()
    } else if (input.mode === "verify") {
      const selected = await selectConversation(input.binding)
      if (!selected) {
        return
      }
      const generationRunning = await js(String.raw`Boolean(
        document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
      )`)
      if (generationRunning) {
        humanRequired("conversation_generation_in_progress", "The bound conversation is still generating a response.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      const entries = await readConversationEntries()
      const head = summarizeConversationHead(entries, input.binding.messageCount)
      if (input.binding.headFingerprint && !bindingMatchesHead(input.binding, entries, head)) {
        humanRequired("conversation_head_changed", "The bound conversation head changed outside the broker workflow.", {
          messageCount: head.messageCount,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      emit({
        ok: true,
        result: {
          canonicalUrl: normalizeUrl(selected.inspection.info.url),
          head,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        },
      })
    } else {
      throw new Error("Unsupported driver mode")
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const controlRequired = /user is controlling|inactive|not assigned to an agent/i.test(message)
    if (controlRequired) {
      humanRequired("browser_control_unavailable", "The Ego task space is under user control or inactive.", {})
    } else {
      emit({
        error: {
          code: "ego_driver_error",
          diagnosticDigest: sha256(message),
          message: "The fixed Ego Browser driver failed.",
        },
        ok: false,
      })
    }
  }
}

export const EGO_DRIVER_SOURCE = `(${egoDriverMain.toString()})()\n`
