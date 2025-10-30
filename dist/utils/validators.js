"use strict";
// server/src/utils/validators.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.isUUID = isUUID;
exports.isISODate = isISODate;
exports.isEmail = isEmail;
exports.isRequired = isRequired;
/**
 * Validates whether a string is a valid UUID (v1–v5)
 */
function isUUID(value) {
    if (typeof value !== "string")
        return false;
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return UUID_REGEX.test(value);
}
/**
 * Checks if a string looks like a valid ISO date/time (YYYY-MM-DD or ISO timestamp)
 */
function isISODate(value) {
    if (typeof value !== "string")
        return false;
    const d = new Date(value);
    return !Number.isNaN(d.getTime());
}
/**
 * Checks if a string looks like an email address
 */
function isEmail(value) {
    if (typeof value !== "string")
        return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
/**
 * Generic required value check
 */
function isRequired(value) {
    return value !== null && value !== undefined && value !== "";
}
