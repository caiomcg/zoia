/**
 * Open text chats: the pinned ones first, which stay, and one more that cycles.
 * Opening a chat that has no tab takes the place of the unpinned one, so tabs
 * never pile up; pin a chat to keep it. Closing the last stays closed.
 */
export interface ChatTabs {
  ids: string[];
  pinned: string[];
  activeId: string | null;
  initialized: boolean;
}

export const EMPTY_CHAT_TABS: ChatTabs = {
  ids: [],
  pinned: [],
  activeId: null,
  initialized: false,
};

type Action =
  /** `saved`: the pins kept from last time, restored when the tabs start. */
  | { type: 'sync'; ids: string[]; saved?: readonly string[] }
  /** Drag a tab onto another: it takes that tab's place, within its own group. */
  | { type: 'move'; id: string; to: string }
  | { type: 'open'; id: string }
  | { type: 'close'; id: string }
  | { type: 'pin'; id: string; pinned: boolean }
  | { type: 'reset' };

export function chatTabs(state: ChatTabs, action: Action): ChatTabs {
  switch (action.type) {
    case 'reset':
      return EMPTY_CHAT_TABS;
    case 'open':
      return {
        ...state,
        ids: state.ids.includes(action.id) ? state.ids : [...state.pinned, action.id],
        activeId: action.id,
        initialized: true,
      };
    case 'close': {
      const index = state.ids.indexOf(action.id);
      if (index < 0) return state;
      const ids = state.ids.filter((id) => id !== action.id);
      return {
        ...state,
        ids,
        pinned: state.pinned.filter((id) => id !== action.id),
        activeId:
          state.activeId === action.id
            ? (ids[Math.min(index, ids.length - 1)] ?? null)
            : state.activeId,
      };
    }
    case 'pin': {
      if (!state.ids.includes(action.id)) return state;
      if (state.pinned.includes(action.id) === action.pinned) return state;
      const pinned = state.pinned.filter((id) => id !== action.id);
      if (action.pinned) pinned.push(action.id);
      return {
        ...state,
        pinned,
        ids: [...pinned, ...state.ids.filter((id) => !pinned.includes(id))],
      };
    }
    case 'move': {
      if (action.id === action.to) return state;
      const pinned = state.pinned.includes(action.id);
      if (!state.ids.includes(action.to) || pinned !== state.pinned.includes(action.to)) {
        return state;
      }
      const place = (list: string[]) => {
        if (!list.includes(action.id)) return list;
        const from = list.indexOf(action.id);
        const to = list.indexOf(action.to);
        const next = list.filter((id) => id !== action.id);
        next.splice(to, 0, action.id);
        return from === to ? list : next;
      };
      return { ...state, ids: place(state.ids), pinned: place(state.pinned) };
    }
    case 'sync': {
      const first = action.ids[0];
      if (!state.initialized && first) {
        // Last time's pins that still exist, in their order, then the default chat.
        const pinned = [...new Set(action.saved ?? [])].filter((id) => action.ids.includes(id));
        return {
          ...EMPTY_CHAT_TABS,
          ids: pinned.includes(first) ? pinned : [...pinned, first],
          pinned,
          activeId: first,
          initialized: true,
        };
      }
      let next = state;
      for (const id of state.ids) {
        if (!action.ids.includes(id)) next = chatTabs(next, { type: 'close', id });
      }
      return next;
    }
  }
}
