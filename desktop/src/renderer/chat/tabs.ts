/** Open text chats, in the order they were opened. Closing the last stays closed. */
export interface ChatTabs {
  ids: string[];
  activeId: string | null;
  initialized: boolean;
}

export const EMPTY_CHAT_TABS: ChatTabs = {
  ids: [],
  activeId: null,
  initialized: false,
};

type Action =
  | { type: 'sync'; ids: string[] }
  | { type: 'open'; id: string }
  | { type: 'close'; id: string }
  | { type: 'reset' };

export function chatTabs(state: ChatTabs, action: Action): ChatTabs {
  switch (action.type) {
    case 'reset':
      return EMPTY_CHAT_TABS;
    case 'open':
      return {
        ...state,
        ids: state.ids.includes(action.id) ? state.ids : [...state.ids, action.id],
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
        activeId:
          state.activeId === action.id
            ? (ids[Math.min(index, ids.length - 1)] ?? null)
            : state.activeId,
      };
    }
    case 'sync': {
      const first = action.ids[0];
      if (!state.initialized && first) {
        return { ...EMPTY_CHAT_TABS, ids: [first], activeId: first, initialized: true };
      }
      let next = state;
      for (const id of state.ids) {
        if (!action.ids.includes(id)) next = chatTabs(next, { type: 'close', id });
      }
      return next;
    }
  }
}
