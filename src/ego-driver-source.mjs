export const EGO_DRIVER_RESULT_PREFIX = "__EGO_CHAT_DRIVER_RESULT__"

async function egoDriverMain(inputPathOverride = undefined) {
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
        || stat.size > 256 * 1024
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
  let driverStage = "initializing"
  let observedModelPolicy = null
  let sendClickStarted = false
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

    return {
      accountState,
      blockedReason: hasCaptcha ? "verification_challenge" : null,
      composerCount,
      composerSemanticId: dom.composerSemanticId ?? composerCount === 1,
      hasComposer: composerCount === 1,
      info,
      snapshotDigest: sha256(snapshot),
      unexpectedDraft: dom.draft.trim().length > 0,
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
          composer.replaceChildren()
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

  function compositionChunks(value, maximumLength = 4_000) {
    const chunks = []
    let offset = 0
    while (offset < value.length) {
      let end = Math.min(value.length, offset + maximumLength)
      const endsWithHighSurrogate = /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")
      const nextIsLowSurrogate = /[\uDC00-\uDFFF]/.test(value[end] ?? "")
      if (end < value.length && endsWithHighSurrogate && nextIsLowSurrogate) {
        end -= 1
      }
      chunks.push(value.slice(offset, end))
      offset = end
    }
    return chunks
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
    const chunks = compositionChunks(value)
    for (let index = 0; index < chunks.length; index += 1) {
      driverStage = "inserting_prompt_chunk"
      // eslint-disable-next-line no-undef -- cdp is injected by the ego-browser runtime.
      await cdp("Input.insertText", { text: chunks[index] })
      if (index === chunks.length - 1) {
        continue
      }
      driverStage = "anchoring_prompt_chunk"
      const cursorAtEnd = await js(String.raw`(() => {
        const composer = document.querySelector('#prompt-textarea')
        if (!composer) {
          return false
        }
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(composer)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
        composer.focus()
        return document.activeElement === composer
      })()`)
      if (!cursorAtEnd) {
        throw new Error("The ChatGPT composer cursor could not be anchored after a text chunk.")
      }
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

  async function useBoundTaskSpace(binding) {
    const taskSpaces = await globalThis.listTaskSpaces()
    const requested = taskSpaces.find((taskSpace) => taskSpaceMatches(taskSpace, binding.taskSpaceId))
    if (!binding.key) {
      if (requested?.ownership && requested.ownership !== "agent") {
        humanRequired("browser_control_unavailable", "The bound Ego task space is under user control or inactive.", {
          taskSpaceId: requested.id,
        })
        return null
      }
      return useOrCreateTaskSpace(requested?.id ?? binding.taskSpaceId)
    }
    const fallbackName = boundTaskSpaceName(binding)
    const fallback = taskSpaces.find((taskSpace) => taskSpaceMatches(taskSpace, fallbackName))
    const controlled = [requested, fallback]
      .find((taskSpace) => taskSpace?.ownership && taskSpace.ownership !== "agent")
    if (controlled) {
      humanRequired("browser_control_unavailable", "The bound Ego task space is under user control or inactive.", {
        taskSpaceId: controlled.id,
      })
      return null
    }
    return useOrCreateTaskSpace(fallback?.id ?? fallbackName)
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
    if (inspection.unexpectedDraft) {
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
        const modelPolicy = await verifyExistingMaximumModelPolicy(selected)
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
    if (input.browserContractRevision !== 6) {
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
    if (input.browserContractRevision !== 6) {
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
    const inspection = selected.inspection
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
    const promptMarkerCount = prompt?.text.split(input.turnMarker).length - 1
    const renderedMarkerCount = entries.reduce(
      (count, entry) => count + entry.text.split(input.turnMarker).length - 1,
      0,
    )
    const terminalCount = response?.text.split(input.expectedTerminalMarker).length - 1
    const responseEndsWithTerminal = response?.text.trimEnd().endsWith(input.expectedTerminalMarker) ?? false
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
    if (input.browserContractRevision !== 6) {
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
    const preComposeHead = await readConversationHead(input.binding.messageCount)
    if (preComposeHead.fingerprint !== beforeHead.fingerprint) {
      humanRequired("conversation_head_changed", "The bound conversation head changed while the ChatGPT model policy was being verified.", {
        messageCount: preComposeHead.messageCount,
        targetId: selected.targetId,
        taskSpaceId: selected.task.id,
      })
      return
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
      const draftCleared = input.mode === "exchange" && !sendClickStarted && unsentDraftMayExist
        ? await clearUnsentComposerDraft()
        : null
      emit({
        error: {
          code: "ego_driver_error",
          diagnosticDigest: sha256(message),
          ...(typeof draftCleared === "boolean" ? { draftCleared } : {}),
          ...(observedModelPolicy ? { modelPolicy: observedModelPolicy } : {}),
          message: "The fixed Ego Browser driver failed.",
          stage: driverStage,
        },
        ok: false,
      })
    }
  }
}

export function egoDriverSourceForInput(inputPath) {
  return `(${egoDriverMain.toString()})(${JSON.stringify(inputPath)})\n`
}

export const EGO_DRIVER_SOURCE = `(${egoDriverMain.toString()})()\n`
