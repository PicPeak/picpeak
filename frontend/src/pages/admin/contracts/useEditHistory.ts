/**
 * Undo/redo over an editor's state (#1445 template editor). Every change is
 * a step, except that changes carrying the same `coalesce` key within a
 * second fold into one — typing in a field is one step, not one per letter.
 * At most 100 steps are kept.
 */
import { useCallback, useReducer } from 'react';

const LIMIT = 100;
const COALESCE_MS = 1000;

interface State<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey: string | null;
  lastAt: number;
}

type Action<T> =
  | { type: 'change'; update: (current: T) => T; coalesce?: string; at: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: T }
  | { type: 'replace'; value: T };

function reducer<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case 'change': {
      const next = action.update(state.present);
      if (next === state.present) return state;
      const fold = action.coalesce != null && action.coalesce === state.lastKey && action.at - state.lastAt < COALESCE_MS;
      return {
        past: fold ? state.past : [...state.past, state.present].slice(-LIMIT),
        present: next,
        future: [],
        lastKey: action.coalesce ?? null,
        lastAt: action.at,
      };
    }
    case 'undo': {
      if (!state.past.length) return state;
      const previous = state.past[state.past.length - 1];
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], lastKey: null, lastAt: 0 };
    }
    case 'redo': {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return { past: [...state.past, state.present].slice(-LIMIT), present: next, future: rest, lastKey: null, lastAt: 0 };
    }
    case 'reset':
      return { past: [], present: action.value, future: [], lastKey: null, lastAt: 0 };
    case 'replace':
      // A new state that is itself a step (e.g. taking another admin's version): undo goes back.
      return { past: [...state.past, state.present].slice(-LIMIT), present: action.value, future: [], lastKey: null, lastAt: 0 };
    default:
      return state;
  }
}

export function useEditHistory<T>(initial: T) {
  const [state, dispatch] = useReducer(reducer as (s: State<T>, a: Action<T>) => State<T>, {
    past: [], present: initial, future: [], lastKey: null, lastAt: 0,
  });
  const change = useCallback((update: (current: T) => T, coalesce?: string) => {
    dispatch({ type: 'change', update, coalesce, at: Date.now() });
  }, []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback((value: T) => dispatch({ type: 'reset', value }), []);
  const replace = useCallback((value: T) => dispatch({ type: 'replace', value }), []);
  return {
    present: state.present,
    change,
    undo,
    redo,
    reset,
    replace,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
