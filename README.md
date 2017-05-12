# amqp-tools

This package provides two CLI tools for interacting with a RabbitMQ server. You
can consume (export) data from queues and/or exchanges into JSON. Also you can
then publish (import) that JSON data.

When installed globally, the tools are exposed as `amqp-consume` and
`amqp-publish`.

The rest of this README is just the output from using the tools with `--help`.

## Consume

amqp-consume

  Consumes AMQP messages from Queues and Exchange+RoutingKey

Usage

  amqp-consume [options] specification [specification...]

  specification := queue|binding
  binding       := exchange "/" route ("/" route)*

Options

  -u, --url string           URL of AMQP server
  -x, --max number           maximum messages to consume
  --min number               require minimum messages available to consume
  -i, --indentation number   JSON output indentation
  -a, --ack                  acknowledge consumed messages
  -v, --verbose              turn volume up to 11
  -h, --help                 show help

Output

  The output is a stream of JSON data, or an array of messages when indentation
  is used. The JSON data matches the output of amqplib, with some added
  friendly conversion of binary data and, when contentType is
  'application/json', JSON parsing.

Examples

  $ amqp-consume -x 10 -a my-queue

  Consume and acknowledge 10 messages from queue named 'my-queue'.

  $ amqp-consume amq.topic/# My-Exchange/my.routing.key my-queue

  Consume all messages from exchange 'amq.topic', messages from exchange 'My-
  Exchange' matching the routing key 'my.routing.key', and also messages from
  queue named 'my-queue'. (Stop consuming on interrupt.)



## Publish


amqp-publish

  Publish JSON-based AMQP messages from STDIN (see amqp-consume)
  By default, published to original exchange+route from metadata, and
  additionally to specified queues or exchange+route

Usage

  amqp-publish [options] [specification...]

Specification

  specification := queue|binding
  binding       := exchange "/" route ("/" route)*

Options

  -u, --url string   URL of AMQP server
  -n, --nometa       ignore metadata when publishing (requires specs)
  -q, --queue        use queue -- not exchange/route -- from metadata
  -v, --verbose      turn volume up to 11
  -h, --help         show help

Examples

  $ amqp-publish < saved-messages.json

  Publish the saved messages to the exchange as they were consumed from, using
  the same routing key.

  $ amqp-publish -n amq.topic/my.topic.routing.key < saved-messages.json

  Ignore original message metadata, instead publish to exchange 'amq.topic'
  with routing key 'my.topic.routing.key'.

  $ amqp-publish -q < saved-messages.json

  Publish the saved messages directly to the same queue they were consumed
  from.

  $ amqp-publish amq.topic/route.one/route.two < saved-messages.json

  Publish the saved messages to original exchange+route, but additionally to
  exchange 'amq.topic' using both 'route.one' and 'route.two' routing keys.
