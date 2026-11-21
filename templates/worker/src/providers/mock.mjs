export async function mockProvider({ env }) {
  return env.MOCK_REPLY || `Hola, soy Falco, el asistente de ${env.BUSINESS_NAME}.`;
}
