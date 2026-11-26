/**
 * Congratulating someone on their birthday (ADR 0055): one of a few greetings,
 * the same words whatever the app's language, sent to them alone in a direct
 * chat (ADR 0047), made if need be.
 */

export const BIRTHDAY_GREETINGS = [
  'Parabéns, chuchuzinho!',
  'Feliz aniversário, meu docinho!',
  'Felicidades, fofura!',
] as const;

export type BirthdayGreeting = (typeof BIRTHDAY_GREETINGS)[number];

export const isBirthdayGreeting = (body: string): body is BirthdayGreeting =>
  (BIRTHDAY_GREETINGS as readonly string[]).includes(body);

/** The direct-chat bridge, as much of it as a greeting needs; a parameter so it is tested. */
export interface GreetingBridge {
  direct(
    accountId: string,
  ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: string }>;
  send(chatId: string, body: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * Sends a greeting to `accountId` in your direct chat with them. Resolves to
 * the server's refusal code, or null once it is sent. Only the predefined
 * greetings go: anything else is refused here, before the server.
 */
export async function sendBirthdayGreeting(
  accountId: string,
  greeting: string,
  bridge: GreetingBridge = window.zoia.chat,
): Promise<string | null> {
  if (!isBirthdayGreeting(greeting)) return 'invalid_greeting';
  const chat = await bridge.direct(accountId);
  if (!chat.ok) return chat.error;
  const sent = await bridge.send(chat.value.id, greeting);
  return sent.ok ? null : sent.error;
}
