// Keys and tokens live in the iPhone Keychain, never in the app's data (which a backup file contains).

import * as SecureStore from "expo-secure-store";

export type SecretName = "anthropic_api_key" | "hosted_token" | "oura_tokens";

const OPTS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export async function getSecret(name: SecretName): Promise<string | null> {
  return SecureStore.getItemAsync(name, OPTS);
}

export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  if (value) await SecureStore.setItemAsync(name, value, OPTS);
  else await SecureStore.deleteItemAsync(name, OPTS);
}
