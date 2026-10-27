// Minimal NEAR JSON-RPC client: node errors and transport errors are told apart, reads are retried.

/** The node answered with an error: the request certainly had no effect beyond what the error says. */
export class RpcError extends Error {
  constructor(error) {
    super(error?.cause?.name ?? error?.name ?? error?.message ?? 'rpc error');
    this.name = 'RpcError';
    this.rpc = error;
  }
}

/**
 * True only for the node's explicit refusal of a transaction while validating it (bad nonce, balance,
 * signature, expired block hash). Any other error, a node-side timeout included, leaves the outcome open.
 */
export const isValidationRejection = (e) => e instanceof RpcError && e.rpc?.cause?.name === 'INVALID_TRANSACTION';

/** No usable answer (network, timeout, bad response): the outcome of the request is unknown. */
export class TransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransportError';
  }
}

const READS = new Set(['block', 'query', 'gas_price', 'EXPERIMENTAL_protocol_config']);

export function createRpc(url, { timeoutMs = 15000, retries = 3, fetchImpl = fetch } = {}) {
  let id = 0;
  async function once(method, params, timeout) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new TransportError(`${method}: ${e?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
    }
    let body;
    try { body = await res.json(); } catch { throw new TransportError(`${method}: HTTP ${res.status}, no JSON`); }
    if (body.error) {
      if (body.error.cause?.name === 'TIMEOUT_ERROR') throw new TransportError(`${method}: node timeout`);
      throw new RpcError(body.error);
    }
    // Some nodes report a failed view inside the result rather than as an error.
    if (body.result?.error) throw new RpcError({ name: 'QUERY_ERROR', message: String(body.result.error) });
    return body.result;
  }

  async function call(method, params, { timeout = timeoutMs } = {}) {
    for (let i = 0; ; i++) {
      try {
        return await once(method, params, timeout);
      } catch (e) {
        // A transaction is never resent here: a lost answer does not mean a lost transaction.
        if (!(e instanceof TransportError) || !READS.has(method) || i >= retries) throw e;
        await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
      }
    }
  }

  // The provider shape `checkVault` (sdk/vault.mjs) reads through.
  const provider = {
    block: (params) => call('block', params),
    query: (params) => call('query', params),
    sendJsonRpc: (method, params) => call(method, params),
  };
  return { call, provider };
}
