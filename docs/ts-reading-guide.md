# TypeScript reading guide for this repo

Everything here is a construct you already know from Python. The code in this
repo is deliberately plain: explicit types on function boundaries, no custom
generics, no decorators, no classes outside CDK constructs. If a file needs
something not on this page, the walkthrough will flag it.

## 1. `async` / `await`

Same as Python. Every AWS SDK call returns a Promise; `await` it.

```ts
const res = await s3.send(new GetObjectCommand({ Bucket, Key }));
```

Python: `res = await client.get_object(Bucket=..., Key=...)`.

## 2. `type` and `interface` (shapes of data)

Both describe the shape of an object. We use `type` for unions and `interface`
for records. Think `TypedDict` / `dataclass` that the compiler checks.

```ts
interface ImageItem {
  PK: string;            // "ORG#acme"
  SK: string;            // "IMAGE#img_123"
  status: ImageStatus;
  currentStep: number;
  sourceETag?: string;   // ? = optional, like Optional[str]
}
```

## 3. Union types and discriminated unions

`A | B` means "either". A discriminated union has a field (here `status`) that
tells you which branch you are in, and the compiler narrows accordingly.

```ts
type FilterResponse =
  | { status: 'ok'; output: { width: number; height: number; bytes: number } }
  | { status: 'error'; error: { code: string; message: string; retryable: boolean } };

if (res.status === 'ok') {
  res.output.width;     // allowed
} else {
  res.error.code;       // allowed; res.output would be a compile error
}
```

Python has no built-in equivalent; closest is `Literal` + `match`.

## 4. Destructuring

Pull fields out of an object or array in one line.

```ts
const { imageId, step, pipelineSnapshot } = event;
const [first, ...rest] = items;
```

Python: `image_id, step = event["imageId"], event["step"]`.

## 5. Optional chaining `?.` and nullish coalescing `??`

```ts
const etag = item?.sourceETag ?? 'none';
```

Reads: if `item` is null/undefined, stop and give `undefined`; then if the
result is null/undefined, use `'none'`. Python: `(item or {}).get("sourceETag") or "none"`
but without treating `""`/`0` as missing.

## 6. `import` / `export`

A file exports what others may use; others import by name.

```ts
// lambdas/shared/errors.ts
export class RetryableError extends Error { ... }

// lambdas/worker/run-step.ts
import { RetryableError } from '../shared/errors';
```

Python: `from shared.errors import RetryableError`.

## 7. Errors: `class X extends Error`, `throw`, `try/catch`

```ts
export class TerminalError extends Error {
  constructor(public readonly cls: 'input' | 'platform', message: string) {
    super(message);
    this.name = 'TerminalError';   // this is the name Step Functions matches on
  }
}

try {
  await runFilter(...);
} catch (e) {
  if (e instanceof TerminalError) { ... }
  throw e;
}
```

`this.name` matters: Lambda reports `errorType` = the error's `name`, and the
Step Functions `Retry`/`Catch` `ErrorEquals` list matches that string.

## 8. Bounded parallelism with `Promise.all`

Node is single-threaded but I/O is concurrent. To upload six files at a time:

```ts
const pool = 6;
const queue = [...files];
await Promise.all(Array.from({ length: pool }, async () => {
  while (queue.length) {
    const f = queue.shift()!;    // ! = "I know this is not undefined"
    await uploadOne(f);
  }
}));
```

Six workers each pull from the queue until it is empty. Python:
`asyncio.Semaphore(6)` with `asyncio.gather`.

## 9. CDK-specific shapes you will see

```ts
new NodejsFunction(this, 'Worker', {          // (scope, id, props)
  entry: 'lambdas/worker/run-step.ts',
  runtime: Runtime.NODEJS_20_X,
  architecture: Architecture.ARM_64,
  memorySize: 10240,
  timeout: Duration.minutes(15),
  reservedConcurrentExecutions: 300,
  environment: { TABLE_NAME: table.tableName },
});
table.grantReadWriteData(worker);               // generates the IAM policy
```

Every construct is `new Thing(scope, id, props)`. `grant*` methods write IAM
policies for you; when a permission is missing at runtime, the fix is usually
one more `grant` line.

## 10. Things that look odd but are harmless

- `!` after an expression: non-null assertion, "trust me".
- `as const`: freezes a literal so its type is the exact value, not `string`.
- `Record<string, string>`: a dict with string keys and string values.
- `unknown` in a `catch (e)`: TypeScript does not assume errors are `Error`; we narrow with `instanceof`.
- Trailing `satisfies SomeType`: checks a literal against a type without changing its inferred type.
