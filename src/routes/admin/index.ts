// routes/admin/index.ts
import { Router } from "express";
import users from "./users";
import roles from "./roles";
import permissions from "./permissions";

const router = Router();
router.use("/users", users);
router.use("/roles", roles);
router.use("/permissions", permissions);
export default router;
