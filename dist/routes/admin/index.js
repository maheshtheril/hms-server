"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// routes/admin/index.ts
const express_1 = require("express");
const users_1 = __importDefault(require("./users"));
const roles_1 = __importDefault(require("./roles"));
const permissions_1 = __importDefault(require("./permissions"));
const router = (0, express_1.Router)();
router.use("/users", users_1.default);
router.use("/roles", roles_1.default);
router.use("/permissions", permissions_1.default);
exports.default = router;
