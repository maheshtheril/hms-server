import { Server } from "socket.io";
let io: Server | null = null;
export function initSocket(server: any) {
  io = new Server(server, { cors: { origin: "*" } });
  return io;
}
export function emitLeadEvent(type: string, leadId: string, payload: any = {}) {
  (io as any)?.emit(`lead.${leadId}`, { type, leadId, payload });
}
