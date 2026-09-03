import assert from "node:assert/strict"
import test from "node:test"

import {
  createEmptyTaskState,
  reduceTaskCommand,
  TASK_JSON_MAX_BYTES,
} from "../src/task-domain.mjs"

const AT = "2026-09-03T00:00:00.000Z"

test("the task reducer is deterministic and does not mutate its input", () => {
  const initial = createEmptyTaskState()
  const command = {
    acceptanceContract: { criteria: ["exact-head verification"] },
    at: AT,
    conversationId: "conversation-1",
    requiredEvidenceKinds: ["verification"],
    taskId: "task-1",
    type: "create_conversation_and_task",
  }

  const first = reduceTaskCommand(initial, command)
  const second = reduceTaskCommand(initial, command)

  assert.deepEqual(first, second)
  assert.deepEqual(initial, createEmptyTaskState())
  assert.equal(first.next.conversations["conversation-1"].acceptanceContractDigest.length, 64)
  assert.deepEqual(first.emitted.map((event) => event.seq), [1, 2])
  assert.deepEqual(first.emitted.map((event) => event.type), [
    "conversation.created",
    "task.created",
  ])
})

test("the task reducer rejects a changed acceptance contract under the same logical identity", () => {
  const initial = createEmptyTaskState()
  const first = reduceTaskCommand(initial, {
    acceptanceContract: { criteria: ["first"] },
    at: AT,
    conversationId: "conversation-1",
    requiredEvidenceKinds: ["verification"],
    taskId: "task-1",
    type: "create_conversation_and_task",
  })

  assert.throws(
    () => reduceTaskCommand(first.next, {
      acceptanceContract: { criteria: ["changed"] },
      at: AT,
      conversationId: "conversation-1",
      requiredEvidenceKinds: ["verification"],
      taskId: "task-1",
      type: "create_conversation_and_task",
    }),
    (error) => error.code === "conversation_already_exists",
  )
})

test("the task reducer rejects oversized and excessively nested JSON input", () => {
  const initial = createEmptyTaskState()
  const baseCommand = {
    at: AT,
    conversationId: "conversation-1",
    requiredEvidenceKinds: ["verification"],
    taskId: "task-1",
    type: "create_conversation_and_task",
  }

  assert.throws(
    () => reduceTaskCommand(initial, {
      ...baseCommand,
      acceptanceContract: { payload: "x".repeat(TASK_JSON_MAX_BYTES) },
    }),
    (error) => error.code === "invalid_task_command",
  )

  let nested = { criterion: "bounded" }
  for (let depth = 0; depth < 80; depth += 1) nested = { nested }
  assert.throws(
    () => reduceTaskCommand(initial, { ...baseCommand, acceptanceContract: nested }),
    (error) => error.code === "invalid_task_command",
  )
})

test("the task reducer rejects accessors without invoking them", () => {
  const initial = createEmptyTaskState()
  let getterCalls = 0
  const criteria = ["safe"]
  Object.defineProperty(criteria, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("array getter must not run")
    },
  })
  const command = {
    acceptanceContract: { criteria },
    at: AT,
    conversationId: "conversation-1",
    requiredEvidenceKinds: ["verification"],
    taskId: "task-1",
    type: "create_conversation_and_task",
  }

  assert.throws(
    () => reduceTaskCommand(initial, command),
    (error) => error.code === "invalid_task_command",
  )
  assert.equal(getterCalls, 0)

  const commandWithAccessor = { ...command, acceptanceContract: { criteria: ["safe"] } }
  Object.defineProperty(commandWithAccessor, "at", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error("command getter must not run")
    },
  })
  assert.throws(
    () => reduceTaskCommand(initial, commandWithAccessor),
    (error) => error.code === "invalid_task_command",
  )
  assert.equal(getterCalls, 0)
})

test("the task reducer normalizes without invoking inherited array toJSON", () => {
  const initial = createEmptyTaskState()
  let toJsonCalls = 0
  const capabilities = Array.from(
    { length: 6_000 },
    (_, index) => `${index}`.padEnd(100, "x"),
  )
  Object.setPrototypeOf(capabilities, {
    toJSON() {
      toJsonCalls += 1
      return []
    },
  })

  assert.throws(
    () => reduceTaskCommand(initial, {
      at: AT,
      capabilities,
      runnerId: "runner-1",
      type: "register_runner",
    }),
    (error) => error.code === "invalid_task_command" && /byte limit/.test(error.message),
  )
  assert.equal(toJsonCalls, 0)
  assert.deepEqual(initial, createEmptyTaskState())
})
