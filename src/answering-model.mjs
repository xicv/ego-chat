import { ANSWERING_MODEL_RANKS } from "./constants.mjs"

// Higher is stronger. An exact match ranks by its position in
// ANSWERING_MODEL_RANKS; otherwise the longest known prefix match wins (a
// versioned or dated slug such as "gpt-6-pro-2026" still resolves to
// "gpt-6-pro"). An unknown, null, or non-string slug ranks lowest (0).
export function answeringModelRank(slug) {
  if (typeof slug !== "string" || slug.length === 0) {
    return 0
  }
  const exactIndex = ANSWERING_MODEL_RANKS.indexOf(slug)
  if (exactIndex !== -1) {
    return ANSWERING_MODEL_RANKS.length - exactIndex
  }
  let bestIndex = -1
  let bestLength = -1
  for (const [index, candidate] of ANSWERING_MODEL_RANKS.entries()) {
    if (slug.startsWith(candidate) && candidate.length > bestLength) {
      bestIndex = index
      bestLength = candidate.length
    }
  }
  return bestIndex === -1 ? 0 : ANSWERING_MODEL_RANKS.length - bestIndex
}

// True only when the previous slug is a known, ranked model and the next
// slug ranks strictly below it. An unknown next slug counts as a downgrade
// because it cannot be proven at least as strong; an unknown previous slug,
// an upgrade, or an unchanged model is never a downgrade.
export function isAnsweringModelDowngrade(previousSlug, slug) {
  if (typeof previousSlug !== "string" || typeof slug !== "string") {
    return false
  }
  const previousRank = answeringModelRank(previousSlug)
  if (previousRank === 0) {
    return false
  }
  return answeringModelRank(slug) < previousRank
}
