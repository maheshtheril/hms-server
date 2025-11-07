import { getLeadDoc } from "../collab/y-docs";
import * as Y from "yjs";
import { encodeStateAsUpdate, applyUpdate } from "yjs";

export function enableCollab(io: any) {
  io.on("connection", (socket: any) => {
    socket.on("collab.join", (leadId: string) => {
      const doc = getLeadDoc(leadId);
      socket.emit("collab.sync", encodeStateAsUpdate(doc));
      socket.join(`lead.${leadId}`);
    });
    socket.on("collab.update", ({ leadId, update }: any) => {
      const doc = getLeadDoc(leadId);
      applyUpdate(doc, update);
      socket.to(`lead.${leadId}`).emit("collab.update", update);
    });
  });
}
