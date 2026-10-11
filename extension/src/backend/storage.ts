export async function ensureTrustedStorageAccess(): Promise<boolean> {
  try {
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    return true;
  } catch {
    return false;
  }
}
