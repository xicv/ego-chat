export class EgoChatError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = "EgoChatError"
    this.code = code
    this.details = details
  }
}

export function asPublicError(error) {
  if (error instanceof EgoChatError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }

  return {
    code: "internal_error",
    message: "The operation failed unexpectedly. Inspect the local daemon log for details.",
  }
}
