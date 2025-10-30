"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = asyncHandler;
/**
 * asyncHandler: wraps an async route handler and forwards errors to next()
 * Usage: router.get("/", asyncHandler(async (req, res) => { ... }))
 */
function asyncHandler(fn) {
    return function (req, res, next) {
        // call and forward any errors to express error handler
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
