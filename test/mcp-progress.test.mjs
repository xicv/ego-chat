import assert from "node:assert/strict"
import test from "node:test"

import {
  readSupervisedWorkflow,
  withProgress,
  withWaitMode,
} from "../src/mcp-server.mjs"

test("supervised workflow status degrades a missing child record without losing the parent", async () => {
  let calls = 0
  const workflow = await readSupervisedWorkflow(
    {},
    "parent",
    undefined,
    async (_config, _method, input) => {
      calls += 1
      if (input.workflowId === "parent") {
        return {
          childWorkflowId: "missing-child",
          createdAt: "2026-09-03T00:00:00.000Z",
          cycle: 2,
          kind: "convergence",
          phase: "chatgpt_running",
          status: "running",
        }
      }
      throw new Error("child record is unavailable")
    },
  )

  assert.equal(calls, 2)
  assert.equal(workflow.supervision.chatGpt.delivery, "child_unavailable")
  assert.match(workflow.supervision.message, /record is unavailable/)
})

test("an in-flight supervision read is aborted and drained before the wait returns", async () => {
  let activeReads = 0
  let readCount = 0
  let releaseOperation
  let secondReadStarted
  const operationReleased = new Promise((resolve) => {
    releaseOperation = resolve
  })
  const secondReadObserved = new Promise((resolve) => {
    secondReadStarted = resolve
  })
  const messages = []
  const extra = {
    _meta: { progressToken: "progress-race" },
    sendNotification: async (notification) => {
      messages.push(notification.params.message)
    },
  }
  const readWorkflow = async (_config, _workflowId, signal) => {
    readCount += 1
    if (readCount === 1) {
      return { supervision: { message: "running before completion" } }
    }
    activeReads += 1
    secondReadStarted()
    try {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    } finally {
      activeReads -= 1
    }
    throw new Error("unreachable")
  }

  const waiting = withProgress(
    extra,
    "test wait",
    async () => {
      await operationReleased
      return "completed"
    },
    {
      config: {},
      heartbeatMs: 60_000,
      pollMs: 1,
      readWorkflow,
      workflowId: "workflow-race",
    },
  )
  await secondReadObserved
  releaseOperation()
  const result = await waiting

  assert.equal(result, "completed")
  assert.equal(activeReads, 0)
  assert.deepEqual(messages, ["running before completion"])
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(messages, ["running before completion"])
})

