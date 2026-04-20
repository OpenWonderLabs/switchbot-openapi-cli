# Verbose header redaction

When `--verbose` is on, the CLI logs request and response traces to stderr.
To prevent credential leakage, sensitive headers are mid-masked before printing:
the first 2 characters and last 2 characters are kept; everything in between is
replaced with asterisks (e.g. `Bearer my-secret-token` → `Be**************en`).

## Masked headers

The following header names trigger masking (case-insensitive unless noted):

| Header         | Notes                                                         |
|----------------|---------------------------------------------------------------|
| `authorization`| Standard HTTP auth header                                     |
| `token`        | SwitchBot API token header                                    |
| `sign`         | HMAC-SHA256 signature                                         |
| `nonce`        | Random nonce used in HMAC construction                        |
| `x-api-key`    | Generic API key header                                        |
| `cookie`       | Session cookies                                               |
| `set-cookie`   | Server-set cookies                                            |
| `x-auth-token` | Alternative auth token header                                 |
| `t`            | Timestamp (exact match); combined with `sign`, can replay HMAC|

## Opt-out: `--trace-unsafe`

Pass `--trace-unsafe` to any command to disable masking and print all headers
verbatim. A prominent one-time warning is printed to stderr when this flag is
active:

```
WARNING  --trace-unsafe: sensitive headers will be printed UNMASKED. Do not share this output.
```

Use `--trace-unsafe` only in local debugging sessions. Never share the output
publicly — it contains credentials that can be replayed.
