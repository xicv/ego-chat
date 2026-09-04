import {
  BROWSER_CONTRACT_REVISION,
  MAX_DRIVER_INPUT_BYTES,
} from "./constants.mjs"

export const EGO_DRIVER_RESULT_PREFIX = "__EGO_CHAT_DRIVER_RESULT__"

async function egoDriverMain(
  inputPathOverride = undefined,
  expectedBrowserContractRevision = undefined,
  inputMaxBytes = undefined,
) {
  const fsConstants = (await import("node:fs")).constants
  const fs = await import("node:fs/promises")
  const crypto = await import("node:crypto")
  const path = await import("node:path")

  const resultPrefix = "__EGO_CHAT_DRIVER_RESULT__"
  const uid = typeof process.getuid === "function" ? process.getuid() : "user"
  const mailboxDirectory = `/tmp/egc-driver-${uid}`
  const inputPath = inputPathOverride ?? `${mailboxDirectory}/input.json`
  const inputNameMatch = /^input-([1-9][0-9]{0,9})-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/
    .exec(path.basename(inputPath))
  if (
    inputPathOverride !== undefined
    && (
      path.dirname(inputPath) !== mailboxDirectory
      || !inputNameMatch
    )
  ) {
    throw new Error("The Ego driver input path is outside its private mailbox.")
  }
  let inputText
  if (inputPathOverride === undefined) {
    inputText = await fs.readFile(inputPath, "utf8")
  } else {
    const handle = await fs.open(
      inputPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    try {
      const stat = await handle.stat()
      if (
        !stat.isFile()
        || stat.nlink !== 1
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (stat.mode & 0o777) !== 0o600
        || stat.size > inputMaxBytes
      ) {
        throw new Error("The Ego driver input is not a private bounded regular file.")
      }
      const linkedStat = await fs.lstat(inputPath)
      if (
        linkedStat.isSymbolicLink()
        || linkedStat.dev !== stat.dev
        || linkedStat.ino !== stat.ino
      ) {
        throw new Error("The Ego driver input pathname changed after its private open.")
      }
      await fs.unlink(inputPath)
      inputText = await handle.readFile("utf8")
    } finally {
      await handle.close()
    }
  }
  const input = JSON.parse(inputText)
  let compositionMethod = null
  let driverStage = "initializing"
  let observedModelPolicy = null
  let promptBytes = null
  let promptCharacters = null
  let sendClickStarted = false
  let taskSpaceControlRecovery = null
  let unsentDraftMayExist = false

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

  async function assertBrokerAuthority(phase) {
    if (
      !input.brokerLease
      || typeof input.brokerLease.ownerPath !== "string"
      || typeof input.brokerLease.brokerId !== "string"
      || !Number.isSafeInteger(input.brokerLease.epoch)
      || !Number.isSafeInteger(input.brokerLease.pid)
      || input.brokerLease.pid < 1
    ) {
      humanRequired("broker_fence_missing", "The browser operation has no authoritative broker generation proof.", { phase })
      return false
    }

    let owner
    try {
      owner = JSON.parse(await fs.readFile(input.brokerLease.ownerPath, "utf8"))
    } catch (_error) {
      humanRequired("broker_fence_lost", "The authoritative broker lease disappeared during the browser operation.", { phase })
      return false
    }
    if (
      owner.brokerId !== input.brokerLease.brokerId
      || owner.epoch !== input.brokerLease.epoch
      || owner.pid !== input.brokerLease.pid
    ) {
      humanRequired("broker_fence_lost", "A newer broker generation fenced this browser operation.", {
        observedBrokerId: owner.brokerId ?? null,
        observedEpoch: owner.epoch ?? null,
        phase,
      })
      return false
    }
    try {
      process.kill(owner.pid, 0)
    } catch (error) {
      if (error?.code !== "EPERM") {
        humanRequired("broker_fence_lost", "The authoritative broker process exited during the browser operation.", {
          observedBrokerId: owner.brokerId,
          observedEpoch: owner.epoch,
          phase,
        })
        return false
      }
    }
    return true
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
      const composers = [...document.querySelectorAll('#prompt-textarea')]
      const draft = composer
        ? (composer.matches('input, textarea')
            ? composer.value
            : composer.innerText || composer.textContent || '')
        : ''
      return {
        composerCount: composers.length,
        composerSemanticId: composers.length === 1 && composers[0].id === 'prompt-textarea',
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
    const composerCount = Number.isInteger(dom.composerCount) ? dom.composerCount : (dom.hasComposer ? 1 : 0)
    const hasCaptcha = composerCount === 0 && (
      normalized.includes("captcha")
        || normalized.includes("verify you are human")
        || normalized.includes("checking your browser")
    )
    const accountState = hasCaptcha
      ? "blocked"
      : (dom.hasComposer
          && composerCount === 1
          ? "authenticated"
          : (dom.hasLoginAction ? "unauthenticated" : "unknown"))

    const canonicalDraft = String(dom.draft || '').replaceAll("\u00a0", " ")
    return {
      accountState,
      blockedReason: hasCaptcha ? "verification_challenge" : null,
      composerCount,
      composerSemanticId: dom.composerSemanticId ?? composerCount === 1,
      draftDigest: canonicalDraft.trim().length > 0 ? sha256(canonicalDraft) : null,
      draftMarkerCount: typeof input.turnMarker === "string"
        ? canonicalDraft.split(input.turnMarker).length - 1
        : 0,
      hasComposer: composerCount === 1,
      info,
      snapshotDigest: sha256(snapshot),
      unexpectedDraft: canonicalDraft.trim().length > 0,
    }
  }

  async function clearUnsentComposerDraft() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await js(String.raw`(() => {
          const composer = document.querySelector('#prompt-textarea')
          if (!composer) {
            return false
          }
          if (composer.matches('input, textarea')) {
            composer.value = ''
          } else {
            composer.replaceChildren()
          }
          composer.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward',
          }))
          return true
        })()`)
        await wait(1)
        const empty = await js(String.raw`(() => {
          const composer = document.querySelector('#prompt-textarea')
          if (!composer) {
            return false
          }
          const draft = composer.matches('input, textarea')
            ? composer.value
            : composer.innerText || composer.textContent || ''
          return String(draft).trim().length === 0
        })()`)
        if (empty) {
          unsentDraftMayExist = false
          return true
        }
      } catch (_error) {
        // A timed-out renderer mutation can still complete; the next bounded pass verifies it.
      }
      await wait(1)
    }
    return false
  }

  async function composePrompt(value) {
    const ready = await js(String.raw`(() => {
      const composer = document.querySelector('#prompt-textarea')
      if (!composer) {
        return false
      }
      const draft = composer.matches('input, textarea')
        ? composer.value
        : composer.innerText || composer.textContent || ''
      if (String(draft).trim().length > 0) {
        return false
      }
      composer.focus()
      return document.activeElement === composer
    })()`)
    if (!ready) {
      throw new Error("The verified ChatGPT composer was not empty and focusable.")
    }

    unsentDraftMayExist = true
    compositionMethod = "dom_paragraph_input"
    promptBytes = Buffer.byteLength(value, "utf8")
    promptCharacters = value.length
    const valueLiteral = JSON.stringify(value)
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029")
    driverStage = "inserting_prompt_content"
    const inserted = await js(`(() => {
      const value = ${valueLiteral}
      const composer = document.querySelector('#prompt-textarea')
      if (!composer || composer.matches('input, textarea')) {
        return false
      }
      const fragment = document.createDocumentFragment()
      for (const line of value.split('\\n')) {
        const paragraph = document.createElement('p')
        if (line.length > 0) {
          paragraph.textContent = line
        } else {
          paragraph.appendChild(document.createElement('br'))
        }
        fragment.appendChild(paragraph)
      }
      composer.replaceChildren(fragment)
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: null,
        inputType: 'insertText',
      }))
      composer.focus()
      return document.activeElement === composer
    })()`)
    if (!inserted) {
      throw new Error("The ChatGPT rich-text composer rejected the exact prompt mutation.")
    }
    await wait(1)
  }

  async function readConversationEntries() {
    const messages = await js(String.raw`(() => {
      const messageNodes = [
        ...document.querySelectorAll('[data-message-author-role]'),
        ...[...document.querySelectorAll('section[data-turn="assistant"][data-turn-id]')]
          .filter((turn) => (
            !turn.querySelector('[data-message-author-role]')
            && turn.querySelector('[id^="image-"] img')
          )),
      ]
      messageNodes.sort((left, right) => (
        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      ))
      return messageNodes.map((message) => {
        const imageOnly = !message.hasAttribute('data-message-author-role')
        const role = imageOnly
          ? message.getAttribute('data-turn')
          : message.getAttribute('data-message-author-role')
        const content = imageOnly
          ? ''
          : role === 'user'
          ? (message.querySelector('[data-testid="collapsible-user-message-content"]')?.textContent
              ?? message.querySelector('.whitespace-pre-wrap')?.textContent
              ?? message.innerText)
          : (message.querySelector('.markdown')?.innerText ?? message.innerText)
        const attachmentIds = imageOnly
          ? [...message.querySelectorAll('[id^="image-"]')]
              .map((image) => image.id)
              .filter(Boolean)
          : []
        return {
          attachmentCount: new Set(attachmentIds).size,
          imageOnly,
          messageId: imageOnly
            ? message.getAttribute('data-turn-id')
            : message.getAttribute('data-message-id'),
          role,
          text: String(content || ''),
        }
      })
    })()`)
    return messages.map((message) => ({
      contentDigest: sha256(message.text),
      ...(message.imageOnly === true
        ? {
            attachmentCount: Number.isSafeInteger(message.attachmentCount)
              ? message.attachmentCount
              : 0,
            imageOnly: true,
          }
        : {}),
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

  function classifyHeadChange(binding, observedHead) {
    if (observedHead.renderedMessageCount === 0) {
      return "conversation_cleared"
    }
    if (observedHead.lastRole !== (binding.headRole ?? null)) {
      return Number.isInteger(binding.messageCount)
        && observedHead.renderedMessageCount > binding.messageCount
        ? "message_appended"
        : "tail_role_changed"
    }
    if (observedHead.lastMessageId === (binding.headMessageId ?? null)) {
      return observedHead.lastContentDigest !== (binding.headContentDigest ?? null)
        ? "tail_content_changed"
        : "unknown"
    }
    if (
      Number.isInteger(binding.messageCount)
      && observedHead.renderedMessageCount > binding.messageCount
    ) {
      return "message_appended"
    }
    if (observedHead.lastContentDigest === (binding.headContentDigest ?? null)) {
      return "tail_identity_changed"
    }
    return "branch_changed"
  }

  function headChangeEvidence(binding, observedHead) {
    return {
      changeKind: classifyHeadChange(binding, observedHead),
      expectedFingerprint: binding.headFingerprint,
      expectedMessageCount: Number.isInteger(binding.messageCount) ? binding.messageCount : null,
      expectedRole: binding.headRole ?? null,
      observedFingerprint: observedHead.fingerprint,
      observedRenderedMessageCount: observedHead.renderedMessageCount,
      observedRole: observedHead.lastRole,
    }
  }

  async function stabilizeBoundHead(binding, entries, head) {
    if (bindingMatchesHead(binding, entries, head)) {
      return { entries, head, state: "matched" }
    }
    await wait(1)
    const stableEntries = await readConversationEntries()
    const stableHead = summarizeConversationHead(stableEntries, binding.messageCount)
    if (bindingMatchesHead(binding, stableEntries, stableHead)) {
      return { entries: stableEntries, head: stableHead, state: "matched_after_hydration" }
    }
    if (
      stableHead.fingerprint !== head.fingerprint
      || stableHead.renderedMessageCount !== head.renderedMessageCount
    ) {
      return { entries: stableEntries, head: stableHead, state: "unstable" }
    }
    return { entries: stableEntries, head: stableHead, state: "changed" }
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

  function taskSpaceMatches(taskSpace, identifier) {
    if (typeof identifier === "number") {
      return taskSpace.id === identifier
    }
    const requested = String(identifier)
    if (taskSpace.name === requested || taskSpace.taskId === requested) {
      return true
    }
    return /^\d+$/.test(requested) && String(taskSpace.id) === requested
  }

  function boundTaskSpaceName(binding) {
    const identity = binding.key || binding.bindingKey || binding.canonicalUrl
    return `ego-chat-bound-${sha256(String(identity)).slice(0, 16)}`
  }

  function canReclaimBoundTaskSpace(binding) {
    return input.allowTaskSpaceReclaim === true
      && (
        (typeof binding.key === "string" && binding.key.length > 0)
        || (input.mode === "adopt" && typeof binding.bindingKey === "string" && binding.bindingKey.length > 0)
      )
      && ["adopt", "capture_exchange", "exchange", "reanchor", "reconcile_bound"].includes(input.mode)
  }

  async function reclaimBoundTaskSpace(taskSpace, identifier) {
    const method = taskSpace.ownership === "agentDelegatedToUser" ? "take_over" : "claim"
    if (!await assertBrokerAuthority("before_task_space_reclaim")) {
      return null
    }
    try {
      if (method === "take_over") {
        await globalThis.takeOverTaskSpace(taskSpace.id)
      } else {
        await globalThis.claimTaskSpace(taskSpace.id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      humanRequired("browser_control_reclaim_failed", "Ego Chat could not reclaim its exact bound task space before Send.", {
        diagnosticDigest: sha256(message),
        method,
        taskSpaceId: taskSpace.id,
      })
      return null
    }

    let verified = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const taskSpaces = await globalThis.listTaskSpaces()
      verified = taskSpaces.find((candidate) => (
        candidate.id === taskSpace.id && taskSpaceMatches(candidate, identifier)
      ))
      if (verified?.ownership === "agent") {
        break
      }
      if (attempt < 2) {
        await wait(1)
      }
    }
    if (verified?.ownership !== "agent") {
      humanRequired("browser_control_reclaim_failed", "Ego Chat could not verify agent control of its exact bound task space before Send.", {
        method,
        taskSpaceId: taskSpace.id,
      })
      return null
    }

    const selected = await useOrCreateTaskSpace(verified.id)
    if (selected.id !== verified.id) {
      humanRequired("browser_control_reclaim_failed", "Ego Chat selected a different task space after reclaiming browser control.", {
        method,
        taskSpaceId: taskSpace.id,
      })
      return null
    }
    taskSpaceControlRecovery = {
      method,
      taskSpaceId: verified.id,
    }
    return selected
  }

  async function useBoundTaskSpace(binding) {
    const taskSpaces = await globalThis.listTaskSpaces()
    const requested = taskSpaces.find((taskSpace) => taskSpaceMatches(taskSpace, binding.taskSpaceId))
    if (!binding.key) {
      if (requested?.ownership && requested.ownership !== "agent") {
        if (canReclaimBoundTaskSpace(binding)) {
          return reclaimBoundTaskSpace(requested, binding.taskSpaceId)
        }
        humanRequired("browser_control_unavailable", "The bound Ego task space is under user control or inactive.", {
          taskSpaceId: requested.id,
        })
        return null
      }
      return useOrCreateTaskSpace(requested?.id ?? binding.taskSpaceId)
    }
    const fallbackName = boundTaskSpaceName(binding)
    const fallback = taskSpaces.find((taskSpace) => taskSpaceMatches(taskSpace, fallbackName))
    if (
      fallback
      && Object.hasOwn(fallback, "ownership")
      && fallback.ownership !== "agent"
    ) {
      if (canReclaimBoundTaskSpace(binding)) {
        return reclaimBoundTaskSpace(fallback, fallbackName)
      }
      humanRequired("browser_control_unavailable", "The bound Ego task space is under user control or inactive.", {
        taskSpaceId: fallback.id,
      })
      return null
    }
    return useOrCreateTaskSpace(fallback?.id ?? fallbackName)
  }

  function isExactOwnedUnsentDraft(inspection) {
    return input.mode === "reconcile_bound"
      && input.allowDeliveryAbsent === true
      && inspection.unexpectedDraft === true
      && typeof input.inputDigest === "string"
      && inspection.draftDigest === input.inputDigest
      && inspection.draftMarkerCount === 1
  }

  function assertReady(inspection, selected) {
    if (!isChatGptOrigin(inspection.info.url)) {
      humanRequired("unexpected_origin", "The selected tab is no longer on ChatGPT.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return false
    }
    if (inspection.accountState === "unknown") {
      humanRequired(
        "page_state_unresolved",
        "ChatGPT page readiness could not be established.",
        {
          accountState: inspection.accountState,
          composerCount: inspection.composerCount,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        },
      )
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
    if (inspection.unexpectedDraft && !isExactOwnedUnsentDraft(inspection)) {
      humanRequired("unexpected_draft", "The selected ChatGPT composer contains an unexpected draft.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return false
    }
    return true
  }

  async function waitForReadyInspection() {
    const configuredTimeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 10_000
    const deadline = Date.now() + Math.max(0, Math.min(configuredTimeoutMs, 10_000))
    let inspection = await inspectPage()
    let consecutiveUnauthenticated = inspection.accountState === "unauthenticated" ? 1 : 0
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (
        inspection.accountState === "authenticated"
        || inspection.accountState === "blocked"
        || consecutiveUnauthenticated >= 2
      ) {
        break
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        break
      }
      await wait(Math.min(1, remainingMs / 1_000))
      inspection = await inspectPage()
      consecutiveUnauthenticated = inspection.accountState === "unauthenticated"
        ? consecutiveUnauthenticated + 1
        : 0
    }
    if (
      inspection.accountState === "authenticated"
      || inspection.accountState === "blocked"
      || consecutiveUnauthenticated >= 2
    ) {
      return inspection
    }
    return { ...inspection, accountState: "unknown" }
  }

  function safePolicyLabel(value) {
    return typeof value === "string"
      && value.length > 0
      && value.length <= 120
      && !/[\u0000-\u001F\u007F]/.test(value)
  }

  async function inspectModelPolicyTrigger() {
    return js(String.raw`(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length > 0)
      const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ')
      const composer = document.querySelector('#prompt-textarea')
      const root = composer?.closest('form') || composer?.parentElement?.parentElement?.parentElement || document
      const classPills = [...root.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]')]
        .filter(visible)
      const semanticPills = classPills.length > 0
        ? classPills
        : [...root.querySelectorAll('button[aria-haspopup="menu"]')]
            .filter(visible)
            .filter((element) => (
              element.getAttribute('data-testid') !== 'composer-plus-btn'
              && clean(element.innerText || element.textContent).length > 0
            ))
      return {
        count: semanticPills.length,
        expanded: semanticPills[0]?.getAttribute('aria-expanded') === 'true',
        label: clean(semanticPills[0]?.innerText || semanticPills[0]?.textContent),
        selectorKind: classPills.length === 1 ? 'composer_pill' : 'semantic_menu_button',
      }
    })()`)
  }

  async function focusModelPolicyTrigger() {
    return js(String.raw`(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length > 0)
      const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ')
      const composer = document.querySelector('#prompt-textarea')
      const root = composer?.closest('form') || composer?.parentElement?.parentElement?.parentElement || document
      const classPills = [...root.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]')]
        .filter(visible)
      const pills = classPills.length > 0
        ? classPills
        : [...root.querySelectorAll('button[aria-haspopup="menu"]')]
            .filter(visible)
            .filter((element) => (
              element.getAttribute('data-testid') !== 'composer-plus-btn'
              && clean(element.innerText || element.textContent).length > 0
            ))
      if (pills.length !== 1) {
        return false
      }
      pills[0].focus()
      return document.activeElement === pills[0]
    })()`)
  }

  async function settleComposerFocusForPolicyMenu() {
    const settled = await js(String.raw`(() => {
      const composer = document.querySelector('#prompt-textarea')
      if (!composer) {
        return { blurred: false, ok: false }
      }
      const active = document.activeElement
      if (active !== composer && !composer.contains(active)) {
        return { blurred: false, ok: true }
      }
      composer.blur()
      return {
        blurred: true,
        ok: document.activeElement !== composer && !composer.contains(document.activeElement),
      }
    })()`)
    if (settled.blurred) {
      await wait(1)
    }
    return settled.ok
  }

  async function inspectModelPolicyMenu() {
    return js(String.raw`(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length > 0)
      const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ')
      const composer = document.querySelector('#prompt-textarea')
      const root = composer?.closest('form') || composer?.parentElement?.parentElement?.parentElement || document
      const classPills = [...root.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]')]
        .filter(visible)
      const pills = classPills.length > 0
        ? classPills
        : [...root.querySelectorAll('button[aria-haspopup="menu"]')]
            .filter(visible)
            .filter((element) => (
              element.getAttribute('data-testid') !== 'composer-plus-btn'
              && clean(element.innerText || element.textContent).length > 0
            ))
      if (pills.length !== 1) {
        return { ok: false, pillCount: pills.length, reason: 'policy_trigger_count' }
      }

      const pill = pills[0]
      const menuId = pill.getAttribute('aria-controls')
      const controlledMenu = menuId ? document.getElementById(menuId) : null
      const policyMenus = [...document.querySelectorAll('[role="menu"]')]
        .filter(visible)
        .filter((menu) => menu.querySelector('[role="menuitem"][aria-label="Power"]'))
      const menu = visible(controlledMenu) && controlledMenu.querySelector('[role="menuitem"][aria-label="Power"]')
        ? controlledMenu
        : policyMenus.length === 1 ? policyMenus[0] : null
      if (pill.getAttribute('aria-expanded') !== 'true' || !visible(menu)) {
        return {
          ok: false,
          policyMenuCount: policyMenus.length,
          reason: 'policy_menu_not_open',
        }
      }

      const powerItems = [...menu.querySelectorAll('[role="menuitem"][aria-label="Power"]')]
        .filter(visible)
      const sliders = powerItems.length === 1
        ? [...powerItems[0].querySelectorAll('[role="slider"]')].filter(visible)
        : []
      const slider = sliders[0]
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
      const menuItems = [...menu.querySelectorAll('[role="menuitem"]')].filter(visible)
      const rows = menuItems
        .filter((row) => row.getAttribute('aria-haspopup') === 'menu')
        .map((row) => clean(row.innerText || row.textContent))
      const modelRows = rows.filter((row) => row.startsWith('Model '))
      const effortRows = rows.filter((row) => row.startsWith('Effort '))
      const modelTriggers = menuItems.filter((row) => row.getAttribute('aria-label') === 'Select model')
      const modelChoices = [...menu.querySelectorAll('[role="menuitemradio"]')]
        .filter(visible)
        .filter((row) => row.getAttribute('aria-disabled') !== 'true')
      const modelChoiceLines = modelChoices.map((row) => String(row.innerText || row.textContent || '')
        .split('\n')
        .map(clean)
        .filter(Boolean))
      const modelLabels = modelChoiceLines.map((lines) => lines[0] || '')
      const selectedModelIndexes = modelChoices
        .map((row, index) => row.getAttribute('aria-checked') === 'true' ? index : -1)
        .filter((index) => index >= 0)
      const automaticModelIndexes = modelChoiceLines
        .map((lines, index) => {
          const label = lines[0] || ''
          const description = clean(lines.slice(1).join(' '))
          const automatic = /^(?:auto|default)$/i.test(label)
            || /(?:frontier models|recommended selection|automatic model selection)/i.test(description)
          return automatic ? index : -1
        })
        .filter((index) => index >= 0)
      const strongestModelIndex = automaticModelIndexes.length === 0
        ? 0
        : automaticModelIndexes.length === 1
          && automaticModelIndexes[0] === 0
          && modelChoices.length > 1
          ? 1
          : null

      if (
        powerItems.length !== 1
        || sliders.length !== 1
        || !Number.isInteger(minimum)
        || !Number.isInteger(maximum)
        || !Number.isInteger(current)
        || minimum < 0
        || current < minimum
        || maximum < current
        || maximum - minimum + 1 > 20
      ) {
        return {
          current,
          effortRowCount: effortRows.length,
          maximum,
          minimum,
          modelRowCount: modelRows.length,
          ok: false,
          powerItemCount: powerItems.length,
          sliderCount: sliders.length,
          reason: 'policy_menu_structure',
        }
      }

      if (modelRows.length === 1 && effortRows.length === 1 && modelTriggers.length === 0) {
        return {
          current,
          effortLabel: effortRows[0].slice('Effort '.length).trim(),
          maximum,
          minimum,
          modelLabel: modelRows[0].slice('Model '.length).trim(),
          ok: true,
          pillLabel: clean(pill.innerText || pill.textContent),
          policyVariant: 'coupled_power',
        }
      }

      if (modelTriggers.length === 1 && modelRows.length === 0 && effortRows.length === 0) {
        const modelChoicesOpen = modelChoices.length > 0
        const modelLabelsValid = !modelChoicesOpen || (
          modelChoices.length <= 20
          && selectedModelIndexes.length === 1
          && modelLabels.every((label) => (
            label.length > 0
            && label.length <= 120
            && !/[\u0000-\u001F\u007F]/.test(label)
          ))
          && new Set(modelLabels).size === modelLabels.length
          && Number.isInteger(strongestModelIndex)
        )
        if (!modelLabelsValid) {
          return {
            modelChoiceCount: modelChoices.length,
            ok: false,
            reason: 'policy_model_choices',
            selectedModelCount: selectedModelIndexes.length,
          }
        }
        return {
          current,
          effortLabel: clean(modelTriggers[0].innerText || modelTriggers[0].textContent),
          maximum,
          minimum,
          modelChoiceCount: modelChoices.length,
          modelChoicesOpen,
          modelLabel: modelChoicesOpen ? modelLabels[selectedModelIndexes[0]] : null,
          ok: true,
          pillLabel: clean(pill.innerText || pill.textContent),
          policyVariant: 'separate_model',
          selectedModelIndex: modelChoicesOpen ? selectedModelIndexes[0] : null,
          strongestModelIndex: modelChoicesOpen ? strongestModelIndex : null,
        }
      }

      return {
        effortRowCount: effortRows.length,
        modelChoiceCount: modelChoices.length,
        modelRowCount: modelRows.length,
        modelTriggerCount: modelTriggers.length,
        ok: false,
        reason: 'policy_model_structure',
      }
    })()`)
  }

  async function waitForModelPolicyMenu(requireModelChoices = false) {
    let inspection
    for (let attempt = 0; attempt < 5; attempt += 1) {
      inspection = await inspectModelPolicyMenu()
      if (
        inspection.ok
        && (!requireModelChoices || inspection.policyVariant !== "separate_model" || inspection.modelChoicesOpen)
      ) {
        return inspection
      }
      await wait(1)
    }
    return inspection
  }

  async function closeModelPolicyMenu() {
    let composerDismissalAttempted = false
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = await js(String.raw`(() => {
        const visible = (element) => Boolean(element && element.getClientRects().length > 0)
        const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ')
        const composer = document.querySelector('#prompt-textarea')
        const root = composer?.closest('form') || composer?.parentElement?.parentElement?.parentElement || document
        const classPills = [...root.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]')]
          .filter(visible)
        const pills = classPills.length > 0
          ? classPills
          : [...root.querySelectorAll('button[aria-haspopup="menu"]')]
              .filter(visible)
              .filter((element) => (
                element.getAttribute('data-testid') !== 'composer-plus-btn'
                && clean(element.innerText || element.textContent).length > 0
              ))
        const policyMenus = [...document.querySelectorAll('[role="menu"]')]
          .filter(visible)
          .filter((menu) => (
            menu.querySelector('[role="menuitem"][aria-label="Power"]')
            || menu.querySelector('[role="menuitemradio"]')
          ))
        return {
          composerCount: document.querySelectorAll('#prompt-textarea').length,
          count: pills.length,
          expanded: pills[0]?.getAttribute('aria-expanded'),
          policyMenuCount: policyMenus.length,
          selectorKind: classPills.length === 1 ? 'composer_pill' : 'semantic_menu_button',
          visibleModelChoiceCount: [...document.querySelectorAll('[role="menuitemradio"]')]
            .filter(visible).length,
        }
      })()`)
      if (
        state.count === 1
        && state.expanded === "false"
        && state.policyMenuCount === 0
        && state.visibleModelChoiceCount === 0
      ) {
        return true
      }
      if (state.count === 1 && state.expanded === "true") {
        if (state.selectorKind === "composer_pill") {
          await click('button.__composer-pill[aria-haspopup="menu"]', { label: "close ChatGPT policy menu" })
        } else {
          const focused = await focusModelPolicyTrigger()
          if (!focused) {
            await wait(1)
            continue
          }
          await pressKey("ENTER")
        }
        await wait(1)
        continue
      }
      if (state.policyMenuCount > 0 || state.visibleModelChoiceCount > 0) {
        await pressKey("ESCAPE")
        await wait(1)
        continue
      }
      if (state.count !== 1 || state.composerCount !== 1 || composerDismissalAttempted) {
        await wait(1)
        continue
      }
      await click('#prompt-textarea', { label: "dismiss ChatGPT policy menu" })
      composerDismissalAttempted = true
      await wait(1)
    }
    return false
  }

  async function focusPolicyMenuItem(ariaLabel) {
    const labelLiteral = JSON.stringify(ariaLabel)
    return js(String.raw`(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length > 0)
      const items = [...document.querySelectorAll('[role="menuitem"]')]
        .filter(visible)
        .filter((element) => element.getAttribute('aria-label') === ${labelLiteral})
      if (items.length !== 1) {
        return false
      }
      items[0].focus()
      return document.activeElement === items[0]
    })()`)
  }

  async function focusModelChoice(index) {
    if (!Number.isInteger(index) || index < 0 || index >= 20) {
      return false
    }
    const indexLiteral = JSON.stringify(index)
    return js(String.raw`(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length > 0)
      const choices = [...document.querySelectorAll('[role="menuitemradio"]')]
        .filter(visible)
        .filter((element) => element.getAttribute('aria-disabled') !== 'true')
      const choiceIndex = ${indexLiteral}
      if (choices.length < 1 || choices.length > 20 || choiceIndex >= choices.length) {
        return false
      }
      choices[choiceIndex].focus()
      return document.activeElement === choices[choiceIndex]
    })()`)
  }

  async function openModelPolicyState(requireModelChoices = true) {
    let trigger = await inspectModelPolicyTrigger()
    if (trigger.count !== 1 || !safePolicyLabel(trigger.label)) {
      return { ok: false, reason: "policy_trigger_count", trigger }
    }
    if (!trigger.expanded) {
      if (!await settleComposerFocusForPolicyMenu()) {
        return { ok: false, reason: "policy_composer_blur", trigger }
      }
      trigger = await inspectModelPolicyTrigger()
      if (trigger.count !== 1 || !safePolicyLabel(trigger.label)) {
        return { ok: false, reason: "policy_trigger_changed", trigger }
      }
      if (trigger.selectorKind === "composer_pill") {
        await click('button.__composer-pill[aria-haspopup="menu"]', { label: "open ChatGPT policy menu" })
      } else {
        const focused = await focusModelPolicyTrigger()
        if (!focused) {
          return { ok: false, reason: "policy_trigger_focus", trigger }
        }
        await pressKey("ENTER")
      }
      await wait(1)
      const postActivationTrigger = await inspectModelPolicyTrigger()
      if (
        trigger.selectorKind === "composer_pill"
        && postActivationTrigger.count === 1
        && !postActivationTrigger.expanded
      ) {
        await click('button.__composer-pill[aria-haspopup="menu"]', { label: "retry ChatGPT policy menu" })
        await wait(1)
      }
    }

    let state = await waitForModelPolicyMenu()
    if (!state.ok) {
      return { ok: false, reason: state.reason, state, trigger }
    }
    if (requireModelChoices && state.policyVariant === "separate_model" && !state.modelChoicesOpen) {
      const focused = await focusPolicyMenuItem("Select model")
      if (!focused) {
        return { ok: false, reason: "policy_model_trigger_focus", state, trigger }
      }
      await pressKey("ENTER")
      await wait(1)
      state = await waitForModelPolicyMenu(true)
      if (!state.ok || !state.modelChoicesOpen) {
        return { ok: false, reason: state.reason ?? "policy_model_choices_closed", state, trigger }
      }
    }
    return { ok: true, state, trigger }
  }

  async function openStableModelPolicyState(requireModelChoices = true) {
    const first = await openModelPolicyState(requireModelChoices)
    if (first.ok) {
      return first
    }
    if (!await closeModelPolicyMenu()) {
      return { ...first, reason: "policy_menu_recovery_close" }
    }
    await wait(1)
    return openModelPolicyState(requireModelChoices)
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

    let opened = await openStableModelPolicyState()
    if (!opened.ok) {
      await closeModelPolicyMenu()
      humanRequired("model_policy_ui_unknown", "The ChatGPT maximum-power menu did not expose a safe semantic policy control.", {
        reason: opened.reason,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }
    const before = opened.state
    let adjusted = false
    if (
      before.policyVariant === "separate_model"
      && before.selectedModelIndex !== before.strongestModelIndex
    ) {
      const focused = await focusModelChoice(before.strongestModelIndex)
      if (!focused) {
        await closeModelPolicyMenu()
        humanRequired("model_policy_ui_unknown", "The strongest ChatGPT model choice could not receive safe keyboard input.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return null
      }
      await pressKey("ENTER")
      adjusted = true
      await wait(1)
      if (!await closeModelPolicyMenu()) {
        humanRequired("model_policy_ui_unknown", "The ChatGPT model policy menu did not close after selecting the strongest model.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return null
      }
      opened = await openStableModelPolicyState()
      if (!opened.ok) {
        await closeModelPolicyMenu()
        humanRequired("model_policy_ui_unknown", "The strongest ChatGPT model choice could not be verified after selection.", {
          reason: opened.reason,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return null
      }
    }

    const currentState = opened.state
    if (currentState.current < currentState.maximum) {
      const focused = await focusPolicyMenuItem("Power")
      if (!focused) {
        await closeModelPolicyMenu()
        humanRequired("model_policy_ui_unknown", "The ChatGPT maximum-power control could not receive safe keyboard input.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return null
      }
      for (let step = currentState.current; step < currentState.maximum; step += 1) {
        await pressKey("ARROWRIGHT")
      }
      adjusted = true
      await wait(1)
    }

    if (!await closeModelPolicyMenu()) {
      humanRequired("model_policy_ui_unknown", "The ChatGPT model policy menu did not close cleanly before final verification.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }
    const afterRead = adjusted ? await openStableModelPolicyState() : opened
    const after = afterRead.state
    const labelsValid = afterRead.ok
      && safePolicyLabel(after.modelLabel)
      && safePolicyLabel(after.effortLabel)
      && (
        after.policyVariant !== "separate_model"
        || after.selectedModelIndex === after.strongestModelIndex
      )
    if (!labelsValid || after.current !== after.maximum) {
      await closeModelPolicyMenu()
      humanRequired("model_policy_mismatch", "ChatGPT did not confirm its strongest available model and maximum thinking setting.", {
        modelCount: after?.modelChoiceCount ?? null,
        modelPosition: Number.isInteger(after?.selectedModelIndex) ? after.selectedModelIndex + 1 : null,
        strongestModelPosition: Number.isInteger(after?.strongestModelIndex)
          ? after.strongestModelIndex + 1
          : null,
        powerLevel: after?.ok ? after.current - after.minimum + 1 : null,
        powerMax: after?.ok ? after.maximum - after.minimum + 1 : null,
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

    const finalTrigger = await inspectModelPolicyTrigger()
    const pillLabel = finalTrigger.count === 1 && !finalTrigger.expanded
      ? finalTrigger.label
      : null
    if (!safePolicyLabel(pillLabel)) {
      humanRequired("model_policy_ui_unknown", "The closed ChatGPT model policy control could not be read safely.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    return {
      adjusted,
      effortLabel: after.policyVariant === "separate_model" ? pillLabel : after.effortLabel,
      key: policy.key,
      modelLabel: after.modelLabel,
      pillLabel,
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

    const opened = await openStableModelPolicyState()
    const observed = opened.state
    const closed = await closeModelPolicyMenu()
    const finalTrigger = closed ? await inspectModelPolicyTrigger() : null
    const pillLabel = finalTrigger?.count === 1 && !finalTrigger.expanded
      ? finalTrigger.label
      : null
    const labelsValid = opened.ok
      && safePolicyLabel(observed.modelLabel)
      && safePolicyLabel(observed.effortLabel)
      && safePolicyLabel(pillLabel)
    if (!labelsValid || !closed) {
      humanRequired("model_policy_ui_unknown", "The ChatGPT maximum-power policy could not be read safely immediately before Send.", {
        reason: opened.reason ?? null,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    const powerLevel = observed.current - observed.minimum + 1
    const powerMax = observed.maximum - observed.minimum + 1
    if (
      observed.current !== observed.maximum
      || (
        observed.policyVariant === "separate_model"
        && observed.selectedModelIndex !== observed.strongestModelIndex
      )
    ) {
      humanRequired("model_policy_mismatch", "ChatGPT no longer shows its strongest available model and maximum thinking immediately before Send.", {
        effortLabel: observed.effortLabel,
        modelCount: observed.modelChoiceCount ?? null,
        modelLabel: observed.modelLabel,
        modelPosition: Number.isInteger(observed.selectedModelIndex) ? observed.selectedModelIndex + 1 : null,
        strongestModelPosition: Number.isInteger(observed.strongestModelIndex)
          ? observed.strongestModelIndex + 1
          : null,
        powerLevel,
        powerMax,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return null
    }

    return {
      adjusted: false,
      effortLabel: observed.policyVariant === "separate_model" ? pillLabel : observed.effortLabel,
      key: policy.key,
      modelLabel: observed.modelLabel,
      pillLabel,
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
      const inspection = await waitForReadyInspection()
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

    const task = await useBoundTaskSpace(binding)
    if (!task) {
      return null
    }
    const expectedUrl = normalizeUrl(binding.canonicalUrl)
    const tabs = await listTabs()
    const boundTab = tabs.find((candidate) => candidate.targetId === binding.targetId)
    if (boundTab) {
      await switchTab(boundTab.targetId)
      const currentInfo = await pageInfo()
      if (normalizeUrl(currentInfo.url) === expectedUrl) {
        const inspection = await waitForReadyInspection()
        const selected = { inspection, tab: boundTab, targetId: boundTab.targetId, task }
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
    }

    const opened = await openOrReuseTab(expectedUrl, { timeout: 30, wait: true })
    const refreshedTabs = await listTabs()
    const activeTab = refreshedTabs.find((candidate) => candidate.targetId === opened?.targetId)
      || refreshedTabs.find((candidate) => candidate.active)
      || opened
    if (!activeTab?.targetId) {
      humanRequired("bound_conversation_open_failed", "The canonical ChatGPT conversation could not be opened.", {
        taskSpaceId: task.id,
      })
      return null
    }
    await switchTab(activeTab.targetId)
    const inspection = await waitForReadyInspection()
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

  async function captureAttachmentExecution() {
    if (input.browserContractRevision !== expectedBrowserContractRevision) {
      humanRequired("browser_contract_mismatch", "The browser driver and broker capability contracts do not match.")
      return
    }
    if (
      !/^[a-f0-9]{64}$/.test(input.captureOperationKeySha256)
      || !/^[a-f0-9]{64}$/.test(input.sourceConfirmedSendIdentitySha256)
      || typeof input.providerPromptMessageId !== "string"
      || input.providerPromptMessageId.length < 1
      || input.providerPromptMessageId.length > 200
      || !Number.isSafeInteger(input.observationSequence)
      || input.observationSequence < 1
    ) {
      humanRequired("attachment_capture_metadata_invalid", "Attachment capture metadata is incomplete or invalid.")
      return
    }
    const selected = await selectConversation(input.binding)
    if (!selected) {
      return
    }
    if (!await assertBrokerAuthority("before_attachment_observation")) {
      return
    }
    const info = await pageInfo()
    const canonicalUrl = normalizeUrl(info.url)
    if (canonicalUrl !== normalizeUrl(input.binding.canonicalUrl)) {
      humanRequired("canonical_conversation_changed", "The attachment response moved away from its bound canonical conversation.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const surface = await js(String.raw`(() => {
      const observationSchema = 'ego-chat-attachment-graph-observation/v1'
      const expectedPromptMessageId = ` + JSON.stringify(input.providerPromptMessageId) + String.raw`
      const maximumItems = 64
      const terminalStatuses = new Set([
        'finished_successfully',
        'finished',
        'complete',
        'completed',
      ])
      const statusOf = (message) => {
        const status = String(message?.status || '').toLowerCase()
        if (terminalStatuses.has(status)) return 'COMPLETE'
        if (status.includes('fail') || status.includes('error')) return 'FAILED'
        if (status.includes('progress') || status.includes('running')) return 'IN_PROGRESS'
        return 'UNKNOWN'
      }
      const turnFromNode = (node) => {
        const property = Object.getOwnPropertyNames(node)
          .find((key) => key.startsWith('__reactFiber$'))
        let fiber = property ? node[property] : null
        for (let depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
          const props = fiber.memoizedProps || fiber.pendingProps
          if (props?.turn?.messages && Array.isArray(props.turn.messages)) {
            return props.turn
          }
        }
        return null
      }
      const turnNodes = [...document.querySelectorAll('section[data-turn="assistant"][data-turn-id]')]
      const turns = turnNodes.map((node) => ({ node, turn: turnFromNode(node) }))
      const directTurns = turns.filter(({ turn }) => (
        turn
        && turn.messages.some((message) => message?.metadata?.parent_id === expectedPromptMessageId)
      ))
      const selectedTurn = directTurns.at(-1) || null
      const artifacts = []
      const artifactMessageIds = new Set()
      let pointerPresent = false
      let graphTruncated = directTurns.length > maximumItems
      let hydrationPending = selectedTurn === null
      let normalSaveControlCount = 0
      let normalDownloadControlCount = 0
      let reactSaveDownloadPropCount = 0
      let reactSurfaceOverflow = false
      const visibleActions = new Set()
      const saveAssociations = []

      const scanReactSurface = (wrapper) => {
        const roots = [wrapper, ...wrapper.querySelectorAll('*')]
          .flatMap((node) => Object.getOwnPropertyNames(node)
            .filter((key) => key.startsWith('__reactProps$'))
            .map((key) => node[key]))
        const pending = roots.map((value) => ({ depth: 0, value }))
        const seen = new WeakSet()
        let visited = 0
        while (pending.length > 0) {
          const { depth, value } = pending.shift()
          if (!value || typeof value !== 'object' || seen.has(value)) continue
          seen.add(value)
          visited += 1
          if (visited > 2048) {
            reactSurfaceOverflow = true
            return
          }
          const keys = Object.keys(value)
          if (keys.length > 100) {
            reactSurfaceOverflow = true
            return
          }
          for (const key of keys) {
            if (/^(?:on)?(?:save|download)(?:image)?$/i.test(key)) {
              reactSaveDownloadPropCount += 1
            }
            const nested = value[key]
            if (depth < 8 && nested && typeof nested === 'object') {
              pending.push({ depth: depth + 1, value: nested })
            }
          }
        }
      }

      const observeControls = (wrapper, artifact) => {
        const controls = [...wrapper.querySelectorAll('button, [role="button"], a')]
        for (const control of controls) {
          const label = String(
            control.getAttribute('aria-label')
              || control.getAttribute('title')
              || control.innerText
              || control.textContent
              || '',
          ).trim().replace(/\s+/g, ' ')
          if (!label && control.querySelector('img')) continue
          if (/^edit(?: this)? image$/i.test(label) || /^edit$/i.test(label)) {
            visibleActions.add('EDIT_IMAGE')
          } else if (/^share(?: this)? image$/i.test(label) || /^share$/i.test(label)) {
            visibleActions.add('SHARE_IMAGE')
          } else if (/^save(?: this)? image$/i.test(label) || /^save$/i.test(label)) {
            visibleActions.add('SAVE_IMAGE')
            normalSaveControlCount += 1
            saveAssociations.push(
              control.id || artifact.dom_wrapper_id + ':save:' + saveAssociations.length,
            )
          } else if (/^download(?: this)? image$/i.test(label) || /^download$/i.test(label)) {
            visibleActions.add('DOWNLOAD_IMAGE')
            normalDownloadControlCount += 1
          } else {
            visibleActions.add('UNKNOWN')
          }
        }
        scanReactSurface(wrapper)
      }

      for (const { node, turn } of directTurns.slice(0, maximumItems)) {
        for (const message of turn.messages) {
          const parts = Array.isArray(message?.content?.parts) ? message.content.parts : []
          parts.forEach((part, partIndex) => {
            if (!part || typeof part !== 'object' || typeof part.asset_pointer !== 'string') {
              return
            }
            pointerPresent = pointerPresent || part.asset_pointer.length > 0
            const contentType = String(part.content_type || '')
            const graphAttachmentId = message.id + ':part:' + partIndex
            if (contentType === 'image_asset_pointer') {
              const fileIds = part.asset_pointer.match(/file[_-][A-Za-z0-9_-]{8,200}/g) || []
              const fileId = [...new Set(fileIds)].length === 1 ? fileIds[0] : null
              const generationIds = [
                part.metadata?.generation?.gen_id,
                part.metadata?.dalle?.gen_id,
              ].filter((value) => typeof value === 'string' && value.length > 0)
              const generationId = [...new Set(generationIds)].length === 1
                ? generationIds[0]
                : null
              const wrapper = document.getElementById('image-' + message.id)
              const artifact = {
                artifact_id: generationId || fileId || graphAttachmentId,
                artifact_kind: 'GENERATED_IMAGE',
                dom_wrapper_id: wrapper?.id || null,
                file_id: fileId,
                generation_id: generationId,
                graph_attachment_id: graphAttachmentId,
                image_message_id: message.id,
              }
              artifacts.push(artifact)
              artifactMessageIds.add(message.id)
              if (!wrapper || !wrapper.querySelector('img')) {
                hydrationPending = true
              } else {
                observeControls(wrapper, artifact)
              }
            } else if (/^(?:audio|video|file)_asset_pointer$/.test(contentType)) {
              artifacts.push({
                artifact_id: graphAttachmentId,
                artifact_kind: 'NON_IMAGE',
                dom_wrapper_id: null,
                file_id: null,
                generation_id: null,
                graph_attachment_id: null,
                image_message_id: null,
              })
              artifactMessageIds.add(message.id)
            } else {
              artifacts.push({
                artifact_id: graphAttachmentId,
                artifact_kind: 'UNCLASSIFIED',
                dom_wrapper_id: null,
                file_id: null,
                generation_id: null,
                graph_attachment_id: null,
                image_message_id: null,
              })
              artifactMessageIds.add(message.id)
            }
          })
        }
        if (artifacts.length > maximumItems) graphTruncated = true
        if (node.getAttribute('data-turn-id') !== turn.id) hydrationPending = true
      }

      const selectedMessages = selectedTurn?.turn?.messages || []
      const relevantMessages = selectedMessages.filter((message) => (
        message?.id === selectedTurn?.turn?.id
        || message?.metadata?.parent_id === expectedPromptMessageId
        || artifactMessageIds.has(message?.id)
        || (message?.author?.role === 'assistant' && message?.end_turn === true)
      ))
      if (relevantMessages.length > maximumItems) graphTruncated = true
      const providerNodes = [...new Map(relevantMessages.slice(0, maximumItems).map((message) => [
        message.id,
        {
          message_id: message.id,
          parent_id: typeof message?.metadata?.parent_id === 'string'
            ? message.metadata.parent_id
            : null,
          provider_status: statusOf(message),
          terminal: statusOf(message) === 'COMPLETE',
          turn_exchange_id: typeof message?.metadata?.turn_exchange_id === 'string'
            ? message.metadata.turn_exchange_id
            : null,
        },
      ])).values()]
      const directBranchIds = [...new Set(directTurns
        .map(({ turn }) => turn?.id)
        .filter((value) => typeof value === 'string' && value.length > 0))]
        .sort()
      const continuationCursorPresent = directTurns.some(({ turn }) => (
        turn.userContinuationRootTurnId !== null
        || turn.userContinuationParentTurnId !== null
        || turn.userContinuationSuccessorTurnId !== null
      ))
      const generatedImageCount = artifacts.filter(
        (artifact) => artifact.artifact_kind === 'GENERATED_IMAGE',
      ).length
      const nonImageCount = artifacts.filter(
        (artifact) => artifact.artifact_kind === 'NON_IMAGE',
      ).length
      const unclassifiedCount = artifacts.filter(
        (artifact) => artifact.artifact_kind === 'UNCLASSIFIED',
      ).length
      const generationTerminal = (
        !document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
        && providerNodes.every((node) => node.terminal)
      )
      const saveAssociationId = (
        artifacts.length === 1
        && generatedImageCount === 1
        && normalSaveControlCount === 1
        && saveAssociations.length === 1
      ) ? saveAssociations[0] : null
      return {
        artifacts: artifacts.slice(0, maximumItems),
        asset_pointer_state: pointerPresent ? 'PRESENT_NON_CONTROL' : 'ABSENT',
        continuation_cursor_present: continuationCursorPresent,
        direct_branch_ids: directBranchIds.slice(0, maximumItems),
        direct_response_branch_count: directBranchIds.length <= maximumItems
          ? directBranchIds.length
          : null,
        generated_image_artifact_count: artifacts.length <= maximumItems
          ? generatedImageCount
          : null,
        generation_terminal: generationTerminal,
        graph_complete: directTurns.length > 0 && !graphTruncated,
        graph_truncated: graphTruncated,
        hydration_pending: hydrationPending,
        non_image_artifact_count: artifacts.length <= maximumItems ? nonImageCount : null,
        normal_download_control_count: normalDownloadControlCount <= maximumItems
          ? normalDownloadControlCount
          : null,
        normal_save_control_count: normalSaveControlCount <= maximumItems
          ? normalSaveControlCount
          : null,
        provider_nodes: providerNodes,
        react_save_download_prop_count: reactSurfaceOverflow
          || reactSaveDownloadPropCount > maximumItems
          ? null
          : reactSaveDownloadPropCount,
        response_message_id: selectedTurn?.turn?.id || null,
        save_association_id: saveAssociationId,
        selected_branch_id: selectedTurn?.turn?.id || null,
        total_artifact_count: artifacts.length <= maximumItems ? artifacts.length : null,
        ui_action_surface_complete: !reactSurfaceOverflow && !hydrationPending,
        unclassified_artifact_count: artifacts.length <= maximumItems
          ? unclassifiedCount
          : null,
        visible_attachment_actions: [...visibleActions].sort(),
      }
    })()`)
    if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
      humanRequired("attachment_observation_unavailable", "The bound response did not expose a closed attachment observation.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    if (!await assertBrokerAuthority("after_attachment_observation")) {
      return
    }
    emit({
      ok: true,
      result: {
        ...surface,
        canonical_conversation_locator_sha256: sha256(canonicalUrl),
        capture_operation_key_sha256: input.captureOperationKeySha256,
        observation_sequence: input.observationSequence,
        observed_at: new Date().toISOString(),
        provider_prompt_message_id: input.providerPromptMessageId,
        schema: "ego-chat-attachment-graph-observation/v1",
        source_confirmed_send_identity_sha256: input.sourceConfirmedSendIdentitySha256,
      },
    })
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
        browserContract: {
          composerCount: inspection.composerCount,
          composerSemanticId: inspection.composerSemanticId,
          revision: 2,
          safe: inspection.accountState === "authenticated"
            && inspection.composerCount === 1
            && inspection.composerSemanticId
            && !inspection.unexpectedDraft,
        },
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
      bindingKey: input.bindingKey,
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
    if (!await assertBrokerAuthority("before_head_commit")) {
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
      bindingKey: input.bindingKey,
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
    const initialAnchor = initialEntries[anchorIndex]
    if (!initialAnchor || !initialAnchor.messageId) {
      humanRequired("adoption_anchor_missing", "The conversation has no uniquely identifiable latest user turn to adopt.", {
        renderedMessageCount: initialEntries.length,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const adoptedWhileGenerating = await js(String.raw`Boolean(
      document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
    )`)
    let anchor = initialAnchor
    let initialPrefixFingerprint = legacyConversationFingerprint(initialEntries.slice(0, anchorIndex + 1))
    let stableAnchorIndex = anchorIndex
    let stableEntries = initialEntries
    let stableAnchorCount = 1
    while (stableAnchorCount < 2 && Date.now() - startedAt < input.timeoutMs) {
      await wait(1)
      if (Date.now() - startedAt >= input.timeoutMs) {
        break
      }
      const entries = await readConversationEntries()
      const anchorIndexes = entries
        .map((entry, index) => entry.messageId === initialAnchor.messageId ? index : -1)
        .filter((index) => index >= 0)
      const currentAnchorIndex = anchorIndexes[0] ?? -1
      const currentAnchor = currentAnchorIndex >= 0 ? entries[currentAnchorIndex] : null
      if (anchorIndexes.length !== 1 || currentAnchor?.role !== "user") {
        humanRequired("adoption_anchor_changed", "The adopted user turn changed while its initial browser rendering was stabilizing.", {
          anchorCount: anchorIndexes.length,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      const prefixFingerprint = legacyConversationFingerprint(entries.slice(0, currentAnchorIndex + 1))
      if (
        currentAnchor.contentDigest === anchor.contentDigest
        && prefixFingerprint === initialPrefixFingerprint
      ) {
        stableAnchorCount += 1
      } else {
        anchor = currentAnchor
        initialPrefixFingerprint = prefixFingerprint
        stableAnchorCount = 1
      }
      stableAnchorIndex = currentAnchorIndex
      stableEntries = entries
    }
    if (stableAnchorCount < 2) {
      humanRequired("adoption_anchor_unstable", "The adopted user turn did not reach a stable initial browser rendering before the deadline.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const initialTail = stableEntries.slice(stableAnchorIndex + 1)
    if (initialTail.length > 1 || (initialTail[0] && initialTail[0].role !== "assistant")) {
      humanRequired("adoption_tail_interleaved", "The latest user turn is not followed by at most one assistant response.", {
        committedCount: initialTail.length,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

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
        const finalInspection = await waitForReadyInspection()
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
        const modelPolicy = await ensureMaximumModelPolicy(selected)
        if (!modelPolicy) {
          return
        }
        const postPolicyInfo = await pageInfo()
        if (normalizeUrl(postPolicyInfo.url) !== canonicalUrl) {
          humanRequired("adoption_url_changed", "The ChatGPT conversation URL changed before adoption completed.", {
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          })
          return
        }
        observedModelPolicy = modelPolicy
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
        if (!await assertBrokerAuthority("before_head_commit")) {
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
    if (input.browserContractRevision !== expectedBrowserContractRevision) {
      humanRequired("browser_contract_mismatch", "The browser driver and broker capability contracts do not match.")
      return
    }
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
    if (!input.expectedTerminalMarker || !input.turnMarker) {
      humanRequired("reconciliation_metadata_missing", "Create-once reconciliation requires the exact workflow markers.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
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
    const entries = await readConversationEntries()
    const prompt = entries[0]
    const response = entries[1]
    const promptMarkerCount = prompt?.text.split(input.turnMarker).length - 1
    const renderedMarkerCount = entries.reduce(
      (count, entry) => count + entry.text.split(input.turnMarker).length - 1,
      0,
    )
    const terminalCount = response?.text.split(input.expectedTerminalMarker).length - 1
    const attributablePair = (
      entries.length === 2
      && prompt?.role === "user"
      && response?.role === "assistant"
      && Boolean(prompt?.messageId)
      && Boolean(response?.messageId)
      && prompt.messageId !== response.messageId
      && prompt.contentDigest === input.inputDigest
      && promptMarkerCount === 1
      && renderedMarkerCount === 1
      && terminalCount === 1
      && response.text.trimEnd().endsWith(input.expectedTerminalMarker)
    )
    if (!attributablePair) {
      humanRequired("reconciliation_prompt_mismatch", "The canonical conversation does not contain exactly one stable user/assistant pair attributable to the confirmed send.", {
        messageCount: entries.length,
        promptDigestMatches: prompt?.contentDigest === input.inputDigest,
        promptMarkerCount: Number.isInteger(promptMarkerCount) ? promptMarkerCount : null,
        renderedMarkerCount,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
        terminalCount: Number.isInteger(terminalCount) ? terminalCount : null,
      })
      return
    }
    const head = summarizeConversationHead(entries, 2)
    await wait(1)
    const stableEntries = await readConversationEntries()
    const stableHead = summarizeConversationHead(stableEntries, 2)
    const stablePrompt = stableEntries.find((entry) => entry.messageId === prompt.messageId)
    const stableResponse = stableEntries.find((entry) => entry.messageId === response.messageId)
    if (
      stableEntries.length !== entries.length
      || stableHead.fingerprint !== head.fingerprint
      || stableHead.lastMessageId !== response.messageId
      || stablePrompt?.contentDigest !== prompt.contentDigest
      || stableResponse?.contentDigest !== response.contentDigest
    ) {
      humanRequired("reconciliation_head_incomplete", "The reconciled first turn changed while its response was being observed.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    if (!await assertBrokerAuthority("before_head_commit")) {
      return
    }
    emit({
      ok: true,
      result: {
        canonicalUrl: normalizeUrl(inspection.info.url),
        head: stableHead,
        responseDigest: stableResponse.contentDigest,
        responseText: stableResponse.text,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
        turnMarker: input.turnMarker,
      },
    })
  }

  async function reconcileBound() {
    if (input.browserContractRevision !== expectedBrowserContractRevision) {
      humanRequired("browser_contract_mismatch", "The browser driver and broker capability contracts do not match.")
      return
    }
    const expectedCanonicalUrl = input.canonicalUrl ?? input.binding.canonicalUrl
    const selected = await selectConversation({
      ...input.binding,
      canonicalUrl: expectedCanonicalUrl,
    })
    if (!selected) {
      return
    }
    let inspection = selected.inspection
    if (isExactOwnedUnsentDraft(inspection)) {
      if (!await assertBrokerAuthority("before_owned_draft_recovery")) {
        return
      }
      const draftCleared = await clearUnsentComposerDraft()
      if (!draftCleared) {
        humanRequired("owned_draft_clear_failed", "The exact broker-owned unsent draft could not be cleared for restart recovery.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      inspection = await waitForReadyInspection()
      if (!assertReady(inspection, selected)) {
        return
      }
    }
    if (!expectedCanonicalUrl || normalizeUrl(inspection.info.url) !== normalizeUrl(expectedCanonicalUrl)) {
      humanRequired("reconciliation_url_mismatch", "The late send is not in the bound canonical conversation.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    if (
      (input.binding.state === "bound" && !input.expectedPreviousMessageId)
      || !input.expectedTerminalMarker
      || !input.turnMarker
    ) {
      humanRequired("reconciliation_metadata_missing", "Bound late-send reconciliation requires the prior head and exact workflow markers.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    let generationRunning = await js(String.raw`Boolean(
      document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
    )`)
    if (input.mode === "capture_exchange") {
      const captureDeadline = Date.now() + input.timeoutMs
      while (generationRunning && Date.now() < captureDeadline) {
        if (!await assertBrokerAuthority("capturing_confirmed_send")) {
          return
        }
        await wait(5)
        generationRunning = await js(String.raw`Boolean(
          document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
        )`)
      }
      if (generationRunning) {
        if (input.captureContinuationAllowed === true) {
          const pendingInfo = await pageInfo()
          const pendingEntries = await readConversationEntries()
          const pendingAnchorIndexes = input.expectedPreviousMessageId
            ? pendingEntries
                .map((entry, index) => entry.messageId === input.expectedPreviousMessageId ? index : -1)
                .filter((index) => index >= 0)
            : []
          const pendingAnchorIndex = pendingAnchorIndexes[0] ?? -1
          const pendingAnchor = pendingAnchorIndex >= 0 ? pendingEntries[pendingAnchorIndex] : null
          const pendingCommitted = pendingAnchorIndex >= 0
            ? pendingEntries.slice(pendingAnchorIndex + 1)
            : pendingEntries
          const pendingPrompt = pendingCommitted[0]
          const pendingAssistant = pendingCommitted[1]
          const pendingRenderedMarkerCount = pendingEntries.reduce(
            (count, entry) => count + entry.text.split(input.turnMarker).length - 1,
            0,
          )
          const pendingIdentityMatches = (
            normalizeUrl(pendingInfo.url) === normalizeUrl(expectedCanonicalUrl)
            && (input.expectedPreviousMessageId
              ? pendingAnchorIndexes.length === 1
              : pendingAnchorIndexes.length === 0)
            && (!input.expectedPreviousContentDigest
              || pendingAnchor?.contentDigest === input.expectedPreviousContentDigest)
            && (!input.binding.headRole || pendingAnchor?.role === input.binding.headRole)
            && pendingCommitted.length >= 1
            && pendingCommitted.length <= 2
            && pendingPrompt?.messageId === input.promptMessageId
            && pendingPrompt?.role === "user"
            && pendingPrompt.text.split(input.turnMarker).length - 1 === 1
            && pendingRenderedMarkerCount === 1
            && (!pendingAssistant || pendingAssistant.role === "assistant")
          )
          if (!pendingIdentityMatches) {
            humanRequired("capture_pending_identity_mismatch", "The generating response no longer follows the exact confirmed prompt and prior head.", {
              anchorCount: pendingAnchorIndexes.length,
              committedCount: pendingCommitted.length,
              promptMessageIdMatches: pendingPrompt?.messageId === input.promptMessageId,
              renderedMarkerCount: pendingRenderedMarkerCount,
              targetId: selected.targetId,
              taskSpaceId: selected.task.id,
            })
            return
          }
          emit({
            ok: true,
            result: {
              canonicalUrl: normalizeUrl(pendingInfo.url),
              captureReason: "generation_running",
              captureState: "pending",
              generationRunning: true,
              promptMessageId: pendingPrompt.messageId,
              targetId: selected.targetId,
              taskSpaceId: selected.task.id,
              turnMarker: input.turnMarker,
            },
          })
          return
        }
        humanRequired("completion_timeout_after_confirmed_send", "The confirmed prompt is still generating after the broker-owned generation deadline.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
          turnMarker: input.turnMarker,
        })
        return
      }
    } else if (generationRunning) {
      humanRequired("conversation_generation_in_progress", "The late accepted send is still generating a response.", {
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    const entries = await readConversationEntries()
    const anchorIndexes = input.expectedPreviousMessageId
      ? entries
          .map((entry, index) => entry.messageId === input.expectedPreviousMessageId ? index : -1)
          .filter((index) => index >= 0)
      : []
    const anchorIndex = anchorIndexes[0] ?? -1
    const anchor = anchorIndex >= 0 ? entries[anchorIndex] : null
    const committed = anchorIndex >= 0 ? entries.slice(anchorIndex + 1) : entries
    const prompt = committed[0]
    const response = committed[1]
    const anchorDigestMatches = !input.expectedPreviousContentDigest
      || anchor?.contentDigest === input.expectedPreviousContentDigest
    const anchorRoleMatches = !input.binding.headRole || anchor?.role === input.binding.headRole
    const promptDigestMatches = prompt?.contentDigest === input.inputDigest
    const promptMessageIdMatches = !input.promptMessageId
      || prompt?.messageId === input.promptMessageId
    const promptMarkerCount = prompt?.text.split(input.turnMarker).length - 1
    const renderedMarkerCount = entries.reduce(
      (count, entry) => count + entry.text.split(input.turnMarker).length - 1,
      0,
    )
    const terminalCount = response?.text.split(input.expectedTerminalMarker).length - 1
    const responseEndsWithTerminal = response?.text.trimEnd().endsWith(input.expectedTerminalMarker) ?? false
    const exactTerminalResponse = terminalCount === 1 && responseEndsWithTerminal
    const protocolRepairResponse = (
      input.allowProtocolRepairCapture === true
      && !exactTerminalResponse
      && typeof response?.text === "string"
      && response.text.trim().length > 0
    )
    const reviewPairReady = (
      committed.length === 2
      && prompt?.role === "user"
      && response?.role === "assistant"
      && Boolean(prompt?.messageId)
      && Boolean(response?.messageId)
      && promptMessageIdMatches
      && prompt.messageId !== response.messageId
      && (exactTerminalResponse || protocolRepairResponse)
    )
    const imageOnlyResponseReady = (
      (input.expectedPreviousMessageId ? anchorIndexes.length === 1 : anchorIndexes.length === 0)
      && anchorDigestMatches
      && anchorRoleMatches
      && committed.length === 2
      && prompt?.messageId === input.promptMessageId
      && prompt?.role === "user"
      && promptDigestMatches
      && promptMarkerCount === 1
      && response?.role === "assistant"
      && response?.imageOnly === true
      && Boolean(response.messageId)
      && response.messageId !== prompt.messageId
      && !exactTerminalResponse
    )
    if (imageOnlyResponseReady) {
      humanRequired(
        "image_only_response_without_terminal_marker",
        "The confirmed prompt produced an image-only assistant turn without the expected terminal marker.",
        {
          attachmentCount: response.attachmentCount,
          promptMessageIdMatches,
          responseMessageIdPresent: Boolean(response.messageId),
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        },
      )
      return
    }
    const incompleteCaptureCanContinue = (
      input.mode === "capture_exchange"
      && input.captureContinuationAllowed === true
      && (input.expectedPreviousMessageId ? anchorIndexes.length === 1 : anchorIndexes.length === 0)
      && anchorDigestMatches
      && anchorRoleMatches
      && committed.length >= 1
      && committed.length <= 2
      && prompt?.messageId === input.promptMessageId
      && prompt?.role === "user"
      && promptMarkerCount === 1
      && (!response || (
        response.role === "assistant"
        && (!response.messageId || response.messageId !== prompt.messageId)
        && (!Number.isInteger(terminalCount) || terminalCount <= 1)
      ))
      && !reviewPairReady
    )
    if (incompleteCaptureCanContinue) {
      const pendingInfo = await pageInfo()
      if (normalizeUrl(pendingInfo.url) !== normalizeUrl(expectedCanonicalUrl)) {
        humanRequired("reconciliation_url_mismatch", "The incomplete response moved away from the bound canonical conversation.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      emit({
        ok: true,
        result: {
          canonicalUrl: normalizeUrl(pendingInfo.url),
          captureReason: "response_not_terminal",
          captureState: "pending",
          generationRunning: false,
          promptMessageId: prompt.messageId,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
          turnMarker: input.turnMarker,
        },
      })
      return
    }
    const deliveryAbsentCandidate = (
      input.allowDeliveryAbsent === true
      && anchorIndexes.length === 1
      && anchorDigestMatches
      && anchorRoleMatches
      && committed.length === 0
      && renderedMarkerCount === 0
    )
    if (deliveryAbsentCandidate) {
      await wait(2)
      const stableEntries = await readConversationEntries()
      const stableAnchorIndexes = stableEntries
        .map((entry, index) => entry.messageId === input.expectedPreviousMessageId ? index : -1)
        .filter((index) => index >= 0)
      const stableAnchorIndex = stableAnchorIndexes[0] ?? -1
      const stableAnchor = stableAnchorIndex >= 0 ? stableEntries[stableAnchorIndex] : null
      const stableCommitted = stableAnchorIndex >= 0 ? stableEntries.slice(stableAnchorIndex + 1) : stableEntries
      const stableMarkerCount = stableEntries.reduce(
        (count, entry) => count + entry.text.split(input.turnMarker).length - 1,
        0,
      )
      const firstHead = summarizeConversationHead(entries, input.binding.messageCount)
      const stableHead = summarizeConversationHead(stableEntries, input.binding.messageCount)
      const deliveryAbsentStable = (
        stableAnchorIndexes.length === 1
        && stableAnchor?.contentDigest === input.expectedPreviousContentDigest
        && stableAnchor?.role === input.binding.headRole
        && stableCommitted.length === 0
        && stableMarkerCount === 0
        && stableEntries.length === entries.length
        && stableHead.fingerprint === firstHead.fingerprint
      )
      if (!deliveryAbsentStable) {
        humanRequired("bound_reconciliation_unstable", "The conversation changed while prompt-delivery absence was being verified.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      if (!await assertBrokerAuthority("before_absent_delivery_reconciliation")) {
        return
      }
      emit({
        ok: true,
        result: {
          canonicalUrl: normalizeUrl(inspection.info.url),
          deliveryState: "absent",
          head: stableHead,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
          turnMarker: input.turnMarker,
        },
      })
      return
    }
    const attributablePair = (
      (input.expectedPreviousMessageId ? anchorIndexes.length === 1 : anchorIndexes.length === 0)
      && anchorDigestMatches
      && anchorRoleMatches
      && committed.length === 2
      && prompt?.role === "user"
      && response?.role === "assistant"
      && Boolean(prompt?.messageId)
      && Boolean(response?.messageId)
      && promptMessageIdMatches
      && prompt.messageId !== response.messageId
      && promptMarkerCount === 1
      && (exactTerminalResponse || protocolRepairResponse)
    )
    if (!attributablePair) {
      humanRequired("bound_reconciliation_mismatch", "The browser does not contain exactly one stable late user/assistant pair attributable to that workflow.", {
        anchorCount: anchorIndexes.length,
        anchorDigestMatches,
        anchorRoleMatches,
        committedCount: committed.length,
        promptDigestMatches,
        promptMessageIdMatches,
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

    await wait(protocolRepairResponse ? 5 : 1)
    const stableGenerationRunning = protocolRepairResponse
      ? await js(String.raw`Boolean(
          document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
        )`)
      : false
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
      || stableGenerationRunning
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
    if (!await assertBrokerAuthority("before_head_commit")) {
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
    driverStage = "checking_browser_contract"
    if (input.browserContractRevision !== expectedBrowserContractRevision) {
      humanRequired("browser_contract_mismatch", "The browser driver and broker capability contracts do not match.")
      return
    }
    driverStage = "selecting_conversation"
    const selected = await selectConversation(input.binding)
    if (!selected) {
      return
    }
    driverStage = "checking_generation_state"
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
    driverStage = "reading_before_head"
    let beforeEntries = await readConversationEntries()
    let beforeHead = summarizeConversationHead(beforeEntries, input.binding.messageCount)
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
        const stabilized = await stabilizeBoundHead(input.binding, beforeEntries, beforeHead)
        beforeEntries = stabilized.entries
        beforeHead = stabilized.head
        if (stabilized.state === "unstable") {
          humanRequired("conversation_head_unstable", "The bound conversation head did not stabilize after navigation.", {
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          })
          return
        }
        if (stabilized.state === "changed") {
          humanRequired("conversation_head_changed", "The bound conversation head changed outside the broker workflow.", {
            headChange: headChangeEvidence(input.binding, beforeHead),
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          })
          return
        }
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

    if (!await assertBrokerAuthority("before_policy_verification")) {
      return
    }

    driverStage = "verifying_model_policy"
    const modelPolicy = await ensureMaximumModelPolicy(selected)
    if (!modelPolicy) {
      return
    }
    observedModelPolicy = modelPolicy
    driverStage = "verifying_precompose_head"
    let preComposeEntries = await readConversationEntries()
    let preComposeHead = summarizeConversationHead(preComposeEntries, input.binding.messageCount)
    if (preComposeHead.fingerprint !== beforeHead.fingerprint) {
      const stabilized = await stabilizeBoundHead(input.binding, preComposeEntries, preComposeHead)
      preComposeEntries = stabilized.entries
      preComposeHead = stabilized.head
      if (stabilized.state === "unstable") {
        humanRequired("conversation_head_unstable", "The bound conversation head changed unstably while the ChatGPT model policy was being verified.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      if (preComposeHead.fingerprint !== beforeHead.fingerprint) {
        humanRequired("conversation_head_changed", "The bound conversation head changed while the ChatGPT model policy was being verified.", {
          headChange: headChangeEvidence(input.binding, preComposeHead),
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
    }
    if (!await assertBrokerAuthority("before_composition")) {
      return
    }

    driverStage = "inspecting_composer"
    const sendControl = await js(String.raw`(() => {
      const composers = [...document.querySelectorAll('#prompt-textarea')]
      const sendButtons = [...document.querySelectorAll('button[data-testid="send-button"]')]
      const composer = composers[0]
      const draft = composer
        ? (composer.matches('input, textarea')
            ? composer.value
            : composer.innerText || composer.textContent || '')
        : ''
      return {
        composerCount: composers.length,
        draftEmpty: String(draft).trim().length === 0,
        enabledSendCount: sendButtons.filter((button) => !button.disabled).length,
        sendCount: sendButtons.length,
      }
    })()`)
    if (sendControl.composerCount !== 1) {
      humanRequired("unknown_chatgpt_ui", "The ChatGPT composer could not be identified unambiguously.", sendControl)
      return
    }
    if (!sendControl.draftEmpty) {
      humanRequired("unexpected_chatgpt_draft", "The ChatGPT composer contains an unexpected draft.", sendControl)
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
      const canonicalComposerText = (value) => value.replaceAll("\u00a0", " ")
      const expectedDigest = sha256(canonicalComposerText(input.prompt))
      const canonicalCandidates = [...new Set(candidates.map(canonicalComposerText))]
      const matchingCandidates = canonicalCandidates.filter((candidate) => sha256(candidate) === expectedDigest)
      return {
        candidateCount: canonicalCandidates.length,
        digestMatchCount: matchingCandidates.length,
        editorSpaceCanonicalized: candidates.some((candidate) => candidate.includes("\u00a0")),
        markerCount: matchingCandidates[0]?.split(input.turnMarker).length - 1,
      }
    }

    function composedPromptIsExact(inspection) {
      return inspection.digestMatchCount === 1 && inspection.markerCount === 1
    }

    async function inspectSendTarget() {
      return js(String.raw`(() => {
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
    }

    driverStage = "composing_prompt"
    await composePrompt(input.prompt)
    driverStage = "verifying_composed_prompt"
    const composedPrompt = await inspectComposedPrompt()
    if (!composedPromptIsExact(composedPrompt)) {
      const draftCleared = await clearUnsentComposerDraft()
      humanRequired("compose_verification_failed", "The exact uniquely marked prompt was not present in the ChatGPT composer.", {
        ...composedPrompt,
        draftCleared,
        phase: "after_fill",
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    driverStage = "locating_send_control"
    let sendTarget = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      sendTarget = await inspectSendTarget()
      if (sendTarget.ok && sendTarget.hit) {
        break
      }
      await wait(1)
    }
    if (!sendTarget.ok || !sendTarget.hit) {
      const draftCleared = await clearUnsentComposerDraft()
      humanRequired("send_control_unavailable", "The ChatGPT send control is unavailable after composing the prompt.", {
        draftCleared,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }

    driverStage = "checking_presend_policy_fence"
    if (!await assertBrokerAuthority("before_presend_policy_verification")) {
      await clearUnsentComposerDraft()
      return
    }
    driverStage = "verifying_presend_model_policy"
    const preSendModelPolicy = await verifyExistingMaximumModelPolicy(selected)
    if (!preSendModelPolicy) {
      await clearUnsentComposerDraft()
      return
    }
    observedModelPolicy = preSendModelPolicy

    driverStage = "verifying_preclick_prompt"
    const preClickPrompt = await inspectComposedPrompt()
    if (!composedPromptIsExact(preClickPrompt)) {
      const draftCleared = await clearUnsentComposerDraft()
      humanRequired("compose_verification_failed", "The exact uniquely marked prompt changed before the ChatGPT send click.", {
        ...preClickPrompt,
        draftCleared,
        phase: "before_click",
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    driverStage = "checking_preclick_fence"
    if (!await assertBrokerAuthority("before_send_click")) {
      await clearUnsentComposerDraft()
      return
    }

    driverStage = "rechecking_send_control"
    sendTarget = await inspectSendTarget()
    if (!sendTarget.ok || !sendTarget.hit) {
      const draftCleared = await clearUnsentComposerDraft()
      humanRequired("send_control_changed", "The exact ChatGPT send control changed immediately before dispatch.", {
        draftCleared,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
    }
    driverStage = "checking_send_dispatch_fence"
    if (!await assertBrokerAuthority("immediately_before_send_click")) {
      await clearUnsentComposerDraft()
      return
    }

    driverStage = "dispatching_send_click"
    sendClickStarted = true
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
    driverStage = "confirming_send"
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
    driverStage = "resolving_canonical_conversation"
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

    if (input.exchangeStage === "send_only") {
      driverStage = "verifying_sent_identity"
      const sentEntries = await readConversationEntries()
      const renderedMarkerCount = sentEntries.reduce(
        (count, entry) => count + entry.text.split(input.turnMarker).length - 1,
        0,
      )
      const markedUsers = sentEntries.filter((entry) => (
        entry.role === "user" && entry.text.split(input.turnMarker).length - 1 === 1
      ))
      if (renderedMarkerCount !== 1 || markedUsers.length !== 1 || !markedUsers[0].messageId) {
        humanRequired("send_confirmation_ambiguous", "The prompt was clicked, but its durable user-message identity is ambiguous.", {
          renderedMarkerCount,
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
          userMarkerCount: markedUsers.length,
        })
        return
      }
      emit({
        ok: true,
        result: {
          canonicalUrl,
          modelPolicy,
          promptMessageId: markedUsers[0].messageId,
          sentAt: new Date(sentAt).toISOString(),
          targetId: selected.targetId,
          ...(taskSpaceControlRecovery ? { taskSpaceControlRecovery } : {}),
          taskSpaceId: selected.task.id,
          turnMarker: input.turnMarker,
        },
      })
      return
    }

    driverStage = "capturing_response"
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
        && state.assistantText.length > 0
        && (
          state.assistantText.includes(input.expectedTerminalMarker)
          || input.allowProtocolRepairCapture === true
        )
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
        if (!await assertBrokerAuthority("before_head_commit")) {
          return
        }
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
          && (
            (terminalCount === 1 && responseEndsWithTerminal)
            || (
              input.allowProtocolRepairCapture === true
              && typeof committed[1]?.text === "string"
              && committed[1].text.trim().length > 0
            )
          )
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
            ...(taskSpaceControlRecovery ? { taskSpaceControlRecovery } : {}),
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
    driverStage = `dispatching_${input.mode}`
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
      if (!await assertBrokerAuthority("before_policy_verification")) {
        return
      }
      const modelPolicy = await ensureMaximumModelPolicy(selected)
      if (modelPolicy) {
        emit({ ok: true, result: modelPolicy })
      }
    } else if (input.mode === "reconcile") {
      await reconcile()
    } else if (input.mode === "capture_exchange" || input.mode === "reconcile_bound") {
      await reconcileBound()
    } else if (input.mode === "capture_attachment_execution") {
      await captureAttachmentExecution()
    } else if (input.mode === "reanchor") {
      if (input.browserContractRevision !== expectedBrowserContractRevision) {
        humanRequired("browser_contract_mismatch", "The browser driver and broker capability contracts do not match.")
        return
      }
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
      const firstEntries = await readConversationEntries()
      const firstHead = summarizeConversationHead(firstEntries)
      await wait(1)
      const stableEntries = await readConversationEntries()
      const stableHead = summarizeConversationHead(stableEntries)
      if (
        firstHead.fingerprint !== stableHead.fingerprint
        || firstHead.renderedMessageCount !== stableHead.renderedMessageCount
      ) {
        humanRequired("conversation_head_unstable", "The changed conversation head did not remain stable for re-anchoring.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      if (bindingMatchesHead(input.binding, stableEntries, stableHead)) {
        humanRequired("conversation_head_unchanged", "The live conversation already matches the durable binding head.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      if (stableHead.fingerprint !== input.expectedObservedHeadFingerprint) {
        humanRequired("reanchor_observation_changed", "The live conversation no longer matches the authorized observed head.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      if (stableHead.lastRole !== "assistant") {
        humanRequired("reanchor_requires_assistant_head", "Re-anchoring requires one stable completed assistant response at the conversation head.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      const finalInspection = await inspectPage()
      if (!assertReady(finalInspection, selected)) {
        return
      }
      if (normalizeUrl(finalInspection.info.url) !== normalizeUrl(input.binding.canonicalUrl)) {
        humanRequired("canonical_conversation_changed", "The bound conversation URL changed before re-anchoring completed.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      const finalGenerationRunning = await js(String.raw`Boolean(
        document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
      )`)
      if (finalGenerationRunning) {
        humanRequired("conversation_generation_in_progress", "The bound conversation started generating before re-anchoring completed.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      const finalEntries = await readConversationEntries()
      const finalHead = summarizeConversationHead(finalEntries)
      if (
        finalHead.fingerprint !== stableHead.fingerprint
        || finalHead.renderedMessageCount !== stableHead.renderedMessageCount
      ) {
        humanRequired("conversation_head_unstable", "The changed conversation head moved before re-anchoring completed.", {
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        })
        return
      }
      if (!await assertBrokerAuthority("before_reanchor_capture")) {
        return
      }
      emit({
        ok: true,
        result: {
          canonicalUrl: normalizeUrl(finalInspection.info.url),
          head: finalHead,
          headChange: headChangeEvidence(input.binding, finalHead),
          targetId: selected.targetId,
          taskSpaceId: selected.task.id,
        },
      })
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
      let entries = await readConversationEntries()
      let head = summarizeConversationHead(entries, input.binding.messageCount)
      if (input.binding.headFingerprint && !bindingMatchesHead(input.binding, entries, head)) {
        const stabilized = await stabilizeBoundHead(input.binding, entries, head)
        entries = stabilized.entries
        head = stabilized.head
        if (stabilized.state === "unstable") {
          humanRequired("conversation_head_unstable", "The bound conversation head did not stabilize after navigation.", {
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          })
          return
        }
        if (stabilized.state === "changed") {
          humanRequired("conversation_head_changed", "The bound conversation head changed outside the broker workflow.", {
            headChange: headChangeEvidence(input.binding, head),
            targetId: selected.targetId,
            taskSpaceId: selected.task.id,
          })
          return
        }
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
      const draftCleared = input.mode === "exchange" && !sendClickStarted && unsentDraftMayExist
        ? await clearUnsentComposerDraft()
        : null
      emit({
        error: {
          code: "ego_driver_error",
          ...(compositionMethod ? { compositionMethod } : {}),
          diagnosticDigest: sha256(message),
          ...(typeof draftCleared === "boolean" ? { draftCleared } : {}),
          ...(observedModelPolicy ? { modelPolicy: observedModelPolicy } : {}),
          ...(Number.isInteger(promptBytes) ? { promptBytes } : {}),
          ...(Number.isInteger(promptCharacters) ? { promptCharacters } : {}),
          message: "The fixed Ego Browser driver failed.",
          stage: driverStage,
        },
        ok: false,
      })
    }
  }
}

export function egoDriverSourceForInput(inputPath) {
  return `(${egoDriverMain.toString()})(${JSON.stringify(inputPath)}, ${BROWSER_CONTRACT_REVISION}, ${MAX_DRIVER_INPUT_BYTES})\n`
}

export const EGO_DRIVER_SOURCE = `(${egoDriverMain.toString()})(undefined, ${BROWSER_CONTRACT_REVISION}, ${MAX_DRIVER_INPUT_BYTES})\n`
