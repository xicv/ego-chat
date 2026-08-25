import readline from "node:readline"

const lines = readline.createInterface({ input: process.stdin })
const threadId = "019d0000-0000-7000-8000-000000000001"
const duplicateTurnReads = process.argv.includes("--duplicate-turn-reads")
const exitAfterTurnStart = process.argv.includes("--exit-after-turn-start")
const multipleFinalMessages = process.argv.includes("--multiple-final-messages")
const phaseUnknownMessages = process.argv.includes("--phase-unknown-messages")
let turnNumber = 1
let activeReadsRemaining = 0
const completedTurns = []

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    if (message.params.capabilities?.experimentalApi !== true) {
      send({ error: { code: -32600, message: "experimentalApi capability is required" }, id: message.id })
    } else {
      send({ id: message.id, result: { platformFamily: "unix", platformOs: "macos", userAgent: "fake" } })
    }
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    send({
      id: message.id,
      result: {
        thread: { id: threadId, sessionId: threadId },
      },
    })
  } else if (message.method === "thread/read") {
    const status = activeReadsRemaining > 0 ? { activeFlags: [], type: "active" } : { type: "idle" }
    activeReadsRemaining = Math.max(0, activeReadsRemaining - 1)
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          status,
          ...(message.params.includeTurns
            ? { turns: duplicateTurnReads ? [...completedTurns, ...completedTurns] : completedTurns }
            : {}),
        },
      },
    })
  } else if (message.method === "thread/unsubscribe") {
    send({ id: message.id, result: {} })
  } else if (message.method === "turn/start") {
    turnNumber += 1
    const responseText = message.params.outputSchema
      ? JSON.stringify({
          blockers: [],
          criteria: [{ evidence: "The fake structured turn passed.", id: "AC-1", status: "pass" }],
          reviewPacket: "Fake structured review packet.",
          status: "candidate",
          summary: "Fake structured result.",
        })
      : message.params.input[0].text.split(": ").at(-1)
    const turn = {
      durationMs: 1,
      id: `019d0000-0000-7000-8000-${String(turnNumber).padStart(12, "0")}`,
      items: [
        {
          aggregatedOutput: "test/fixtures/fake-app-server.mjs\n",
          command: "rg --files",
          id: `command-${turnNumber}`,
          status: "completed",
          type: "commandExecution",
        },
        {
          id: `commentary-${turnNumber}`,
          phase: phaseUnknownMessages ? null : "commentary",
          text: "The fake App Server is preparing the terminal response.",
          type: "agentMessage",
        },
        ...(multipleFinalMessages
          ? [{
              id: `superseded-final-${turnNumber}`,
              phase: "final_answer",
              text: "This superseded final item is not the terminal structured envelope.",
              type: "agentMessage",
            }]
          : []),
        {
          id: `message-${turnNumber}`,
          phase: phaseUnknownMessages ? null : "final_answer",
          text: responseText,
          type: "agentMessage",
        },
      ],
      status: "completed",
    }
    completedTurns.push(turn)
    activeReadsRemaining = 1
    send({ id: message.id, result: { turn: { ...turn, items: [], status: "inProgress" } } })
    if (exitAfterTurnStart) {
      setTimeout(() => process.exit(70), 10)
      return
    }
    send({ method: "turn/completed", params: { threadId, turn } })
  }
})
