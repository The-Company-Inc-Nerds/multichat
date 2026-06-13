import type {
  ChannelState,
  ChatMessage,
  DeleteEvent,
  Emitter,
  Platform,
} from "../src/types.ts";

export interface Captured {
  messages: ChatMessage[];
  deletes: DeleteEvent[];
  statuses: Array<{ platform: Platform; name: string; state: ChannelState }>;
}

/** An Emitter that records everything sent to it, for assertions in tests. */
export function fakeEmitter(): Emitter & { captured: Captured } {
  const captured: Captured = { messages: [], deletes: [], statuses: [] };
  return {
    captured,
    message: (msg) => captured.messages.push(msg),
    delete: (ev) => captured.deletes.push(ev),
    status: (platform, name, state) =>
      captured.statuses.push({ platform, name, state }),
  };
}
