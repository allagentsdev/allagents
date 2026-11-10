/** Resolve portable MCP URL references without putting values in diagnostics. */
export function resolveMcpOAuthServerUrl(
  serverUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  credentialValues?: Set<string>,
): string {
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
  const whole = reference.exec(serverUrl)?.[1];
  const read = (name: string, queryParameter = false): string => {
    const value = environment[name];
    if (value === undefined)
      throw new Error(
        `MCP URL${queryParameter ? ' query parameter' : ''} references missing environment variable '${name}'`,
      );
    credentialValues?.add(value);
    return value;
  };
  if (whole) serverUrl = read(whole);
  if (!serverUrl.includes('${') && !/(?:\$|%24)(?:\{|%7b)/i.test(serverUrl)) {
    if (!whole) return serverUrl;
    try {
      return new URL(serverUrl).toString();
    } catch {
      throw new Error('Invalid MCP URL environment reference');
    }
  }
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error('Invalid MCP URL environment reference');
  }
  let changed = false;
  const query = url.search
    .slice(1)
    .split('&')
    .map((parameter) => {
      const separator = parameter.indexOf('=');
      if (separator === -1) return parameter;
      const value = new URLSearchParams(parameter).values().next().value ?? '';
      const match = reference.exec(value)?.[1];
      if (!match) return parameter;
      const encoded = encodeURIComponent(read(match, true));
      credentialValues?.add(encoded);
      credentialValues?.add(encoded.replaceAll("'", '%27'));
      changed = true;
      return `${parameter.slice(0, separator + 1)}${encoded}`;
    })
    .join('&');
  if (!changed) return serverUrl;
  url.search = query;
  return url.toString();
}
