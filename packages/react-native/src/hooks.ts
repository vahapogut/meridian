/**
 * Meridian React Native Hooks
 *
 * Same API as meridian-react, optimized for React Native.
 * No DOM-specific APIs used — fully compatible with RN's render lifecycle.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { RNClient } from './rn-client.js';

type Query<T> = { subscribe(cb: (data: T) => void): () => void; get(): Promise<T> };
type CollectionProxy = { find(filter?: any): Query<any[]>; findOne(id: string): Query<any>; live(options?: any): Query<any[]>; put(doc: any): Promise<void>; update(id: string, fields: any): Promise<void>; delete(id: string): Promise<void> };

export type { Query };

export function useQuery<T>(query: Query<T>): T | undefined {
  const [data, setData] = useState<T>();
  useEffect(() => {
    let mounted = true;
    const unsub = query.subscribe((result) => { if (mounted) setData(result); });
    return () => { unsub(); mounted = false; };
  }, []);
  return data;
}

export function useLiveQuery(collection: CollectionProxy, options: any = {}): any[] | undefined {
  const [data, setData] = useState<any[]>();
  const { where: _w, orderBy: _ob, limit: _lim } = options;
  const depKey = `${_ob || ''}-${_lim || 0}-${Object.entries(_w || {}).sort().join(',')}`;

  useEffect(() => {
    const query = collection.live(options);
    let mounted = true;
    const unsub = query.subscribe((result: any) => { if (mounted) setData(result); });
    return () => { unsub(); mounted = false; };
  }, [depKey]);
  return data;
}

export function useDoc(collection: CollectionProxy, docId: string | null): any | null | undefined {
  const [doc, setDoc] = useState<any>();
  useEffect(() => {
    if (!docId) { setDoc(null); return; }
    let mounted = true;
    const unsub = collection.findOne(docId).subscribe((result: any) => { if (mounted) setDoc(result); });
    return () => { unsub(); mounted = false; };
  }, [docId]);
  return doc;
}

export function useSync(client: RNClient) {
  const [state, setState] = useState({ connected: false, pendingCount: 0 });
  useEffect(() => {
    const interval = setInterval(() => {
      setState({ connected: client.connectionState === 'connected', pendingCount: 0 });
    }, 1000);
    return () => clearInterval(interval);
  }, []);
  return state;
}

export function usePresence(_client: RNClient): Record<string, any> {
  return {};
}

export function useMutation(collection: CollectionProxy) {
  return {
    put: useCallback((doc: any) => collection.put(doc), []),
    update: useCallback((id: string, fields: any) => collection.update(id, fields), []),
    remove: useCallback((id: string) => collection.delete(id), []),
  };
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

export function useQueryOptimized(query: Query<any[]>): Map<string, any> {
  const [docMap, setDocMap] = useState<Map<string, any>>(new Map());
  useEffect(() => {
    let mounted = true;
    const unsub = query.subscribe((docs: any[]) => {
      if (!mounted) return;
      setDocMap(prev => {
        const next = new Map(prev);
        const newIds = new Set<string>();
        for (const doc of docs) {
          const id = doc.id as string;
          newIds.add(id);
          const existing = prev.get(id);
          if (!existing || !shallowEqual(existing, doc)) next.set(id, { ...doc });
        }
        for (const id of prev.keys()) { if (!newIds.has(id)) next.delete(id); }
        if (next.size === prev.size) { let same = true; for (const [id, d] of next) { if (prev.get(id) !== d) { same = false; break; } } if (same) return prev; }
        return next;
      });
    });
    return () => { unsub(); mounted = false; };
  }, []);
  return docMap;
}