test("the initial supervision read is aborted and drained when the operation finishes", async () => {
  let activeReads = 0
  let abortedReads = 0
  const messages = []
  const result = await withProgress(
    {
      _meta: { progressToken: "initial-progress-race" },
      sendNotification: async (notification) => {
        messages.push(notification.params.message)
      },
    },
    "initial read test",
    async () => "completed",
    {
      config: {},
      pollMs: 60_000,
      readWorkflow: async (_config, _workflowId, signal) => {
        activeReads += 1
        try {
          await new Promise((resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"))
              return
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
        } catch (error) {
          abortedReads += 1
          throw error
        } finally {
          activeReads -= 1
        }
      },
      workflowId: "initial-progress-workflow",
    },
  )

  assert.equal(result, "completed")
  assert.equal(abortedReads, 1)
  assert.equal(activeReads, 0)
  assert.deepEqual(messages, [])
})

test("polling starts after the initial durable observation and heartbeats from that anchor", async () => {
  const messages = []
  let reads = 0
  let finishOperation
  let releaseInitialRead
  let initialReadStarted
  let intervalScheduled
  let message = "initial durable state"
  let tick
  let now = 1_000
  const operationFinished = new Promise((resolve) => {
    finishOperation = resolve
  })
  const initialReadReleased = new Promise((resolve) => {
    releaseInitialRead = resolve
  })
  const observedInitialRead = new Promise((resolve) => {
    initialReadStarted = resolve
  })
  const observedInterval = new Promise((resolve) => {
    intervalScheduled = resolve
  })
  const waiting = withProgress(
    {
      _meta: { progressToken: "initial-observation-heartbeat" },
      sendNotification: async (notification) => {
        messages.push(notification.params.message)
      },
    },
    "heartbeat schedule test",
    async () => {
      await operationFinished
      return "completed"
    },
    {
      clearIntervalFn: (timer) => {
        assert.equal(timer, "owned-test-interval")
      },
      config: {},
      heartbeatMs: 60_000,
      now: () => now,
      pollMs: 10_000,
      readWorkflow: async () => {
        reads += 1
        if (reads === 1) {
          initialReadStarted()
          await initialReadReleased
        }
        return { supervision: { message } }
      },
      setIntervalFn: (callback, delayMs) => {
        assert.equal(delayMs, 10_000)
        tick = callback
        intervalScheduled()
        return "owned-test-interval"
      },
      workflowId: "initial-observation-heartbeat-workflow",
    },
  )

  await observedInitialRead
  assert.equal(tick, undefined)
  releaseInitialRead()
  await observedInterval
  assert.deepEqual(messages, ["initial durable state"])

  message = "changed durable state"
  now += 1
  await tick()
  assert.equal(reads, 2)
  assert.deepEqual(messages, ["initial durable state", "changed durable state"])

  now += 59_999
  await tick()
  assert.equal(reads, 3)
  assert.deepEqual(messages, ["initial durable state", "changed durable state"])

  now += 1
  await tick()
  assert.equal(reads, 4)
  assert.deepEqual(messages, [
    "initial durable state",
    "changed durable state",
    "changed durable state",
  ])

  finishOperation()
  const result = await waiting
  assert.equal(result, "completed")
  assert.deepEqual(messages, [
    "initial durable state",
    "changed durable state",
    "changed durable state",
  ])
})

test("a delayed progress notification is accepted before the operation result returns", async () => {
  let notifyStarted
  let releaseNotification
  let returned = false
  const notificationStarted = new Promise((resolve) => {
    notifyStarted = resolve
  })
  const notificationReleased = new Promise((resolve) => {
    releaseNotification = resolve
  })
  const delivered = []
  const waiting = withProgress(
    {
      _meta: { progressToken: "blocked-notification" },
      sendNotification: async (notification) => {
        notifyStarted()
        await notificationReleased
        delivered.push(notification.params.message)
      },
    },
    "blocked notification test",
    async () => {
      await notificationStarted
      return "completed"
    },
    {
      config: {},
      pollMs: 60_000,
      readWorkflow: async () => ({ supervision: { message: "still running" } }),
      workflowId: "blocked-notification-workflow",
    },
  )
  waiting.finally(() => {
    returned = true
  })
  await notificationStarted
  await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(returned, false)
  assert.deepEqual(delivered, [])
  releaseNotification()
  const result = await waiting

  assert.equal(result, "completed")
  assert.deepEqual(delivered, ["still running"])
})

test("a backpressured notification does not suppress later supervision reads", async () => {
  let readCount = 0
  let releaseFirstNotification
  let thirdRead
  const firstNotificationReleased = new Promise((resolve) => {
    releaseFirstNotification = resolve
  })
  const thirdReadObserved = new Promise((resolve) => {
    thirdRead = resolve
  })
  const delivered = []
  const waiting = withProgress(
    {
      _meta: { progressToken: "backpressured-notification" },
      sendNotification: async (notification) => {
        if (delivered.length === 0) {
          await firstNotificationReleased
        }
        delivered.push(notification.params.message)
      },
    },
    "backpressure test",
    async () => {
      await thirdReadObserved
      releaseFirstNotification()
      return "completed"
    },
    {
      config: {},
      heartbeatMs: 1,
      pollMs: 1,
      readWorkflow: async () => {
        readCount += 1
        if (readCount === 3) thirdRead()
        return { supervision: { message: `running state ${readCount}` } }
      },
      workflowId: "backpressured-workflow",
    },
  )
  const result = await waiting

  assert.equal(result, "completed")
  assert.ok(readCount >= 3)
  assert.equal(delivered.length, 1)
})

test("Token-Saver starts no supervision reads or progress notifications", async () => {
  let notifications = 0
  let reads = 0
  const result = await withWaitMode(
    {
      _meta: { progressToken: "silent-wait" },
      sendNotification: async () => {
        notifications += 1
      },
    },
    "silent test",
    "token_saver",
    async () => "completed",
    {
      config: {},
      pollMs: 1,
      readWorkflow: async () => {
        reads += 1
      },
      workflowId: "silent-workflow",
    },
  )

  assert.equal(result, "completed")
  assert.equal(reads, 0)
  assert.equal(notifications, 0)
})
