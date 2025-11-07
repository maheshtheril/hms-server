import * as Y from "yjs";
const docs = new Map<string, Y.Doc>();
export function getLeadDoc(leadId: string) {
  if (!docs.has(leadId)) docs.set(leadId, new Y.Doc());
  return docs.get(leadId)!;
}
