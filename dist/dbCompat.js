"use strict";
// server/src/dbCompat.ts
// Thin compatibility wrapper so existing code that expects `getClient()` can keep using it
// without changing the original server/src/db.ts file.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = exports.q = void 0;
exports.getClient = getClient;
const db_1 = __importStar(require("./db")), dbNamed = db_1;
// dbDefault is likely the default export (object) or maybe a function — handle both.
// helper: if dbDefault is an object with pool, use pool.connect()
// if dbDefault is a function, call it (backwards-compatible)
async function obtainClient() {
    // @ts-ignore
    if (typeof db_1.default === "function") {
        // original db exported a function (already callable)
        // @ts-ignore
        return (0, db_1.default)();
    }
    // otherwise expect an exported pool: dbDefault.pool or dbNamed.pool
    const maybePool = (db_1.default && (db_1.default.pool)) || (dbNamed && dbNamed.pool);
    if (!maybePool || typeof maybePool.connect !== "function") {
        throw new Error("dbCompat: unable to find pool.connect on ./db — inspect server/src/db.ts");
    }
    return maybePool.connect();
}
// Named export q: reuse existing q if present, otherwise re-export query wrapper
exports.q = (dbNamed && dbNamed.q) || (async function (text, params) {
    // @ts-ignore
    if (db_1.default && typeof db_1.default.query === "function")
        return db_1.default.query(text, params);
    throw new Error("dbCompat: no query function available on ./db");
});
// named export getClient
async function getClient() {
    return obtainClient();
}
// default export getClient — so `import getClient from "./dbCompat"` works
exports.default = getClient;
// also expose pool if available
exports.pool = (db_1.default && (db_1.default.pool)) || (dbNamed.pool) || null;
