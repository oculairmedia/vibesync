const originalFetch = globalThis.fetch;

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === 'http://localhost:3110') return new Response('ok', { status: 200 });
  if (url === 'https://vibesync.oculair.ca/api/health') return new Response('unavailable', { status: 503 });
  return originalFetch(input, init);
};
