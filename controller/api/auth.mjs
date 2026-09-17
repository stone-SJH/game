export function auth(req, expected, header = 'x-internal-token') {
  return Boolean(expected) && req.headers[header] === expected;
}
