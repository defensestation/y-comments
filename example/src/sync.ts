import * as Y from "yjs";

/**
 * Minimal cross-tab Yjs sync over BroadcastChannel — enough to demo
 * collaborative editing (open two tabs) without a network provider.
 * Real apps replace this with y-websocket/ysync/etc.; comments don't care,
 * they never touch the doc either way.
 */
export function connectLocalTabs(doc: Y.Doc, room: string): () => void {
  const channel = new BroadcastChannel(room);
  const ORIGIN = "broadcast-channel";

  channel.onmessage = (event: MessageEvent<{ type: string; data?: ArrayBuffer }>) => {
    const { type, data } = event.data;
    if (type === "update" && data) {
      Y.applyUpdate(doc, new Uint8Array(data), ORIGIN);
    } else if (type === "sync-request") {
      channel.postMessage({ type: "update", data: Y.encodeStateAsUpdate(doc).buffer });
    }
  };

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== ORIGIN) {
      // copy: the buffer may be a slice of a larger pooled ArrayBuffer
      channel.postMessage({ type: "update", data: new Uint8Array(update).buffer });
    }
  };
  doc.on("update", onUpdate);
  channel.postMessage({ type: "sync-request" });

  return () => {
    doc.off("update", onUpdate);
    channel.close();
  };
}
