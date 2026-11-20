// Oura's sign-in returns to sylvester://oura. The sign-in sheet normally catches it; if iOS hands it to the app
// instead, go back to Settings rather than showing "not found".

import { Redirect } from "expo-router";

export default function OuraReturn() {
  return <Redirect href="/settings" />;
}
