export class AppError extends Error {
  constructor(message, code, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorResponse(error) {
  return {
    error: {
      code: error.code || "INTERNAL_ERROR",
      message: error.message || "Something went wrong",
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}
