// A small DOM boundary fixture: the driver executes its actual policy scripts.
// Unrelated radios and Power controls stay visible outside the composer menu.
export function createModelPolicyDom(options = {}) {
  const state = {
    current: 2,
    maximum: 4,
    menuOpen: false,
    modelOpen: false,
    selected: 1,
    ...options,
  }
  const events = []
  class Element {
    constructor(attributes = {}, text = "", children = [], shown = () => true) {
      this.attributes = attributes
      this.textContent = text
      this.children = children
      this.shown = shown
    }
    get id() { return this.getAttribute("id") }
    get innerText() { return this.textContent }
    getAttribute(name) {
      const value = this.attributes[name]
      return typeof value === "function" ? value() : value ?? null
    }
    hasAttribute(name) { return this.getAttribute(name) !== null }
    getClientRects() { return this.shown() ? [{}] : [] }
    contains(element) {
      return element === this || this.children.some((child) => child.contains(element))
    }
    querySelectorAll(selector) {
      const matches = (element) => selector.split(", ").some((part) => {
        const tag = part.match(/^[a-z]+/)?.[0]
        const cls = part.match(/\.([\w-]+)/)?.[1]
        const id = part.match(/^#([\w-]+)/)?.[1]
        const attrs = [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)]
        return (!tag || element.getAttribute("tag") === tag)
          && (!cls || element.getAttribute("class") === cls)
          && (!id || element.id === id)
          && attrs.every(([, name, value]) => value === undefined
            ? element.hasAttribute(name)
            : element.getAttribute(name) === value)
      })
      return this.children.flatMap((child) => [
        ...(matches(child) ? [child] : []),
        ...child.querySelectorAll(selector),
      ])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    focus() {
      if (this.hasAttribute("tabindex") || this.getAttribute("tag") === "button") {
        document.activeElement = this
      }
    }
    click() { this.activate?.() }
  }
  const slider = new Element({
    role: "slider",
    "aria-valuemin": "0",
    "aria-valuemax": () => String(state.maximum),
    "aria-valuenow": () => String(state.current),
  }, "", [], () => state.menuOpen)
  const power = new Element({ role: "menuitem", "aria-label": "Power", tabindex: "-1" },
    "", [slider], () => state.menuOpen)
  const modelTrigger = new Element({
    role: "menuitem", "aria-label": "Select model", tabindex: "-1",
  }, "6 Pro", [], () => state.menuOpen)
  const labels = options.labels ?? ["Latest", "GPT-5.6 Sol"]
  const choices = labels.map((label, index) => {
    const choice = new Element({
      role: "menuitemradio",
      "aria-checked": () => String(state.selected === index || state.duplicateSelection),
      ...(state.focusableRows ? { tabindex: "-1" } : {}),
    }, label, [], () => state.menuOpen && state.modelOpen)
    choice.activate = () => {
      events.push({ index, kind: "model_activation", method: state.activationMethod ?? "dom" })
      if (!state.ignoreActivation) state.selected = index
      state.menuOpen = false
      state.modelOpen = false
    }
    if (state.focusableChild) {
      const child = new Element({ tag: "button" }, "", [], choice.shown)
      child.activate = choice.activate
      choice.children.push(child)
    }
    return choice
  })
  const menu = new Element({ id: "policy-menu", role: "menu" }, "",
    [power, modelTrigger, ...choices], () => state.menuOpen)
  const pill = new Element({
    tag: "button", class: "__composer-pill", "aria-haspopup": "menu",
    "aria-controls": () => state.missingControls ? null : state.wrongControls ? "missing-menu" : "policy-menu",
    "aria-expanded": () => String(state.menuOpen),
  }, "6 Pro")
  pill.activate = () => {
    state.menuOpen = !state.menuOpen
    if (!state.menuOpen) state.modelOpen = false
    events.push({ kind: state.menuOpen ? "open" : "close" })
  }
  const composer = new Element({ id: "prompt-textarea" })
  const form = new Element({ tag: "form" }, "", [
    ...(state.missingComposer ? [] : [composer]),
    ...(state.duplicateComposer ? [new Element({ id: "prompt-textarea" })] : []),
    pill,
  ])
  composer.closest = () => state.missingComposerRoot || state.broadComposerRoot ? null : form
  const composerParent = new Element({}, "", [composer])
  const composerGrandparent = new Element({}, "", [composerParent])
  const broadComposerRoot = new Element({}, "", [composerGrandparent, pill])
  composer.parentElement = composerParent
  composerParent.parentElement = composerGrandparent
  composerGrandparent.parentElement = broadComposerRoot
  const unrelatedRadio = new Element({ role: "menuitemradio", "aria-checked": "true", tabindex: "0" }, "Unrelated page content")
  const unrelatedPower = new Element({ role: "menuitem", "aria-label": "Power", tabindex: "0" })
  const unrelated = new Element({ id: "unrelated-menu", role: "menu" }, "",
    [unrelatedRadio, ...(state.unrelatedPower === false ? [] : [unrelatedPower])])
  for (const element of [unrelatedRadio, unrelatedPower]) {
    element.focus = () => { events.push({ kind: "unrelated_focus" }); document.activeElement = element }
    element.activate = () => events.push({ kind: "unrelated_click" })
  }
  const document = new Element({}, "", [unrelated, ...(state.broadComposerRoot ? [broadComposerRoot] : [form]), menu,
    ...(state.duplicateMenu ? [new Element({ id: "policy-menu", role: "menu" })] : []),
  ])
  document.getElementById = (id) => document.querySelectorAll("[id]").find((element) => element.id === id) ?? null
  document.activeElement = null
  return {
    evaluate(source) {
      const result = Function("document", "HTMLElement", "return " + source)(document, Element)
      if (source.includes("aria-valuemin") && result.ok) {
        events.push({ kind: "read", current: result.current, maximum: result.maximum, selected: result.selectedModelIndex })
      }
      return result
    },
    click(target) {
      if (String(target).includes("__composer-pill")) pill.click()
    },
    pressKey(key) {
      if (key === "ENTER") {
        if (document.activeElement === modelTrigger) state.modelOpen = true
        else if (document.activeElement === pill) pill.click()
        else {
          state.activationMethod = "keyboard"
          document.activeElement?.click()
          state.activationMethod = null
        }
      }
      if (key === "ARROWRIGHT" && document.activeElement === power) {
        state.current = Math.min(state.current + 1, state.maximum)
        events.push({ kind: "power_step" })
      }
      if (key === "ESCAPE") {
        events.push({ kind: "escape" })
        state.menuOpen = false
        state.modelOpen = false
      }
    },
    afterComposition() {
      events.push({ kind: "composition" })
      if (state.downgradeAfterComposition) state.current = state.maximum - 1
    },
    events,
  }
}
