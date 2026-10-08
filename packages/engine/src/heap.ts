import type { SimEvent } from './types';

const less = (a: SimEvent, b: SimEvent): boolean => a.t < b.t || (a.t === b.t && a.seq < b.seq);

/** Min-Heap auf einem einfachen Array (Teil des serialisierbaren Zustands). */
export function heapPush(heap: SimEvent[], ev: SimEvent): void {
  heap.push(ev);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const p = heap[parent] as SimEvent;
    const c = heap[i] as SimEvent;
    if (!less(c, p)) break;
    heap[parent] = c;
    heap[i] = p;
    i = parent;
  }
}

export function heapPop(heap: SimEvent[]): SimEvent | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (top === undefined || last === undefined) return undefined;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && less(heap[l] as SimEvent, heap[m] as SimEvent)) m = l;
      if (r < heap.length && less(heap[r] as SimEvent, heap[m] as SimEvent)) m = r;
      if (m === i) break;
      const tmp = heap[m] as SimEvent;
      heap[m] = heap[i] as SimEvent;
      heap[i] = tmp;
      i = m;
    }
  }
  return top;
}

/** Entfernt Ereignisse, die das Prädikat erfüllen, und stellt die Heap-Eigenschaft wieder her. */
export function heapRemove(heap: SimEvent[], pred: (ev: SimEvent) => boolean): number {
  const keep = heap.filter((e) => !pred(e));
  const removed = heap.length - keep.length;
  if (removed > 0) {
    heap.length = 0;
    for (const e of keep) heapPush(heap, e);
  }
  return removed;
}
