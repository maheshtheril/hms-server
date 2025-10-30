"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withTenantClient = withTenantClient;
const pool_1 = __importDefault(require("../pool")); // adjust import to your existing pool export
async function withTenantClient(ctx, fn) {
    const client = await pool_1.default.connect();
    try {
        await client.query("BEGIN");
        // SET LOCAL ensures the GUC only lives for the transaction (safe for pooled clients)
        await client.query("SET LOCAL app.tenant_id = $1", [ctx.tenant_id]);
        await client.query("SET LOCAL app.company_id = $1", [ctx.company_id]);
        if (ctx.user_id) {
            await client.query("SET LOCAL app.user_id = $1", [ctx.user_id]);
        }
        else {
            await client.query("RESET app.user_id");
        }
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    }
    catch (err) {
        await client.query("ROLLBACK").catch(() => { });
        throw err;
    }
    finally {
        client.release();
    }
}
