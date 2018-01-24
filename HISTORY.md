# v1.2.0

- `amqp-publish` will now set the `correlationId` on a published message if this
  is set in the message properties.
- `amqp-publish` has new option `correlation` to manually set a correlation ID,
  which will be used only if the message has no `correlationId` in its
  properties.
- style: used `const` over `let` where possible

Technically this is a backwards-incompatible change but is extremely unlikely to
affect any actual usage. Could only affect manually-crafted messages having
properties `fields` and `content` but not `properties`.

# v1.1.1

- `amqp-consume` bugfix: messages automatically acknowledged when no limit set
  for consumption, which is undesirable for existing queues

# v1.0.1

- support for rc configuration files added to simplify setting server URL
