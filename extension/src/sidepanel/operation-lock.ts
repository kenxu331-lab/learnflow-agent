/** Chrome Web Locks serialize UI actions across extension windows. */
export async function withOperationLock<T>(key: string, operation: () => Promise<T>, busy: () => T): Promise<T> {
  if (!navigator.locks) return operation();
  return navigator.locks.request(`learnflow:${key}`, { ifAvailable: true }, (lock) => lock ? operation() : busy());
}
