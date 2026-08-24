import { randomUUID } from "node:crypto"
import path from "node:path"

import { AppServerClient } from "../src/app-server-client.mjs"

const cwd = path.resolve(process.cwd())
const firstMarker = `EGO_CHAT_APP_SERVER_START_${randomUUID().replaceAll("-", "").toUpperCase()}`
const resumeMarker = `EGO_CHAT_APP_SERVER_RESUME_${randomUUID().replaceAll("-", "").toUpperCase()}`

if (process.env.EGO_CHAT_APP_SERVER_SKIP_BROKER_OWNED !== "1") {
  let threadId
  const firstClient = new AppServerClient()
  try {
    await firstClient.connect()
    const thread = await firstClient.startThread({ cwd })
    threadId = thread.id
    const firstTurn = await firstClient.runMarkerTurn(threadId, firstMarker)
    process.stdout.write(`${JSON.stringify({ gate: "broker_owned_thread_start", ok: true, responseDigest: firstTurn.responseDigest })}\n`)
  } finally {
    await firstClient.close()
  }

  const secondClient = new AppServerClient()
  try {
    await secondClient.connect()
    await secondClient.resumeThread(threadId)
    const secondTurn = await secondClient.runMarkerTurn(threadId, resumeMarker)
    await secondClient.unsubscribeThread(threadId)
    process.stdout.write(`${JSON.stringify({ gate: "broker_owned_thread_resume", ok: true, responseDigest: secondTurn.responseDigest })}\n`)
  } finally {
    await secondClient.close()
  }
}

const desktopThreadId = process.env.CODEX_THREAD_ID
if (desktopThreadId) {
  const desktopClient = new AppServerClient()
  try {
    await desktopClient.connect()
    await desktopClient.readThread(desktopThreadId, false)
    try {
      const resumed = await desktopClient.resumeThread(desktopThreadId)
      await desktopClient.unsubscribeThread(desktopThreadId)
      process.stdout.write(`${JSON.stringify({
        exactIdentity: resumed.id === desktopThreadId,
        gate: "desktop_origin_thread_read_resume_unsubscribe",
        ok: resumed.id === desktopThreadId,
        resumeAfterInactive: true,
      })}\n`)
    } catch (error) {
      if (error.code !== "app_server_request_failed" || error.details?.reason !== "active_writer") {
        throw error
      }
      process.stdout.write(`${JSON.stringify({
        activeWriterIsolation: true,
        exactReadIdentity: true,
        gate: "desktop_origin_thread_read_resume_unsubscribe",
        ok: true,
        resumeAfterInactive: false,
      })}\n`)
    }
  } finally {
    await desktopClient.close()
  }
} else {
  process.stdout.write(`${JSON.stringify({ gate: "desktop_origin_thread_read_resume_unsubscribe", ok: false, reason: "CODEX_THREAD_ID unavailable" })}\n`)
}
