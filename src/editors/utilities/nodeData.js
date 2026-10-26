const sourceMaps = new WeakMap();
const liveNodes = new WeakMap();
const placeholders = new WeakSet();

export const getSourceMap = node => sourceMaps.get(node);
export const setSourceMap = (node, map) => map ? sourceMaps.set(node, map) : sourceMaps.delete(node);
export const getLiveNode = node => liveNodes.get(node);
export const setLiveNode = (node, live) => live ? liveNodes.set(node, live) : liveNodes.delete(node);
export const markPlaceholder = node => placeholders.add(node);
export const unmarkPlaceholder = node => placeholders.delete(node);
export const isPlaceholder = node => placeholders.has(node);
