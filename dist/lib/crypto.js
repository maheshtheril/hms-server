"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.compare = exports.hash = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
/** Hash a plain text string (e.g., password) */
const hash = (s) => bcryptjs_1.default.hashSync(s, 10);
exports.hash = hash;
/** Compare a plain text string against a hashed value */
const compare = (s, h) => bcryptjs_1.default.compareSync(s, h);
exports.compare = compare;
