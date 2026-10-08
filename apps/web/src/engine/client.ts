import * as Comlink from 'comlink';
import type { WorkerApi } from './engine.worker';

const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
export const api = Comlink.wrap<WorkerApi>(worker);
export const proxy = Comlink.proxy;
