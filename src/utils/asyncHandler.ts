// server/src/utils/asyncHandler.ts
import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * asyncHandler: wraps an async route handler and forwards errors to next()
 * Usage: router.get("/", asyncHandler(async (req, res) => { ... }))
 */
export default function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<any>
): RequestHandler {
  return function (req: Request, res: Response, next: NextFunction) {
    // call and forward any errors to express error handler
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}
